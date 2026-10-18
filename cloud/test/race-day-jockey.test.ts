import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { RaceIdVenueKind } from "../../packages/core/src/scraper/ids";
import type { JockeyResultsSaveEntry, JockeyResultsStore, StoredJockeyResults } from "../../packages/core/src/scraper/jockey-results-store";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #226: 騎手の年度別成績(全体の複勝率)を prior に入れる。
 * AC: j1 事前分析の取得ステップが、出走馬の騎手ごとに年度別成績を1本ずつ取得する(既存の19本の後ろ) / j2 騎手の重みが 0 のときは取得しない /
 * j3 計算ステップは netkeiba に出ず、取得済みのキャッシュから騎手の成績を使う / j4 発走前の取得は事前分析のキャッシュを使い回す(騎手を取り直さない) /
 * j5 発走前の分析の保存に『騎手成績』の寄与度が適用で載る(ライブ: 前年+当年・中央の中立) / j6 取得時の設定のスナップショットに従う /
 * j7 騎手の成績の取得に失敗してもレースの取得・計算は失敗せず、その騎手は補正なし。
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
  /** URL → 本文(null なら 404)。既定は 202603020211 のフィクスチャ。 */
  body: (url: string) => string | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: (url) => fixtureForUrl(url),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = gate.body(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly warnings: string[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(settings: CloudSettings = JOCKEY_ONLY, overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") }; // JST 2026/06/28 09:00 = 分析日(開催日)と同じ日 → ライブ
  const warnings: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, warnings, settings } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

const JOCKEY_URL = "/jockey/result.html";
const jockeyUrls = (h: Harness): string[] => h.gate.urls.filter((u) => u.includes(JOCKEY_URL));

/** 事前分析の取得ステップだけを回す。 */
async function morningFetch(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
}

/** 事前分析(取得 → 計算)を回して、朝の prior(馬番順)を返す。 */
async function morningPriors(h: Harness): Promise<number[]> {
  await morningFetch(h);
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
  return [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
}

/** 発走前の分析(取得 → 計算・保存)を回して、保存した分析を返す。 */
async function preRaceSaved(h: Harness): Promise<AnalysisRecord> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
  expect(h.sink.saved).toHaveLength(1);
  return h.sink.saved[0]!;
}

type Contribution = { biasName: string; applied: boolean; correction: number; sampleCount?: number; targetRate?: number | null; overallRate?: number | null; reason: string };
const jockeyContributionOf = (record: AnalysisRecord, umaban: number): Contribution =>
  (record.horses.find((h) => h.umaban === umaban)!.contributions as Contribution[]).find((c) => c.biasName === "騎手成績")!;

/** このファイルは騎手の取得だけを検査する。調教師の成績(Issue #354)は取らない設定を既定にして、本数・キャッシュの検査の意味を保つ(期待値は変えていない)。調教師の取得は race-day-trainer.test.ts が固定する。 */
const JOCKEY_ONLY: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightTrainer: 0 };
const NO_JOCKEY: CloudSettings = { ...JOCKEY_ONLY, baseScoreWeightJockey: 0 };

/** 出馬表の騎手ID → 馬番。 */
const SHUTUBA = parseShutuba(loadFixture("shutuba_202603020211.html"));
const umabanOfJockey = (jockeyId: string): number => SHUTUBA.horses.find((h) => h.jockeyId === jockeyId)!.umaban;

describe("j1・j2: 取得ステップが騎手の年度別成績を取る(重みが 0 のときは取らない)", () => {
  it("j1: 既定の重み(0.15)では、事前分析の取得で騎手16人ぶん=16本を、既存の19本(出馬表1+戦績16+調教1+オッズ1)の後ろに取る", async () => {
    const h = harness();
    await morningFetch(h);
    expect(h.gate.urls).toHaveLength(19 + 16);
    expect(jockeyUrls(h)).toHaveLength(16);
    expect(h.gate.urls.slice(0, 19).some((u) => u.includes(JOCKEY_URL))).toBe(false);
    expect(new Set(jockeyUrls(h)).size).toBe(16); // 騎手IDで一意(同じ騎手を二度取らない)
    expect(jockeyUrls(h).every((u) => u.startsWith("https://db.netkeiba.com/jockey/result.html?id=") && !u.includes("syusai"))).toBe(true);
  });

  it("j2: 騎手の重みが 0 のときは、騎手のURLを1本も取らない(取得は19本のまま)", async () => {
    const h = harness(NO_JOCKEY);
    await morningFetch(h);
    expect(h.gate.urls).toHaveLength(19);
    expect(jockeyUrls(h)).toHaveLength(0);
  });
});

describe("j3: 計算ステップは netkeiba に出ず、取得済みのキャッシュから騎手の成績を使う", () => {
  it("事前分析の計算でゲートへの取得は増えず、騎手の重みを変えると朝の prior が変わる(16頭の実フィクスチャ)", async () => {
    const on = harness();
    const priorOn = await morningPriors(on);
    expect(on.gate.urls).toHaveLength(35); // 計算は取得を増やさない
    const off = harness(NO_JOCKEY);
    const priorOff = await morningPriors(off);
    expect(priorOn).toHaveLength(16);
    expect(priorOff).toHaveLength(16);
    const maxDiff = Math.max(...priorOn.map((p, i) => Math.abs(p - priorOff[i]!)));
    expect(maxDiff).toBeGreaterThan(0.0005); // 騎手の項が prior を実際に動かしている
  });
});

describe("j3b: 計算ステップは、キャッシュに騎手の成績が無くても失敗しない(その騎手は補正なし。戦績が無いときとは違う)", () => {
  it("取得のあとに騎手のキャッシュだけが消えた(掃除された等)とき、計算は ok で、ネットワークに出ず、朝の prior は騎手を取らない設定の prior と同じ", async () => {
    const h = harness();
    await morningFetch(h);
    expect(jockeyUrls(h)).toHaveLength(16);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%/jockey/result.html%'");
    const before = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(before); // 計算で netkeiba に出ていない
    const actual = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    const reference = await morningPriors(harness(NO_JOCKEY));
    expect(actual).toEqual(reference); // 騎手の補正が全員 0 になっただけ
  });
});

describe("j4: 発走前の取得は事前分析のキャッシュを使い回す", () => {
  it("事前分析のあとに発走前の分析を回しても、騎手のURLは16本のまま(取り直さない)", async () => {
    const h = harness();
    await morningPriors(h); // 取得 → 計算
    expect(jockeyUrls(h)).toHaveLength(16);
    await preRaceSaved(h);
    expect(jockeyUrls(h)).toHaveLength(16);
    // 比較の前提: 発走前の取得は実際に走っている(単勝・複勝オッズはキャッシュを迂回して取り直すので、朝と発走前で2回)。
    expect(h.gate.urls.filter((u) => u.includes("api_get_jra_odds") && u.includes("type=1"))).toHaveLength(2);
  });
});

describe("j5: 発走前の分析の保存に『騎手成績』の寄与度が載る", () => {
  it("ライブ(分析日=今日): 01170 の馬は 前年+当年(2026: 608走・226回、2025: 774走・285回)の合計で、中央の中立 0.22・重み 0.15 の補正", async () => {
    const h = harness();
    const record = await preRaceSaved(h);
    const c = jockeyContributionOf(record, umabanOfJockey("01170"));
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(608 + 774);
    expect(c.targetRate).toBeCloseTo((226 + 285) / (608 + 774), 10);
    expect(c.overallRate).toBe(0.22);
    expect(c.correction).toBeCloseTo(((226 + 285) / (608 + 774) - 0.22) * 0.15, 10);
  });

  it("別の騎手の馬は、別の成績(01220: 2026 は 624走・136回、2025 は 345走・45回)で補正される(騎手の取り違えがない)", async () => {
    const h = harness();
    const record = await preRaceSaved(h);
    const other = SHUTUBA.horses.find((x) => x.jockeyId !== "01170")!;
    const c = jockeyContributionOf(record, other.umaban);
    expect(c.sampleCount).toBe(624 + 345);
    expect(c.targetRate).toBeCloseTo((136 + 45) / (624 + 345), 10);
    expect(c.correction).not.toBeCloseTo(jockeyContributionOf(record, umabanOfJockey("01170")).correction, 5);
  });

  it("重みが 0 なら、保存の寄与度は『データなし』で補正なし(取得していない)", async () => {
    const h = harness(NO_JOCKEY);
    const record = await preRaceSaved(h);
    const c = jockeyContributionOf(record, umabanOfJockey("01170"));
    expect(c.applied).toBe(false);
    expect(c.reason).toContain("データなし");
    expect(c.correction).toBe(0);
  });
});

describe("j6: 取得時の設定のスナップショットに従う(取得後に重みを変えても、そのタスクの取得と計算は同じ設定)", () => {
  it("重み 0 で取得したあとに重みを 0.15 に変えても、計算は取得時の設定(騎手なし)で行い、失敗もしない", async () => {
    const h = harness(NO_JOCKEY);
    await morningFetch(h);
    h.settings = JOCKEY_ONLY; // 取得のあとに設定が変わった
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(19);
    const ref = harness(NO_JOCKEY);
    const expected = await morningPriors(ref);
    const actual = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(actual).toEqual(expected);
  });
});

describe("j7: 騎手の成績の取得に失敗しても、レースの取得・計算は失敗しない(その騎手は補正なし)", () => {
  it("騎手のURLがすべて 404 でも、事前分析の取得・計算は ok で、保存の寄与度は『データなし』", async () => {
    const h = harness();
    h.gate.body = (url) => (url.includes(JOCKEY_URL) ? null : fixtureForUrl(url));
    const priors = await morningPriors(h);
    expect(priors).toHaveLength(16);
    expect(jockeyUrls(h)).toHaveLength(16); // 試みた
    const record = await preRaceSaved(h);
    const c = jockeyContributionOf(record, umabanOfJockey("01170"));
    expect(c.applied).toBe(false);
    expect(c.reason).toContain("データなし");
  });

  it("1人だけ失敗(01170 のみ 404)なら、その騎手の馬だけ補正なしで、ほかの15人は補正される", async () => {
    const h = harness();
    h.gate.body = (url) => (url.includes(JOCKEY_URL) && url.includes("id=01170") ? null : fixtureForUrl(url));
    const record = await preRaceSaved(h);
    expect(jockeyContributionOf(record, umabanOfJockey("01170")).applied).toBe(false);
    const applied = record.horses.filter((x) => jockeyContributionOf(record, x.umaban).applied);
    expect(applied).toHaveLength(15);
  });
});

// ───────────── 週 1 回の更新(日をまたいで共有する保存先。D1)・計算ステップの取りこぼし・1 ステップの呼び出しの上限 ─────────────

/** 取得日時つきでメモリに持つ偽の保存先(D1 の代わり)。呼び出しを記録し、失敗も模擬できる。D1 の SQL そのものは jockey-results-repository.test.ts が確かめる。 */
class MemoryJockeyStore implements JockeyResultsStore {
  readonly entries = new Map<string, StoredJockeyResults>();
  loads = 0;
  saves = 0;
  failLoad = false;
  failSave = false;
  async loadMany(ids: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredJockeyResults>> {
    this.loads += 1;
    if (this.failLoad) throw new Error("D1 を読めません");
    const out = new Map<string, StoredJockeyResults>();
    for (const id of ids) {
      const hit = this.entries.get(`${kind}:${id}`);
      if (hit !== undefined) out.set(id, hit);
    }
    return out;
  }
  async saveMany(kind: RaceIdVenueKind, entries: readonly JockeyResultsSaveEntry[]): Promise<void> {
    this.saves += 1;
    if (this.failSave) throw new Error("D1 に書けません");
    for (const e of entries) this.entries.set(`${kind}:${e.jockeyId}`, { fetchedAtMs: e.fetchedAtMs, years: e.years });
  }
  /** すべての保存の取得日時をずらす(負なら過去へ)。 */
  shift(ms: number): void {
    for (const [key, value] of this.entries) this.entries.set(key, { ...value, fetchedAtMs: value.fetchedAtMs + ms });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("j8・j9: 保存先(D1)で、騎手の成績を日をまたいで共有する(週に 1 回の更新)", () => {
  it("j8: 前の日に取った成績が保存先にあれば、翌日の DO(空のキャッシュ)でも騎手のURLは 0 本。取得は既存の 19 本だけで、成績は同じ値で使われる", async () => {
    const store = new MemoryJockeyStore();
    const day1 = harness(JOCKEY_ONLY, { jockeyStore: store });
    const priors1 = await morningPriors(day1);
    expect(jockeyUrls(day1)).toHaveLength(16);
    expect(store.entries.size).toBe(16);
    expect(store.saves).toBe(1); // 保存は 1 回(16 人まとめて)
    expect(store.loads).toBe(2); // 読みは取得ステップと計算ステップで 1 回ずつ
    store.shift(-DAY_MS); // 1 日前に取ったことにする

    const day2 = harness(JOCKEY_ONLY, { jockeyStore: store }); // 別の DO = 空のキャッシュ
    const priors2 = await morningPriors(day2);
    expect(jockeyUrls(day2)).toHaveLength(0);
    expect(day2.gate.urls).toHaveLength(19);
    expect(priors2).toEqual(priors1);
  });

  it("j9: 保存が 6 日前なら使い、8 日前なら取り直して保存し直す(境界は 7 日)", async () => {
    const store = new MemoryJockeyStore();
    await morningPriors(harness(JOCKEY_ONLY, { jockeyStore: store })); // 保存を作る(取得日時 = 時計の今)
    store.shift(-6 * DAY_MS);
    const sixDays = harness(JOCKEY_ONLY, { jockeyStore: store });
    await morningFetch(sixDays);
    expect(jockeyUrls(sixDays)).toHaveLength(0);

    store.shift(-2 * DAY_MS); // 合計 8 日前
    const eightDays = harness(JOCKEY_ONLY, { jockeyStore: store });
    await morningFetch(eightDays);
    expect(jockeyUrls(eightDays)).toHaveLength(16);
    expect([...store.entries.values()].every((e) => e.fetchedAtMs === eightDays.clock.now)).toBe(true); // 取り直して取得日時が新しくなった
  });

  it("j10: 保存先の読みが失敗しても、取得ステップ・計算ステップは ok。騎手は netkeiba から取得して使う(フォールバック)", async () => {
    const store = new MemoryJockeyStore();
    store.failLoad = true;
    const h = harness(JOCKEY_ONLY, { jockeyStore: store });
    const priors = await morningPriors(h);
    expect(jockeyUrls(h)).toHaveLength(16);
    const reference = await morningPriors(harness(JOCKEY_ONLY)); // 保存先なしの構成と同じ prior
    expect(priors).toEqual(reference);
  });

  it("j11: 保存先の書き込みが失敗しても、取得ステップ・計算ステップは ok で、成績は使われる(次回も取得する)", async () => {
    const store = new MemoryJockeyStore();
    store.failSave = true;
    const h = harness(JOCKEY_ONLY, { jockeyStore: store });
    const priors = await morningPriors(h);
    expect(store.entries.size).toBe(0);
    expect(priors).toEqual(await morningPriors(harness(JOCKEY_ONLY)));
  });

  it("j8 の配線: 本番の DO は保存先(D1)を渡す", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/race-day-do.ts"), "utf8");
    const start = source.indexOf("new RaceDayCore({");
    expect(start).toBeGreaterThan(-1);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toMatch(/jockeyStore:\s*new D1JockeyResultsStore\(\{\s*db:\s*env\.DB\s*\}\)/);
  });

  it("重みが 0 なら保存先にも触れない(読みも書きもしない)", async () => {
    const store = new MemoryJockeyStore();
    const h = harness(NO_JOCKEY, { jockeyStore: store });
    await morningPriors(h);
    expect(store.loads).toBe(0);
    expect(store.saves).toBe(0);
  });
});

describe("j12: 1 ステップの gate の呼び出しの上限(40)", () => {
  it("中央 16 頭・組合せ ON・冷えた状態の発走前の取得は、騎手以外が 25 本 → 騎手は 15 人まで(合計 40 本)。取らなかった 1 人は補正なしで、分析は保存される", async () => {
    const h = harness({ ...JOCKEY_ONLY, includeComboOdds: true });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(h.gate.urls).toHaveLength(40);
    expect(jockeyUrls(h)).toHaveLength(15);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const record = h.sink.saved[0]!;
    const applied = record.horses.filter((x) => jockeyContributionOf(record, x.umaban).applied);
    expect(applied).toHaveLength(15);
    // 取らなかったのは出馬表の最後の馬の騎手。
    const last = SHUTUBA.horses[SHUTUBA.horses.length - 1]!;
    expect(jockeyContributionOf(record, last.umaban).applied).toBe(false);
    expect(jockeyContributionOf(record, last.umaban).reason).toContain("データなし");
  });

  it("保存先に全員が保存済みなら、同じ条件(組合せ ON・冷えた状態)でも騎手の取得は 0 本で、16 人全員に補正が掛かる(合計 25 本)", async () => {
    const store = new MemoryJockeyStore();
    await morningPriors(harness(JOCKEY_ONLY, { jockeyStore: store })); // 保存先を作る
    const h = harness({ ...JOCKEY_ONLY, includeComboOdds: true }, { jockeyStore: store });
    const record = await preRaceSaved(h);
    expect(h.gate.urls).toHaveLength(25);
    expect(record.horses.filter((x) => jockeyContributionOf(record, x.umaban).applied)).toHaveLength(16);
  });
});

describe("j13: 取得と計算のあいだで時計が進んでも、計算ステップは騎手の成績を取りこぼさない(CACHE_ONLY_TTL の jockeyMs は実質無期限)", () => {
  /** 事前分析の prior の列(馬番順)。 */
  const priorsOf = (h: Harness): number[] => [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);

  it("保存先あり: 取得の 8 日後(許容鮮度 7 日を超える)に計算しても、保存先の成績を使う。騎手を取らない設定の prior とは別の値", async () => {
    const store = new MemoryJockeyStore();
    const h = harness(JOCKEY_ONLY, { jockeyStore: store });
    await morningFetch(h);
    expect(store.entries.size).toBe(16);
    h.clock.now += 8 * DAY_MS;
    const before = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(before); // 計算は netkeiba に出ない
    // 比較の前提: 同じ時間の進め方で、騎手を取らない構成(重み 0)を回すと、prior が違う(騎手の項が prior を動かす)。
    const without = harness(NO_JOCKEY, { jockeyStore: new MemoryJockeyStore() });
    await morningFetch(without);
    without.clock.now += 8 * DAY_MS;
    await without.core.runNextStep();
    expect(priorsOf(h)).not.toEqual(priorsOf(without));
  });

  it("保存先なし(取得キャッシュだけ): 取得の 8 日後に計算しても、取得キャッシュの成績を使う", async () => {
    const h = harness(JOCKEY_ONLY);
    await morningFetch(h);
    h.clock.now += 8 * DAY_MS;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    const without = harness(NO_JOCKEY);
    await morningFetch(without);
    without.clock.now += 8 * DAY_MS;
    await without.core.runNextStep();
    expect(priorsOf(h)).not.toEqual(priorsOf(without));
  });

  it("発走前の分析でも同じ: 取得の 8 日後に計算・保存しても、16 人全員に騎手の補正が掛かっている", async () => {
    const store = new MemoryJockeyStore();
    const h = harness(JOCKEY_ONLY, { jockeyStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.clock.now += 8 * DAY_MS;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const record = h.sink.saved[0]!;
    expect(record.horses.filter((x) => jockeyContributionOf(record, x.umaban).applied)).toHaveLength(16);
  });
});
