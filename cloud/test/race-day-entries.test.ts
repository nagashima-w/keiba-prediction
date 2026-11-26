import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba";
import type { GateResult } from "../../cloud/src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { planHorseRunsSave, summarizeSave, type HorseRunsStore, type SaveStats } from "../src/horse-runs";
import type { RaceEntriesRecord, RaceEntriesStore } from "../src/race-entries";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #799: 事前分析(morning)の計算ステップの末尾で、読んだ出馬表を D1 に保存する(`raceEntriesStore`)。
 * AC: e1 計算ステップで 1 回・出馬表の全頭(16 頭)を渡す / e2 prior の保存・タスクの完了より後に呼ぶ(戦績の保存より後) /
 * e3 保存が失敗しても分析は止まらない(done のまま。警告に鍵の形を伏せて残す。再試行しない。戦績の保存の失敗とも独立) /
 * e4 netkeiba への取得を増やさない(取得ステップ・発走前の分析は保存しない) / e5 保存先なしの構成は従来どおり / e6 計算が失敗したら保存しない。
 * ゲート・保存先は偽。ストレージは `node:sqlite`。
 */

const DATE = "20260628";
const RACE = "202603020211";
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
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = fixtureForUrl(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

function fakeSink(): AnalysisSink & { readonly saved: AnalysisRecord[] } {
  const sink = {
    saved: [] as AnalysisRecord[],
    async save(record: AnalysisRecord) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" as const };
    },
    async findByAnalyzedAt(raceId: string, analyzedAt: string) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id: number) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface FakeEntries extends RaceEntriesStore {
  readonly calls: RaceEntriesRecord[];
  /** save の呼び出しの瞬間に呼ぶ(順序の検査用)。 */
  onCall: () => void;
  /** 投げる例外(null なら成功)。 */
  failWith: Error | null;
}

function fakeEntries(): FakeEntries {
  const store: FakeEntries = {
    calls: [],
    onCall: () => undefined,
    failWith: null,
    async save(record) {
      store.calls.push(record);
      store.onCall();
      await Promise.resolve();
      if (store.failWith !== null) {
        throw store.failWith;
      }
    },
  };
  return store;
}

/** 戦績の保存先の偽(呼ばれた順序と、失敗の注入だけ)。 */
function fakeHorseRuns(): HorseRunsStore & { calls: number; failWith: Error | null; onCall: () => void } {
  const store = {
    calls: 0,
    failWith: null as Error | null,
    onCall: () => undefined,
    async saveRace(input: Parameters<HorseRunsStore["saveRace"]>[0]): Promise<SaveStats> {
      store.calls += 1;
      store.onCall();
      await Promise.resolve();
      if (store.failWith !== null) {
        throw store.failWith;
      }
      return summarizeSave(planHorseRunsSave(input, []), new Set(), 0);
    },
  };
  return store;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: ReturnType<typeof fakeSink>;
  readonly clock: { now: number };
  readonly warnings: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-27T12:00:00Z") }; // 前日の JST 21:00(事前分析の時刻)
  const warnings: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink,
    // 調教師の成績は取らない(取得の本数を固定する。再実行で取得が増えないことの検査が、冷えた状態の上限〈40 本〉に左右されないように。Issue #354)
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightTrainer: 0 }),
    ...overrides,
  });
  return { core, sql, gate, sink, clock, warnings };
}

const SHUTUBA = parseShutuba(loadFixture("shutuba_202603020211.html"));
const taskStatus = (h: Harness, mode: string): string | undefined =>
  (h.sql.exec("SELECT status FROM race_day_tasks WHERE race_id = ? AND mode = ?", RACE, mode).toArray() as { status: string }[])[0]?.status;

async function morningFetch(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
}
async function morningCompute(h: Harness): Promise<void> {
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
}


describe("e1: 計算ステップの末尾で、出馬表の全頭を保存先に渡す", () => {
  it("1回だけ呼ばれ、レース・開催日・競馬場コード・コース・距離・発走時刻と、出馬表の 16 頭すべての行(馬 ID・馬番・枠・騎手 ID・調教師 ID・斤量・性齢)を渡す", async () => {
    const store = fakeEntries();
    const h = harness({ raceEntriesStore: store });
    await morningFetch(h);
    expect(store.calls).toHaveLength(0); // e4: 取得ステップでは保存しない
    h.clock.now += 60_000;
    await morningCompute(h);
    expect(store.calls).toHaveLength(1);
    const rec = store.calls[0]!;
    expect(rec.race).toMatchObject({
      raceId: RACE,
      kaisaiDate: DATE,
      venueCode: "03",
      courseType: SHUTUBA.race.courseType,
      distance: SHUTUBA.race.distance,
      savedAt: h.clock.now,
    });
    expect(SHUTUBA.race.startTime, "前提: フィクスチャに発走時刻がある").toBeDefined();
    expect(rec.race.startTime).toBe(SHUTUBA.race.startTime!.padStart(5, "0"));
    expect(rec.horses).toHaveLength(16); // 前提: 空振りでない
    // 期待値は、フィクスチャを別の経路(パーサを直接)で読んだ値。
    for (const expected of SHUTUBA.horses) {
      const got = rec.horses.find((x) => x.umaban === expected.umaban)!;
      expect(got, `馬番 ${expected.umaban}`).toEqual({
        umaban: expected.umaban,
        waku: expected.wakuban,
        horseId: expected.horseId,
        jockeyId: expected.jockeyId,
        trainerId: expected.trainerId,
        kinryo: expected.kinryo,
        sex: expected.sex,
        age: expected.age,
        scratch: null,
      });
    }
    expect(rec.horses.some((x) => x.jockeyId !== null && x.trainerId !== null && x.jockeyId !== x.trainerId)).toBe(true); // 前提: 取り違えを検出できる
  });
});

describe("e2・e3: prior の保存・完了より後に呼ぶ(戦績の保存より後)。保存が失敗しても分析は止まらない", () => {
  it("呼ばれた時点で朝の prior は保存済み・タスクは done・戦績の保存は済み。失敗(鍵の形を含む文面)しても計算は ok のままで、警告に鍵の形を残さない", async () => {
    const store = fakeEntries();
    const runs = fakeHorseRuns();
    const h = harness({ raceEntriesStore: store, horseRunsStore: runs });
    let priorAtCall = false;
    let statusAtCall: string | undefined;
    let runsAtCall = 0;
    store.onCall = () => {
      priorAtCall = h.core.getMorningPrior(RACE) !== null;
      statusAtCall = taskStatus(h, "morning");
      runsAtCall = runs.calls;
    };
    store.failWith = new Error("D1 の失敗 sk-ant-api03-ABCDEFGHIJKLMNOP");
    await morningFetch(h);
    await morningCompute(h); // ok のまま
    expect(priorAtCall).toBe(true);
    expect(statusAtCall).toBe("done");
    expect(runsAtCall).toBe(1);
    expect(taskStatus(h, "morning")).toBe("done");
    const warned = h.warnings.filter((w) => w.includes("出馬表"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(RACE);
    expect(warned.join("\n")).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("保存が失敗しても再試行しない(状態は変わらず、保存先は 1 回しか呼ばれない)", async () => {
    const store = fakeEntries();
    store.failWith = new Error("D1 の失敗");
    const h = harness({ raceEntriesStore: store });
    await morningFetch(h);
    await morningCompute(h);
    expect(await h.core.runNextStep()).toMatchObject({ kind: "idle" });
    expect(store.calls).toHaveLength(1);
  });

  it("戦績の保存が失敗しても、出馬表の保存は呼ばれる(別の try/catch)。逆も同じ", async () => {
    const store = fakeEntries();
    const runs = fakeHorseRuns();
    runs.failWith = new Error("戦績の失敗");
    const h = harness({ raceEntriesStore: store, horseRunsStore: runs });
    await morningFetch(h);
    await morningCompute(h);
    expect(runs.calls).toBe(1);
    expect(store.calls).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("戦績"))).toHaveLength(1);
    // 逆: 出馬表の保存が失敗しても、戦績の保存は済んでいる(上のテストで順序を固定している)。
    const store2 = fakeEntries();
    store2.failWith = new Error("出馬表の失敗");
    const runs2 = fakeHorseRuns();
    const h2 = harness({ raceEntriesStore: store2, horseRunsStore: runs2 });
    await morningFetch(h2);
    await morningCompute(h2);
    expect(runs2.calls).toBe(1);
    expect(h2.warnings.filter((w) => w.includes("戦績"))).toEqual([]);
  });
});

describe("e4: netkeiba への取得を増やさない", () => {
  it("保存先の有無で、事前分析の全ステップの取得(ゲートへの URL の列)が完全に同じ", async () => {
    const without = harness();
    await morningFetch(without);
    await morningCompute(without);
    const withStore = harness({ raceEntriesStore: fakeEntries() });
    await morningFetch(withStore);
    await morningCompute(withStore);
    expect(withStore.gate.urls.length).toBeGreaterThan(19); // 前提: 取得が実際に行われている
    expect(withStore.gate.urls).toStrictEqual(without.gate.urls);
  });
});

describe("e4-2・e5・e6: 発走前は保存しない / 保存先なしは従来どおり / 計算が失敗したら保存しない", () => {
  it("発走前の分析(pre_race)は、取得も計算も保存先を呼ばない", async () => {
    const store = fakeEntries();
    const h = harness({ raceEntriesStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    expect(h.sink.saved).toHaveLength(1); // 前提: 発走前の分析が実際に保存まで行った
    expect(store.calls).toHaveLength(0);
  });

  it("e5: 保存先なしの構成は、警告なしで従来どおり完了する", async () => {
    const h = harness();
    await morningFetch(h);
    await morningCompute(h);
    expect(h.core.getMorningPrior(RACE)).not.toBeNull();
    expect(h.warnings.filter((w) => w.includes("出馬表"))).toEqual([]);
  });

  it("e6: キャッシュに戦績が無く計算が失敗したときは、保存先を呼ばない", async () => {
    const store = fakeEntries();
    const h = harness({ raceEntriesStore: store });
    await morningFetch(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%horse_results%' OR key LIKE '%ajax_horse_results%'");
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "failed" });
    expect(store.calls).toHaveLength(0);
  });
});
