/**
 * prior へのタイム指数の組み込み(Issue #353〈#274-B〉)。
 *
 * 入れ方: raw = 中立確率 + Σ(基礎6 + バイアス7 の補正) + w × 特徴量 を、既存のロジットシフトで正規化する。
 * 特徴量はレース内の中央値との差なので、1頭ごとの computePrior ではなく computeFieldPriors が足す(14 番目の寄与度として末尾に置く)。
 */

import { describe, expect, it } from "vitest";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../src/scorer/config.js";
import {
  computeFieldPriors,
  computePrior,
  normalizeFieldPriors,
  type PriorInput,
  type TodayRaceConditions,
} from "../../src/scorer/prior.js";
import { STANDARD_TIME_TABLE } from "../../src/scorer/standard-times.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";
import { makeResult, rank, venue } from "./helpers.js";

/** timeIndex 以外のすべての重みを 0 にし、タイム指数だけを効かせた設定(prior 合成式の検算用)。 */
function onlyTimeIndexCfg(timeIndex: number): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    weights: { trackCondition: 0, venue: 0, season: 0, frame: 0, summerFatigue: 0, transport: 0, rotation: 0 },
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      weights: { recentForm: 0, last3f: 0, courseDistance: 0, jockey: 0, weightChange: 0, courseFrameBias: 0, timeIndex },
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

/** 東京の芝 1600・良の 1 走。タイムは秒で渡す(0.1 秒刻み)。 */
function tokyoTurf(sec: number): HorseRaceResult {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, "0");
  return makeResult({
    date: "2026/01/01",
    venue: venue("東京"),
    courseType: "芝",
    distance: 1600,
    trackCondition: "良",
    time: `${m}:${s}`,
    finishPosition: rank(5),
  });
}

/** 指数が出せない走(地方)。 */
const NO_INDEX: HorseRaceResult = makeResult({ date: "2026/01/01", venueKind: "地方", finishPosition: rank(5) });

/** 東京の芝 1600・良の指数(テスト内で表の値から直接計算する。runTimeIndex は使わない)。 */
function expectedIndex(sec: number): number {
  const std = STANDARD_TIME_TABLE.standards["東京|芝|1600"]!.median;
  const off = STANDARD_TIME_TABLE.offsets["芝|良"]!.median;
  return (std + off * 1.6 - sec) / 1.6;
}

function inputsOf(times: Array<number | null>, config: ScorerConfig, today: TodayRaceConditions = TODAY): PriorInput[] {
  return times.map((t) => ({
    features: deriveRaceFeatures([t === null ? NO_INDEX : tokyoTurf(t)]),
    today,
    fieldSize: times.length,
    config,
  }));
}

describe("computeFieldPriors × タイム指数", () => {
  const W = 0.12;
  // 指数: A=0.475, B=−0.15, C=−0.775(昇順 [−0.775, −0.15, 0.475] の floor(3/2)=1 番目 = B が中央値)→ 特徴量 A=+0.625, B=0, C=−0.625、D は値なしで 0。
  const TIMES = [93.5, 94.5, 95.5, null];

  it("前提: 手計算の指数(A=0.475, B=−0.15, C=−0.775)が表の値から出る", () => {
    expect(expectedIndex(93.5)).toBeCloseTo(0.475, 10);
    expect(expectedIndex(94.5)).toBeCloseTo(-0.15, 10);
    expect(expectedIndex(95.5)).toBeCloseTo(-0.775, 10);
  });

  it("寄与度は 14 項目で、タイム指数は末尾(13 項目の並びは computePrior と同じ)", () => {
    const priors = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(W)));
    const single = computePrior(inputsOf(TIMES, onlyTimeIndexCfg(W))[0]!);
    expect(single.contributions).toHaveLength(13);
    for (const p of priors) {
      expect(p.contributions).toHaveLength(14);
      expect(p.contributions.slice(0, 13).map((c) => c.biasName)).toEqual(single.contributions.map((c) => c.biasName));
      expect(p.contributions[13]!.biasName).toBe("タイム指数");
    }
  });

  it("rawPrior = 中立確率 + 補正合計(13 項目 + w×特徴量)。補正合計 = 寄与度の和", () => {
    const priors = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(W)));
    const x = [0.625, 0, -0.625, 0];
    priors.forEach((p, i) => {
      expect(p.neutralProb).toBeCloseTo(3 / 4, 12);
      expect(p.contributions[13]!.correction).toBeCloseTo(W * x[i]!, 10);
      const sum = p.contributions.reduce((s, c) => s + c.correction, 0);
      expect(p.correctionSum).toBeCloseTo(sum, 12);
      // 他の重みはすべて 0 なので、補正合計は w×特徴量だけ。
      expect(p.correctionSum).toBeCloseTo(W * x[i]!, 10);
      expect(p.rawPrior).toBeCloseTo(3 / 4 + W * x[i]!, 10);
    });
  });

  it("prior は raw を既存のロジットシフトで正規化したもの(合計 = 3)。指数の高い馬ほど高く、値なしの馬は中央値の馬と同じ", () => {
    const priors = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(W)));
    const expected = normalizeFieldPriors(priors.map((p) => p.rawPrior), onlyTimeIndexCfg(W).prior);
    priors.forEach((p, i) => expect(p.prior).toBeCloseTo(expected[i]!, 12));
    expect(priors.reduce((s, p) => s + p.prior, 0)).toBeCloseTo(3, 9);
    // 前提: A > B > C が実際に分かれている(0 差でない)。
    expect(priors[0]!.prior - priors[1]!.prior).toBeGreaterThan(1e-3);
    expect(priors[1]!.prior - priors[2]!.prior).toBeGreaterThan(1e-3);
    // D(値なし = 特徴量 0)は B(特徴量 0)と同じ。
    expect(priors[3]!.prior).toBeCloseTo(priors[1]!.prior, 12);
  });

  it("重み 0 なら、タイム指数のない 13 項目だけの prior と一致する", () => {
    const withZero = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(0)));
    // 13 項目だけの raw は、重みを全部 0 にした今回の設定では中立確率そのもの(3/4)。
    const base = normalizeFieldPriors([0.75, 0.75, 0.75, 0.75], onlyTimeIndexCfg(0).prior);
    withZero.forEach((p, i) => {
      expect(p.rawPrior).toBeCloseTo(0.75, 12);
      expect(p.prior).toBeCloseTo(base[i]!, 12);
    });
  });

  it("全馬同一データなら全馬同一 prior(タイム指数を足しても保たれる)", () => {
    const priors = computeFieldPriors(inputsOf([94.5, 94.5, 94.5, 94.5], onlyTimeIndexCfg(W)));
    for (const p of priors) expect(p.prior).toBeCloseTo(priors[0]!.prior, 12);
    expect(priors[0]!.contributions[13]!.applied).toBe(true);
  });

  it("地方のレースでは効かない: 値のある馬がいても全頭 0・applied:false・「NARのため対象外」", () => {
    const nar: TodayRaceConditions = { ...TODAY, venueKind: "nar" };
    const priors = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(W), nar));
    for (const p of priors) {
      const c = p.contributions[13]!;
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("NARのため対象外");
    }
  });

  it("今回が障害のレースでは効かない: 全頭 0・applied:false・「障害のため対象外」", () => {
    const shou: TodayRaceConditions = { ...TODAY, courseType: "障" };
    const priors = computeFieldPriors(inputsOf(TIMES, onlyTimeIndexCfg(W), shou));
    for (const p of priors) {
      const c = p.contributions[13]!;
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("障害のため対象外");
    }
  });

  it("既定の設定: タイム指数の重みは 0.12(探索の 0.118 を丸めた値。Issue #353)", () => {
    expect(DEFAULT_SCORER_CONFIG.baseScore.weights.timeIndex).toBe(0.12);
  });

  it("頭数 0 は空配列(従来どおり)", () => {
    expect(computeFieldPriors([])).toEqual([]);
  });
});
