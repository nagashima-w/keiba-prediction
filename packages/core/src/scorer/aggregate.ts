/**
 * 複勝率集計とバイアス補正の共通ユーティリティ。
 *
 * 4種の環境・状態バイアス(馬場状態・競馬場・季節・枠順)はいずれも
 * 「条件に合致する過去走の複勝率」と「全体複勝率」の差分に重みを掛けて補正値を作る、
 * という同一パターンで計算する。その共通部分(母数から対象外を除く複勝率集計、
 * 2走未満は補正なしの境界処理、寄与度ログ用の内訳生成)をここに切り出す。
 */

import type { PlacedResult } from "./derive-features.js";

/** 複勝率の集計結果。母数(sampleCount)は対象外(中止など)を除いた走数。 */
export interface PlaceRateAggregate {
  /** 集計対象走数(対象外を除いた母数)。 */
  readonly sampleCount: number;
  /** うち複勝圏内の走数。 */
  readonly placedCount: number;
  /** 複勝率(placedCount / sampleCount)。母数0のときは0(ゼロ除算回避)。 */
  readonly rate: number;
}

/**
 * 複勝圏判定の列から複勝率を集計する。
 * 「対象外(中止・除外・非数値着順など)」は母数から除外する(仕様: サンプル不足でのペナルティは付けない)。
 */
export function aggregatePlaceRate(
  results: readonly PlacedResult[],
): PlaceRateAggregate {
  let sampleCount = 0;
  let placedCount = 0;
  for (const r of results) {
    if (r.kind === "対象外") {
      continue;
    }
    sampleCount += 1;
    if (r.placed) {
      placedCount += 1;
    }
  }
  return {
    sampleCount,
    placedCount,
    rate: sampleCount === 0 ? 0 : placedCount / sampleCount,
  };
}

/**
 * バイアス1項目分の寄与度(ログ用内訳付き)。
 *
 * 仕様「各バイアスの寄与度をログ出力し、verifyで重みを調整できること」に対応する。
 * 補正なし(不明・非発動)でも内訳(サンプル数・複勝率・重み)は保持し、常に
 * `correction === (targetRate − overallRate) × weight`(補正なし時は correction=0)が成り立つ。
 */
export interface BiasContribution {
  /** バイアス名(ログ識別用)。 */
  readonly biasName: string;
  /** 補正を適用したか(2走未満・非発動なら false)。 */
  readonly applied: boolean;
  /** 適用/非適用の理由(サンプル不足・非発動など)。 */
  readonly reason: string;
  /** 対象条件のサンプル数(対象外を除いた母数)。 */
  readonly sampleCount: number;
  /** 対象条件の複勝率。集計できない場合は null。 */
  readonly targetRate: number | null;
  /** 比較基準となる全体複勝率。集計できない場合は null。 */
  readonly overallRate: number | null;
  /** 実際に適用した重み係数(代替評価では減衰込み)。 */
  readonly weight: number;
  /** 最終的な補正値(不明・非発動なら0)。 */
  readonly correction: number;
}

/** computeDifferenceCorrection の入力。 */
export interface DifferenceCorrectionParams {
  /** バイアス名。 */
  readonly biasName: string;
  /** 対象条件の複勝率集計。 */
  readonly target: PlaceRateAggregate;
  /** 全体複勝率集計。 */
  readonly overall: PlaceRateAggregate;
  /** 重み係数。 */
  readonly weight: number;
  /** 補正を適用する最小サンプル数(通常は config.minSampleForBias)。 */
  readonly minSample: number;
  /** サンプル不足で補正しない場合の理由文言。 */
  readonly insufficientReason: string;
  /** 補正を適用した場合の理由文言。 */
  readonly appliedReason: string;
}

/**
 * 差分ベースのバイアス補正を組み立てる。
 *
 * - 対象サンプルが minSample 未満なら補正なし(correction=0, applied=false)。
 * - それ以外は correction = (対象複勝率 − 全体複勝率) × weight。
 * どちらの場合も寄与度ログ用の内訳(サンプル数・複勝率・重み)を返す。
 */
export function computeDifferenceCorrection(
  params: DifferenceCorrectionParams,
): BiasContribution {
  const { biasName, target, overall, weight, minSample } = params;
  const base = {
    biasName,
    sampleCount: target.sampleCount,
    targetRate: target.rate,
    overallRate: overall.rate,
    weight,
  } as const;

  if (target.sampleCount < minSample) {
    return {
      ...base,
      applied: false,
      reason: params.insufficientReason,
      correction: 0,
    };
  }
  return {
    ...base,
    applied: true,
    reason: params.appliedReason,
    correction: (target.rate - overall.rate) * weight,
  };
}
