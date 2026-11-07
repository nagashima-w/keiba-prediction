/**
 * 並走(影の計算。Issue #649)の保存用の記録の型。`AnalysisRecord.shadow` に載せる(型だけ。計算は `analysis/shadow-record.ts`)。
 * **買い目・配分・EV・画面・LLM には使わない。** D1 の表は `analysis_shadow_horses`(馬ごと)・`analysis_shadow_probs`(馬 × モデルごと)。
 */

import type { ShadowFlag } from "./stat-shadow-flags.js";
import type { ShadowProb } from "./stat-shadow.js";

/** 馬ごとの記録(モデルによらない部分)。 */
export interface ShadowHorseRecord {
  readonly umaban: number;
  /** 計算に使った分析の時点の単勝オッズ。取れていない馬は null。 */
  readonly inputWinOdds: number | null;
  /** 市場の確率 q(1/オッズをレース内で合計 1 にした値)。1 頭でもオッズが無いレースは全馬 null。 */
  readonly marketQ: number | null;
  /** #653 の印(休み明け・芝ダ替わり・前走で逃げた・人気薄の大敗続き)。前走が分からない馬は null。 */
  readonly flagLongRest: ShadowFlag;
  readonly flagSurfaceChange: ShadowFlag;
  readonly flagFrontRunner: ShadowFlag;
  readonly flagLongshotSlump: ShadowFlag;
}

/** 並走の記録(1 分析ぶん)。 */
export interface ShadowRecord {
  readonly horses: readonly ShadowHorseRecord[];
  readonly probs: readonly ShadowProb[];
}
