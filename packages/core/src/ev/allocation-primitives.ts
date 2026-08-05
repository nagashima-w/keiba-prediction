/**
 * allocation-primitives — 馬券配分最適化の券種非依存プリミティブ(機能D-2a・Issue #14)。
 *
 * 背景: 機能C-1/C-2で複勝専用に実装した `bet-allocation.ts` のロジックを、ワイド・三連複等の
 * 「馬の組」が買い目になる券種へ一般化するにあたり、防御関数群・貪欲最適化・部分集合への畳み込み・
 * betUnit丸め・キャップ比例縮小のゼロ除算ガード・最低額ロジックの数値部分・見送り理由の判定ロジック
 * (文言を除く)は、複勝経路(bet-allocation.ts)と組合せ経路(combo-bet-allocation.ts)で
 * **同一実装を共有する**(boss着手前ゲート2026-08-05の決定)。
 *
 * 共有する理由(最重要): 防御関数群(resolveBankroll等)は C-1 で3回発生した「サイレント破損」
 * 欠陥クラスの再発防止そのものである。この防御ロジックが複勝経路と組合せ経路の2箇所に分かれて
 * 実装されると、将来どちらか一方だけを直して他方が古いまま残る事故(本リポジトリが最も繰り返している
 * 事故形)につながる。よって本ファイルへ一元化し、両経路はここをimportして使う。
 *
 * 共有しないもの(意図的に分離): 見送り理由・advisoryの**文言定数**、券種固有フィールド
 * (placeProb/placeOddsMin/excludedReason、「全出走馬を0円で含める」契約)。理由は
 * bet-allocation.ts・combo-bet-allocation.ts それぞれのJSDoc参照。本ファイルは
 * `determineSkipReasonCode` のように**理由コード(文言を持たない判別共用体)**までを返し、
 * 文言へのマッピングは呼び出し側(各モジュール)の責務とすることで、テキスト結合を作らない。
 *
 * 内部専用モジュール: `package.json` の `exports` には出さない(公開APIを増やさない。
 * boss着手前ゲート決定10)。bet-allocation.ts の公開契約(resolveEffectivePerRaceCapの
 * 公開場所を含む)は本抽出の前後で一切変えない。`bet-allocation.ts` は本ファイルから
 * `resolveEffectivePerRaceCap` を再exportし、既存の import 元(SettingsView.tsx等)を維持する。
 *
 * 挙動の等価性: 本ファイルへの抽出は「1ビットも挙動を変えないリファクタ」として行った。
 * 証拠は既存 `packages/core/test/ev/bet-allocation.test.ts` の73件が無改変のまま全件パスすること
 * (extraction前後で同一の計算順序・同一の浮動小数演算列を保つよう、ループの反復順序等を
 * そのまま移植した)。
 */

import type { PlaceOutcome } from "./place-joint-model.js";

/** 数値誤差を許容する微小値(貪欲配分の資産下限ガードに使う)。 */
const NUMERIC_EPS = 1e-9;

/** ケリー係数の既定値(0.5)。resolveKellyFraction のフォールバック先であり、
 *  bet-allocation.ts の DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction もこの値を参照する
 *  (数値の二重定義を避ける)。 */
export const DEFAULT_KELLY_FRACTION = 0.5;
/** 賭け金の最小単位の既定値(100円)。用途はDEFAULT_KELLY_FRACTIONと同じ。 */
export const DEFAULT_BET_UNIT = 100;
/** 貪欲逐次配分の分割数の既定値(1000)。用途はDEFAULT_KELLY_FRACTIONと同じ。 */
export const DEFAULT_GREEDY_STEPS = 1000;

/**
 * 総資金を解決する(クランプのみ・床関数はかけない)。非有限(NaN/Infinity)・0以下は0を返す。
 * betUnitの倍数への丸めは行わない(1レース単位の話ではなく総資金そのものであるため)。
 */
export function resolveBankroll(bankroll: number): number {
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return 0;
  }
  return bankroll;
}

/**
 * betUnit(賭け金の最小単位)を防御する。非有限・0以下・非整数は既定値(100)へフォールバック
 * する。betUnitが0/NaNのまま割り算に渡ると計算結果がInfinity/NaNになり、以降totalStakeまで
 * NaNが伝播してisSkip=false・skipReason=nullのままサイレントに破損した結果を返してしまう
 * (C-1で発生した重大バグの再発防止)。
 */
export function resolveBetUnit(betUnit: number): number {
  if (!Number.isFinite(betUnit) || betUnit <= 0 || !Number.isInteger(betUnit)) {
    return DEFAULT_BET_UNIT;
  }
  return betUnit;
}

/**
 * greedySteps(貪欲逐次配分の分割数)を防御する。非有限・0以下・非整数は既定値(1000)へ
 * フォールバックする。greedySteps<=0/NaNだと貪欲ループが1回も実行されず、連続最適比率が
 * (実際には判定していないのに)全て0のまま返り、「妙味が小さい」という誤った見送り理由を
 * 報告してしまう(「判定していないことを判定結果として報告してはならない」欠陥の再発防止)。
 */
export function resolveGreedySteps(greedySteps: number): number {
  if (!Number.isFinite(greedySteps) || greedySteps <= 0 || !Number.isInteger(greedySteps)) {
    return DEFAULT_GREEDY_STEPS;
  }
  return greedySteps;
}

/**
 * λ(ケリー係数)を防御する。非有限(NaN/Infinity)・[0,1]範囲外は既定値(0.5)へフォールバック
 * する(bankrollのように「範囲外を0に落とす」クランプではなく既定値へ戻す。λ=0への一律クランプ
 * だと「負値だから何も賭けない」という誤った理由を誘発しうるため)。
 */
export function resolveKellyFraction(kellyFraction: number): number {
  if (!Number.isFinite(kellyFraction) || kellyFraction < 0 || kellyFraction > 1) {
    return DEFAULT_KELLY_FRACTION;
  }
  return kellyFraction;
}

/**
 * 1レース上限を実効値へ解決する(公開関数。SettingsViewの「実効上限」ライブプレビューが使う)。
 * 非有限(NaN/Infinity)・0以下は0を、そうでなければbetUnitの倍数に切り捨てた値を返す。
 * betUnitはこの関数の外で既に resolveBetUnit 済みの値が渡される想定だが、公開APIとして
 * 任意の呼び出し元から異常なbetUnitを渡された場合の防御として、内部でも resolveBetUnit を通す
 * (冪等なので二重に通しても結果は変わらない)。
 */
export function resolveEffectivePerRaceCap(perRaceCap: number, betUnit: number): number {
  const resolvedBetUnit = resolveBetUnit(betUnit);
  if (!Number.isFinite(perRaceCap) || perRaceCap <= 0) {
    return 0;
  }
  return Math.floor(perRaceCap / resolvedBetUnit) * resolvedBetUnit;
}

/**
 * 同時分布を「候補umaban集合との交差」ごとに畳み込む。候補集合に含まれないumabanはTから除外
 * される(候補に限定した部分集合に確率を合算する)。
 *
 * 券種非依存性: candidateUmabanSetを「全候補の買い目に登場するumabanの和集合」として渡せば、
 * 単一馬候補(複勝)・組合せ候補(ワイド・三連複)のいずれでも正しく機能する。理由: 和集合に
 * 含まれる各umaban uについて、outcome.placedとの交差はuの有無を過不足なく表現するため、
 * 「候補combo Cの全メンバーがoutcome.placedに含まれるか」という判定に必要な情報は、
 * 交差後のoutcome.placedからも完全に復元できる(情報を失わない畳み込み)。
 */
export function foldToCandidateSubsets(
  rawDistribution: readonly PlaceOutcome[],
  candidateUmabanSet: ReadonlySet<number>,
): readonly PlaceOutcome[] {
  const folded = new Map<string, { placed: number[]; probability: number }>();
  for (const outcome of rawDistribution) {
    const t = outcome.placed.filter((u) => candidateUmabanSet.has(u)).sort((a, b) => a - b);
    const key = t.join(",");
    const existing = folded.get(key);
    if (existing) {
      existing.probability += outcome.probability;
    } else {
      folded.set(key, { placed: t, probability: outcome.probability });
    }
  }
  return [...folded.values()];
}

/** 貪欲逐次配分に渡す1 outcome分の的中候補インデックス集合。 */
export interface OutcomeIndexSet {
  /** この outcome で的中している候補のインデックス(candidates配列内の位置)。 */
  readonly indices: readonly number[];
  /** この outcome の確率。 */
  readonly probability: number;
}

/**
 * 畳み込み済みoutcomeごとに、的中している候補のインデックス集合を列挙する。
 * 「的中」の定義は呼び出し側が isHit で与える(券種非依存性の要): 複勝なら
 * `outcome.placed.includes(candidate.umaban)`、組合せ券種なら
 * `candidate.umabans.every(u => outcome.placed.includes(u))`(部分集合包含)。
 */
export function buildOutcomeIndexSets<T>(
  candidates: readonly T[],
  foldedOutcomes: readonly PlaceOutcome[],
  isHit: (candidate: T, outcome: PlaceOutcome) => boolean,
): OutcomeIndexSet[] {
  return foldedOutcomes.map((outcome) => {
    const indices: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (isHit(candidates[i]!, outcome)) {
        indices.push(i);
      }
    }
    return { indices, probability: outcome.probability };
  });
}

/**
 * 貪欲逐次配分で連続最適比率(ケリー基準のバンクロール比率 x*_i、0〜1)を求める。
 * 目的関数 F(x) = Σ_T P(T)·log(1 − Σx_i + Σ_{i∈T}x_i·o_i)。
 * 総資金・1レース上限には一切依存しない(スケール不変)。候補が「馬」か「馬の組」かには
 * 一切依存しない(odds・outcomeIndexSetsだけを参照する。的中判定はbuildOutcomeIndexSetsで
 * 済んでいる前提)。
 *
 * 貪欲法に大域最適の理論保証は無い(bet-allocation.ts 由来の既知の注記。目的関数Fはlogの内側で
 * 変数x_iが結合しており分離可能ではないため)。試した範囲では全探索の最適格子点と経験的に
 * 一致した(bet-allocation.test.ts参照)。
 *
 * 計算量: 1ステップあたり候補数×outcome数の評価が必要(greedySteps回繰り返す)。
 */
export function runGreedyAllocation(
  n: number,
  odds: readonly number[],
  outcomeIndexSets: readonly OutcomeIndexSet[],
  greedySteps: number,
): number[] {
  if (n === 0) {
    return [];
  }

  const x = new Array<number>(n).fill(0);
  const delta = 1 / greedySteps;
  let sumX = 0;

  const computeF = (trialSumX: number, trialX: readonly number[]): number | null => {
    let total = 0;
    for (const outcome of outcomeIndexSets) {
      let payout = 0;
      for (const idx of outcome.indices) {
        payout += trialX[idx]! * odds[idx]!;
      }
      const wealth = 1 - trialSumX + payout;
      if (wealth <= NUMERIC_EPS) {
        // 資産が0以下になる割当は候補から除外する(logの定義域外)。
        return null;
      }
      total += outcome.probability * Math.log(wealth);
    }
    return total;
  };

  let currentF = computeF(sumX, x)!; // 全て0の初期状態は必ず有効(wealth=1 for 全outcome)。

  for (let step = 0; step < greedySteps; step++) {
    let bestIdx = -1;
    let bestIncrement = 0; // 増分の最大値が0以下になったら停止するため、初期値は0(厳密に上回る候補のみ採用)。
    const trialSumX = sumX + delta;
    for (let i = 0; i < n; i++) {
      const trialX = x.slice();
      trialX[i] = trialX[i]! + delta;
      const trialF = computeF(trialSumX, trialX);
      if (trialF === null) {
        continue;
      }
      const increment = trialF - currentF;
      if (increment > bestIncrement) {
        bestIncrement = increment;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      break; // 増分の最大値が0以下 → 停止(残りは配分しない=「使い切らない」の実現)。
    }
    x[bestIdx] = x[bestIdx]! + delta;
    sumX = trialSumX;
    currentF = computeF(sumX, x)!;
  }

  return x;
}

/** ケリー適正額・キャップ・比例縮小係数sの計算結果。 */
export interface KellyTarget {
  /** ケリー適正額(キャップ前・丸め前)= λ·Σx*·resolvedBankroll。 */
  readonly kellyTargetStake: number;
  /** min(kellyTargetStake, effectivePerRaceCap)。 */
  readonly plannedStake: number;
  /** kellyTargetStakeがeffectivePerRaceCapを上回り、1レース上限で頭打ちになったか。 */
  readonly capApplied: boolean;
  /** キャップ比例縮小係数(kellyTargetStake=0のときのゼロ除算ガード込み)。 */
  readonly s: number;
}

/**
 * ケリー適正額・キャップ判定・比例縮小係数sを計算する。
 * kellyTargetStake=0のときのゼロ除算ガードが必須(C-1で繰り返した「サイレント破損」欠陥クラスの
 * 再発防止)。
 */
export function computeKellyTarget(
  kellyFraction: number,
  sumContinuousFractions: number,
  resolvedBankroll: number,
  effectivePerRaceCap: number,
): KellyTarget {
  const kellyTargetStake = kellyFraction * sumContinuousFractions * resolvedBankroll;
  const plannedStake = Math.min(kellyTargetStake, effectivePerRaceCap);
  const capApplied = kellyTargetStake > effectivePerRaceCap;
  const s = kellyTargetStake > 0 ? Math.min(1, effectivePerRaceCap / kellyTargetStake) : 0;
  return { kellyTargetStake, plannedStake, capApplied, s };
}

/** betUnit丸め後のstake計算結果。 */
export interface RoundedStakes {
  /** betUnit単位に切り捨てたstake(候補インデックス順)。 */
  readonly rawStakes: number[];
  /** λ縮小後の比率(cap前の理論値。候補インデックス順)。 */
  readonly scaledFractions: number[];
  /** rawStakesの合計。 */
  readonly totalStake: number;
}

/**
 * 各候補のstakeをcap比例縮小込み・betUnit未満切り捨てで算出する。剰余は再配分しない
 * (bet-allocation.ts 設計判断2: 1レース上限は「使い切らなくてよい上限」の直接的な実装)。
 */
export function roundStakes(
  continuousFractions: readonly number[],
  kellyFraction: number,
  s: number,
  resolvedBankroll: number,
  betUnit: number,
): RoundedStakes {
  const rawStakes: number[] = [];
  const scaledFractions: number[] = [];
  let totalStake = 0;
  for (let i = 0; i < continuousFractions.length; i++) {
    const continuousFraction = continuousFractions[i]!;
    const scaledFraction = kellyFraction * continuousFraction;
    const raw = Math.floor((s * scaledFraction * resolvedBankroll) / betUnit) * betUnit;
    const stake = raw < betUnit ? 0 : raw;
    rawStakes.push(stake);
    scaledFractions.push(scaledFraction);
    totalStake += stake;
  }
  return { rawStakes, scaledFractions, totalStake };
}

/** 最低額ロジック適用後の結果。 */
export interface MinimumStakeResult {
  /** 適用後のstake(候補インデックス順。適用箇所以外はrawStakesと同じ)。 */
  readonly rawStakes: number[];
  /** 適用後の合計stake。 */
  readonly totalStake: number;
  /** 最低額ロジックを適用したか。 */
  readonly minimumStakeApplied: boolean;
}

/**
 * 最低額ロジック(bet-allocation.ts 設計判断3)。丸めの結果totalStakeが0円になった場合に限り、
 * continuousFraction最大の1候補にbetUnit1単位を与える。
 *
 * 適用条件(4条件すべてを満たす場合のみ):
 *   - totalStake(丸め後)が0円であること
 *   - continuousFractionが正の候補が1件以上いること
 *   - resolvedBankroll > 0(総資金が有効であること)
 *   - effectivePerRaceCap >= betUnit(1レース上限がbetUnit以上であること)
 *   - kellyTargetStake > 0(λ=0という明示的な「賭けない」指定を尊重するためのガード)
 *
 * タイブレークの契約: 同値の場合は**インデックスが小さい方**(=先に出現した方)を採用する。
 * 呼び出し側は、候補配列をタイブレークで優先したい順序(複勝: 馬番昇順、組合せ券種: 馬番配列の
 * 辞書順)へあらかじめ並べてから渡すこと(本関数自身は候補の識別子を一切参照しない。券種非依存)。
 *
 * **留意事項(code-reviewer指摘・機能D-2a): この契約は本JSDocによる取り決めのみで、実行時の
 * 強制(ソート済みであることの検証)は行っていない。** 抽出前(旧 bet-allocation.ts 内で
 * `candidateHorses[i].umaban < candidateHorses[bestIdx].umaban` を明示的に比較していた実装)から
 * 抽出後の本実装への置き換えは、呼び出し側(bet-allocation.ts・combo-bet-allocation.ts)が
 * いずれも馬番昇順/馬番配列辞書順にソート済みの配列を渡す不変条件のもとで、
 * 出力が完全に一致することを確認済み(ソート済み入力では常に一致・非ソート入力でのみ
 * 結果が食い違うことを比較スクリプトで実測)。将来ソートされていない配列を渡す呼び出しが
 * 追加された場合はこの契約が黙って破られる点に注意。
 */
export function applyMinimumStake(
  rawStakes: readonly number[],
  continuousFractions: readonly number[],
  totalStake: number,
  candidateCount: number,
  resolvedBankroll: number,
  effectivePerRaceCap: number,
  betUnit: number,
  kellyTargetStake: number,
): MinimumStakeResult {
  const nextStakes = [...rawStakes];
  let nextTotal = totalStake;
  let minimumStakeApplied = false;

  if (
    totalStake === 0 &&
    candidateCount > 0 &&
    resolvedBankroll > 0 &&
    effectivePerRaceCap >= betUnit &&
    kellyTargetStake > 0
  ) {
    let bestIdx = -1;
    let bestFraction = 0;
    for (let i = 0; i < continuousFractions.length; i++) {
      const fraction = continuousFractions[i]!;
      if (fraction <= 0) {
        continue;
      }
      // 同値は先に出現したインデックス(=呼び出し側が並べたタイブレーク順)が勝つ。
      if (bestIdx === -1 || fraction > bestFraction) {
        bestIdx = i;
        bestFraction = fraction;
      }
    }
    if (bestIdx !== -1) {
      nextStakes[bestIdx] = betUnit;
      nextTotal = betUnit;
      minimumStakeApplied = true;
    }
  }

  return { rawStakes: nextStakes, totalStake: nextTotal, minimumStakeApplied };
}

/**
 * 見送り理由のコード(文言を持たない判別共用体)。文言は呼び出し側(bet-allocation.ts /
 * combo-bet-allocation.ts)がそれぞれ独立して持つ(見送り理由・advisoryの文言定数は
 * 券種ごとに分離する。boss着手前ゲート2026-08-05決定)。
 */
export type SkipReasonCode =
  | "bankroll-unset"
  | "cap-unset"
  | "cap-too-small"
  | "kelly-zero"
  | "no-candidates"
  | "no-edge";

/**
 * 見送り理由を6分類・優先順位順に決定する(コードのみ。文言化は呼び出し側の責務)。
 * isSkip(totalStake===0)のときにのみ呼び出される想定。
 *
 * 優先順位: ①総資金未設定 → ②1レース上限未設定 → ③1レース上限不足 → ④ケリー係数0
 * → ⑤候補0頭 → ⑥連続最適解ゼロ の順(bet-allocation.ts 設計判断7と同一)。
 */
export function determineSkipReasonCode(
  bankrollInput: number,
  perRaceCapInput: number,
  effectivePerRaceCap: number,
  betUnit: number,
  kellyTargetStake: number,
  kellyFraction: number,
  candidateCount: number,
): SkipReasonCode {
  if (!Number.isFinite(bankrollInput) || bankrollInput <= 0) {
    return "bankroll-unset";
  }
  if (!Number.isFinite(perRaceCapInput) || perRaceCapInput <= 0) {
    return "cap-unset";
  }
  if (effectivePerRaceCap < betUnit) {
    return "cap-too-small";
  }
  if (kellyTargetStake === 0 && kellyFraction === 0) {
    return "kelly-zero";
  }
  if (candidateCount === 0) {
    return "no-candidates";
  }
  return "no-edge";
}
