/**
 * 季節適性バイアスと夏負けフラグ。仕様「環境・状態バイアス補正 > 季節適性」。
 *
 * (1) 季節適性: 過去走を季節分類(前処理層 classifySeason)し、今回の開催季節の複勝率で補正。
 *     各季節2走未満は補正なし。補正 = (対象季節の複勝率 − 全季節の複勝率) × 重み。
 * (2) 夏負けフラグ: 今回が夏開催のとき、夏開催の過去走の平均馬体重変化が閾値(既定 -6kg)以下なら
 *     マイナス補正。馬体重が欠損した夏走は平均から除外。夏走が2走未満なら判定しない。
 */

import type { DerivedRaceFeature, Season } from "./derive-features.js";
import {
  aggregatePlaceRate,
  computeDifferenceCorrection,
  type BiasContribution,
} from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";

/** 今回レースの季節条件。 */
export interface SeasonInput {
  /** 今回の開催季節(夏/冬/春秋)。 */
  readonly season: Season;
}

const SEASON_BIAS_NAME = "季節適性";
const SUMMER_FATIGUE_NAME = "夏負けフラグ";

/**
 * 季節適性の補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の開催季節。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeSeasonBias(
  features: readonly DerivedRaceFeature[],
  today: SeasonInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BiasContribution {
  // 季節が判定できる走のみを基準集合とする(日付欠損走は母数から除外)。
  const seasoned = features.filter((f) => f.season !== null);
  const targetSeason = seasoned.filter((f) => f.season === today.season);

  const target = aggregatePlaceRate(targetSeason.map((f) => f.placed));
  const overall = aggregatePlaceRate(seasoned.map((f) => f.placed));

  return computeDifferenceCorrection({
    biasName: SEASON_BIAS_NAME,
    target,
    overall,
    weight: config.weights.season,
    minSample: config.minSampleForBias,
    insufficientReason: `${today.season}の実績が2走未満のため補正なし`,
    appliedReason: `${today.season}の複勝率で補正`,
  });
}

/** 夏負けフラグの寄与度(ログ用内訳付き)。複勝率ではなく馬体重変化ベースの補正。 */
export interface SummerFatigueContribution {
  /** バイアス名(ログ識別用)。 */
  readonly biasName: string;
  /** 補正を適用したか(非夏開催・夏走2走未満・夏負けなしなら false)。 */
  readonly applied: boolean;
  /** 適用/非適用の理由。 */
  readonly reason: string;
  /** 判定に使えた夏走数(馬体重変化が取れた夏開催の走数)。 */
  readonly summerRunCount: number;
  /** 夏走の平均馬体重変化(kg)。判定できない場合は null。 */
  readonly avgWeightDiff: number | null;
  /** 夏負けと判定する閾値(kg)。 */
  readonly threshold: number;
  /** 適用した重み係数。 */
  readonly weight: number;
  /** 最終的な補正値(夏負けならマイナス、それ以外は0)。 */
  readonly correction: number;
}

/**
 * 夏負けフラグの補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の開催季節。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeSummerFatigueBias(
  features: readonly DerivedRaceFeature[],
  today: SeasonInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): SummerFatigueContribution {
  const { avgWeightDiffThreshold, penalty } = config.summerFatigue;
  const weight = config.weights.summerFatigue;
  const base = {
    biasName: SUMMER_FATIGUE_NAME,
    threshold: avgWeightDiffThreshold,
    weight,
  } as const;

  // 今回が夏開催でなければ判定しない。
  if (today.season !== "夏") {
    return {
      ...base,
      applied: false,
      reason: "今回が夏開催でないため非発動",
      summerRunCount: 0,
      avgWeightDiff: null,
      correction: 0,
    };
  }

  // 夏開催かつ馬体重変化が取れた走の diff を集める。
  const summerDiffs = features
    .filter((f) => f.season === "夏" && f.result.bodyWeight !== null)
    .map((f) => f.result.bodyWeight!.diff);

  // 夏走2走未満は判定しない(サンプル不足)。
  if (summerDiffs.length < config.minSampleForBias) {
    return {
      ...base,
      applied: false,
      reason: "夏走(馬体重取得)が2走未満のため判定なし",
      summerRunCount: summerDiffs.length,
      avgWeightDiff: null,
      correction: 0,
    };
  }

  const avg =
    summerDiffs.reduce((sum, d) => sum + d, 0) / summerDiffs.length;

  // 平均馬体重変化が閾値以下(既定 -6kg 以下)なら夏負けとしてマイナス補正。
  if (avg <= avgWeightDiffThreshold) {
    return {
      ...base,
      applied: true,
      reason: `夏開催の平均馬体重変化が${avgWeightDiffThreshold}kg以下(夏負け)`,
      summerRunCount: summerDiffs.length,
      avgWeightDiff: avg,
      correction: -penalty * weight,
    };
  }

  return {
    ...base,
    applied: false,
    reason: `夏開催の平均馬体重変化が${avgWeightDiffThreshold}kgより大きく夏負けなし`,
    summerRunCount: summerDiffs.length,
    avgWeightDiff: avg,
    correction: 0,
  };
}
