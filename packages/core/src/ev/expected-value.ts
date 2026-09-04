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
 * - オッズ欠損馬(複勝オッズに馬番がない/下限が null)、および複勝オッズ下限が値域外
 *   (1.0未満・非有限。Issue #74)の馬は EV を計算せず対象外とし、理由(excludedReason)を
 *   明示する。呼び出し側で欠落・値域外に気づけるよう ev=null で全馬分を返す
 *   (値域外の場合もplaceOddsMinは生の値を保持し、nullに潰さない。#31の「判定不能と判定結果を
 *   混ぜない」原則を計算側でも守るため。詳細はevaluateHorse実装参照)。
 */

import { isUsableOdds, MIN_VALID_ODDS } from "./allocation-primitives.js";
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

/**
 * EV閾値(threshold)を防御する。非有限(NaN/Infinity)は既定値(DEFAULT_EV_CONFIG.threshold=1.0)
 * へフォールバックする(resolveKellyFraction/resolveBetUnit等と同じ流儀。
 * bet-allocation系の防御的フォールバックの慣行に合わせる)。
 *
 * 受け入れ条件19(機能D-2a・boss指摘2026-08-06への対応): `isPositive = ev > threshold` の
 * 右辺がNaNだと比較が常にfalseになり、どんなに良いオッズでも全候補が黙って「妙味なし」に
 * 分類される(threshold=-Infinityの場合は逆に全候補が黙って「妙味あり」になる)。
 * この関数を `computeRaceEv` / `computeEstimatedRaceEv` / `buildComboCandidates`
 * (combo-bet-allocation.ts)の3箇所で共有し、片側だけ守って非対称を作らない
 * (受け入れ条件17「閾値を二重定義しない」の当然の帰結)。
 */
export function resolveEvThreshold(threshold: number): number {
  if (!Number.isFinite(threshold)) {
    return DEFAULT_EV_CONFIG.threshold;
  }
  return threshold;
}

/** computeRaceEv の入力(1頭分の複勝確率)。 */
export interface HorsePrior {
  /** 馬番。 */
  readonly umaban: number;
  /** 複勝圏内確率(prior もしくは analyzer 補正後確率)。 */
  readonly placeProb: number;
}

/**
 * 推定複勝下限(estimatePlaceOddsMinFromWin)の設定。
 * Task#25: 発売前(oddsStatus=yoso)は予想単勝オッズしかなく複勝が無いため、単勝オッズから
 * 複勝下限を経験則ベースで概算するための係数。
 */
export interface EstimatedPlaceConfig {
  /**
   * 単勝オッズから複勝下限を換算する係数(既定0.2)。
   * 換算式: 推定複勝下限 = max(1.0, 1.0 + (winOdds − 1.0) × coef)。
   */
  readonly coef: number;
}

/** 既定の推定複勝下限設定(係数0.2)。 */
export const DEFAULT_ESTIMATED_PLACE_CONFIG: EstimatedPlaceConfig = {
  coef: 0.2,
};

/**
 * 単勝オッズから複勝オッズ下限を推定する(経験則ベースの概算)。
 *
 * 換算式(既定): 推定複勝下限 = max(1.0, 1.0 + (winOdds − 1.0) × coef)、coef 既定0.2。
 * 単勝1.5倍→1.1、10倍→2.8、50倍→10.8 になる素直なアフィン近似(人気馬ほど複勝下限は単勝に近づき、
 * 大穴ほど複勝下限は単勝より大きく割り引かれる、という複勝オッズの一般的傾向を単純化して表現する)。
 *
 * **注意: これはあくまで経験則ベースの概算であり、実際の複勝オッズ下限とは ±20〜30%程度の
 * 誤差がありうる。** 出走頭数・人気の偏り・複勝の的中率(3着以内が対象で単勝より的中しやすい)
 * などの要因で複勝配当は単勝から一意には決まらないため、この関数は事前スクリーニング用の概算値を
 * 返すに留める。複勝オッズが発売され次第、確定オッズで再分析することが前提となる。
 *
 * @param winOdds 単勝オッズ。null・非有限(NaN/Infinity)・MIN_VALID_ODDS(1.0)未満は
 *   推定不可としてnullを返す。
 * @param config 推定係数(省略時は既定coef=0.2)。
 */
export function estimatePlaceOddsMinFromWin(
  winOdds: number | null,
  config: EstimatedPlaceConfig = DEFAULT_ESTIMATED_PLACE_CONFIG,
): number | null {
  if (winOdds === null || !Number.isFinite(winOdds) || winOdds < MIN_VALID_ODDS) {
    return null;
  }
  return Math.max(MIN_VALID_ODDS, MIN_VALID_ODDS + (winOdds - MIN_VALID_ODDS) * config.coef);
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
  const threshold = resolveEvThreshold(config.threshold);
  return priors.map((p) => evaluateHorse(p, odds, threshold));
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

  // 複勝オッズ下限が値域外(Issue #74)。オッズの値域は1.0以上であり、`0`は構文上は正当な
  // 数値だが値域外。判定基準は allocation-primitives.ts の isUsableOdds(>=MIN_VALID_ODDS)へ
  // 委譲する(V-2: 新しい述語を作らず既存述語に集約)。
  //
  // 【重要】excluded()には流さない。excluded()はplaceOddsMinをnullに潰すため、下流
  // (bet-allocation.ts)が「未確定(EXCLUDED_NO_ODDS)」と誤認し、oddsMalformedCountが
  // 静かに0になる退行を起こす(#31の成果を計算側で自分で壊すことになる。boss着手前ゲート
  // 【最重要の裁定】参照)。値域外だけはplaceOddsMinを生の値のまま保持し、evのみnullにする。
  if (!isUsableOdds(oddsMin)) {
    return {
      umaban: prior.umaban,
      placeProb: prior.placeProb,
      placeOddsMin: oddsMin,
      ev: null,
      isPositive: false,
      // boss裁定Q1(a)(2026-09-04): 到達しうる全入力(0/-0/(0,1)/NaN/±Infinity)に対して
      // 真であることが必須。「1.0未満」単独だとNaN・+Infinityで偽になる(NaN<1.0も
      // Infinity<1.0もfalse)。「1.0未満・非有限」の選言にすることで常に真になる。
      excludedReason: "複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外",
    };
  }

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

/**
 * 推定EVの1頭分の計算結果(Task#25)。HorseEv と同じ形状に加え、複勝下限が実オッズではなく
 * 単勝オッズからの推定値であることを示す evEstimated: true を持つ。確定EV(HorseEv、
 * evEstimated フィールドを持たない)とは型レベルで区別できるようにするための別インターフェース。
 */
export interface EstimatedHorseEv extends HorseEv {
  /** 常に true。複勝下限が単勝オッズからの推定値であることを示す。 */
  readonly evEstimated: true;
}

/**
 * 複勝オッズがまだ発売されていないレース(oddsStatus=yoso 等)向けに、単勝オッズから推定した
 * 複勝下限でEVを概算する。呼び出し側(analysis-pipeline)は odds.oddsStatus が "yoso" のときに
 * この関数を、それ以外(result/middle)では computeRaceEv(確定EV)を使い分ける想定であり、
 * 本関数は odds.place を一切参照しない(常に推定に統一するため。odds.place に値があっても無視する)。
 *
 * 確定EV経路(computeRaceEv/HorseEv)とは完全に独立した別関数・別型とすることで、確定EV経路の
 * 計算結果・型には一切影響を与えない(既存の回帰テストが示す挙動は不変)。
 *
 * **残余(boss メタレビューR1・2026-09-04・#74。選択(b): 実装は変えず明記に留める)**:
 * `evaluateEstimatedHorse` は `estimatedOddsMin === null` しか見ておらず、
 * `estimatePlaceOddsMinFromWin` の非null出力を `isUsableOdds` に通していない。そのため
 * `placeConfig.coef` が非有限(NaN/Infinity)だと、`estimatePlaceOddsMinFromWin` が
 * `isUsableOdds` を満たさない値を返す(`Math.max(MIN_VALID_ODDS, ...)` の `Math.max` は
 * 引数にNaNが混じると常にNaNを返し、Infinityが混じると常にInfinityを返すため、下限クランプが
 * 機能しない)。具体的には `coef=NaN` で `placeOddsMin=NaN`・`ev=NaN`・`isPositive=false`、
 * `coef=+Infinity` で `placeOddsMin=+Infinity`・`ev=+Infinity`・`isPositive=true`
 * になる(実測。`expected-value.test.ts`「残余(boss メタレビューR1・選択(b))」describe参照)。
 * 後者は `isPositive=true` かつ `placeOddsMin` が `isUsableOdds` を満たさないという、
 * `verify.ts` の規則Uが「本番経路では到達しない」と明記している状態そのものであり、
 * `evaluateHorse`(確定EV側。値域外はisUsableOddsで弾く)との間に新しい非対称を作る。
 *
 * **本番では到達しない**: `placeConfig`(`EstimatedPlaceConfig`)の供給元は
 * `packages/app/src` に存在せず(`analysis-pipeline.ts` の任意dep宣言と
 * `?? DEFAULT_ESTIMATED_PLACE_CONFIG` へのフォールバックの2箇所のみで、実際に非既定値を
 * 渡す呼び出し元が無い)、本番では常に既定値(`coef=0.2`)が使われる。既定coefおよび
 * `estimatePlaceOddsMinFromWin` が受理する有限のwinOdds(>=1.0)の組み合わせでは、
 * 出力は常に `isUsableOdds` を満たす(`expected-value.test.ts`「AC-4(b)」describe参照)。
 *
 * **状態の分離(discriminated union化)は本Issueでは行わない。** `estimatePlaceOddsMinFromWin`が
 * null/非有限/値域外を1つのnull戻り値に統合している設計自体の見直しは #23-B の射程
 * (`docs/issue-order.md`「#23-B / #23-Cの再ゲートで必ず扱う論点」参照)。ここで新設すると
 * #23-Bの状態分離設計を先取りすることになる。
 *
 * @param priors 各馬の馬番と複勝圏内確率
 * @param odds 単勝・複勝オッズのスナップショット(単勝オッズのみ使用)
 * @param config EV設定(省略時は既定閾値1.0)
 * @param placeConfig 推定複勝下限の換算係数(省略時は既定coef=0.2)
 */
export function computeEstimatedRaceEv(
  priors: readonly HorsePrior[],
  odds: OddsSnapshot,
  config: EvConfig = DEFAULT_EV_CONFIG,
  placeConfig: EstimatedPlaceConfig = DEFAULT_ESTIMATED_PLACE_CONFIG,
): EstimatedHorseEv[] {
  const threshold = resolveEvThreshold(config.threshold);
  return priors.map((p) => evaluateEstimatedHorse(p, odds, threshold, placeConfig));
}

/** 1頭分の推定EVを評価する(単勝オッズ欠損は対象外として理由付きで返す)。 */
function evaluateEstimatedHorse(
  prior: HorsePrior,
  odds: OddsSnapshot,
  threshold: number,
  placeConfig: EstimatedPlaceConfig,
): EstimatedHorseEv {
  const winOdds = odds.win[prior.umaban]?.odds ?? null;
  const estimatedOddsMin = estimatePlaceOddsMinFromWin(winOdds, placeConfig);

  if (estimatedOddsMin === null) {
    return {
      // Issue #74: estimatePlaceOddsMinFromWinはnull/非有限/MIN_VALID_ODDS未満を1つの
      // null戻り値に統合しているため、「未確定」と断定すると値域外(単勝オッズは存在するが
      // 1.0未満・非有限)の場合に偽になる。到達しうる全ケースで真になる選言にする
      // (状態を分離するdiscriminated union化は#23-Bへ。本Issueでは文言の偽の断定除去のみ)。
      ...excluded(prior, "単勝オッズが未確定または不正な値のため推定複勝下限を算出できない"),
      evEstimated: true,
    };
  }

  const ev = prior.placeProb * estimatedOddsMin;
  return {
    umaban: prior.umaban,
    placeProb: prior.placeProb,
    placeOddsMin: estimatedOddsMin,
    ev,
    isPositive: ev > threshold,
    excludedReason: null,
    evEstimated: true,
  };
}
