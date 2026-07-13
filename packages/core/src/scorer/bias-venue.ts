/**
 * 競馬場適性バイアス。仕様「環境・状態バイアス補正 > 競馬場適性」。
 *
 * (A) 当該場実績: 今回の競馬場に2走以上あれば、その複勝率で差分補正する
 *     (補正 = (当該場の複勝率 − 中央全体の複勝率) × 重み)。
 * (B) 代替評価: 当該場が2走未満のときは、コース特性の類似性で代替評価する。
 *     設計判断(仕様「類似性で代替評価」の具体化):
 *       - 中央各場のコース特性(回り/直線長/坂/芝質)から今回の場との類似度を求める。
 *       - 類似度が閾値以上の過去走を、類似度を重みにしたプールに集める。
 *       - 類似度重み付き複勝率 = Σ(類似度 × 複勝(0/1)) / Σ(類似度)。
 *       - 補正 = (類似度重み付き複勝率 − 中央全体の複勝率) × 重み × 減衰係数。
 *         代替評価は直接実績より不確実なため、減衰係数(config.venue.similarityDecay, 既定0.5)で
 *         割り引く。プールの走数が2走未満なら不明として補正なし。
 *
 * 地方・海外走はこのバイアスでは対象外(当該場実績・全体母数・代替プールのいずれからも除外)。
 */

import type { DerivedRaceFeature } from "./derive-features.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import {
  aggregatePlaceRate,
  computeDifferenceCorrection,
  type BiasContribution,
} from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";
import { courseSimilarity, isCentralVenue } from "./course-traits.js";

/** 今回レースの競馬場条件。 */
export interface VenueInput {
  /** 今回の中央競馬場名(福島・京都など)。 */
  readonly venueName: string;
  /**
   * 今回レースの開催区分(中央/地方)。省略時は "central"(従来どおり)。
   * "nar"(地方競馬)では COURSE_TRAITS が中央10場前提のため、コース類似度による
   * 競馬場適性補正(当該場実績・代替評価とも)を一律対象外とする。
   */
  readonly venueKind?: RaceIdVenueKind;
}

/** 競馬場適性の評価種別。 */
export type VenueBiasKind = "実績" | "代替評価" | "不明";

/** 競馬場適性の寄与度(評価種別付き)。 */
export interface VenueBiasContribution extends BiasContribution {
  /** どの経路で評価したか(当該場実績/代替評価/不明)。 */
  readonly kind: VenueBiasKind;
}

const BIAS_NAME = "競馬場適性";

/** 中央かつ会場名が中央10場として既知の走だけを取り出す。 */
function centralKnownRuns(
  features: readonly DerivedRaceFeature[],
): DerivedRaceFeature[] {
  return features.filter((f) => {
    const name = f.result.venue?.name;
    return (
      f.result.venueKind === "中央" &&
      name !== null &&
      name !== undefined &&
      isCentralVenue(name)
    );
  });
}

/**
 * 競馬場適性の補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の競馬場。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeVenueBias(
  features: readonly DerivedRaceFeature[],
  today: VenueInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): VenueBiasContribution {
  const weight = config.weights.venue;
  const unknown = (reason: string): VenueBiasContribution => ({
    biasName: BIAS_NAME,
    kind: "不明",
    applied: false,
    reason,
    sampleCount: 0,
    targetRate: null,
    overallRate: null,
    weight,
    correction: 0,
  });

  // 地方(NAR)レースはコース特性テーブルが中央10場前提のため一律対象外とする。
  if (today.venueKind === "nar") {
    return unknown("NARのため対象外(コース類似度による競馬場適性の補正なし)");
  }

  // 今回の会場が中央10場でなければ評価不能。
  if (!isCentralVenue(today.venueName)) {
    return unknown("今回の会場が中央10場でないため補正なし");
  }

  const central = centralKnownRuns(features);
  if (central.length === 0) {
    return unknown("中央での出走歴がないため補正なし");
  }

  const overall = aggregatePlaceRate(central.map((f) => f.placed));

  // (A) 当該場実績。
  const directRuns = central.filter(
    (f) => f.result.venue!.name === today.venueName,
  );
  const directAgg = aggregatePlaceRate(directRuns.map((f) => f.placed));
  if (directAgg.sampleCount >= config.minSampleForBias) {
    const c = computeDifferenceCorrection({
      biasName: BIAS_NAME,
      target: directAgg,
      overall,
      weight,
      minSample: config.minSampleForBias,
      insufficientReason: "", // 到達しない(sampleCount>=minSample を確認済み)
      appliedReason: `${today.venueName}の複勝率で補正`,
    });
    return { ...c, kind: "実績" };
  }

  // (B) 代替評価(類似コース)。
  const { similarityThreshold, similarityDecay } = config.venue;
  let sumSim = 0;
  let sumSimPlaced = 0;
  let sampleCount = 0;
  for (const f of central) {
    const name = f.result.venue!.name!;
    if (name === today.venueName) {
      continue; // 当該場は(2走未満なので)代替プールに含めない。
    }
    if (f.placed.kind === "対象外") {
      continue; // 中止などは母数から除外。
    }
    const sim = courseSimilarity(today.venueName, name);
    if (sim === null || sim < similarityThreshold) {
      continue; // 類似度が閾値未満の場は使わない。
    }
    sumSim += sim;
    sumSimPlaced += sim * (f.placed.placed ? 1 : 0);
    sampleCount += 1;
  }

  const effectiveWeight = weight * similarityDecay;
  if (sampleCount < config.minSampleForBias) {
    return {
      biasName: BIAS_NAME,
      kind: "代替評価",
      applied: false,
      reason: "類似コースの実績も2走未満のため補正なし",
      sampleCount,
      targetRate: sampleCount === 0 ? null : sumSimPlaced / sumSim,
      overallRate: overall.rate,
      weight: effectiveWeight,
      correction: 0,
    };
  }

  const weightedRate = sumSimPlaced / sumSim;
  return {
    biasName: BIAS_NAME,
    kind: "代替評価",
    applied: true,
    reason: `類似コース(減衰${similarityDecay})の複勝率で代替補正`,
    sampleCount,
    targetRate: weightedRate,
    overallRate: overall.rate,
    weight: effectiveWeight,
    correction: (weightedRate - overall.rate) * effectiveWeight,
  };
}
