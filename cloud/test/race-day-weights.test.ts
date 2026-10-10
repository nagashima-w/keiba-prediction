import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { MAX_ATTEMPTS, RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #218: スコアリングの重み(13項目)が、事前分析(prior)と発走前の分析の両方で使われる。
 * AC: w1 発走前の分析が保存済みの重みを使う / w2 朝の prior も同じ重みを使い、同じ設定なら発走前の prior と一致する / w3 各タスクは取得時の設定のスナップショットで計算する(取得後に設定を保存しても、
 * そのタスクの重みは変わらない。朝・発走前とも) / w4 朝の取得で設定を読めなければ再試行し、尽きたら failed(既定値の重みで prior を作らない) / w5 loadSettings が無い構成は既定値で続ける /
 * w6 スナップショットが無い・重みの項目が無い旧いタスクは既定値の重み(今までと同じ結果) / w7 本番の DO は loadSettings を渡す(事前分析が既定値に黙って落ちない) / w8 極端に大きい重みでもクラッシュ・NaN にならない。
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
  readonly calls: string[];
  /** save をこの回数だけ「保存してから例外」にする(D1 へ書いた後、応答を受け取る前にクラッシュした状況の模擬)。 */
  crashAfterSave: number;
  /** save をこの回数だけ、保存せずに例外にする(D1・R2 の一時的な失敗)。 */
  failBeforeSave: number;
  childrenOverride: { horses: number; bets: number } | null;
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    calls: [],
    crashAfterSave: 0,
    failBeforeSave: 0,
    childrenOverride: null,
    async save(record) {
      sink.calls.push("save");
      if (sink.failBeforeSave > 0) {
        sink.failBeforeSave -= 1;
        throw new Error("D1 の一時的な失敗");
      }
      sink.saved.push(record);
      if (sink.crashAfterSave > 0) {
        sink.crashAfterSave -= 1;
        throw new Error("保存後のクラッシュ");
      }
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      sink.calls.push("find");
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      sink.calls.push("count");
      if (sink.childrenOverride !== null) return sink.childrenOverride;
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

const ALL_ON: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  readonly settingsLoads: number[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const settingsLoads: number[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, alarm, warnings, settingsLoads, settings: ALL_ON } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => {
      settingsLoads.push(clock.now);
      return h.settings;
    },
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}



/** 重みを強く変えた設定(recentForm を 3、courseDistance を 2。prior が既定値の重みの結果とは別の値になる=下のテストが前提として固定する)。 */
const HEAVY: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightRecentForm: 3, baseScoreWeightCourseDistance: 2 };

const priorsOf = (record: AnalysisRecord): number[] => [...record.horses].sort((a, b) => a.umaban - b.umaban).map((h) => h.prior);

/** 事前分析(取得 → 計算)を2ステップ回し、朝の prior を返す。 */
async function morningPriors(h: Harness): Promise<number[]> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
  const prior = h.core.getMorningPrior(RACE);
  expect(prior).not.toBeNull();
  return [...prior!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
}

/** 発走前の分析(取得 → 計算・保存)を2ステップ回し、保存した prior を返す。 */
async function preRacePriors(h: Harness): Promise<number[]> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
  expect(h.sink.saved).toHaveLength(1);
  return priorsOf(h.sink.saved[0]!);
}

describe("w1・w2: 重みが分析に効く(発走前・朝の両方)", () => {
  it("前提: 既定の重みと HEAVY の重みでは、発走前の prior の列が別の値になる(同じ列なら、以下のテストは何も検出できない)", async () => {
    const a = harness();
    a.settings = DEFAULT_CLOUD_SETTINGS;
    const b = harness();
    b.settings = HEAVY;
    const priorA = await preRacePriors(a);
    const priorB = await preRacePriors(b);
    expect(priorA).toHaveLength(16);
    expect(priorB).toHaveLength(16);
    const maxDiff = Math.max(...priorA.map((p, i) => Math.abs(p - priorB[i]!)));
    expect(maxDiff).toBeGreaterThan(0.001);
  });

  it("w1: 発走前の分析は保存済みの重みを使う — 1項目ずつ 4 に変えると(ほかは既定値のまま)、このレース(良馬場の 16 頭)では13項目のうち10項目が prior を動かす", async () => {
    const base = harness();
    base.settings = DEFAULT_CLOUD_SETTINGS;
    const basePriors = await preRacePriors(base);
    const moved: string[] = [];
    for (const f of SCORING_WEIGHT_FIELDS) {
      const h = harness();
      h.settings = { ...DEFAULT_CLOUD_SETTINGS, [f.field]: 4 };
      const priors = await preRacePriors(h);
      if (priors.some((p, i) => Math.abs(p - basePriors[i]!) > 1e-12)) moved.push(f.field);
    }
    // 動かない3項目(実測。いずれも重みの渡し漏れではない: scorer-config.test.ts が13項目の対応を固定している):
    //  - biasWeightTrackCondition: 道悪(稍重以下)のレースのときだけ発動する補正(bias-track-condition.ts)。このレースでは補正が 0
    //  - biasWeightSummerFatigue: 夏負けの判定(bias-season.ts)に、このレースの出走馬が当たらない
    //  - baseScoreWeightJockey: 騎手の当該コース成績。分析のパイプライン(runAnalysis。exe も同じ)が jockeyCourseStats を渡さない(`grep -rn jockeyCourseStats packages/app/src` は 0 件)ので、重みが効く入力が無い(既存の挙動)
    expect(moved.sort()).toEqual(
      [
        "biasWeightVenue",
        "biasWeightSeason",
        "biasWeightFrame",
        "biasWeightTransport",
        "biasWeightRotation",
        "baseScoreWeightRecentForm",
        "baseScoreWeightLast3f",
        "baseScoreWeightCourseDistance",
        "baseScoreWeightWeightChange",
        "baseScoreWeightCourseFrameBias",
      ].sort(),
    );
  });

  it("w2: 朝の prior も保存済みの重みを使い、HEAVY の朝の prior は既定値の朝の prior と別の値", async () => {
    const a = harness();
    a.settings = DEFAULT_CLOUD_SETTINGS;
    const b = harness();
    b.settings = HEAVY;
    const priorA = await morningPriors(a);
    const priorB = await morningPriors(b);
    expect(priorA).toHaveLength(16);
    expect(Math.max(...priorA.map((p, i) => Math.abs(p - priorB[i]!)))).toBeGreaterThan(0.001);
  });

  it("w2: 同じ設定なら、朝の prior = 発走前の prior(既定値の重み・HEAVY の重みの両方。朝と発走前で別の重みにならない)", async () => {
    for (const settings of [DEFAULT_CLOUD_SETTINGS, HEAVY]) {
      const morning = harness();
      morning.settings = settings;
      const pre = harness();
      pre.settings = settings;
      expect(await morningPriors(morning)).toEqual(await preRacePriors(pre));
    }
  });
});

describe("w3: 取得時の設定のスナップショットで計算する(取得後に設定を保存しても、そのタスクの重みは変わらない)", () => {
  it("朝: 取得のあと・計算の前に重みを HEAVY に変えても、朝の prior は取得時の(既定値の)重みのもの。設定の読み出しは1回", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await morningPriors(ref);
    const h = harness();
    h.settings = DEFAULT_CLOUD_SETTINGS;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    await h.core.runNextStep(); // 取得
    h.settings = HEAVY; // 取得のあとに設定が変わった
    await h.core.runNextStep(); // 計算
    const got = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(got).toEqual(expected);
    expect(h.settingsLoads).toHaveLength(1);
  });

  it("発走前: 取得のあと・計算の前に重みを HEAVY に変えても、保存する prior は取得時の(既定値の)重みのもの。設定の読み出しは1回", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await preRacePriors(ref);
    const h = harness();
    h.settings = DEFAULT_CLOUD_SETTINGS;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    h.settings = HEAVY;
    await h.core.runNextStep();
    expect(priorsOf(h.sink.saved[0]!)).toEqual(expected);
    expect(h.settingsLoads).toHaveLength(1);
  });

  it("朝の取得を再試行しても、最初に読んだ設定のスナップショットを使う(再試行のたびに設定を読み直さない)", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await morningPriors(ref);
    const h = harness();
    h.settings = DEFAULT_CLOUD_SETTINGS;
    let shutubaFailures = 0;
    h.gate.body = (url) => {
      if (url.includes("shutuba.html") && shutubaFailures < 1) {
        shutubaFailures += 1;
        return null;
      }
      return fixtureForUrl(url);
    };
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "retry" });
    h.settings = HEAVY; // 1回目の取得のあとに設定が変わった
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
    await h.core.runNextStep();
    expect(h.settingsLoads).toHaveLength(1);
    expect([...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior)).toEqual(expected);
  });

  it("再予約(事前分析をもう一度積む)すると、スナップショットは作り直す: 2回目は新しい設定(HEAVY)の重みで prior を作る", async () => {
    const h = harness();
    h.settings = DEFAULT_CLOUD_SETTINGS;
    const first = await morningPriors(h);
    h.settings = HEAVY;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    await h.core.runNextStep();
    await h.core.runNextStep();
    const second = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(Math.max(...first.map((p, i) => Math.abs(p - second[i]!)))).toBeGreaterThan(0.001);
    expect(h.settingsLoads).toHaveLength(2);
  });
});

describe("w4: 朝の取得で設定を読めなかったとき(既定値の重みで黙って prior を作らない)", () => {
  it(`設定の読み出しが失敗し続けると、取得ステップを再試行し、${"MAX_ATTEMPTS"} 回で failed。計算ステップには進まず、朝の prior は作られない。netkeiba には出ない`, async () => {
    const h = harness({
      loadSettings: async () => {
        throw new Error("D1 の一時的な失敗");
      },
    });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    const outcomes: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      h.clock.now += 2 * 60_000;
      const o = await h.core.runNextStep();
      outcomes.push(o.kind === "ran" ? `${o.mode}:${o.step}:${o.result}` : o.kind);
    }
    expect(outcomes).toEqual(["morning:fetch:retry", "morning:fetch:retry", "morning:fetch:failed"]);
    expect(h.core.getMorningPrior(RACE)).toBeNull();
    expect(h.gate.urls).toHaveLength(0);
    expect(h.core.getBoard().races.find((r) => r.mode === "morning")).toMatchObject({ status: "failed" });
  });

  it("1回目だけ失敗して2回目に読めれば、その設定(HEAVY)の重みで続ける", async () => {
    let calls = 0;
    const h = harness({
      loadSettings: async () => {
        calls += 1;
        if (calls === 1) throw new Error("D1 の一時的な失敗");
        return HEAVY;
      },
    });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "retry" });
    h.clock.now += 2 * 60_000;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    const ref = harness();
    ref.settings = HEAVY;
    const got = [...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior);
    expect(got).toEqual(await morningPriors(ref));
  });
});

describe("w5・w6: 設定が無い・旧いタスクは既定値の重み(今までと同じ結果)", () => {
  it("w5: loadSettings が無い構成の事前分析は、既定値の重みで動く(設定を読まない)", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await morningPriors(ref);
    const h = harness({ loadSettings: undefined });
    expect(await morningPriors(h)).toEqual(expected);
    expect(h.settingsLoads).toHaveLength(0);
  });

  it("w6: スナップショットの無い朝のタスク(この変更の前に取得まで済んだタスク)は、計算ステップで既定値の重みを使う", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await morningPriors(ref);
    const h = harness();
    h.settings = HEAVY;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    await h.core.runNextStep(); // 取得(HEAVY のスナップショットができる)
    h.sql.exec("UPDATE race_day_tasks SET settings_json = NULL WHERE mode = 'morning'"); // 旧いタスク(スナップショットなし)の模擬
    await h.core.runNextStep();
    expect([...h.core.getMorningPrior(RACE)!.result.rows].sort((a, b) => a.umaban - b.umaban).map((r) => r.prior)).toEqual(expected);
  });

  it("w6: 重みの項目が無い旧いスナップショット(この変更の前に取得まで済んだ発走前のタスク)は、既定値の重みで計算する(他の項目はスナップショットのまま)", async () => {
    const ref = harness();
    ref.settings = DEFAULT_CLOUD_SETTINGS;
    const expected = await preRacePriors(ref);
    const h = harness();
    h.settings = HEAVY;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep(); // 取得(HEAVY のスナップショットができる)
    const snapshot = JSON.parse((h.sql.exec("SELECT settings_json FROM race_day_tasks WHERE mode = 'pre_race'").toArray()[0] as { settings_json: string }).settings_json) as Record<string, unknown>;
    expect(snapshot["baseScoreWeightRecentForm"]).toBe(3); // 前提: 新しいスナップショットは重みを持つ
    for (const f of SCORING_WEIGHT_FIELDS) delete snapshot[f.field];
    h.sql.exec("UPDATE race_day_tasks SET settings_json = ? WHERE mode = 'pre_race'", JSON.stringify(snapshot));
    await h.core.runNextStep();
    expect(priorsOf(h.sink.saved[0]!)).toEqual(expected);
  });
});

describe("w7: 本番の DO は loadSettings を渡す(事前分析が、設定を読まずに既定値の重みへ黙って落ちない)", () => {
  it("race-day-do.ts の RaceDayCore の構築に loadSettings(D1 の設定を読む)が含まれ、`loadSettings(env.DB)` を呼ぶ", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/race-day-do.ts"), "utf8");
    const start = source.indexOf("new RaceDayCore({");
    expect(start).toBeGreaterThan(-1);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toMatch(/loadSettings:\s*async\s*\(\)\s*=>/);
    expect(construction).toContain("loadSettings(env.DB)");
  });
});

describe("w8: 極端に大きい重み(上限は無い。exe と同じ)でも、分析は失敗せず、prior は有限で 0〜1 に収まる", () => {
  it("13項目すべてを Number.MAX_VALUE にしても、発走前の分析は成功して保存される。prior・補正後確率はすべて有限で 0 以上 1 以下(実測: 1e6 以上では16頭とも同じ prior 0.1875 に飽和する。クラッシュ・NaN はしない)", async () => {
    const h = harness();
    h.settings = { ...DEFAULT_CLOUD_SETTINGS, ...Object.fromEntries(SCORING_WEIGHT_FIELDS.map((f) => [f.field, Number.MAX_VALUE])) } as CloudSettings;
    const priors = await preRacePriors(h);
    expect(priors).toHaveLength(16);
    for (const horse of h.sink.saved[0]!.horses) {
      expect(Number.isFinite(horse.prior), `馬番 ${horse.umaban} の prior`).toBe(true);
      expect(Number.isFinite(horse.adjustedProb), `馬番 ${horse.umaban} の補正後確率`).toBe(true);
      expect(horse.prior).toBeGreaterThanOrEqual(0);
      expect(horse.prior).toBeLessThanOrEqual(1);
    }
  });
});
