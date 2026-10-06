import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "../../packages/core/src/scraper/http-client";
import type { GateResult } from "../src/gate-core";
import { GateRefusedError, type GateLike } from "../src/gate-fetch";
import { CACHE_RETENTION_MS, MAX_TASKS_PER_DAY, PURGE_MARGIN_MS, RaceDayCore, serializeGate, type RaceDayDeps } from "../src/race-day-core";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #177(#164-b): 日単位の DO `RaceDay` の中身(`RaceDayCore`。純ロジック)。朝の取得(ステップ1)と prior(ステップ2)・取得キャッシュ・状態。
 * ゲートは偽(フィクスチャのバイト列を返す)。ストレージは `node:sqlite`(本物の SQLite)。D1・R2 は渡さない(朝の prior は DO にだけ置く)。
 */

const DATE = "20260628";
const RACE_A = "202603020211";
const RACE_B = "202603020210"; // 別レース(フィクスチャは 202603020211 のもの。取得の本数・順序を見るだけなので、中身は同じでよい)
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
  maxInFlight: number;
  /** 次の呼び出しから、この URL に当たったら拒否にする(ブレーカー・待ち行列の模擬)。 */
  failWhen: ((url: string) => GateResult | null) | null;
}

function fakeGate(delayMs = 0): FakeGate {
  let inFlight = 0;
  const gate: FakeGate = {
    urls: [],
    maxInFlight: 0,
    failWhen: null,
    async fetchRaw(url) {
      gate.urls.push(url);
      inFlight += 1;
      gate.maxInFlight = Math.max(gate.maxInFlight, inFlight);
      try {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          await Promise.resolve();
        }
        const forced = gate.failWhen?.(url) ?? null;
        if (forced !== null) {
          return forced;
        }
        return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(fixtureForUrl(url)), queuedMs: 0, elapsedMs: 1 };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return gate;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly alarms: number[];
  /** 今設定されているアラーム(DO のアラームは1つだけ。設定は上書き、鳴ったら空になる)。 */
  readonly alarm: { at: number | null };
  readonly warnings: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) {
    sql.close();
  }
});

function harness(overrides: Partial<RaceDayDeps> = {}, gate: FakeGate = fakeGate()): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarms: number[] = [];
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    ...overrides,
  });
  return { core, sql, gate, clock, alarms, alarm, warnings };
}

/**
 * 偽の時計で「アラームだけで進む」ことを確かめる(手動で idle まで回さない)。DO と同じく、アラームは1つだけで、鳴った時刻に時計を進め、
 * 鳴ったアラームは空にしてから `runNextStep` を呼ぶ(中で設定されたものだけが残る)。上限つき。
 */
async function driveByAlarms(h: Harness, max = 50, options: { readonly stopAtMax?: boolean } = {}): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const at = h.alarm.at;
    if (at === null) {
      return outcomes;
    }
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    const outcome = await h.core.runNextStep();
    outcomes.push(outcome.kind === "idle" ? "idle" : `${outcome.raceId}:${outcome.step}:${outcome.result}`);
  }
  if (options.stopAtMax === true) {
    return outcomes;
  }
  throw new Error("アラームが止まらない(上限超過)");
}

async function runAll(h: Harness, max = 20): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const outcome = await h.core.runNextStep();
    if (outcome.kind === "idle") {
      return outcomes;
    }
    outcomes.push(`${outcome.raceId}:${outcome.step}:${outcome.result}`);
  }
  throw new Error("ステップが終わらない(上限超過)");
}

describe("朝の取得(ステップ1)と計算(ステップ2)(Issue #177 AC-b5・AC-b2)", () => {
  it("AC-b5: 冷えた状態(キャッシュなし)の中央16頭で、取得ステップの gate への取得は 19 本(出馬表 1・戦績 16・調教 1・単勝複勝 1)", async () => {
    const h = harness();
    expect((await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE })).accepted).toBe(true);
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", raceId: RACE_A, step: "fetch", result: "ok" });
    expect(h.gate.urls).toHaveLength(19);
    const count = (fragment: string): number => h.gate.urls.filter((u) => u.includes(fragment)).length;
    expect(count("shutuba.html")).toBe(1);
    expect(count("ajax_horse_results")).toBe(16);
    expect(count("oikiri.html")).toBe(1);
    expect(count("api_get_jra_odds")).toBe(1);
    expect(count("type=1")).toBe(1); // 単勝複勝だけ。組合せオッズ(type=3〜8)は朝は取らない
    expect(h.core.getBoard().races[0]).toMatchObject({ raceId: RACE_A, status: "fetched" });
  });

  it("ステップ2(計算)は gate を呼ばず、朝の prior(16頭・LLM なし・配分なし)を DO に置く。AC-b2: キャッシュだけで足りる", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    const afterFetch = h.gate.urls.length;
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", raceId: RACE_A, step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(afterFetch); // 計算のステップで、gate への取得は0本
    const prior = h.core.getMorningPrior(RACE_A);
    expect(prior).not.toBeNull();
    expect(prior!.result.rows).toHaveLength(16);
    expect(prior!.result.llmUsed).toBe(false);
    expect(prior!.result.dateApproximate).toBe(false);
    expect(prior!.result.date).toBe("2026/06/28");
    expect("wideCombo" in prior!.result).toBe(false); // 朝は組合せオッズを取らない
    expect(prior!.result.rows.every((r) => r.prior > 0 && r.prior < 1)).toBe(true);
    expect(new Set(prior!.result.rows.map((r) => r.prior)).size).toBeGreaterThan(1); // 退化していない(全馬が同じ値ではない)
    expect(h.core.getBoard().races[0]).toMatchObject({ raceId: RACE_A, status: "done" });
  });

  it("朝の prior は exe 側の golden(LLM なし・配分なし)の rows と同じ prior になる(同じ runAnalysis)", async () => {
    const golden = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "app", "test", "golden", "pipeline-golden.json"), "utf-8"),
    ) as { noLlmNoAllocationNoDate: { result: { rows: { umaban: number; prior: number }[] } } };
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await runAll(h);
    const rows = h.core.getMorningPrior(RACE_A)!.result.rows;
    expect(rows.map((r) => [r.umaban, r.prior])).toEqual(golden.noLlmNoAllocationNoDate.result.rows.map((r) => [r.umaban, r.prior]));
  });

  it("AC-b2: キャッシュに当たれば gate への取得は0本(TTL 内の再実行)。出馬表 10 分・オッズ 60 秒を過ぎたぶんだけ取り直す(2本)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await runAll(h);
    expect(h.gate.urls).toHaveLength(19);

    // 30 秒後(オッズ 60 秒・出馬表 10 分の内側): 全部キャッシュ
    h.clock.now += 30_000;
    expect((await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE })).accepted).toBe(true); // 完了済みは再実行できる
    await runAll(h);
    expect(h.gate.urls).toHaveLength(19);

    // さらに 11 分後: 出馬表(10 分)・オッズ(60 秒)は期限切れ、戦績(24 時間)・調教(6 時間)はヒット
    h.clock.now += 11 * 60_000;
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await runAll(h);
    const refetched = h.gate.urls.slice(19);
    expect(refetched).toHaveLength(2);
    expect(refetched.some((u) => u.includes("shutuba.html"))).toBe(true);
    expect(refetched.some((u) => u.includes("api_get_jra_odds"))).toBe(true);
  });

  it("ステップ2は、取得の直後(出馬表・オッズの TTL が切れた後でも)キャッシュだけで計算できる(TTL を延ばして読む)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep(); // fetch
    h.clock.now += 3 * 60 * 60_000; // 3 時間後(全カテゴリの通常の TTL を超えうる。ステップの間にアラームが遅れた状況)
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(19);
  });

  it("ステップ2でキャッシュに戦績が無い(掃除された等)なら、ネットワークに出ず、失敗として記録する(戦績なしの prior を黙って作らない)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%ajax_horse_results%'");
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", step: "compute", result: "failed" });
    expect(h.gate.urls).toHaveLength(19);
    expect(h.core.getMorningPrior(RACE_A)).toBeNull();
    const race = h.core.getBoard().races[0]!;
    expect(race.status).toBe("failed");
    expect(race.error).toMatch(/戦績/);
  });
});

describe("gate は同時に1本だけ呼ぶ(AC-b3)", () => {
  it("serializeGate: 同時に5本呼んでも、gate の中は常に1本。呼んだ順に処理し、失敗した取得が後続を止めない", async () => {
    const inner = fakeGate(5);
    let failFirst = true;
    inner.failWhen = () => {
      if (failFirst) {
        failFirst = false;
        return { kind: "refused", reason: "queue-full", message: "満杯" };
      }
      return null;
    };
    const serial = serializeGate(inner);
    const urls = [1, 2, 3, 4, 5].map((n) => `https://race.netkeiba.com/race/shutuba.html?race_id=20260302021${n}`);
    const results = await Promise.all(urls.map((u) => serial.fetchRaw(u)));
    expect(inner.maxInFlight).toBe(1);
    expect(inner.urls).toEqual(urls);
    expect(results[0]).toMatchObject({ kind: "refused" });
    expect(results.slice(1).every((r) => r.kind === "response")).toBe(true);
  });

  it("対照: 直列化しない素の gate は、同時に呼ぶと重なる(上のテストが空振りでないことの確認)", async () => {
    const inner = fakeGate(5);
    await Promise.all([1, 2, 3].map((n) => inner.fetchRaw(`https://race.netkeiba.com/race/shutuba.html?race_id=20260302021${n}`)));
    expect(inner.maxInFlight).toBeGreaterThan(1);
  });

  it("RaceDayCore の取得ステップ全体でも、gate の中は常に1本(遅延のある gate で19本)", async () => {
    const gate = fakeGate(2);
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    expect(gate.urls).toHaveLength(19);
    expect(gate.maxInFlight).toBe(1);
  });
});

describe("予約・状態・アラーム(Issue #177)", () => {
  it("schedule は予約だけ: gate を呼ばず、アラームを now に1回だけ設定して戻る", async () => {
    const h = harness();
    const result = await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(result).toMatchObject({ accepted: true, raceId: RACE_A, status: "queued" });
    expect(h.gate.urls).toEqual([]);
    expect(h.alarms).toEqual([h.clock.now]);
    expect(h.core.getBoard().races).toEqual([expect.objectContaining({ raceId: RACE_A, status: "queued" })]);
  });

  it("実行中(queued・fetched)の同じレースの二重の予約は、受け付けず(accepted: false)、タスクは1件のまま・アラームも増やさない", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    const second = await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(second).toMatchObject({ accepted: false, status: "queued" });
    expect(h.core.getBoard().races).toHaveLength(1);
    expect(h.alarms).toHaveLength(1);
    await h.core.runNextStep(); // fetched になっても同じ
    expect(await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE })).toMatchObject({ accepted: false, status: "fetched" });
    expect(h.alarms).toHaveLength(2); // ステップ1のあとの「続きのアラーム」だけ
  });

  it("ステップごとにアラームを分ける: 取得 → (アラーム now)→ 計算 → (最後は掃除専用のアラーム。次の仕事のアラームではない)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(h.alarms).toHaveLength(1);
    await h.core.runNextStep(); // fetch
    expect(h.alarms).toHaveLength(2);
    expect(h.alarms[1]).toBe(h.clock.now); // 計算ステップのためのアラーム(すぐ)
    await h.core.runNextStep(); // compute
    expect(h.alarms).toHaveLength(3);
    expect(h.alarms[2]).toBe(h.clock.now + CACHE_RETENTION_MS + PURGE_MARGIN_MS); // もう仕事は無いので、掃除専用のアラームだけ
  });

  it("複数のレースは直列に、1レースずつ(取得 → 計算)を終えてから次のレースへ進む", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    h.clock.now += 1; // 予約の順(A が先)。同じ時刻なら、レースID の昇順で決まる
    await h.core.schedule({ raceId: RACE_B, kaisaiDate: DATE });
    const outcomes = await runAll(h);
    expect(outcomes).toEqual([
      `${RACE_A}:fetch:ok`,
      `${RACE_A}:compute:ok`,
      `${RACE_B}:fetch:ok`,
      `${RACE_B}:compute:ok`,
    ]);
    expect(h.core.getBoard().races.map((r) => [r.raceId, r.status])).toEqual([
      [RACE_B, "done"],
      [RACE_A, "done"],
    ]);
  });

  it("DO が1つの開催日だけを扱う: 別の日の予約・raceId の年と開催日の年が違う予約・無効な raceId/日付は拒否し、何も取得せずアラームも設定しない", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    const alarmsBefore = h.alarms.length;
    await expect(h.core.schedule({ raceId: RACE_B, kaisaiDate: "20260629" })).rejects.toThrow(/開催日/);
    await expect(h.core.schedule({ raceId: "202503020211", kaisaiDate: DATE })).rejects.toThrow(/年/);
    await expect(h.core.schedule({ raceId: "abc", kaisaiDate: DATE })).rejects.toThrow();
    await expect(h.core.schedule({ raceId: RACE_B, kaisaiDate: "2026-06-28" })).rejects.toThrow();
    expect(h.alarms).toHaveLength(alarmsBefore);
    expect(h.gate.urls).toEqual([]);
    expect(h.core.getBoard().races).toHaveLength(1);
  });

  it("最初の予約より前に別の日付で作った DO は作られない: 日付が未確定のうちに無効な予約が来ても、日付を固定しない", async () => {
    const h = harness();
    await expect(h.core.schedule({ raceId: "abc", kaisaiDate: DATE })).rejects.toThrow();
    expect(h.core.getBoard().kaisaiDate).toBeNull();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: "20260628" });
    expect(h.core.getBoard().kaisaiDate).toBe("20260628");
  });
});

describe("入口の検証の最後の守り(Issue #180)", () => {
  it("地方のレースIDの月日が開催日と違う予約は、DO でも拒否する(入口の検証をすり抜けた RPC でも、netkeiba に撃たない)", async () => {
    const h = harness();
    await expect(h.core.schedule({ raceId: "202654071210", kaisaiDate: "20260713" })).rejects.toThrow(/月日/);
    expect(h.alarms).toEqual([]);
    expect(h.gate.urls).toEqual([]);
    expect(h.core.getBoard().kaisaiDate).toBeNull();
  });

  it("1日(1つの DO)に受け付けるレースの数に上限がある(中央 36・地方を含めても余裕のある値)。上限を超えた予約は拒否し、すでにあるレースの再予約は受け付ける", async () => {
    expect(MAX_TASKS_PER_DAY).toBeGreaterThanOrEqual(60);
    const h = harness();
    const ids: string[] = [];
    for (let venue = 1; venue <= 10 && ids.length < MAX_TASKS_PER_DAY + 1; venue++) {
      for (let race = 1; race <= 12 && ids.length < MAX_TASKS_PER_DAY + 1; race++) {
        ids.push(`2026${String(venue).padStart(2, "0")}0101${String(race).padStart(2, "0")}`);
      }
    }
    // 中央の ID は 10 場 × 12 = 120 通り(上限 + 1 以上ある)
    expect(ids.length).toBe(Math.min(MAX_TASKS_PER_DAY + 1, 120));
    if (MAX_TASKS_PER_DAY + 1 > 120) {
      throw new Error("テストの ID の生成が足りない(上限を下げるか、ID の生成を増やす)");
    }
    for (const id of ids.slice(0, MAX_TASKS_PER_DAY)) {
      expect((await h.core.schedule({ raceId: id, kaisaiDate: DATE })).accepted).toBe(true);
    }
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY);
    await expect(h.core.schedule({ raceId: ids[MAX_TASKS_PER_DAY]!, kaisaiDate: DATE })).rejects.toThrow(/上限/);
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY);
    // すでにあるレース(実行中)は、上限に達していても「受け付けない(accepted: false)」の通常の応答
    expect(await h.core.schedule({ raceId: ids[0]!, kaisaiDate: DATE })).toMatchObject({ accepted: false });
    // 完了済み(done)・失敗(failed)のレースの再予約は、上限に達していても受け付ける(新しいレースを増やさない)
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ?", ids[1]);
    expect(await h.core.schedule({ raceId: ids[1]!, kaisaiDate: DATE })).toMatchObject({ accepted: true, status: "queued" });
    expect(h.core.getBoard().races).toHaveLength(MAX_TASKS_PER_DAY);
  });
});

describe("失敗と再試行(Issue #177)", () => {
  it("取得の失敗(gate が拒否)はタスクを queued のまま再試行用のアラーム(遅れて)にし、試行回数が上限に達したら failed にして、アラームを止める", async () => {
    const gate = fakeGate();
    gate.failWhen = () => ({ kind: "refused", reason: "queue-full", message: "満杯" });
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    const first = await h.core.runNextStep();
    expect(first).toMatchObject({ step: "fetch", result: "retry" });
    expect(h.alarms[h.alarms.length - 1]! - h.clock.now).toBeGreaterThanOrEqual(30_000); // すぐには撃ち直さない
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "queued", attempts: 1 });
    await h.core.runNextStep();
    const third = await h.core.runNextStep();
    expect(third).toMatchObject({ step: "fetch", result: "failed" });
    const race = h.core.getBoard().races[0]!;
    expect(race).toMatchObject({ status: "failed", attempts: 3 });
    expect(race.error).toBeTruthy();
    // 仕事は無くなった: 掃除専用のアラームだけが残る(再試行のアラームは残らない)
    expect(h.alarm.at).toBe(h.clock.now + CACHE_RETENTION_MS + PURGE_MARGIN_MS);
    const purgeAlarm = h.alarm.at;
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" }); // 早く起きても何もしない
    expect(h.alarm.at).toBe(purgeAlarm);
  });

  it("ブレーカーが開いている(blocked)ときは、再試行せず直ちに failed(30 分のブレーカーの間に撃ち直さない)", async () => {
    const gate = fakeGate();
    gate.failWhen = () => ({ kind: "refused", reason: "blocked", message: "止めています", blockedUntil: Date.now() + 1_000_000, retryAfterMs: 1_000_000 });
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "failed" });
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("戦績の一部が取れなかった(scrapeRace は警告にして続ける)ときは、取得ステップを成功にせず再試行する。再試行では取れたぶんをキャッシュから読み、取れなかった馬だけを取り直す", async () => {
    const gate = fakeGate();
    let failures = 0;
    gate.failWhen = (url) => {
      if (url.includes("ajax_horse_results") && failures < 2) {
        failures += 1;
        return { kind: "refused", reason: "queue-full", message: "満杯" };
      }
      return null;
    };
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "retry" });
    expect(gate.urls).toHaveLength(19); // 2 頭ぶんは失敗したが、取得の呼び出しは19本
    const retried = await h.core.runNextStep();
    expect(retried).toMatchObject({ step: "fetch", result: "ok" });
    const second = gate.urls.slice(19);
    expect(second.filter((u) => u.includes("ajax_horse_results"))).toHaveLength(2); // 取れなかった2頭だけ
    expect(second.filter((u) => u.includes("shutuba.html"))).toHaveLength(0); // 出馬表は TTL 内でキャッシュ
    expect(second.filter((u) => u.includes("api_get_jra_odds"))).toHaveLength(0);
  });

  it("gate の失敗(例外)も同じく再試行・上限で failed になる(RPC の失敗など)", async () => {
    const gate = fakeGate();
    gate.fetchRaw = async () => {
      throw new Error("RPC の失敗");
    };
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "retry" });
    expect(h.core.getBoard().races[0]!.error).toContain("RPC の失敗");
  });
});

describe("朝の prior は DO にだけ置く(AC-b4)と、キャッシュの掃除", () => {
  it("race-day-core.ts・race-day-do.ts は D1・R2 に触れない(binding・ストア・リポジトリを参照しない)", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    for (const file of ["race-day-core.ts", "race-day-do.ts"]) {
      const source = readFileSync(path.join(dir, file), "utf-8");
      expect(source.length, file).toBeGreaterThan(1000); // 前提: 実際に読めている
      for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", "analysis-repository", "D1AnalysisStore", "prepare(", "bucket"]) {
        expect(source.includes(forbidden), `${file} に ${forbidden}`).toBe(false);
      }
    }
  });

  it("保存の dep は何も書かない: 朝の runAnalysis の saveAnalysis は D1 にもストレージの analyses 系にも行かず、朝の prior は morning_prior の1行だけ", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await runAll(h);
    const tables = (h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[]).map((t) => t.name).sort();
    expect(tables).toEqual(["fetch_cache", "race_day_meta", "race_day_tasks", "race_day_morning_prior"].sort());
    expect((h.sql.exec("SELECT COUNT(*) AS n FROM race_day_morning_prior").toArray() as { n: number }[])[0]!.n).toBe(1);
  });
});

describe("取得キャッシュの掃除はアラームで行う(レビュー指摘。Issue #177)", () => {
  const PURGE_AT = (h: Harness): number => h.clock.now + CACHE_RETENTION_MS + PURGE_MARGIN_MS;

  async function finishOneRace(h: Harness): Promise<void> {
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    await h.core.runNextStep();
  }

  const cacheRows = (h: Harness): number => (h.sql.exec("SELECT COUNT(*) AS n FROM fetch_cache").toArray() as { n: number }[])[0]!.n;

  it("最後のステップのあと、掃除専用のアラームを(保持期間 + 余裕)後に1回だけ設定する。その時点では、キャッシュの行はまだ消えない", async () => {
    const h = harness();
    await finishOneRace(h);
    expect(h.alarm.at).toBe(PURGE_AT(h));
    expect(h.alarms.filter((at) => at > h.clock.now)).toEqual([PURGE_AT(h)]); // 未来のアラームはこれだけ
    expect(cacheRows(h)).toBe(19);
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "done" });
  });

  it("その時刻にアラームで起きると、期限切れの行(最後のステップで入った行を含む)が消え、アラームは再設定されない", async () => {
    const h = harness();
    await finishOneRace(h);
    const due = h.alarm.at!;
    const alarmsBefore = h.alarms.length;
    h.clock.now = due;
    h.alarm.at = null;
    expect(await h.core.runNextStep()).toMatchObject({ kind: "idle", purged: 19 });
    expect(cacheRows(h)).toBe(0);
    expect(h.alarms).toHaveLength(alarmsBefore); // 再設定しない
    expect(h.alarm.at).toBeNull();
    // 鳴らされなければ、以後も何も起きない(もう一度呼んでも、アラームを足さない)
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" });
    expect(h.alarms).toHaveLength(alarmsBefore);
    // 朝の prior と状態は消えない(掃除の対象は取得キャッシュだけ)
    expect(h.core.getMorningPrior(RACE_A)).not.toBeNull();
  });

  it("保持期間より前に起きた場合は、何も消さず、同じ時刻に掃除のアラームを設定し直す(早く起きても掃除を取りこぼさない)", async () => {
    const h = harness();
    await finishOneRace(h);
    const due = h.alarm.at!;
    h.clock.now = due - 60_000; // 余裕の分だけ早い(行はまだ保持期間の内側か、ちょうど)
    h.alarm.at = null;
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" });
    expect(cacheRows(h)).toBe(19);
    expect(h.alarm.at).toBe(due);
    h.clock.now = due - 1;
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(cacheRows(h)).toBe(19);
    expect(h.alarm.at).toBe(due);
  });

  it("偽の時計で「アラームだけで進む」: 予約 → 取得 → 計算 → 26 時間後の掃除 までを、手動で回さずに到達し、最後はアラームが空になる", async () => {
    const h = harness();
    const start = h.clock.now;
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    const outcomes = await driveByAlarms(h);
    expect(outcomes).toEqual([`${RACE_A}:fetch:ok`, `${RACE_A}:compute:ok`, "idle"]);
    expect(h.clock.now).toBeGreaterThanOrEqual(start + CACHE_RETENTION_MS);
    expect(cacheRows(h)).toBe(0);
    expect(h.alarm.at).toBeNull();
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "done" });
  });

  it("掃除を待っている間に新しい予約が入ったら、通常のアラームを優先して処理し、掃除は最後にあらためて予約し直す(古い掃除の時刻では消さない)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await driveByAlarms(h, 2, { stopAtMax: true }); // 取得・計算まで(掃除のアラームを残す)
    const firstDue = h.alarm.at!;
    h.clock.now += 3600_000; // 1 時間後に、別のレースの予約
    await h.core.schedule({ raceId: RACE_B, kaisaiDate: DATE });
    expect(h.alarm.at).toBe(h.clock.now); // 通常のアラーム(すぐ)が掃除のアラームを上書きする
    await h.core.runNextStep();
    await h.core.runNextStep();
    const secondDue = h.alarm.at!;
    expect(secondDue).toBe(PURGE_AT(h));
    expect(secondDue).toBeGreaterThan(firstDue); // 掃除は後ろへ。B が入れた行が、古い時刻で消されない
    // 古い時刻(firstDue)に起きても、B の行は保持期間の内側にあるので消えず、掃除は新しい時刻のまま
    h.clock.now = firstDue;
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(cacheRows(h)).toBeGreaterThan(0);
    expect(h.alarm.at).toBe(secondDue);
    // 新しい時刻で、全部消える
    h.clock.now = secondDue;
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(cacheRows(h)).toBe(0);
    expect(h.alarm.at).toBeNull();
  });

  it("掃除の対象は保持期間を超えた行だけ: 古い行は消え、新しい行は残る(掃除のアラームでも)", async () => {
    const h = harness();
    await finishOneRace(h);
    h.sql.exec("INSERT INTO fetch_cache VALUES (?, ?, ?)", "old", "x", h.clock.now - 1);
    const due = h.alarm.at!;
    h.clock.now = due;
    // 掃除の時刻の直前に入った行(保持期間の内側)は残る
    h.sql.exec("INSERT INTO fetch_cache VALUES (?, ?, ?)", "recent", "y", due - 1000);
    h.alarm.at = null;
    await h.core.runNextStep();
    const keys = (h.sql.exec("SELECT key FROM fetch_cache").toArray() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(["recent"]);
  });

  it("失敗で終わった(failed)ときも、掃除のアラームを設定する(done のときだけではない)", async () => {
    const gate = fakeGate();
    gate.failWhen = () => ({ kind: "refused", reason: "blocked", message: "止めています" });
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "failed" });
    expect(h.alarm.at).toBe(PURGE_AT(h));
  });

  it("掃除に失敗したら警告だけ出し、投げない(アラームも再設定しない)", async () => {
    const h = harness();
    await finishOneRace(h);
    const due = h.alarm.at!;
    h.sql.exec("DROP TABLE fetch_cache");
    h.clock.now = due;
    h.alarm.at = null;
    await expect(h.core.runNextStep()).resolves.toMatchObject({ kind: "idle" });
    expect(h.warnings.some((w) => w.includes("掃除"))).toBe(true);
    expect(h.alarm.at).toBeNull();
  });
});

describe("取得の前に試行回数を永続化する(レビュー指摘。Issue #177)", () => {
  it("gate を呼んでいる最中(取得の途中)に、すでに attempts = 1 が書かれている(クラッシュしても再実行が無限に続かない)", async () => {
    const gate = fakeGate();
    const h = harness({}, gate);
    const seen: number[] = [];
    const original = gate.fetchRaw.bind(gate);
    gate.fetchRaw = async (url) => {
      seen.push((h.sql.exec("SELECT attempts FROM race_day_tasks WHERE race_id = ?", RACE_A).toArray() as { attempts: number }[])[0]!.attempts);
      return original(url);
    };
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    await h.core.runNextStep();
    expect(seen).toHaveLength(19);
    expect(new Set(seen)).toEqual(new Set([1])); // 全部の取得で、書かれていた試行回数は 1
  });

  it("途中でクラッシュ(gate が最初の呼び出しで投げ続けて回復しない)を繰り返しても、試行は上限(3)で止まる", async () => {
    const gate = fakeGate();
    gate.fetchRaw = async () => {
      throw new Error("クラッシュの模擬");
    };
    const h = harness({}, gate);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: DATE });
    const outcomes = await driveByAlarms(h);
    expect(outcomes.filter((o) => o.endsWith(":fetch:retry") || o.endsWith(":fetch:failed"))).toHaveLength(3);
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "failed", attempts: 3 });
  });
});

describe("GateRefusedError の包み(HttpError の cause)", () => {
  it("前提: gate の拒否は、core の HttpClient では HttpError(cause: GateRefusedError)になる(RaceDay がその reason を読む)", async () => {
    const { createGateHttpClient } = await import("../src/gate-fetch");
    const gate = fakeGate();
    gate.failWhen = () => ({ kind: "refused", reason: "blocked", message: "止めています" });
    const client = createGateHttpClient(gate, { onWarn: () => {} });
    const error = await client.fetchText("https://race.netkeiba.com/race/shutuba.html?race_id=202603020211").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).cause).toBeInstanceOf(GateRefusedError);
    expect(((error as HttpError).cause as GateRefusedError).reason).toBe("blocked");
  });
});
