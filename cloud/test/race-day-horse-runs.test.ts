import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba";
import { excludeNonStartResults, parseHorseResults } from "../../packages/core/src/scraper/parse-horse-results";
import { horseRunKey } from "../../packages/core/src/scraper/horse-run-record";
import { horseResultsApiUrl } from "../../packages/core/src/scraper/urls";
import { D1HorseRunsStore } from "../src/horse-runs-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import type { GateResult } from "../../cloud/src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { planHorseRunsSave, summarizeSave, type HorseRunsStore, type PlanInput, type SaveStats } from "../src/horse-runs";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #256 段階A: 事前分析(morning)の計算ステップの末尾で、各馬の戦績を D1 に貯める(`horseRunsStore`)。
 * AC: h1 計算ステップで1回・出走馬全頭の戦績(除外・取消の行を除いた後のもの)を渡す / h2 prior の保存・タスクの完了より後に呼ぶ /
 * h3 保存が失敗しても分析は止まらない(ok のまま。警告に鍵の形を伏せて残す) / h4 netkeiba への取得を増やさない(取得ステップは保存しない) /
 * h5 発走前の分析(pre_race)は保存しない / h6 保存先なしの構成は従来どおり / h7 計算が失敗したら保存しない。
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

interface FakeStore extends HorseRunsStore {
  readonly calls: PlanInput[];
  /** saveRace の呼び出しの瞬間に呼ぶ(順序の検査用)。 */
  onCall: (input: PlanInput) => void;
  /** 投げる例外(null なら成功)。 */
  failWith: Error | null;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    onCall: () => undefined,
    failWith: null,
    async saveRace(input): Promise<SaveStats> {
      store.calls.push(input);
      store.onCall(input);
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

describe("h1: 計算ステップの末尾で、出走馬全頭の戦績を保存先に渡す", () => {
  it("1回だけ呼ばれ、レース・開催日・時刻と、出馬表の16頭すべての馬 ID と戦績(1走以上)を渡す", async () => {
    const store = fakeStore();
    const h = harness({ horseRunsStore: store });
    await morningFetch(h);
    expect(store.calls).toHaveLength(0); // h4: 取得ステップでは保存しない
    h.clock.now += 60_000;
    await morningCompute(h);
    expect(store.calls).toHaveLength(1);
    const call = store.calls[0]!;
    expect(call).toMatchObject({ raceId: RACE, kaisaiDate: DATE, savedAt: h.clock.now });
    expect(call.horses).toHaveLength(16); // 前提: 空振りでない
    expect(call.horses.map((x) => x.horseId).sort()).toEqual(SHUTUBA.horses.map((x) => x.horseId).sort());
    expect(call.horses.every((x) => x.results.length > 0 && x.horseId.length === 10)).toBe(true);
  });
});

describe("h2・h3: prior の保存・完了より後に呼ぶ。保存が失敗しても分析は止まらない", () => {
  it("呼ばれた時点で朝の prior は保存済み・タスクは done。保存が失敗(鍵の形を含む文面)しても計算は ok のままで、警告に鍵の形を残さない", async () => {
    const store = fakeStore();
    let priorAtCall = false;
    let statusAtCall: string | undefined;
    const h = harness({ horseRunsStore: store });
    store.onCall = () => {
      priorAtCall = h.core.getMorningPrior(RACE) !== null;
      statusAtCall = taskStatus(h, "morning");
    };
    store.failWith = new Error("D1 の失敗 sk-ant-api03-ABCDEFGHIJKLMNOP");
    await morningFetch(h);
    await morningCompute(h); // ok のまま
    expect(priorAtCall).toBe(true);
    expect(statusAtCall).toBe("done");
    expect(taskStatus(h, "morning")).toBe("done");
    expect(h.core.getMorningPrior(RACE)).not.toBeNull();
    const warned = h.warnings.filter((w) => w.includes("戦績"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(RACE);
    expect(warned.join("\n")).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("保存が失敗しても再試行しない(試行回数・状態は変わらず、保存先は1回しか呼ばれない)", async () => {
    const store = fakeStore();
    store.failWith = new Error("D1 の失敗");
    const h = harness({ horseRunsStore: store });
    await morningFetch(h);
    await morningCompute(h);
    expect(await h.core.runNextStep()).toMatchObject({ kind: "idle" });
    expect(store.calls).toHaveLength(1);
  });
});

describe("h4: netkeiba への取得を増やさない", () => {
  it("保存先の有無で、事前分析の全ステップの取得(ゲートへの URL の列)が完全に同じ", async () => {
    const without = harness();
    await morningFetch(without);
    await morningCompute(without);
    const withStore = harness({ horseRunsStore: fakeStore() });
    await morningFetch(withStore);
    await morningCompute(withStore);
    expect(withStore.gate.urls.length).toBeGreaterThan(19); // 前提: 取得が実際に行われている(出馬表・戦績・調教・オッズ + 騎手)
    expect(withStore.gate.urls).toStrictEqual(without.gate.urls);
  });
});

describe("h5・h6・h7: 発走前は保存しない / 保存先なしは従来どおり / 計算が失敗したら保存しない", () => {
  it("h5: 発走前の分析(pre_race)は、取得も計算も保存先を呼ばない", async () => {
    const store = fakeStore();
    const h = harness({ horseRunsStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    expect(h.sink.saved).toHaveLength(1); // 前提: 発走前の分析が実際に保存まで行った
    expect(store.calls).toHaveLength(0);
  });

  it("h6: 保存先なしの構成(horseRunsStore を渡さない)は、警告なしで従来どおり完了する", async () => {
    const h = harness();
    await morningFetch(h);
    await morningCompute(h);
    expect(h.core.getMorningPrior(RACE)).not.toBeNull();
    expect(h.warnings.filter((w) => w.includes("戦績"))).toEqual([]);
  });

  it("h7: キャッシュに戦績が無く計算が失敗したときは、保存先を呼ばない", async () => {
    const store = fakeStore();
    const h = harness({ horseRunsStore: store });
    await morningFetch(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%horse_results%' OR key LIKE '%ajax_horse_results%'");
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "failed" });
    expect(store.calls).toHaveLength(0);
  });
});

describe("h8: 実 D1(ローカルの workerd)との結線: 事前分析 → 計算ステップ → horse_runs・horse_run_saves", () => {
  let local: LocalBindings;
  beforeAll(async () => {
    local = await openLocalBindings();
  }, 180_000);
  afterAll(async () => {
    await local?.dispose();
  });

  /** 期待値は、フィクスチャの戦績を別の経路(パーサを直接)で読んで数える。馬 ID ごとの鍵の集合。 */
  function expectedKeys(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const horse of SHUTUBA.horses) {
      const text = fixtureForUrl(horseResultsApiUrl(horse.horseId));
      expect(text, `馬 ${horse.horseId} の戦績フィクスチャ`).not.toBeNull();
      const keys = new Set<string>();
      for (const run of excludeNonStartResults(parseHorseResults(text!))) {
        const key = horseRunKey(run);
        if (key !== null) keys.add(key);
      }
      out.set(horse.horseId, keys);
    }
    return out;
  }

  it("16頭の戦績が、鍵(馬 ID × 行の鍵)の集合としてフィクスチャの内容と一致して入る。集計の行も1行。同じ事前分析を再実行しても、行は増えず書き込みは 0", async () => {
    await local.reset();
    const h = harness({ horseRunsStore: new D1HorseRunsStore({ db: local.db }) });
    await morningFetch(h);
    await morningCompute(h);
    const expected = expectedKeys();
    const total = [...expected.values()].reduce((n, s) => n + s.size, 0);
    expect(total).toBeGreaterThan(16); // 前提: 空振りでない(16頭に複数の走がある)
    const stored = (await local.db.prepare("SELECT horse_id, race_key FROM horse_runs").all()).results as Array<{ horse_id: string; race_key: string }>;
    expect(stored).toHaveLength(total);
    const actual = new Map<string, Set<string>>();
    for (const row of stored) {
      const set = actual.get(row.horse_id) ?? new Set<string>();
      set.add(row.race_key);
      actual.set(row.horse_id, set);
    }
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [horseId, keys] of expected) {
      expect([...actual.get(horseId)!].sort(), horseId).toEqual([...keys].sort());
    }
    const saves = (await local.db.prepare("SELECT race_id, stats_json FROM horse_run_saves").all()).results as Array<{ race_id: string; stats_json: string }>;
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]!.stats_json)).toMatchObject({ horses: 16, horsesFirstSeen: 16, rowsNew: total, rowsWrittenRuns: total });

    // 再実行(同じ事前分析をもう一度。キャッシュは残っているので取得は増えない)
    const urlsBefore = h.gate.urls.length;
    h.clock.now += 60_000;
    await morningFetch(h);
    await morningCompute(h);
    expect(h.gate.urls.length).toBe(urlsBefore); // 取得は増えない
    expect(await local.db.prepare("SELECT COUNT(*) AS n FROM horse_runs").first<{ n: number }>()).toEqual({ n: total });
    const second = (await local.db.prepare("SELECT stats_json FROM horse_run_saves ORDER BY saved_at DESC LIMIT 1").first<{ stats_json: string }>())!;
    expect(JSON.parse(second.stats_json)).toMatchObject({ rowsNew: 0, rowsDupSameDay: total, rowsWrittenRuns: 0, horsesZeroNew: 16 });
  });
});
