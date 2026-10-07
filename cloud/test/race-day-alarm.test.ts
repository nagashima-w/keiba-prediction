import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { CACHE_RETENTION_MS, PURGE_MARGIN_MS, RETRY_DELAY_MS, RaceDayCore, nextAlarmAt, type AlarmInputs, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #203 段階1(B1。親 #166): アラームの合成(`nextAlarmAt` と、`setAlarm` を呼ぶ唯一の口 `rearm`)と、`pickNext` での発走前(pre_race)の優先。
 * **計画の表はまだ無い**(B2)。この段階の核は、予約が無いときの振る舞いが今と変わらないこと(既存の race-day-*.test.ts が**無改変で緑**)。
 * ここでは、新しい純関数の境界値と、`pickNext` の並びを固定する。ゲート・保存先は偽、ストレージは `node:sqlite`(本物の SQLite)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = Date.parse("2026-06-28T00:00:00Z");
const DATE = "20260628";
const RACE_A = "202603020211";
const RACE_B = "202603020210";
const RACE_C = "202603020209";

const base: AlarmInputs = {
  nowMs: NOW,
  retryDelayMs: RETRY_DELAY_MS,
  immediateWork: false,
  retryWork: false,
  planNextTryAtMs: null,
  planNextDueMs: null,
  purgeDueMs: null,
};

describe("nextAlarmAt(アラームの合成: 今すぐの仕事・再試行待ち・計画・掃除のうち、最も早い時刻)", () => {
  const HOUR = 3600_000;

  it("候補が1つも無ければ null(アラームを設定しない。今の『仕事が無く、掃除の予約も無い』と同じ)", () => {
    expect(nextAlarmAt(base)).toBeNull();
  });

  it("初回の取得・計算の仕事がある → now", () => {
    expect(nextAlarmAt({ ...base, immediateWork: true })).toBe(NOW);
  });

  it("再試行待ちだけ → now + 再試行の間隔(すぐには撃ち直さない)", () => {
    expect(nextAlarmAt({ ...base, retryWork: true })).toBe(NOW + RETRY_DELAY_MS);
    expect(RETRY_DELAY_MS).toBeGreaterThan(0); // 前提: 間隔が 0 でない(0 だと上の値が now と区別できない)
  });

  it("即時の仕事と再試行待ちが両方あれば now(即時が勝つ)", () => {
    expect(nextAlarmAt({ ...base, immediateWork: true, retryWork: true })).toBe(NOW);
  });

  it.each([
    ["計画の次の期限(未来)", { planNextDueMs: NOW + 5 * HOUR }, NOW + 5 * HOUR],
    ["計画の次の期限(過去)は now(過去の時刻を返さない)", { planNextDueMs: NOW - HOUR }, NOW],
    ["計画の次の試行時刻(未来)", { planNextTryAtMs: NOW + 60_000 }, NOW + 60_000],
    ["計画の次の試行時刻(過去)は now", { planNextTryAtMs: NOW - 1 }, NOW],
    ["掃除の期限(未来。仕事が無いとき)", { purgeDueMs: NOW + 26 * HOUR }, NOW + 26 * HOUR],
    ["掃除の期限(過去。仕事が無いとき)は now(起きて掃除する)", { purgeDueMs: NOW - HOUR }, NOW],
  ] as const)("単独の候補: %s", (_name, patch, expected) => {
    expect(nextAlarmAt({ ...base, ...patch })).toBe(expected);
  });

  it("複数の候補は最も早いものを選ぶ(max ではない): 計画の期限が掃除より早ければ計画、遅ければ掃除", () => {
    const planDue = NOW + 7 * HOUR;
    const purgeDue = NOW + 26 * HOUR;
    expect(nextAlarmAt({ ...base, planNextDueMs: planDue, purgeDueMs: purgeDue })).toBe(planDue);
    expect(nextAlarmAt({ ...base, planNextDueMs: NOW + 30 * HOUR, purgeDueMs: purgeDue })).toBe(purgeDue);
    // 前提: 2つの候補は別の値(同じ値だと、min と max を区別できない)
    expect(planDue).not.toBe(purgeDue);
  });

  it("未来の計画の期限があっても、即時の仕事があれば now。再試行待ちだけなら、計画の期限が再試行より早い場合は計画の期限", () => {
    expect(nextAlarmAt({ ...base, immediateWork: true, planNextDueMs: NOW + HOUR })).toBe(NOW);
    expect(nextAlarmAt({ ...base, retryWork: true, planNextDueMs: NOW + HOUR })).toBe(NOW + RETRY_DELAY_MS);
    expect(nextAlarmAt({ ...base, retryWork: true, planNextDueMs: NOW + 10_000 })).toBe(NOW + 10_000);
  });

  it("仕事(即時・再試行待ち)があるあいだ、掃除の期限は候補にしない(古い掃除の期限が、再試行の間隔を無効にして即時に起こさない)。計画の期限は、仕事の有無によらず候補", () => {
    const stalePurge = NOW - HOUR;
    expect(nextAlarmAt({ ...base, retryWork: true, purgeDueMs: stalePurge })).toBe(NOW + RETRY_DELAY_MS);
    expect(nextAlarmAt({ ...base, immediateWork: true, purgeDueMs: NOW + 1000 })).toBe(NOW);
    // 仕事のあるあいだの掃除は、再試行より早い期限でも選ばれない
    expect(nextAlarmAt({ ...base, retryWork: true, purgeDueMs: NOW + 1000 })).toBe(NOW + RETRY_DELAY_MS);
    // 対照: 仕事が無ければ、同じ掃除の期限が選ばれる
    expect(nextAlarmAt({ ...base, purgeDueMs: NOW + 1000 })).toBe(NOW + 1000);
    // 計画の期限は、仕事があっても候補(再試行待ちより早ければ選ばれる。上の表と同じ)
    expect(nextAlarmAt({ ...base, retryWork: true, planNextTryAtMs: NOW + 5000 })).toBe(NOW + 5000);
  });
});

describe("setAlarm を呼ぶのは rearm の1箇所だけ(アラームの上書きを、合成の1か所に集める)", () => {
  /** コメントを除いたコード。 */
  const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const countCalls = (code: string): number => (code.match(/this\.setAlarm\(/g) ?? []).length;

  it("race-day-core.ts の `this.setAlarm(` の呼び出しは1つだけで、rearm の中にある", () => {
    const source = readFileSync(path.join(ROOT, "cloud", "src", "race-day-core.ts"), "utf-8");
    const code = codeOf(source);
    expect(code.length).toBeGreaterThan(5000); // 前提: コメント除去で本文を消していない
    expect(code).toContain("rearm");
    expect(countCalls(code)).toBe(1);
    // その1つは rearm の本体の中(メソッド rearm の開始から次のメソッドの前まで)にある
    const start = code.indexOf("private async rearm(");
    expect(start).toBeGreaterThan(-1);
    expect(code.indexOf("this.setAlarm(")).toBeGreaterThan(start);
    // 対照(空振りでない): 呼び出しを1つ足した本文では、数が変わる
    expect(countCalls(code + "\nthis.setAlarm(1);")).toBe(2);
  });
});

// ---- pickNext の並び(pre_race の優先)----

interface FakeGate extends GateLike {
  failAll: boolean;
}

function bytes(text: string): ArrayBuffer {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    failAll: false,
    async fetchRaw(url): Promise<GateResult> {
      await Promise.resolve();
      if (gate.failAll) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(fixtureForUrl(url)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

/** 発走前の予約を受け付けるための偽の保存先(このテストは、保存まで進めない。呼ばれたら投げる)。 */
const unusedSink: AnalysisSink = {
  save: async () => {
    throw new Error("保存先は使わない");
  },
  findByAnalyzedAt: async () => {
    throw new Error("保存先は使わない");
  },
  findRecentByRace: async () => {
    throw new Error("保存先は使わない");
  },
  countChildren: async () => {
    throw new Error("保存先は使わない");
  },
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: NOW };
  const alarm: { at: number | null } = { at: null };
  const gate = fakeGate();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: () => undefined,
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...overrides,
  });
  return { core, sql, gate, clock, alarm };
}

/** 1ステップ進めて、その結果を「raceId:mode:step:result」にする。 */
async function step(h: Harness): Promise<string> {
  const outcome = await h.core.runNextStep();
  return outcome.kind === "idle" ? "idle" : `${outcome.raceId}:${outcome.mode}:${outcome.step}:${outcome.result}`;
}

/** 1秒ずつ進めながら予約する(queued_at の順序を決める)。 */
async function schedule(h: Harness, raceId: string, mode: "morning" | "pre_race"): Promise<void> {
  h.clock.now += 1000;
  await h.core.schedule({ raceId, kaisaiDate: DATE, mode });
}

describe("pickNext: 発走前(pre_race)を朝(morning)より先に処理する", () => {
  it("朝の取得待ちが2件(先に予約)あっても、後から予約した発走前の取得が先に走る。そのあと朝が予約順に続く", async () => {
    const h = harness();
    await schedule(h, RACE_A, "morning");
    await schedule(h, RACE_B, "morning");
    await schedule(h, RACE_C, "pre_race");
    expect(await step(h)).toBe(`${RACE_C}:pre_race:fetch:ok`);
    // 発走前の計算待ち(fetched)も、朝の取得待ちより先(今までの『計算待ちが先』の規則のまま)
    expect((await step(h)).startsWith(`${RACE_C}:pre_race:compute`)).toBe(true);
    // 発走前が済んだら(計算の再試行の仕方は、この試験の主題ではないので、完了にしてしまう)、朝は予約順
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'pre_race'");
    expect(await step(h)).toBe(`${RACE_A}:morning:fetch:ok`);
  });

  it("計算待ち(fetched)が両方あるとき、発走前の計算が朝の計算より先(朝のほうが先に予約・先に取得済みでも)", async () => {
    const h = harness();
    await schedule(h, RACE_A, "morning"); // queued_at が早い
    await schedule(h, RACE_C, "pre_race");
    // 両方を取得済み(fetched)にする(取得そのものは、このテストの主題ではない)
    h.sql.exec("UPDATE race_day_tasks SET status = 'fetched'");
    const rows = h.sql.exec("SELECT race_id, mode, status, compute_attempts FROM race_day_tasks ORDER BY queued_at").toArray() as { race_id: string; mode: string; status: string; compute_attempts: number }[];
    // 前提: 2件とも fetched・計算の試行 0 回で、朝のほうが先に予約されている(並びの差が、モードだけで決まる)
    expect(rows).toEqual([
      { race_id: RACE_A, mode: "morning", status: "fetched", compute_attempts: 0 },
      { race_id: RACE_C, mode: "pre_race", status: "fetched", compute_attempts: 0 },
    ]);
    expect((await step(h)).startsWith(`${RACE_C}:pre_race:compute`)).toBe(true);
  });

  it("再試行待ち(試行済み)の発走前は、新しい朝より後ろ(再試行の間隔を、モードの優先が無効にしない)。朝が済めば、再試行が走る", async () => {
    const h = harness();
    await schedule(h, RACE_C, "pre_race");
    h.gate.failAll = true;
    expect(await step(h)).toBe(`${RACE_C}:pre_race:fetch:retry`); // 試行1回目の失敗
    expect(h.alarm.at).toBe(h.clock.now + RETRY_DELAY_MS); // 再試行は間隔を空ける
    h.gate.failAll = false;
    await schedule(h, RACE_A, "morning"); // 新しい朝(試行0回)
    const row = h.sql.exec("SELECT attempts FROM race_day_tasks WHERE race_id = ? AND mode = 'pre_race'", RACE_C).toArray() as { attempts: number }[];
    expect(row[0]!.attempts).toBe(1); // 前提: 発走前は再試行待ち(attempts > 0)
    expect(await step(h)).toBe(`${RACE_A}:morning:fetch:ok`); // 新しい朝が先
    expect(await step(h)).toBe(`${RACE_A}:morning:compute:ok`); // 朝の計算待ち(今までの規則: 計算待ちが先)
    expect(await step(h)).toBe(`${RACE_C}:pre_race:fetch:ok`); // 朝が済んで、発走前の再試行
  });

  it("同じモードどうしの並びは今のまま(取得待ちは試行回数の少ない順 → 予約の古い順 → レースID 順)", async () => {
    const h = harness();
    await schedule(h, RACE_B, "morning");
    await schedule(h, RACE_A, "morning");
    expect(await step(h)).toBe(`${RACE_B}:morning:fetch:ok`); // 予約が古いほうが先(レースID 順ではない)
  });
});

describe("rearm: 古い掃除の期限があっても、仕事のあいだは再試行の間隔を守る", () => {
  it("掃除の期限を過ぎたあとで新しい予約が入り、その取得が失敗しても、次のアラームは now + 再試行の間隔(now ではない)", async () => {
    const h = harness();
    await schedule(h, RACE_A, "morning");
    await step(h); // 取得
    await step(h); // 計算 → 仕事が無くなり、掃除の期限が入る
    const purgeDue = h.alarm.at!;
    expect(purgeDue).toBe(h.clock.now + CACHE_RETENTION_MS + PURGE_MARGIN_MS); // 前提: 掃除の期限が入っている
    h.clock.now = purgeDue + 3600_000; // 掃除の期限を1時間過ぎている(古い期限)
    h.gate.failAll = true;
    await schedule(h, RACE_B, "morning");
    expect(await step(h)).toBe(`${RACE_B}:morning:fetch:retry`);
    expect(h.alarm.at).toBe(h.clock.now + RETRY_DELAY_MS);
  });
});
