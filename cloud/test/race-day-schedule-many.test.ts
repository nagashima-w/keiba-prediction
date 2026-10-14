import { afterEach, describe, expect, it } from "vitest";

import type { GateLike } from "../src/gate-fetch";
import { MAX_BULK_RACES, MAX_TASKS_PER_DAY, RaceDayCore, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #251: 日単位の DO の一括予約 `scheduleMany`。管理者が競馬場ごとに、事前分析(morning)か発走前の分析(pre_race)をまとめて予約する。
 * 予約だけをして戻る(取得はアラームの中)。gate は予約の段階では呼ばない。上限(MAX_TASKS_PER_DAY)は「全か無か」で、足りなければ何も積まない。
 */

const DATE = "20260628";
const RACE_A = "202603020211";
const RACE_B = "202603020210";
const RACE_C = "202603020209";
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url) {
      gate.urls.push(url);
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(fixtureForUrl(url)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  /** setAlarm の呼び出し(時刻)の記録。 */
  readonly alarms: number[];
  readonly alarm: { at: number | null };
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) {
    sql.close();
  }
});

/** 発走前の分析の保存先・設定を持たない構成(= pre_race を予約できない構成)が既定。`withPreRace` で持たせる(予約では使われない。ここでは存在だけが要る)。 */
function harness(options: { readonly withPreRace?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const gate = fakeGate();
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarms: number[] = [];
  const alarm: { at: number | null } = { at: null };
  const preRace: Partial<RaceDayDeps> = options.withPreRace === true ? { sink: {} as never, loadSettings: async () => DEFAULT_CLOUD_SETTINGS } : {};
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: () => {},
    ...preRace,
  });
  return { core, sql, gate, clock, alarms, alarm };
}

/** 12 桁の中央のレース ID を n 個作る(場コード 01〜10 × 12R。MAX_TASKS_PER_DAY 件ぶん作れる範囲で)。 */
function manyRaceIds(n: number): string[] {
  const ids: string[] = [];
  for (let venue = 1; venue <= 10 && ids.length < n; venue++) {
    for (let race = 1; race <= 12 && ids.length < n; race++) {
      ids.push(`2026${String(venue).padStart(2, "0")}0101${String(race).padStart(2, "0")}`);
    }
  }
  expect(ids).toHaveLength(n); // 前提: 欲しい数だけ作れた(足りないと上限のテストが空振りする)
  return ids;
}

const rowOf = (h: Harness, raceId: string, mode: string) =>
  h.core.getBoard().races.find((r) => r.raceId === raceId && r.mode === mode);

describe("scheduleMany: 受理と結果(Issue #251)", () => {
  it("新規のレースを全部積む: レースごとの結果は accepted、板に queued の行ができる。アラームを張るのは全体で 1 回(1 レースごとに張り直さない)", async () => {
    const h = harness();
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, RACE_B, RACE_C] });
    expect(result).toEqual({
      accepted: true,
      mode: "morning",
      results: [
        { raceId: RACE_A, result: "accepted" },
        { raceId: RACE_B, result: "accepted" },
        { raceId: RACE_C, result: "accepted" },
      ],
    });
    const rows = h.core.getBoard().races;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.mode).toBe("morning");
      expect(row.status).toBe("queued");
      expect(row.queuedAt).toBe(h.clock.now);
    }
    expect(h.alarms).toHaveLength(1);
    expect(h.gate.urls).toEqual([]); // 予約は netkeiba に出ない
  });

  it("入力の順序を結果に保つ(race_id の昇順に並べ替えない)", async () => {
    const h = harness();
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_C, RACE_A, RACE_B] });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.results.map((r) => r.raceId)).toEqual([RACE_C, RACE_A, RACE_B]);
  });

  it("実行中(queued・fetched)のレースは already-running(いまの状態つき)で、その行は変えない。完了済み・失敗・新規は受理して queued に作り直す", async () => {
    const h = harness();
    // 前提の状態を作る: A=queued(実行中)・B=fetched(実行中)・C=done・D=failed
    const RACE_D = "202603020208";
    for (const id of [RACE_A, RACE_B, RACE_C, RACE_D]) {
      await h.core.schedule({ raceId: id, kaisaiDate: DATE });
    }
    h.sql.exec("UPDATE race_day_tasks SET status = 'fetched' WHERE race_id = ?", RACE_B);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ?", RACE_C);
    h.sql.exec("UPDATE race_day_tasks SET status = 'failed', error = 'x', attempts = 3 WHERE race_id = ?", RACE_D);
    const RACE_E = "202603020207"; // 新規
    const queuedAtBefore = rowOf(h, RACE_A, "morning")!.queuedAt;
    h.clock.now += 60_000; // 時計を進める(実行中の行が作り直されたかを、queued_at の変化で見分けられる)

    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, RACE_B, RACE_C, RACE_D, RACE_E] });
    expect(result).toEqual({
      accepted: true,
      mode: "morning",
      results: [
        { raceId: RACE_A, result: "already-running", status: "queued" },
        { raceId: RACE_B, result: "already-running", status: "fetched" },
        { raceId: RACE_C, result: "accepted" },
        { raceId: RACE_D, result: "accepted" },
        { raceId: RACE_E, result: "accepted" },
      ],
    });
    // 実行中の行は触らない
    expect(rowOf(h, RACE_A, "morning")).toMatchObject({ status: "queued", queuedAt: queuedAtBefore });
    expect(rowOf(h, RACE_B, "morning")).toMatchObject({ status: "fetched", queuedAt: queuedAtBefore });
    // 完了・失敗は作り直す(状態 queued・試行 0・エラー消去・queued_at は新しい時刻)
    expect(rowOf(h, RACE_C, "morning")).toMatchObject({ status: "queued", attempts: 0, error: null, queuedAt: h.clock.now });
    expect(rowOf(h, RACE_D, "morning")).toMatchObject({ status: "queued", attempts: 0, error: null, queuedAt: h.clock.now });
    expect(rowOf(h, RACE_E, "morning")).toMatchObject({ status: "queued", queuedAt: h.clock.now });
  });

  it("全部が実行中でも、結果はすべて already-running(accepted: true の本文)で、行は増えない", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.schedule({ raceId: RACE_B, kaisaiDate: DATE });
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, RACE_B] });
    expect(result).toEqual({
      accepted: true,
      mode: "morning",
      results: [
        { raceId: RACE_A, result: "already-running", status: "queued" },
        { raceId: RACE_B, result: "already-running", status: "queued" },
      ],
    });
    expect(h.core.getBoard().races).toHaveLength(2);
  });

  it("実行中かどうかは (レース, mode) ごと: 事前分析(morning)が実行中でも、発走前(pre_race)は新規に受理する", async () => {
    const h = harness({ withPreRace: true });
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE, mode: "morning" });
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "pre_race", raceIds: [RACE_A] });
    expect(result).toEqual({ accepted: true, mode: "pre_race", results: [{ raceId: RACE_A, result: "accepted" }] });
    expect(h.core.getBoard().races.map((r) => `${r.mode}:${r.status}`).sort()).toEqual(["morning:queued", "pre_race:queued"]);
  });

  it("予約したレースは、アラームだけで最後まで進む(一括で積んだ 2 レースの事前分析が両方 done になる)", async () => {
    const h = harness();
    await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, RACE_B] });
    for (let i = 0; i < 50 && h.alarm.at !== null; i++) {
      h.clock.now = Math.max(h.clock.now, h.alarm.at);
      h.alarm.at = null;
      await h.core.runNextStep();
    }
    const rows = h.core.getBoard().races;
    expect(rows).toHaveLength(2); // 前提
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });
});

describe("scheduleMany: 発走前の分析の自動の印(Issue #251。単独の schedule と同じ規則)", () => {
  const markAuto = (h: Harness, raceId: string, enqueuedAt: number): void => {
    h.sql.exec("INSERT INTO race_day_auto_pre_race (race_id, enqueued_at, fail_reason) VALUES (?, ?, NULL)", raceId, enqueuedAt);
  };
  const hasMarker = (h: Harness, raceId: string): boolean =>
    (h.sql.exec("SELECT COUNT(*) AS n FROM race_day_auto_pre_race WHERE race_id = ?", raceId).toArray() as { n: number }[])[0]!.n === 1;

  it("積み直した pre_race は自動の印を消す(手動が所有権を取る)。実行中で受理しなかったレースの印は消さない", async () => {
    const h = harness({ withPreRace: true });
    // A: 実行中の pre_race(手動で積んだあとに、印だけが残っている想定)・B: 完了済みで自動の印あり
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.schedule({ raceId: RACE_B, kaisaiDate: DATE, mode: "pre_race" });
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ?", RACE_B);
    markAuto(h, RACE_A, 1);
    markAuto(h, RACE_B, 1);
    expect(hasMarker(h, RACE_A)).toBe(true);
    expect(hasMarker(h, RACE_B)).toBe(true);

    await h.core.scheduleMany({ kaisaiDate: DATE, mode: "pre_race", raceIds: [RACE_A, RACE_B] });
    expect(hasMarker(h, RACE_A)).toBe(true); // 実行中(already-running)なので触らない
    expect(hasMarker(h, RACE_B)).toBe(false); // 積み直したので消える
  });

  it("morning の予約は、pre_race の自動の印に触らない", async () => {
    const h = harness({ withPreRace: true });
    markAuto(h, RACE_A, 1);
    await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A] });
    expect(hasMarker(h, RACE_A)).toBe(true);
  });
});

describe("scheduleMany: 1 日の上限は全か無か(Issue #251)", () => {
  it("新しい行が必要な数 + いまの行数が上限を超えるなら、何も積まず day-cap を返す(板・アラームは変わらない)。limit・used・needed を返す", async () => {
    const h = harness();
    const ids = manyRaceIds(MAX_TASKS_PER_DAY + 1);
    for (const id of ids.slice(0, MAX_TASKS_PER_DAY - 1)) {
      await h.core.schedule({ raceId: id, kaisaiDate: DATE });
    }
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY - 1); // 前提: 残り 1 行
    const alarmsBefore = h.alarms.length;
    const boardBefore = JSON.stringify(h.core.getBoard());

    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [ids[MAX_TASKS_PER_DAY - 1]!, ids[MAX_TASKS_PER_DAY]!] });
    expect(result).toEqual({ accepted: false, reason: "day-cap", limit: MAX_TASKS_PER_DAY, used: MAX_TASKS_PER_DAY - 1, needed: 2 });
    expect(JSON.stringify(h.core.getBoard())).toBe(boardBefore);
    expect(h.alarms).toHaveLength(alarmsBefore);
  });

  it("ちょうど上限に収まるなら受理する(境界)", async () => {
    const h = harness();
    const ids = manyRaceIds(MAX_TASKS_PER_DAY);
    for (const id of ids.slice(0, MAX_TASKS_PER_DAY - 2)) {
      await h.core.schedule({ raceId: id, kaisaiDate: DATE });
    }
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: ids.slice(MAX_TASKS_PER_DAY - 2) });
    expect(result.accepted).toBe(true);
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY);
  });

  it("上限に達していても、既存の行の再予約(完了済み・失敗)は新しい行を増やさないので受理する。実行中は already-running", async () => {
    const h = harness();
    const ids = manyRaceIds(MAX_TASKS_PER_DAY);
    for (const id of ids) {
      await h.core.schedule({ raceId: id, kaisaiDate: DATE });
    }
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ?", ids[1]);
    h.sql.exec("UPDATE race_day_tasks SET status = 'failed' WHERE race_id = ?", ids[2]);
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY); // 前提: 満杯

    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [ids[0]!, ids[1]!, ids[2]!] });
    expect(result).toEqual({
      accepted: true,
      mode: "morning",
      results: [
        { raceId: ids[0], result: "already-running", status: "queued" },
        { raceId: ids[1], result: "accepted" },
        { raceId: ids[2], result: "accepted" },
      ],
    });
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY);
  });

  it("上限は (レース, mode) の行で数える: 同じレースの morning と pre_race は 2 行", async () => {
    const h = harness({ withPreRace: true });
    const ids = manyRaceIds(MAX_TASKS_PER_DAY);
    for (const id of ids.slice(0, MAX_TASKS_PER_DAY - 1)) {
      await h.core.schedule({ raceId: id, kaisaiDate: DATE });
    }
    // 残り 1 行。morning が既にあるレースの pre_race は新しい行を 1 つ使う → 1 件なら入り、2 件は入らない
    expect(await h.core.scheduleMany({ kaisaiDate: DATE, mode: "pre_race", raceIds: [ids[0]!, ids[1]!] })).toMatchObject({ accepted: false, reason: "day-cap", used: MAX_TASKS_PER_DAY - 1, needed: 2 });
    expect(await h.core.scheduleMany({ kaisaiDate: DATE, mode: "pre_race", raceIds: [ids[0]!] })).toMatchObject({ accepted: true });
  });
});

describe("scheduleMany: 入力の検証は何も変える前に行う(Issue #251)", () => {
  it("空の一覧・重複・件数が MAX_BULK_RACES 超過は拒否する(行も開催日の固定も作らない)", async () => {
    const h = harness();
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [] })).rejects.toThrow(/race_ids|レース/);
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, RACE_A] })).rejects.toThrow(/重複/);
    const tooMany = manyRaceIds(MAX_BULK_RACES + 1);
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: tooMany })).rejects.toThrow(/多すぎ|上限|以下/);
    expect(h.core.getBoard()).toEqual({ kaisaiDate: null, races: [] });
    expect(h.alarms).toEqual([]);
  });

  it("MAX_BULK_RACES ちょうどは受理する(境界)", async () => {
    const h = harness();
    const result = await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: manyRaceIds(MAX_BULK_RACES) });
    expect(result.accepted).toBe(true);
    expect(h.core.getBoard().races).toHaveLength(MAX_BULK_RACES);
  });

  it("途中に無効なレース ID があれば、手前の有効な ID も積まずに拒否する(部分的な書き込みを残さない)", async () => {
    const h = harness();
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A, "not-a-race"] })).rejects.toThrow();
    expect(h.core.getBoard()).toEqual({ kaisaiDate: null, races: [] });
    expect(h.alarms).toEqual([]);
  });

  it("raceId の年が開催日の年と違う、無効な開催日、未知の mode は拒否する", async () => {
    const h = harness();
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: ["202503020211"] })).rejects.toThrow();
    await expect(h.core.scheduleMany({ kaisaiDate: "2026-06-28", mode: "morning", raceIds: [RACE_A] })).rejects.toThrow();
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "bogus" as never, raceIds: [RACE_A] })).rejects.toThrow(/mode/);
    expect(h.core.getBoard().races).toHaveLength(0);
  });

  it("この DO の開催日と違う日は拒否する(最初の予約で固定した開催日)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await expect(h.core.scheduleMany({ kaisaiDate: "20260629", mode: "morning", raceIds: ["202603020311"] })).rejects.toThrow(/専用/);
  });

  it("発走前の分析の保存先・設定が無い構成では pre_race を拒否する(morning は受理できる)", async () => {
    const h = harness(); // withPreRace なし
    await expect(h.core.scheduleMany({ kaisaiDate: DATE, mode: "pre_race", raceIds: [RACE_A] })).rejects.toThrow(/保存先/);
    expect(h.core.getBoard().races).toHaveLength(0);
    expect((await h.core.scheduleMany({ kaisaiDate: DATE, mode: "morning", raceIds: [RACE_A] })).accepted).toBe(true);
  });
});
