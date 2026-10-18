/**
 * prior への調教師成績の組み込み(Issue #354〈#348 の TR1〉)。
 *
 * 入れ方: raw = 中立確率 + Σ(基礎6 + バイアス7 の補正) + w_タイム指数 × 特徴量 + w_調教師 × 特徴量 を、既存のロジットシフトで正規化する。
 * 特徴量はレース内の平均との差なので、1頭ごとの computePrior ではなく computeFieldPriors が足す(15 番目の寄与度として末尾に置く)。
 */

import { describe, expect, it } from "vitest";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../src/scorer/config.js";
import {
  buildPriorInput,
  computeFieldPriors,
  computePrior,
  normalizeFieldPriors,
  type PriorInput,
  type TodayRaceConditions,
} from "../../src/scorer/prior.js";
import { shrunkTrainerRate, type TrainerStats } from "../../src/scorer/trainer-stats.js";
import type { ShutubaHorse } from "../../src/scraper/types.js";

/** trainer 以外のすべての重みを 0 にし、調教師成績だけを効かせた設定(prior 合成式の検算用)。 */
function onlyTrainerCfg(trainer: number): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    weights: { trackCondition: 0, venue: 0, season: 0, frame: 0, summerFatigue: 0, transport: 0, rotation: 0 },
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      weights: { recentForm: 0, last3f: 0, courseDistance: 0, jockey: 0, weightChange: 0, courseFrameBias: 0, timeIndex: 0, trainer },
    },
  };
}

const TODAY: TodayRaceConditions = {
  courseType: "芝",
  distance: 1600,
  venueName: "東京",
  isWet: false,
  season: "春秋",
  frameZone: "中",
  restRunNumber: null,
  stableLocation: "美浦",
  kinryo: 55,
};

function inputsOf(stats: Array<TrainerStats | undefined>, config: ScorerConfig, today: TodayRaceConditions = TODAY): PriorInput[] {
  return stats.map((s) => ({
    features: deriveRaceFeatures([]),
    today,
    fieldSize: stats.length,
    ...(s !== undefined ? { trainerStats: s } : {}),
    config,
  }));
}

describe("computeFieldPriors × 調教師成績", () => {
  const W = 0.77;
  // 率: A=(300+11.1)/1050≈0.296, B=(22+11.1)/150≈0.221, C=(70+11.1)/450≈0.180。D は値なし。
  const STATS: Array<TrainerStats | undefined> = [
    { starts: 1000, placed: 300 },
    { starts: 100, placed: 22 },
    { starts: 400, placed: 70 },
    undefined,
  ];
  const rates = [311.1 / 1050, 33.1 / 150, 81.1 / 450];
  const mean = (rates[0]! + rates[1]! + rates[2]!) / 3;
  const x = [rates[0]! - mean, rates[1]! - mean, rates[2]! - mean, 0];

  it("前提: 手計算の率が縮小の関数と一致し、特徴量が分かれている", () => {
    STATS.slice(0, 3).forEach((s, i) => expect(shrunkTrainerRate(s)).toBeCloseTo(rates[i]!, 12));
    expect(Math.abs(x[0]! - x[1]!)).toBeGreaterThan(0.05);
  });

  it("寄与度は 15 項目で、調教師成績は末尾(タイム指数は 14 番目のまま)。computePrior(1頭)は 13 項目のまま", () => {
    const priors = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(W)));
    const single = computePrior(inputsOf(STATS, onlyTrainerCfg(W))[0]!);
    expect(single.contributions).toHaveLength(13);
    for (const p of priors) {
      expect(p.contributions).toHaveLength(15);
      expect(p.contributions.slice(0, 13).map((c) => c.biasName)).toEqual(single.contributions.map((c) => c.biasName));
      expect(p.contributions[13]!.biasName).toBe("タイム指数");
      expect(p.contributions[14]!.biasName).toBe("調教師成績");
    }
  });

  it("rawPrior = 中立確率 + 補正合計(w×特徴量)。補正合計 = 寄与度の和", () => {
    const priors = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(W)));
    priors.forEach((p, i) => {
      expect(p.neutralProb).toBeCloseTo(3 / 4, 12);
      expect(p.contributions[14]!.correction).toBeCloseTo(W * x[i]!, 10);
      const sum = p.contributions.reduce((s, c) => s + c.correction, 0);
      expect(p.correctionSum).toBeCloseTo(sum, 12);
      expect(p.correctionSum).toBeCloseTo(W * x[i]!, 10);
      expect(p.rawPrior).toBeCloseTo(3 / 4 + W * x[i]!, 10);
    });
  });

  it("prior は raw を既存のロジットシフトで正規化したもの(合計 = 3)。率の高い調教師の馬ほど高く、値なしの馬は特徴量 0 と同じ", () => {
    const priors = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(W)));
    const expected = normalizeFieldPriors(priors.map((p) => p.rawPrior), onlyTrainerCfg(W).prior);
    priors.forEach((p, i) => expect(p.prior).toBeCloseTo(expected[i]!, 12));
    expect(priors.reduce((s, p) => s + p.prior, 0)).toBeCloseTo(3, 9);
    // 率は A(0.296)> B(0.221)> C(0.180)。prior もその順に、実際に分かれている。
    expect(priors[0]!.prior - priors[1]!.prior).toBeGreaterThan(1e-3);
    expect(priors[1]!.prior - priors[2]!.prior).toBeGreaterThan(1e-3);
    // 値なし(D)は、特徴量 0 の馬と同じ rawPrior(= 中立確率)。
    expect(priors[3]!.rawPrior).toBeCloseTo(3 / 4, 12);
  });

  it("重み 0 なら、調教師成績のない prior と一致する", () => {
    const withZero = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(0)));
    const base = normalizeFieldPriors([0.75, 0.75, 0.75, 0.75], onlyTrainerCfg(0).prior);
    withZero.forEach((p, i) => {
      expect(p.rawPrior).toBeCloseTo(0.75, 12);
      expect(p.prior).toBeCloseTo(base[i]!, 12);
    });
  });

  it("調教師の成績が全頭 undefined(取得していない)なら、全頭 0・applied:false で、prior は変わらない", () => {
    const priors = computeFieldPriors(inputsOf([undefined, undefined, undefined, undefined], onlyTrainerCfg(W)));
    for (const p of priors) {
      expect(p.contributions[14]!.applied).toBe(false);
      expect(p.contributions[14]!.correction).toBe(0);
      expect(p.rawPrior).toBeCloseTo(0.75, 12);
    }
  });

  it("地方のレースでは効かない: 全頭 0・「NARのため対象外」", () => {
    const priors = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(W), { ...TODAY, venueKind: "nar" }));
    for (const p of priors) {
      expect(p.contributions[14]!.applied).toBe(false);
      expect(p.contributions[14]!.reason).toBe("NARのため対象外");
      expect(p.contributions[14]!.correction).toBe(0);
    }
  });

  it("今回が障害のレースでは効かない: 全頭 0・「障害のため対象外」", () => {
    const priors = computeFieldPriors(inputsOf(STATS, onlyTrainerCfg(W), { ...TODAY, courseType: "障" }));
    for (const p of priors) {
      expect(p.contributions[14]!.reason).toBe("障害のため対象外");
      expect(p.contributions[14]!.correction).toBe(0);
    }
  });

  it("既定の設定: 調教師成績の重みは 0.77(探索の 200 レースで Brier が最小だった 0.767 を 0.01 刻みに丸めた値。Issue #354)", () => {
    expect(DEFAULT_SCORER_CONFIG.baseScore.weights.trainer).toBe(0.77);
  });
});

describe("buildPriorInput は trainerStats をそのまま PriorInput に渡す", () => {
  const horse = {
    umaban: 1, wakuban: 1, kinryo: 55, stableLocation: "美浦",
  } as unknown as ShutubaHorse;
  const race = { courseType: "芝", distance: 1600, venueName: "東京", isWet: false, date: "2026/10/17", venueKind: "central" } as const;

  it("渡した値が入り、渡さなければキー自体が無い", () => {
    const stats: TrainerStats = { starts: 300, placed: 80 };
    expect(buildPriorInput({ horse, raceResults: [], race, fieldSize: 10, trainerStats: stats }).trainerStats).toEqual(stats);
    expect("trainerStats" in buildPriorInput({ horse, raceResults: [], race, fieldSize: 10 })).toBe(false);
  });
});
