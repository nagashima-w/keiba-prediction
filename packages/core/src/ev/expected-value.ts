/**
 * ev — 期待値計算。仕様「4. ev — 期待値計算」:
 *   複勝期待値 = place_prob × 複勝オッズ(下限値を使用)
 *   EV > 1.0(設定可能な閾値)の馬券のみ抽出。
 *
 * 設計判断(仕様が設計者に委ねている点):
 * - オッズは複勝オッズの「下限(oddsMin)」を用いる(仕様明記)。複勝は最終配当が下限〜上限の
 *   レンジで確定するため、下限を使う本計算は期待値を保守的(過小)に見積もる。
 * - EVプラス判定は「EV > 閾値」の厳密不等号とする。EV=閾値ちょうどは「プラスではない」。
 *   閾値ちょうどは控除率を織り込むと期待値が中立(妙味なし)であり、境界を拾わない方が安全なため。
 * - オッズ欠損馬(複勝オッズに馬番がない/下限が null)は EV を計算せず対象外とし、
 *   理由(excludedReason)を明示する。呼び出し側で欠落に気づけるよう ev=null で全馬分を返す。
 */

import type { OddsSnapshot } from "../scraper/types.js";

/** EV計算の設定。 */
export interface EvConfig {
  /**
   * EVプラス判定の閾値(既定1.0)。EV > threshold の馬のみ isPositive=true。
   * 仕様「EV > 1.0(設定可能な閾値)」に対応する。
   */
  readonly threshold: number;
}

/** 既定のEV設定(閾値1.0)。 */
export const DEFAULT_EV_CONFIG: EvConfig = {
  threshold: 1.0,
};

/** computeRaceEv の入力(1頭分の複勝確率)。 */
export interface HorsePrior {
  /** 馬番。 */
  readonly umaban: number;
  /** 複勝圏内確率(prior もしくは analyzer 補正後確率)。 */
  readonly placeProb: number;
}

/** 1頭分のEV計算結果。 */
export interface HorseEv {
  /** 馬番。 */
  readonly umaban: number;
  /** 入力の複勝圏内確率。 */
  readonly placeProb: number;
  /** 使用した複勝オッズ下限。欠損で対象外なら null。 */
  readonly placeOddsMin: number | null;
  /** 期待値(placeProb × placeOddsMin)。オッズ欠損で対象外なら null。 */
  readonly ev: number | null;
  /** EVが閾値を上回るか(ev=null または EV≤閾値 なら false)。 */
  readonly isPositive: boolean;
  /** EV計算対象外の理由(対象なら null)。 */
  readonly excludedReason: string | null;
}

/**
 * レース全頭のEVを計算する。全馬を入力順で返し、オッズ欠損馬も欠落させず ev=null で含める。
 * @param priors 各馬の馬番と複勝圏内確率
 * @param odds 単勝・複勝オッズのスナップショット(複勝下限を使用)
 * @param config EV設定(省略時は既定閾値1.0)
 */
export function computeRaceEv(
  priors: readonly HorsePrior[],
  odds: OddsSnapshot,
  config: EvConfig = DEFAULT_EV_CONFIG,
): HorseEv[] {
  return priors.map((p) => evaluateHorse(p, odds, config.threshold));
}

/** 1頭分のEVを評価する(オッズ欠損は対象外として理由付きで返す)。 */
function evaluateHorse(
  prior: HorsePrior,
  odds: OddsSnapshot,
  threshold: number,
): HorseEv {
  const placeOdds = odds.place[prior.umaban];

  // 複勝オッズに馬番が存在しない(取消・データ欠損など)。
  if (placeOdds === undefined) {
    return excluded(prior, "複勝オッズに該当馬番が存在しないため対象外");
  }

  // 複勝オッズ下限が未確定(null)。
  if (placeOdds.oddsMin === null) {
    return excluded(prior, "複勝オッズ下限が未確定(null)のため対象外");
  }

  const oddsMin = placeOdds.oddsMin;
  const ev = prior.placeProb * oddsMin;
  return {
    umaban: prior.umaban,
    placeProb: prior.placeProb,
    placeOddsMin: oddsMin,
    ev,
    isPositive: ev > threshold,
    excludedReason: null,
  };
}

/** EV計算対象外の結果を組み立てる。 */
function excluded(prior: HorsePrior, reason: string): HorseEv {
  return {
    umaban: prior.umaban,
    placeProb: prior.placeProb,
    placeOddsMin: null,
    ev: null,
    isPositive: false,
    excludedReason: reason,
  };
}
