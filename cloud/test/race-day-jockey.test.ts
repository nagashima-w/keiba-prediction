import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
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

function harness(settings: CloudSettings = DEFAULT_CLOUD_SETTINGS, overrides: Partial<RaceDayDeps> = {}): Harness {
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

const NO_JOCKEY: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightJockey: 0 };

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
    h.settings = DEFAULT_CLOUD_SETTINGS; // 取得のあとに設定が変わった
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
