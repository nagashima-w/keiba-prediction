/**
 * 馬場状態適性(道悪)バイアス。仕様「環境・状態バイアス補正 > 馬場状態適性」。
 *
 * - 今回(または想定)馬場が稍重以下(isWet=true)の場合のみ発動する。
 * - 芝とダートで別集計する。今回のコース種別と同じ種別の過去走のみを使う
 *   (仕様: 馬場悪化はダートでは時計が速くなる方向に働き、芝とは意味が異なるため)。
 * - 同種別の道悪実績が2走未満なら「不明」として補正なし(ペナルティを付けない)。
 * - 補正 = (同種別・道悪の複勝率 − 同種別・全体の複勝率) × 重み。
 *   基準を同種別全体に取ることで、道悪固有の得手不得手だけを差分として取り出す。
 */

import type { CourseType } from "../scraper/types.js";
import type { DerivedRaceFeature } from "./derive-features.js";
import {
  aggregatePlaceRate,
  computeDifferenceCorrection,
  type BiasContribution,
} from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";

/** 今回レースの馬場条件。 */
export interface TrackConditionInput {
  /** 今回のコース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 今回(または想定)馬場が稍重以下(道悪)なら true。 */
  readonly isWet: boolean;
}

const BIAS_NAME = "馬場状態適性";

/**
 * 馬場状態適性の補正を計算する。
 * @param features 前処理層 deriveRaceFeatures の出力(過去走の派生特徴量)。
 * @param today 今回レースの馬場条件。
 * @param config scorer 設定(重み・閾値)。省略時は既定値。
 */
export function computeTrackConditionBias(
  features: readonly DerivedRaceFeature[],
  today: TrackConditionInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BiasContribution {
  const weight = config.weights.trackCondition;

  // 今回が良馬場なら非発動。
  if (!today.isWet) {
    return {
      biasName: BIAS_NAME,
      applied: false,
      reason: "今回良馬場のため非発動",
      sampleCount: 0,
      targetRate: null,
      overallRate: null,
      weight,
      correction: 0,
    };
  }

  // 同種別(今回のコース種別)の過去走に限定する。芝/ダートは別集計。
  const sameCourse = features.filter(
    (f) => f.trackWetness !== null && f.trackWetness.courseType === today.courseType,
  );
  // 同種別のうち道悪(isWet=true)の走。
  const wetRuns = sameCourse.filter((f) => f.trackWetness!.isWet);

  const target = aggregatePlaceRate(wetRuns.map((f) => f.placed));
  const overall = aggregatePlaceRate(sameCourse.map((f) => f.placed));

  return computeDifferenceCorrection({
    biasName: BIAS_NAME,
    target,
    overall,
    weight,
    minSample: config.minSampleForBias,
    insufficientReason: "同種別の道悪実績が2走未満のため補正なし",
    appliedReason: "同種別の道悪複勝率で補正",
  });
}
