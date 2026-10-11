/**
 * place-odds-estimate — 分析から見た想定複勝オッズ(Issue #253)。#247 の想定単勝オッズ(`win-odds-estimate.ts`)の複勝版。
 *
 * 想定複勝オッズ = 払戻率 ÷ 複勝の的中率。複勝の的中率は、複勝が何着まで払い戻されるかで決まる。
 *  - **8頭以上(3着まで。`basis="top3"`)**: 的中率 = 補正後の3着内率(`adjustedProb`。LLM なしの分析では prior と同じ値)そのもの。
 *    3着内率は分析が直接出している値なので、モデルを通さない(例: 3着内率 40% → 2.0 倍)。
 *  - **5〜7頭(2着まで。`basis="top2"`)**: 的中率 = 2着内率。勝率と**同じ経路**(補正後の3着内率を `PLACKETT_LUCE_MODEL` に渡して
 *    上位3着の着順分布 `buildOrderedDistribution(horses, 3)` を作る)で、各馬の `order[0]` と `order[1]` の確率を合算して求める
 *    (`aggregateTopFinishProbabilities(ordered, 2)`)。1着と2着は排反なので、合算がそのまま 2着以内の確率になる。
 *    全馬の合計は 2 になる(勝率の合計が 1 になるのと同じ)。
 *  - **4頭以下**は複勝が発売されないので、そもそも呼ばない(頭数から `basis` を決めるのは呼び出し側。`resolvePlaceBetTarget`)。
 *
 * ## これは目安である
 * 3着内率(2着内率)は統計モデルの推定値で、LLM が直接判断した値ではない。払戻率は単勝と同じ 0.8 を中央・地方とも使う
 * (**地方も JRA と同じ 80% と仮定した概算**。利用者の決定 2026-10-10・2026-10-11)。
 * 実際の複勝オッズは、一緒に3着内(2着内)に入る他の馬によって変わるため幅(下限〜上限)で出るのに対し、想定は1つの値である。
 *
 * ## 判定不能の扱い(勝率と同じ)
 * `basis="top2"` で `buildOrderedDistribution` が `null` を返す入力(固定馬が2頭以上、または頭数が2〜3頭)や、θ推定が失敗する入力
 * (範囲外・非有限の3着内率)は、2着内率を決められない。**throw せず**、全馬の的中率・想定を null にする(表示用。API の応答を壊さない)。
 * `basis="top3"` は馬ごとに独立に計算するので、判定不能になるのは当の馬の3着内率が 0 以下・非有限のときだけ。
 *
 * ネットワーク・LLM・SQLite には一切依存しない(与えられた数値から決定的に算出するだけ)。
 */

import type { JointModelHorse } from "./place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "./plackett-luce-model.js";
import { aggregateTopFinishProbabilities, fairOddsOf, WIN_PROB_TOP_FINISH_COUNT } from "./win-odds-estimate.js";

/** 複勝の払戻率(中央・地方とも。地方も JRA と同じと仮定した概算。Issue #253 の利用者の決定)。単勝(`WIN_PAYOUT_RATE`)と同じ 0.8。 */
export const PLACE_PAYOUT_RATE = 0.8;

/**
 * 複勝の的中率の基準。
 *  - `"top3"`: 3着内率(出走8頭以上)
 *  - `"top2"`: 2着内率(出走5〜7頭。複勝は2着まで)
 */
export type PlaceOddsBasis = "top3" | "top2";

/** 2着内率に数える上位着数。 */
const TOP2_DEPTH = 2;

/** 想定複勝オッズ = 払戻率 ÷ 的中率。的中率が 0 以下・非有限、または結果が非有限(オーバーフロー)なら null。的中率が 80% を超えると 1.0 倍を下回る(丸めない)。 */
export function fairPlaceOddsOf(hitProb: number): number | null {
  return fairOddsOf(hitProb, PLACE_PAYOUT_RATE);
}

/** 1頭ぶんの複勝の的中率と想定複勝オッズ。 */
export interface PlaceOddsEstimate {
  readonly umaban: number;
  /** 複勝の的中率(`basis` が top3 なら3着内率、top2 なら2着内率。0〜1)。判定不能・非有限の入力は null。 */
  readonly placeProb: number | null;
  /** 的中率の基準(入力の `basis` をそのまま返す)。 */
  readonly basis: PlaceOddsBasis;
  /** 想定複勝オッズ(払戻率 ÷ 的中率)。的中率が 0 以下・判定不能なら null。1.0 倍未満の値もそのまま返す。 */
  readonly fairPlaceOdds: number | null;
}

/**
 * 2着内率(馬番 → 確率。全馬のキーを持つ)。判定不能・θ推定の失敗は null(throw しない)。
 * 勝率(`estimateWinProbabilities`)と同じ `PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, 3)` の分布を使う。
 */
function estimateTop2Probabilities(horses: readonly JointModelHorse[]): Map<number, number> | null {
  try {
    const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, WIN_PROB_TOP_FINISH_COUNT);
    if (ordered === null) {
      return null;
    }
    const aggregated = aggregateTopFinishProbabilities(ordered, TOP2_DEPTH);
    return new Map(horses.map((h) => [h.umaban, aggregated.get(h.umaban) ?? 0]));
  } catch {
    return null;
  }
}

/**
 * 馬ごとの複勝の的中率と想定複勝オッズ(入力と同じ順序)。**throw しない**。
 * @param horses 出走全頭(`placeProb` は補正後の3着内率)
 * @param basis 的中率の基準。出走頭数から呼び出し側が決める(8頭以上=top3、5〜7頭=top2。4頭以下は呼ばない)
 */
export function estimateFairPlaceOdds(horses: readonly JointModelHorse[], basis: PlaceOddsBasis): readonly PlaceOddsEstimate[] {
  if (basis === "top3") {
    return horses.map((h) => {
      const placeProb = Number.isFinite(h.placeProb) ? h.placeProb : null;
      return { umaban: h.umaban, placeProb, basis, fairPlaceOdds: placeProb === null ? null : fairPlaceOddsOf(placeProb) };
    });
  }
  const top2 = estimateTop2Probabilities(horses);
  return horses.map((h) => {
    const placeProb = top2 === null ? null : (top2.get(h.umaban) ?? 0);
    return { umaban: h.umaban, placeProb, basis, fairPlaceOdds: placeProb === null ? null : fairPlaceOddsOf(placeProb) };
  });
}
