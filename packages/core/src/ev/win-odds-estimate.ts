/**
 * win-odds-estimate — 分析から見た想定単勝オッズ(Issue #247)。
 *
 * 想定単勝オッズ = 払戻率 ÷ 勝率。勝率は**配分の単勝候補(`buildWinCandidates`)と同じ経路**で求める:
 * 補正後の3着内率(`adjustedProb`。LLM なしの分析では prior と同じ値)を `PLACKETT_LUCE_MODEL` に渡して
 * 上位3着の着順分布(`buildOrderedDistribution(horses, 3)`)を作り、各馬の「1着(`order[0]`)の確率」を合算する。
 * 「order[0] の合算」は `aggregateWinProbabilities` 1か所に置き、`buildWinCandidates` も同じ関数を呼ぶ
 * (表示と配分が別々の実装で乖離しないため)。
 *
 * ## これは目安である
 * 勝率は3着内率から推定した値で、LLM が勝率を直接判断したものではない。払戻率は中央・地方とも
 * `WIN_PAYOUT_RATE`(0.8)で、**地方も JRA と同じ 80% と仮定した概算**(利用者の決定 2026-10-10。主催者ごとの払戻率は
 * 反映していない。将来の改善として扱う)。
 *
 * ## 判定不能の扱い(配分と同じ)
 * `buildOrderedDistribution` が `null` を返す入力(固定馬が2頭以上、または頭数が2〜3頭)は、勝率を決められない。
 * `estimateWinProbabilities` は null を返し、`estimateFairWinOdds` は全馬の勝率・想定オッズを null にする。
 * 固定馬がちょうど1頭の入力は、その馬が勝率1(想定 0.8 倍)、ほかの馬は勝率0になる(配分と同じ判定)。
 *
 * ネットワーク・LLM・SQLite には一切依存しない(与えられた数値から決定的に算出するだけ)。
 */

import type { JointModelHorse, OrderedOutcome, OrderedPlaceJointModel } from "./place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "./plackett-luce-model.js";

/** 単勝の払戻率(中央・地方とも。地方も JRA と同じと仮定した概算。Issue #247 の利用者の決定)。 */
export const WIN_PAYOUT_RATE = 0.8;

/**
 * 勝率の推定に使う上位着数。配分(`shared/mixed-candidates.ts` の `COMBO_TOP_FINISH_COUNT`)と同じ 3。
 * 値の一致は `packages/app/test` のテストが固定する(app の定数は export されていないため、`buildMixedCandidates` の戻り値で突き合わせる)。
 */
export const WIN_PROB_TOP_FINISH_COUNT = 3;

/**
 * 順序付き outcome から、各馬の1着確率(`order[0]` の確率の合算)を求める。
 * `buildWinCandidates`(配分)と `estimateWinProbabilities`(表示)が共有する。
 * 着順が空の outcome(出走0頭の縮退)は読み飛ばす。
 */
export function aggregateWinProbabilities(ordered: readonly OrderedOutcome[]): Map<number, number> {
  const winProbByUmaban = new Map<number, number>();
  for (const outcome of ordered) {
    const winner = outcome.order[0];
    if (winner === undefined) {
      continue;
    }
    winProbByUmaban.set(winner, (winProbByUmaban.get(winner) ?? 0) + outcome.probability);
  }
  return winProbByUmaban;
}

/**
 * 補正後の3着内率から、各馬の勝率を推定する(馬番 → 勝率。全馬のキーを持つ。1着になりえない馬は 0)。
 * 判定不能(固定馬2頭以上・頭数2〜3頭)なら null。
 * @throws θ推定が失敗する入力(範囲外・非有限の3着内率など。`PlackettLuceFitError`)。表示用途は `estimateFairWinOdds` を使うこと
 */
export function estimateWinProbabilities(
  horses: readonly JointModelHorse[],
  model: OrderedPlaceJointModel = PLACKETT_LUCE_MODEL,
): Map<number, number> | null {
  const ordered = model.buildOrderedDistribution(horses, WIN_PROB_TOP_FINISH_COUNT);
  if (ordered === null) {
    return null;
  }
  const aggregated = aggregateWinProbabilities(ordered);
  return new Map(horses.map((h) => [h.umaban, aggregated.get(h.umaban) ?? 0]));
}

/** 想定単勝オッズ = 払戻率 ÷ 勝率。勝率が 0 以下・非有限、または結果が非有限(オーバーフロー)なら null。 */
export function fairWinOddsOf(winProb: number): number | null {
  if (!Number.isFinite(winProb) || winProb <= 0) {
    return null;
  }
  const odds = WIN_PAYOUT_RATE / winProb;
  return Number.isFinite(odds) ? odds : null;
}

/** 1頭ぶんの勝率と想定単勝オッズ。 */
export interface WinOddsEstimate {
  readonly umaban: number;
  /** 推定した勝率(0〜1)。判定不能なら null。 */
  readonly winProb: number | null;
  /** 想定単勝オッズ(払戻率 ÷ 勝率)。勝率が 0・判定不能なら null。 */
  readonly fairWinOdds: number | null;
}

/**
 * 馬ごとの勝率と想定単勝オッズ(入力と同じ順序)。**throw しない**: 判定不能・θ推定の失敗は、全馬 null にする
 * (表示用。API の応答を壊さない。配分側は同じ入力で「見送り/invalid」に倒れる)。
 */
export function estimateFairWinOdds(horses: readonly JointModelHorse[]): readonly WinOddsEstimate[] {
  let winProbs: Map<number, number> | null;
  try {
    winProbs = estimateWinProbabilities(horses);
  } catch {
    winProbs = null;
  }
  return horses.map((h) => {
    const winProb = winProbs === null ? null : (winProbs.get(h.umaban) ?? 0);
    return { umaban: h.umaban, winProb, fairWinOdds: winProb === null ? null : fairWinOddsOf(winProb) };
  });
}
