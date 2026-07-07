/**
 * 枠順適性(馬個別)バイアス。仕様「環境・状態バイアス補正 > 枠順適性(馬個別)」。
 *
 * 過去走の枠を内/中/外ゾーンに分類(前処理層 classifyFrameZone)し、今回の枠に対応する
 * ゾーンの複勝率で補正する。各ゾーン2走未満は補正なし。
 * 補正 = (対象ゾーンの複勝率 − 枠が判定できる全走の複勝率) × 重み。
 *
 * 注: これは仕様の枠順2層のうち「②馬個別の枠別成績」の層。
 * 「①コースレベルの枠順バイアス(コース形態で全馬に効く定数テーブル)」は基礎スコア側の
 * スコープであり、本モジュールでは扱わない(別の補正項として独立に加算・調整する設計)。
 */

import type { DerivedRaceFeature, FrameZone } from "./derive-features.js";
import {
  aggregatePlaceRate,
  computeDifferenceCorrection,
  type BiasContribution,
} from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";

/** 今回レースの枠条件。 */
export interface FrameInput {
  /** 今回の枠ゾーン(内/中/外)。 */
  readonly frameZone: FrameZone;
}

const BIAS_NAME = "枠順適性";

/**
 * 枠順適性(馬個別)の補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の枠ゾーン。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeFrameBias(
  features: readonly DerivedRaceFeature[],
  today: FrameInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BiasContribution {
  // 枠ゾーンが判定できる走のみを基準集合とする(枠番欠損の海外走などは母数から除外)。
  const zoned = features.filter((f) => f.frameZone !== null);
  const targetZone = zoned.filter((f) => f.frameZone === today.frameZone);

  const target = aggregatePlaceRate(targetZone.map((f) => f.placed));
  const overall = aggregatePlaceRate(zoned.map((f) => f.placed));

  return computeDifferenceCorrection({
    biasName: BIAS_NAME,
    target,
    overall,
    weight: config.weights.frame,
    minSample: config.minSampleForBias,
    insufficientReason: `${today.frameZone}枠の実績が2走未満のため補正なし`,
    appliedReason: `${today.frameZone}枠の複勝率で補正`,
  });
}
