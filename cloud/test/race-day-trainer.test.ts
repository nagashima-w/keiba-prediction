import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { RaceIdVenueKind } from "../../packages/core/src/scraper/ids";
import type { StoredTrainerResults, TrainerResultsSaveEntry, TrainerResultsStore } from "../../packages/core/src/scraper/trainer-results-store";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config";
import { normalizeFieldPriors } from "../../packages/core/src/scorer/prior";
import { buildCloudScorerConfig } from "../src/scorer-config";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { parseJockeyResults } from "../../packages/core/src/scraper/parse-jockey-results";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #354: 調教師の前2年の3着内率を prior に入れる(クラウド版の取得・計算の結線)。騎手(race-day-jockey.test.ts)と同じ流れ。
 * AC: t1 事前分析の取得ステップが、出走馬の調教師ごとに年度別成績を1本ずつ取得する(既存の19本の後ろ) / t2 調教師の重みが 0 のときは取得しない /
 * t3 計算ステップは netkeiba に出ず、取得済みのキャッシュから調教師の成績を使う / t4 発走前の取得は事前分析のキャッシュを使い回す /
 * t5 発走前の分析の保存に『調教師成績』の寄与度が載る(前2年の合計・レース内の平均との差) / t6 取得時の設定のスナップショットに従う /
 * t7 取得に失敗してもレースの取得・計算は失敗せず、その調教師は補正なし / t8・t9 保存先(D1)で日をまたいで共有する(レースの年の 1 月 1 日〈JST〉以降なら使う) /
 * t10 騎手と共有する gate の呼び出しの上限(40)。
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

function harness(settings: CloudSettings = TRAINER_ONLY, overrides: Partial<RaceDayDeps> = {}): Harness {
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

const TRAINER_URL = "/trainer/result.html";
const trainerUrls = (h: Harness): string[] => h.gate.urls.filter((u) => u.includes(TRAINER_URL));
const JOCKEY_URL = "/jockey/result.html";
const jockeyUrls = (h: Harness): string[] => h.gate.urls.filter((u) => u.includes(JOCKEY_URL));

/** このファイルは調教師の取得だけを検査する。騎手の成績(Issue #226)は取らない設定を既定にして、本数の検査の意味を保つ。 */
const TRAINER_ONLY: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightJockey: 0 };
const NO_TRAINER: CloudSettings = { ...TRAINER_ONLY, baseScoreWeightTrainer: 0 };

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
const trainerContributionOf = (record: AnalysisRecord, umaban: number): Contribution =>
  (record.horses.find((h) => h.umaban === umaban)!.contributions as Contribution[]).find((c) => c.biasName === "調教師成績")!;

/** 出馬表の調教師ID → 馬番。 */
const SHUTUBA = parseShutuba(loadFixture("shutuba_202603020211.html"));
const umabanOfTrainer = (trainerId: string): number => SHUTUBA.horses.find((h) => h.trainerId === trainerId)!.umaban;
const TRAINER_IDS = SHUTUBA.horses.map((h) => h.trainerId!);

/** フィクスチャの実ページ(pipeline-fixtures.ts の代用)の前2年(2024・2025)の合計。 */
function windowOf(fixture: string): { starts: number; placed: number } {
  const years = parseJockeyResults(loadFixture(fixture)).filter((y) => y.year === 2024 || y.year === 2025);
  return { starts: years.reduce((s, y) => s + y.starts, 0), placed: years.reduce((s, y) => s + y.placed, 0) };
}
const W_01126 = windowOf("trainer_results_01126.html");
const W_01175 = windowOf("trainer_results_01175.html");
const W_01092 = windowOf("trainer_results_01214.html"); // 01092 の馬には 01214 の実ページを当てている
const rateOf = (w: { starts: number; placed: number }): number => (w.placed + 50 * 0.222) / (w.starts + 50);

describe("t1・t2: 取得ステップが調教師の年度別成績を取る(重みが 0 のときは取らない)", () => {
  it("t1: 既定の重み(0.77)では、事前分析の取得で調教師16人ぶん=16本を、既存の19本の後ろに取る(中央の既定のページ。&syusai なし)", async () => {
    const h = harness();
    await morningFetch(h);
    expect(TRAINER_IDS).toHaveLength(16);
    expect(h.gate.urls).toHaveLength(19 + 16);
    expect(trainerUrls(h)).toHaveLength(16);
    expect(h.gate.urls.slice(0, 19).some((u) => u.includes(TRAINER_URL))).toBe(false);
    expect(new Set(trainerUrls(h)).size).toBe(16);
    expect(trainerUrls(h).every((u) => u.startsWith("https://db.netkeiba.com/trainer/result.html?id=") && !u.includes("syusai"))).toBe(true);
    expect(trainerUrls(h).map((u) => /id=(\w+)/.exec(u)![1]).sort()).toEqual([...TRAINER_IDS].sort());
  });

  it("t2: 調教師の重みが 0 のときは、調教師のURLを1本も取らない(取得は19本のまま)", async () => {
    const h = harness(NO_TRAINER);
    await morningFetch(h);
    expect(h.gate.urls).toHaveLength(19);
    expect(trainerUrls(h)).toHaveLength(0);
  });
});

describe("t3: 計算ステップは netkeiba に出ず、取得済みのキャッシュから調教師の成績を使う", () => {
  it("事前分析の計算でゲートへの取得は増えず、調教師の重みを変えると朝の prior が変わる(16頭の実フィクスチャ)", async () => {
    const on = harness();
    const priorOn = await morningPriors(on);
    expect(on.gate.urls).toHaveLength(35); // 計算は取得を増やさない
    const off = harness(NO_TRAINER);
    const priorOff = await morningPriors(off);
    expect(priorOn).toHaveLength(16);
    const maxDiff = Math.max(...priorOn.map((p, i) => Math.abs(p - priorOff[i]!)));
    expect(maxDiff).toBeGreaterThan(0.005); // 調教師の項が prior を実際に動かしている
  });

  it("取得のあとに調教師のキャッシュだけが消えても、計算は ok でネットワークに出ず、朝の prior は調教師を取らない設定の prior と同じ(補正が全員 0 になるだけ)", async () => {
    const h = harness();
    await morningFetch(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%/trainer/result.html%'");
    const before = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(before);
    const actual = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(actual).toEqual(await morningPriors(harness(NO_TRAINER)));
  });
});

describe("t4: 発走前の取得は事前分析のキャッシュを使い回す", () => {
  it("事前分析のあとに発走前の分析を回しても、調教師のURLは16本のまま(取り直さない)", async () => {
    const h = harness();
    await morningPriors(h);
    expect(trainerUrls(h)).toHaveLength(16);
    await preRaceSaved(h);
    expect(trainerUrls(h)).toHaveLength(16);
    expect(h.gate.urls.filter((u) => u.includes("api_get_jra_odds") && u.includes("type=1"))).toHaveLength(2); // 前提: 発走前の取得は走っている
  });
});

describe("t5: 発走前の分析の保存に『調教師成績』の寄与度が載る", () => {
  it("成績のある 3 頭(01126・01175・01092)は、前2年(2024+2025)の合計から作った縮小後の率とレース内の平均の差 × 重み 0.77。新人 13 頭は補正なし", async () => {
    const h = harness();
    const record = await preRaceSaved(h);
    const rates = [rateOf(W_01126), rateOf(W_01175), rateOf(W_01092)];
    const mean = rates.reduce((a, b) => a + b, 0) / 3;
    expect(W_01126.starts).toBeGreaterThan(300); // 前提: フィクスチャに前2年の走がある
    expect(Math.abs(rates[0]! - rates[1]!)).toBeGreaterThan(0.01); // 前提: 取り違えを検出できる(率が別々)
    [["01126", W_01126, rates[0]!], ["01175", W_01175, rates[1]!], ["01092", W_01092, rates[2]!]].forEach(([id, w, rate]) => {
      const c = trainerContributionOf(record, umabanOfTrainer(id as string));
      expect(c.applied, id as string).toBe(true);
      expect(c.sampleCount, id as string).toBe((w as { starts: number }).starts);
      expect(c.targetRate, id as string).toBeCloseTo(rate as number, 10);
      expect(c.overallRate, id as string).toBeCloseTo(mean, 10);
      expect(c.correction, id as string).toBeCloseTo(0.77 * ((rate as number) - mean), 10);
    });
    const others = record.horses.filter((x) => !["01126", "01175", "01092"].includes(SHUTUBA.horses.find((s) => s.umaban === x.umaban)!.trainerId!));
    expect(others).toHaveLength(13);
    for (const x of others) {
      const c = trainerContributionOf(record, x.umaban);
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
    }
  });

  it("重みが 0 なら、保存の寄与度は補正なし(取得していない)", async () => {
    const h = harness(NO_TRAINER);
    const record = await preRaceSaved(h);
    const c = trainerContributionOf(record, umabanOfTrainer("01126"));
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("t6: 取得時の設定のスナップショットに従う", () => {
  it("重み 0 で取得したあとに重みを 0.77 に変えても、計算は取得時の設定(調教師なし)で行い、失敗もしない", async () => {
    const h = harness(NO_TRAINER);
    await morningFetch(h);
    h.settings = TRAINER_ONLY;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(19);
    const actual = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(actual).toEqual(await morningPriors(harness(NO_TRAINER)));
  });
});

describe("t7: 調教師の成績の取得に失敗しても、レースの取得・計算は失敗しない(その調教師は補正なし)", () => {
  it("調教師のURLがすべて 404 でも、事前分析の取得・計算は ok で、保存の寄与度は補正なし", async () => {
    const h = harness();
    h.gate.body = (url) => (url.includes(TRAINER_URL) ? null : fixtureForUrl(url));
    expect(await morningPriors(h)).toHaveLength(16);
    expect(trainerUrls(h)).toHaveLength(16); // 試みた
    const record = await preRaceSaved(h);
    expect(trainerContributionOf(record, umabanOfTrainer("01126")).applied).toBe(false);
  });

  it("1人だけ失敗(01126 のみ 404)なら、その調教師の馬だけ補正なしで、残りの成績のある 2 頭は補正される", async () => {
    const h = harness();
    h.gate.body = (url) => (url.includes(TRAINER_URL) && url.includes("id=01126") ? null : fixtureForUrl(url));
    const record = await preRaceSaved(h);
    expect(trainerContributionOf(record, umabanOfTrainer("01126")).applied).toBe(false);
    expect(trainerContributionOf(record, umabanOfTrainer("01175")).applied).toBe(true);
    expect(trainerContributionOf(record, umabanOfTrainer("01092")).applied).toBe(true);
  });
});

// ───────────── 保存先(D1)で日をまたいで共有する・gate の呼び出しの上限 ─────────────

/** 取得日時つきでメモリに持つ偽の保存先(D1 の代わり)。D1 の SQL そのものは trainer-results-repository.test.ts が確かめる。 */
class MemoryTrainerStore implements TrainerResultsStore {
  readonly entries = new Map<string, StoredTrainerResults>();
  loads = 0;
  saves = 0;
  failLoad = false;
  failSave = false;
  async loadMany(ids: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredTrainerResults>> {
    this.loads += 1;
    if (this.failLoad) throw new Error("D1 を読めません");
    const out = new Map<string, StoredTrainerResults>();
    for (const id of ids) {
      const hit = this.entries.get(`${kind}:${id}`);
      if (hit !== undefined) out.set(id, hit);
    }
    return out;
  }
  async saveMany(kind: RaceIdVenueKind, entries: readonly TrainerResultsSaveEntry[]): Promise<void> {
    this.saves += 1;
    if (this.failSave) throw new Error("D1 に書けません");
    for (const e of entries) this.entries.set(`${kind}:${e.trainerId}`, { fetchedAtMs: e.fetchedAtMs, years: e.years });
  }
  /** すべての保存の取得日時をずらす(負なら過去へ)。 */
  shift(ms: number): void {
    for (const [key, value] of this.entries) this.entries.set(key, { ...value, fetchedAtMs: value.fetchedAtMs + ms });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026 年 1 月 1 日 00:00 JST。 */
const YEAR_START_2026_JST = Date.parse("2025-12-31T15:00:00.000Z");

describe("t8・t9: 保存先(D1)で、調教師の成績を日をまたいで共有する(レースの年の 1 月 1 日〈JST〉以降に取ったものを使う)", () => {
  it("t8: 前の日に取った成績が保存先にあれば、翌日の DO(空のキャッシュ)でも調教師のURLは 0 本。取得は既存の 19 本だけで、朝の prior は同じ", async () => {
    const store = new MemoryTrainerStore();
    const day1 = harness(TRAINER_ONLY, { trainerStore: store });
    const priors1 = await morningPriors(day1);
    expect(trainerUrls(day1)).toHaveLength(16);
    expect(store.entries.size).toBe(16);
    expect(store.saves).toBe(1);
    expect(store.loads).toBe(2); // 取得ステップと計算ステップで 1 回ずつ
    store.shift(-DAY_MS);

    const day2 = harness(TRAINER_ONLY, { trainerStore: store });
    const priors2 = await morningPriors(day2);
    expect(trainerUrls(day2)).toHaveLength(0);
    expect(day2.gate.urls).toHaveLength(19);
    expect(priors2).toEqual(priors1);
  });

  it("t9: 今年(2026)の 1 月 1 日 00:00 JST ちょうどに取った保存は使い、1 ミリ秒前(2025 年)のものは取り直して保存し直す", async () => {
    const store = new MemoryTrainerStore();
    await morningPriors(harness(TRAINER_ONLY, { trainerStore: store }));
    const base = [...store.entries.values()][0]!.fetchedAtMs;
    store.shift(YEAR_START_2026_JST - base); // 全員の取得日時を年初ちょうどに
    const exactly = harness(TRAINER_ONLY, { trainerStore: store });
    await morningFetch(exactly);
    expect(trainerUrls(exactly)).toHaveLength(0);

    store.shift(-1);
    const over = harness(TRAINER_ONLY, { trainerStore: store });
    await morningFetch(over);
    expect(trainerUrls(over)).toHaveLength(16);
    expect([...store.entries.values()].every((e) => e.fetchedAtMs === over.clock.now)).toBe(true);
  });

  it("t10: 保存先の読みが失敗しても取得ステップ・計算ステップは ok。調教師は netkeiba から取得して使う(保存先なしの構成と同じ prior)", async () => {
    const store = new MemoryTrainerStore();
    store.failLoad = true;
    const h = harness(TRAINER_ONLY, { trainerStore: store });
    const priors = await morningPriors(h);
    expect(trainerUrls(h)).toHaveLength(16);
    expect(priors).toEqual(await morningPriors(harness(TRAINER_ONLY)));
  });

  it("t11: 保存先の書き込みが失敗しても ok で、成績は使われる(次回も取得する)", async () => {
    const store = new MemoryTrainerStore();
    store.failSave = true;
    const priors = await morningPriors(harness(TRAINER_ONLY, { trainerStore: store }));
    expect(store.entries.size).toBe(0);
    expect(priors).toEqual(await morningPriors(harness(TRAINER_ONLY)));
  });

  it("t12 の配線: 本番の DO は調教師の保存先(D1)を渡す", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/race-day-do.ts"), "utf8");
    const start = source.indexOf("new RaceDayCore({");
    expect(start).toBeGreaterThan(-1);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toMatch(/trainerStore:\s*new D1TrainerResultsStore\(\{\s*db:\s*env\.DB\s*\}\)/);
  });

  it("重みが 0 なら保存先にも触れない(読みも書きもしない)", async () => {
    const store = new MemoryTrainerStore();
    await morningPriors(harness(NO_TRAINER, { trainerStore: store }));
    expect(store.loads).toBe(0);
    expect(store.saves).toBe(0);
  });
});

describe("t12b: 発走前の取得ステップも調教師の保存先(D1)を使う(Issue #373。race-day-core.ts の発走前の取得の scrapeRace への trainerStore の配線)", () => {
  it("読み: 保存先に全員が保存済みなら、組合せ ON・冷えた状態の発走前の取得でも調教師の取得は 0 本(合計 25 本)で、成績のある 3 頭に補正が掛かる", async () => {
    const store = new MemoryTrainerStore();
    await morningPriors(harness(TRAINER_ONLY, { trainerStore: store })); // 保存先を作る
    expect(store.entries.size).toBe(16); // 前提: 16 人ぶん保存されている
    const h = harness({ ...TRAINER_ONLY, includeComboOdds: true }, { trainerStore: store }); // 別の DO(空のキャッシュ)
    const record = await preRaceSaved(h);
    expect(trainerUrls(h)).toHaveLength(0);
    expect(h.gate.urls).toHaveLength(25);
    for (const id of ["01126", "01175", "01092"]) {
      expect(trainerContributionOf(record, umabanOfTrainer(id)).applied, id).toBe(true);
    }
  });

  it("書き: 空の保存先で発走前の取得ステップを回すと、その時点で 16 人ぶんが保存先に書かれている(計算ステップより前。計算ステップは書き込みで代用されない)", async () => {
    const store = new MemoryTrainerStore();
    const h = harness(TRAINER_ONLY, { trainerStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(trainerUrls(h)).toHaveLength(16); // 前提: 保存先が空なので netkeiba から取った
    expect(store.loads).toBe(1);
    expect(store.saves).toBe(1);
    expect(store.entries.size).toBe(16);
  });
});

describe("t15: 調教師の重みは既定値以外でも取得〜計算を通って届く(Issue #373。騎手を取らない構成なので取得の上限 40 に掛からず、成績のある 3 頭が揃う)", () => {
  const WEIGHT = 2;
  const withWeight = (w: number): CloudSettings => ({ ...TRAINER_ONLY, baseScoreWeightTrainer: w });

  it("発走前の分析: 補正は 重み × (縮小した率 − レース内の平均)。重み 2 の補正は、既定の 0.77 の補正と別の値", async () => {
    const record = await preRaceSaved(harness(withWeight(WEIGHT)));
    const rates = [rateOf(W_01126), rateOf(W_01175), rateOf(W_01092)];
    const mean = rates.reduce((a, b) => a + b, 0) / 3;
    const ids = ["01126", "01175", "01092"];
    ids.forEach((id, i) => {
      const c = trainerContributionOf(record, umabanOfTrainer(id));
      expect(c.applied, id).toBe(true);
      expect(Math.abs(rates[i]! - mean), `${id}: 前提 率と平均の差が 0 でない`).toBeGreaterThan(0.001);
      expect(c.correction, id).toBeCloseTo(WEIGHT * (rates[i]! - mean), 10);
      expect(c.correction, id).not.toBeCloseTo(0.77 * (rates[i]! - mean), 5);
    });
  });

  it("朝の prior: 重み 2・既定の 0.77・0 の 3 通りが互いに別の列になる(重みの大きさが prior に届いている)", async () => {
    const at2 = await morningPriors(harness(withWeight(WEIGHT)));
    const at077 = await morningPriors(harness(withWeight(0.77)));
    const at0 = await morningPriors(harness(NO_TRAINER));
    const maxDiff = (a: number[], b: number[]): number => Math.max(...a.map((p, i) => Math.abs(p - b[i]!)));
    expect(at2).toHaveLength(16);
    expect(maxDiff(at2, at077)).toBeGreaterThan(0.001);
    expect(maxDiff(at077, at0)).toBeGreaterThan(0.001);
    expect(maxDiff(at2, at0)).toBeGreaterThan(0.001);
  });

  it("Issue #380: 朝の prior は期待値に一致する: 重み 0 の補正の合計 + 重み × (縮小した率 − レース内の平均) を、頭数レベルの正規化に通した値(重み 2。既定の 0.77 の期待値とは別の列)", async () => {
    // 期待値の作り方と限界: 調教師の項(重み × (率 − 平均))だけを手計算で足し、ほかの補正は重み 0 の発走前の保存の寄与度の合計をそのまま使う。
    // 最後の頭数レベルの正規化(二分法)は閉じた式で書けないので、本番の `normalizeFieldPriors` を使う。確かめるのは「重みが朝の計算まで届くこと」で、正規化の正しさではない
    // (正規化は packages/core 側のテストが確かめる)。重みを別の値(2 の 2 乗など)で渡す・スナップショットの重みを無視して既定値を使う変異は、述語(差が 0.001 超)では見逃すが、ここで捕まる。
    const prior = buildCloudScorerConfig(withWeight(WEIGHT)).prior;
    expect(prior, "前提: 調教師の重みの違いは prior の設定に影響しない(既定の prior 設定を期待値に使える)").toEqual(DEFAULT_SCORER_CONFIG.prior);
    const base = [...(await preRaceSaved(harness(NO_TRAINER))).horses].sort((a, b) => a.umaban - b.umaban); // 重み 0: 調教師の項は 0
    expect(base).toHaveLength(16);
    const neutral = Math.min(prior.targetPlaceCount, base.length) / base.length;
    const rates = new Map([["01126", rateOf(W_01126)], ["01175", rateOf(W_01175)], ["01092", rateOf(W_01092)]]);
    const mean = [...rates.values()].reduce((a, b) => a + b, 0) / 3;
    const expectedAt = (weight: number): number[] =>
      normalizeFieldPriors(
        base.map((h) => {
          const others = (h.contributions as Contribution[]).reduce((sum, c) => sum + c.correction, 0);
          const trainerId = SHUTUBA.horses.find((s) => s.umaban === h.umaban)!.trainerId!;
          return neutral + others + (rates.has(trainerId) ? weight * (rates.get(trainerId)! - mean) : 0);
        }),
        prior,
      );
    const actual = await morningPriors(harness(withWeight(WEIGHT)));
    const expected = expectedAt(WEIGHT);
    const expectedDefault = expectedAt(0.77);
    expect(actual).toHaveLength(16);
    expect(Math.max(...expected.map((p, i) => Math.abs(p - expectedDefault[i]!))), "前提: 期待値は重み 2 と 0.77 を区別できる").toBeGreaterThan(0.001);
    actual.forEach((p, i) => expect(p, `${i + 1} 番目の馬`).toBeCloseTo(expected[i]!, 10));
  });
});

describe("t13: 騎手と共有する gate の呼び出しの上限(40)", () => {
  it("騎手も調教師も ON・冷えた状態の事前分析の取得は、騎手 16 人のあと調教師は 5 人まで(合計 40 本)。取らなかった 11 人は補正なしで、計算は ok", async () => {
    const h = harness(DEFAULT_CLOUD_SETTINGS);
    await morningFetch(h);
    expect(jockeyUrls(h)).toHaveLength(16);
    expect(trainerUrls(h)).toHaveLength(5);
    expect(h.gate.urls).toHaveLength(40);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
  });

  it("Issue #375: 取得の上限で取らなかった調教師(11 人)の計算ステップの警告は「取得に失敗しました」と言わず、取得の失敗か上限のどちらともとれる文言で、次回以降の取得で取ることを言う。1 人 1 行・URL は出さない", async () => {
    const h = harness(DEFAULT_CLOUD_SETTINGS);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(trainerUrls(h), "前提: 取得の上限で 5 人しか取れていない").toHaveLength(5);
    h.warnings.length = 0;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const trainerWarnings = h.warnings.filter((w) => w.includes(": 調教師: "));
    expect(trainerWarnings, "前提: 取らなかった 11 人ぶんの警告が出ている").toHaveLength(11);
    for (const w of trainerWarnings) {
      expect(w).not.toContain("取得に失敗しました");
      expect(w).not.toContain("http");
      expect(w).toMatch(/調教師ID \d{5} の成績は保存先に無いため補正なし/);
      expect(w).toContain("取得の失敗、または取得の上限で取らなかった");
      expect(w).toContain("次回以降のレースの取得で取る");
    }
    expect(new Set(trainerWarnings).size, "11 人が別々の行").toBe(11);
  });

  it("Issue #380: 取得ステップ(朝)は、取得の上限で取らなかった調教師の警告を onWarn に出す。core の文面のとおり 1 行(11 人ぶんをまとめた行)で、騎手の警告は無い", async () => {
    const h = harness(DEFAULT_CLOUD_SETTINGS);
    await morningFetch(h);
    expect(trainerUrls(h), "前提: 取得の上限で 5 人しか取れていない").toHaveLength(5);
    const trainerWarnings = h.warnings.filter((w) => w.includes(": 調教師: "));
    expect(trainerWarnings).toHaveLength(1);
    expect(trainerWarnings[0]).toBe(`朝の取得(${RACE}): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します`);
    expect(h.warnings.filter((w) => w.includes(": 騎手: ")), "騎手の 16 人は取れているので警告なし").toHaveLength(0);
  });

  it("Issue #380: 取得ステップ(朝)は、取得に失敗した調教師を 1 人 1 行で onWarn に出す(core の文面のまま。URL を含む)", async () => {
    const h = harness(TRAINER_ONLY);
    h.gate.body = (url) => (url.includes(TRAINER_URL) ? null : fixtureForUrl(url));
    await morningFetch(h);
    expect(trainerUrls(h), "前提: 16 人ぶん試みた").toHaveLength(16);
    const trainerWarnings = h.warnings.filter((w) => w.includes(": 調教師: "));
    expect(trainerWarnings).toHaveLength(16);
    expect(new Set(trainerWarnings).size, "16 人が別々の行").toBe(16);
    for (const w of trainerWarnings) {
      expect(w).toMatch(new RegExp(`^朝の取得\\(${RACE}\\): 調教師: 調教師ID \\d{5} の年度別成績の取得に失敗しました: `));
      expect(w).toMatch(/\/trainer\/result\.html\?id=\d{5}/);
    }
  });

  it("Issue #380: 取得ステップ(発走前)も同じ。1 人(01126)だけ失敗なら、その 1 行だけが出る。取得ステップは ok のまま", async () => {
    const h = harness(TRAINER_ONLY);
    h.gate.body = (url) => (url.includes(TRAINER_URL) && url.includes("id=01126") ? null : fixtureForUrl(url));
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(trainerUrls(h), "前提: 16 人ぶん試みた").toHaveLength(16);
    const trainerWarnings = h.warnings.filter((w) => w.includes(": 調教師: "));
    expect(trainerWarnings).toHaveLength(1);
    expect(trainerWarnings[0]).toContain(`発走前の取得(${RACE}): 調教師: 調教師ID 01126 の年度別成績の取得に失敗しました: `);
  });

  it("Issue #380: 取得ステップは、調教師の保存先の読み・書きの失敗も onWarn に出す(D1 の障害が見える)。取得ステップは ok のまま", async () => {
    const loadFail = new MemoryTrainerStore();
    loadFail.failLoad = true;
    const a = harness(TRAINER_ONLY, { trainerStore: loadFail });
    await morningFetch(a);
    expect(a.warnings.filter((w) => w.includes(": 調教師: "))).toEqual([`朝の取得(${RACE}): 調教師: 調教師の成績の保存先を読めなかったため、netkeiba から取得します: D1 を読めません`]);
    const saveFail = new MemoryTrainerStore();
    saveFail.failSave = true;
    const b = harness(TRAINER_ONLY, { trainerStore: saveFail });
    await morningFetch(b);
    expect(b.warnings.filter((w) => w.includes(": 調教師: "))).toEqual([`朝の取得(${RACE}): 調教師: 調教師の成績を保存先に保存できなかったため、次回も取得します: D1 に書けません`]);
  });

  it("Issue #380: 取得ステップが出すのは騎手・調教師の警告だけ(調教の取得失敗は出さない。計算ステップでは従来どおり出る)", async () => {
    const h = harness(NO_TRAINER);
    h.gate.body = (url) => (url.includes("oikiri.html") ? null : fixtureForUrl(url));
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(h.gate.urls.some((u) => u.includes("oikiri.html")), "前提: 調教のページを試みた").toBe(true);
    expect(h.warnings.filter((w) => w.includes("調教(追い切り)")), "取得ステップは出さない").toHaveLength(0);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    expect(h.warnings.filter((w) => w.includes("調教(追い切り)")), "前提: 調教の警告は存在し、計算ステップが出す").toHaveLength(1);
  });

  it("Issue #380: 計算ステップの警告の書き換えは、キャッシュ無し(取得の失敗か上限か分からないもの)だけ。ID 付きでもキャッシュ無し以外の調教師の警告(ここでは本文が壊れた)は、文面をそのまま素通しする", async () => {
    const h = harness(TRAINER_ONLY);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.sql.exec("UPDATE fetch_cache SET value = '<html></html>' WHERE key LIKE '%/trainer/result.html?id=01126%'");
    h.warnings.length = 0;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const trainerWarnings = h.warnings.filter((w) => w.includes(": 調教師: "));
    expect(trainerWarnings, "前提: 壊した 1 人ぶんだけ警告が出ている").toHaveLength(1);
    expect(trainerWarnings[0]).toContain("調教師ID 01126 の年度別成績の取得に失敗しました: 年度別成績の表が見つかりません");
    expect(trainerWarnings[0]).not.toContain("保存先に無いため補正なし");
  });

  it("Issue #380: ID を持たない種別(ここでは調教)の警告は、本文にキャッシュ無しの語を含んでも書き換えない(「調教ID undefined …」にならない)", async () => {
    const h = harness(NO_TRAINER);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%oikiri.html%'");
    h.warnings.length = 0;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const oikiriWarnings = h.warnings.filter((w) => w.includes(": 調教: "));
    expect(oikiriWarnings, "前提: 調教の警告が 1 行出ている").toHaveLength(1);
    expect(oikiriWarnings[0]).toContain("調教(追い切り)の取得に失敗しました: キャッシュに無い取得先です");
    expect(oikiriWarnings[0]).not.toContain("undefined");
    expect(oikiriWarnings[0]).not.toContain("保存先に無いため補正なし");
  });

  it("騎手が保存先にあれば調教師の枠が増え、16 人全員を取れる(合計 19 + 16 = 35 本。騎手は保存先から読む)", async () => {
    const jockeyStore = {
      async loadMany(ids: readonly string[]) {
        const years = [{ year: 2025, starts: 600, placed: 200 }];
        return new Map(ids.map((id) => [id, { fetchedAtMs: Date.parse("2026-06-27T00:00:00Z"), years }]));
      },
      async saveMany() {},
    };
    const h = harness(DEFAULT_CLOUD_SETTINGS, { jockeyStore });
    await morningFetch(h);
    expect(jockeyUrls(h)).toHaveLength(0);
    expect(trainerUrls(h)).toHaveLength(16);
    expect(h.gate.urls).toHaveLength(35);
  });
});

describe("t14: 取得と計算のあいだで時計が進んでも、計算ステップは調教師の成績を取りこぼさない", () => {
  it("保存先あり: 取得の 8 日後に計算しても、保存先の成績を使う(取得日時は今年のまま)。調教師を取らない設定の prior とは別の値", async () => {
    const store = new MemoryTrainerStore();
    const h = harness(TRAINER_ONLY, { trainerStore: store });
    await morningFetch(h);
    h.clock.now += 8 * DAY_MS;
    const before = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(before);
    const without = harness(NO_TRAINER, { trainerStore: new MemoryTrainerStore() });
    await morningFetch(without);
    without.clock.now += 8 * DAY_MS;
    await without.core.runNextStep();
    const priorsOf = (x: Harness): number[] => [...x.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(priorsOf(h)).not.toEqual(priorsOf(without));
  });

  it("保存先なし(取得キャッシュだけ): 取得の 8 日後に計算しても、取得キャッシュの成績を使う", async () => {
    const h = harness(TRAINER_ONLY);
    await morningFetch(h);
    h.clock.now += 8 * DAY_MS;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    const without = harness(NO_TRAINER);
    await morningFetch(without);
    without.clock.now += 8 * DAY_MS;
    await without.core.runNextStep();
    const priorsOf = (x: Harness): number[] => [...x.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(priorsOf(h)).not.toEqual(priorsOf(without));
  });
});
