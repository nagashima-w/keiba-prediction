/**
 * ローテーション適性(鉄砲/叩き良化/使い込み下降)。仕様「環境・状態バイアス補正 > ローテーション適性」。
 *
 * 前処理層(deriveRaceFeatures)が各過去走に付与した「休み明け何走目か(restRunNumber)」を入力に、
 *   (1) 走目ごとの複勝率カーブ(N=1,2,3,4+ と、通常時=2走目以降全体、叩き期=2〜3走目、全体)を作り、
 *   (2) カーブ形状からタイプを分類(鉄砲型/叩き良化型/使い込み下降型。排他でなくフラグの組み合わせ)、
 *   (3) 今回の走目に応じて補正する(仕様の4規則)。
 * restRunNumber が null(日付欠損で走目を確定できない)走はカーブの母数から除外する。
 *
 * 設計判断:
 * - 補正値は既存バイアスと同じ「複勝率差分」単位に揃える。今回の走目に対応するバケットの複勝率と
 *   全体複勝率の差分 × 重み を基本とする(叩き良化×休み明けのマイナス = n1率 − 全体率 の実測差分など)。
 * - タイプ判定の各比較は、比較に使うバケットが minSampleForBias(既定2走)以上あることを要求する
 *   (サンプル不足での分類を避ける、既存バイアスの「2走未満補正なし」に整合)。
 * - 休み明け実績(N=1)が2走未満で型判定できないときは「不明」とし、今回が休み明けの場合のみ
 *   弱いマイナス補正(config.rotation.unknownRestPenalty × 重み)を与える。2走目以降なら0。
 */

import type { DerivedRaceFeature } from "./derive-features.js";
import {
  aggregatePlaceRate,
  type PlaceRateAggregate,
} from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";

const BIAS_NAME = "ローテーション適性";

/** 走目ごとの複勝率カーブ。 */
export interface RotationCurve {
  /** 休み明け1走目。 */
  readonly n1: PlaceRateAggregate;
  /** 2走目。 */
  readonly n2: PlaceRateAggregate;
  /** 3走目。 */
  readonly n3: PlaceRateAggregate;
  /** 4走目以降。 */
  readonly n4plus: PlaceRateAggregate;
  /** 通常時(2走目以降全体)。鉄砲型判定の基準。 */
  readonly n2plus: PlaceRateAggregate;
  /** 叩き期(2〜3走目)。叩き良化型判定・叩き2〜3走目補正の基準。 */
  readonly n23: PlaceRateAggregate;
  /** 走目が確定できた全走(rest null を除く)。差分補正の基準。 */
  readonly all: PlaceRateAggregate;
}

/** タイプ分類フラグ(排他でない組み合わせ)。 */
export interface RotationTypeFlags {
  /** 鉄砲型: 休み明け(1走目)が通常時(2走目以降)と同等以上。 */
  readonly freshHorse: boolean;
  /** 叩き良化型: 1走目が2〜3走目より明確に低い(叩いて良化)。 */
  readonly improveWithRacing: boolean;
  /** 使い込み下降型: 4走目以降がピーク走目より明確に低い。 */
  readonly declineWithUse: boolean;
}

/** ローテーション適性の寄与度(ログ用内訳付き)。 */
export interface RotationBiasContribution {
  /** バイアス名(ログ識別用)。 */
  readonly biasName: string;
  /** 補正を適用したか。 */
  readonly applied: boolean;
  /** 適用/非適用の理由。 */
  readonly reason: string;
  /** 今回が休み明け何走目か(null なら走目不明)。 */
  readonly todayRestRunNumber: number | null;
  /** タイプ分類フラグ。 */
  readonly types: RotationTypeFlags;
  /** 走目ごとの複勝率カーブ。 */
  readonly curve: RotationCurve;
  /** 適用した重み係数。 */
  readonly weight: number;
  /** 最終的な補正値(非発動なら0)。 */
  readonly correction: number;
}

/** 今回レースのローテーション条件。 */
export interface RotationInput {
  /**
   * 今回が休み明け何走目か(休み明け=1、叩き2走目=2、…)。
   * 走目を確定できない場合は null。
   */
  readonly restRunNumber: number | null;
}

/**
 * 走目ごとの複勝率カーブを集計する。
 * restRunNumber が null の走は母数から除外する。非数値着順(対象外)は aggregatePlaceRate が除外する。
 */
export function buildRotationCurve(
  features: readonly DerivedRaceFeature[],
): RotationCurve {
  const withRest = features.filter((f) => f.restRunNumber !== null);
  const pick = (pred: (n: number) => boolean): PlaceRateAggregate =>
    aggregatePlaceRate(
      withRest.filter((f) => pred(f.restRunNumber!)).map((f) => f.placed),
    );

  return {
    n1: pick((n) => n === 1),
    n2: pick((n) => n === 2),
    n3: pick((n) => n === 3),
    n4plus: pick((n) => n >= 4),
    n2plus: pick((n) => n >= 2),
    n23: pick((n) => n === 2 || n === 3),
    all: pick(() => true),
  };
}

/**
 * カーブ形状からタイプを分類する(フラグの組み合わせ)。
 * 各比較はバケットが minSampleForBias(既定2走)以上あることを要求する。
 */
export function classifyRotationType(
  curve: RotationCurve,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): RotationTypeFlags {
  const min = config.minSampleForBias;
  const thr = config.rotation.clearlyLowerThreshold;
  const enough = (a: PlaceRateAggregate): boolean => a.sampleCount >= min;

  // 鉄砲型: 休み明けが通常時(2走目以降)と同等以上。
  const freshHorse =
    enough(curve.n1) && enough(curve.n2plus) && curve.n1.rate >= curve.n2plus.rate;

  // 叩き良化型: 休み明けが2〜3走目より明確に低い。
  const improveWithRacing =
    enough(curve.n1) &&
    enough(curve.n23) &&
    curve.n1.rate <= curve.n23.rate - thr;

  // 使い込み下降型: 4走目以降がピーク走目(1〜3走目のうちサンプルのある最大)より明確に低い。
  const earlyRates: number[] = [];
  if (enough(curve.n1)) earlyRates.push(curve.n1.rate);
  if (enough(curve.n2)) earlyRates.push(curve.n2.rate);
  if (enough(curve.n3)) earlyRates.push(curve.n3.rate);
  const peakEarly = earlyRates.length === 0 ? null : Math.max(...earlyRates);
  const declineWithUse =
    enough(curve.n4plus) &&
    peakEarly !== null &&
    curve.n4plus.rate <= peakEarly - thr;

  return { freshHorse, improveWithRacing, declineWithUse };
}

/**
 * ローテーション適性の補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の走目条件(休み明け何走目か)。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeRotationBias(
  features: readonly DerivedRaceFeature[],
  today: RotationInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): RotationBiasContribution {
  const weight = config.weights.rotation;
  const curve = buildRotationCurve(features);
  const types = classifyRotationType(curve, config);
  const n = today.restRunNumber;

  const base = {
    biasName: BIAS_NAME,
    todayRestRunNumber: n,
    types,
    curve,
    weight,
  } as const;

  const none = (reason: string): RotationBiasContribution => ({
    ...base,
    applied: false,
    reason,
    correction: 0,
  });

  // 仕様(L85-87)は補正の向きを型ごとに固定している(叩き良化×休み明け=マイナス、
  // 叩き良化×叩き2〜3走目=プラス、使い込み下降×4走目以降=マイナス)。
  // baseline を curve.all にしているため、タイプ併発(例: 使い込み下降が併発して全体率が偏る)で
  // 差分の符号が仕様と逆になり得る。その場合でも仕様の向きを担保するよう符号クランプする。
  const clampNegative = (x: number): number => Math.min(x, 0); // マイナス補正を保証
  const clampPositive = (x: number): number => Math.max(x, 0); // プラス補正を保証

  // 走目が不明なら補正なし。
  if (n === null) {
    return none("今回の走目が不明のため補正なし");
  }

  // 今回が休み明け(1走目)。
  if (n === 1) {
    // 休み明け実績(N=1)が2走未満 → 不明。弱いマイナス補正のみ。
    if (curve.n1.sampleCount < config.minSampleForBias) {
      return {
        ...base,
        applied: true,
        reason: "休み明け実績2走未満(不明)のため弱いマイナス補正",
        correction: -config.rotation.unknownRestPenalty * weight,
      };
    }
    // 叩き良化型×休み明け → マイナス補正(n1率 − 全体率)。
    if (types.improveWithRacing) {
      return {
        ...base,
        applied: true,
        reason: "叩き良化型×休み明けのためマイナス補正",
        correction: clampNegative((curve.n1.rate - curve.all.rate) * weight),
      };
    }
    // 鉄砲型×休み明け → 補正なし(0)。それ以外(中庸)も補正なし。
    return none(
      types.freshHorse
        ? "鉄砲型×休み明けのため補正なし"
        : "休み明けだがタイプ判定なしのため補正なし",
    );
  }

  // 今回が叩き2〜3走目。
  if (n === 2 || n === 3) {
    if (types.improveWithRacing) {
      return {
        ...base,
        applied: true,
        reason: "叩き良化型×叩き2〜3走目のためプラス補正",
        correction: clampPositive((curve.n23.rate - curve.all.rate) * weight),
      };
    }
    return none("叩き2〜3走目だが叩き良化型でないため補正なし");
  }

  // 今回が4走目以降。
  if (types.declineWithUse) {
    return {
      ...base,
      applied: true,
      reason: "使い込み下降型×4走目以降のためマイナス補正",
      correction: clampNegative((curve.n4plus.rate - curve.all.rate) * weight),
    };
  }
  return none("4走目以降だが使い込み下降型でないため補正なし");
}
