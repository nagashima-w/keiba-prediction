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
 * 証拠は既存 `packages/core/test/ev/bet-allocation.test.ts` の80件が無改変のまま全件パスすること
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

/**
 * 貪欲逐次配分に渡す1 outcome分の的中候補インデックス集合。
 *
 * **不変条件**: `indices`は**同一outcome内で重複を含まない**(同じインデックスが2回以上
 * 現れない)。この不変条件は構築元(`buildOutcomeIndexSets`・`combo-bet-allocation.ts`の
 * `determined`枝)がどちらも「候補インデックスiを0から昇順に1回ずつ走査し、的中していれば
 * pushする」という構造で組み立てているため、データに依存せず常に成立する構造的な保証である
 * (実データでの事後確認ではなく、構築ロジック自体がこの性質を保証する)。
 *
 * この不変条件はIssue #96で検討した`fresh = commonWealth[j] + delta*odds[i]`という
 * O(1)の恒等式(`runGreedyAllocation`の`computeFreshWealth`をO(1)化する案)が依存する
 * 前提として洗い出したものである。**この案自体は同Issueで不採用になった**(数学的には
 * 同値だが浮動小数演算としてはビット一致するとは限らず、実際に既存テストの結果を反転
 * させたため。`runGreedyAllocation`のJSDoc「検討したが採用しなかった案」参照)が、
 * この不変条件自体は`indices`の構築ロジックが持つ性質として引き続き真であり、
 * 将来同種の最適化を検討する際の前提として記録しておく。
 */
export interface OutcomeIndexSet {
  /** この outcome で的中している候補のインデックス(candidates配列内の位置)。重複なし(上記JSDoc参照)。 */
  readonly indices: readonly number[];
  /** この outcome の確率。 */
  readonly probability: number;
}

/**
 * `indices`(的中候補インデックス集合)が完全一致する`OutcomeIndexSet`をまとめ、
 * `probability`を合算する(Issue #96)。
 *
 * ## 背景: 単勝(win)候補が1件でもあると計算量が跳ね上がる問題への対処
 *
 * `combo-bet-allocation.ts`の`allocateGeneralBets`は、win候補が1件でもあり順序が決定できた
 * (`determined`)呼び出しで、`foldToCandidateSubsets`(集合空間への畳み込み)を経由せず、
 * 順序付きoutcome空間(`P(頭数,topFinishCount)`通り。畳み込み無し)をそのまま
 * `runGreedyAllocation`/`computeHitProbabilities`へ渡していた(Issue #92の裁定:
 * winのidentity判定〈`order[0]===umaban`〉は`foldToCandidateSubsets`〈`placed`を候補集合と
 * 交差させ昇順ソートする「順序を捨てる」畳み込み〉を通すと壊れるため、意図的に通さない
 * 設計だった)。この結果、集合空間なら`C(候補数,3)`程度で済むところが、順序空間では
 * `P(候補数,3)`(6倍)になり、実測で`buildMixedAllocationDisplay`が約7.9倍遅くなった
 * (Issue #96)。
 *
 * ## この関数がなぜ正しさを壊さずに高速化になるのか
 *
 * `foldToCandidateSubsets`とは**別物の畳み込み**である: `foldToCandidateSubsets`は`placed`
 * (的中馬番の集合)を書き換える(順序情報を失う)畳み込みだが、本関数は`indices`列
 * (どの買い目候補が的中したか)を**一切変更しない**。同じ`indices`を持つoutcome同士は
 * `wealth_T`(候補の連続比率`x`とオッズから決まる資産額)が常に同一の値になるため
 * (`wealth`は`indices`とその中身〈`x[idx]`・`odds[idx]`〉だけで決まり、`indices`が同じなら
 * `x`・`odds`が同じである限りいつでも同一)、目的関数への寄与
 * `P1·log(wealth_T) + P2·log(wealth_T) = (P1+P2)·log(wealth_T)`
 * が数学的に厳密に成り立つ。したがって「同じ`indices`を持つ複数のoutcomeをまとめて
 * 確率を足し合わせる」ことは、win候補の識別性(`indices`列そのもの)を一切失わずに
 * outcome件数だけを減らせる(実測: 中央16頭の実オッズで3360件→1023件。
 * `scripts/bench-mixed-allocation.ts`で再現可能)。
 *
 * ## 適用範囲
 *
 * `combo-bet-allocation.ts`の`determined`枝(順序付きoutcome空間を直接使う経路)にのみ
 * 適用する。**集合空間(`else`枝、`foldToCandidateSubsets`を通す経路)には適用しない**
 * (#92が非破壊を宣言した既存経路を触る理由が無いため。boss裁定・Issue #96)。
 *
 * ## 出力の性質
 *
 * - 出力順は決定的(同じ入力に対し常に同じ順序を返す。内部でMapを使い、キーの初出順=
 *   入力での初出順を保つ)。
 * - 署名がすべて異なる入力では、件数・順序・`probability`が入力と完全に一致する
 *   (畳み込みが実質的に何もしないケースで挙動が変わらないことの保証)。
 */
export function foldOutcomeIndexSetsBySignature(
  outcomeIndexSets: readonly OutcomeIndexSet[],
): OutcomeIndexSet[] {
  const folded = new Map<string, { indices: readonly number[]; probability: number }>();
  for (const outcome of outcomeIndexSets) {
    const key = outcome.indices.join(",");
    const existing = folded.get(key);
    if (existing) {
      existing.probability += outcome.probability;
    } else {
      folded.set(key, { indices: outcome.indices, probability: outcome.probability });
    }
  }
  return [...folded.values()];
}

/**
 * 畳み込み済みoutcomeごとに、的中している候補のインデックス集合を列挙する。
 * 「的中」の定義は呼び出し側が isHit で与える(券種非依存性の要): 複勝なら
 * `outcome.placed.includes(candidate.umaban)`、組合せ券種なら
 * `candidate.umabans.every(u => outcome.placed.includes(u))`(部分集合包含)。
 *
 * **単勝(win)の的中判定はこの部分集合包含ではない**(Issue #92)。win候補は
 * `outcome.order[0] === candidate.umaban`(1着の identity 判定)であり、`foldedOutcomes`
 * (`PlaceOutcome[]`。順序を持たない)を経由できない(`order`情報自体を持たないため)。
 * `combo-bet-allocation.ts`の`allocateGeneralBets`はwin候補があり順序が決定できた
 * (`determined`)呼び出しで、本関数(`buildOutcomeIndexSets`)を通さず、`OrderedOutcome[]`
 * から`OutcomeIndexSet[]`を直接構築する(win候補があっても`indeterminate`の呼び出しは
 * `else`枝に落ちて本関数を通る。`combo-bet-allocation.ts`の該当コメント参照)。
 * 型ジェネリック`<T>`は候補型のみで、outcome型は`PlaceOutcome`に固定されたまま。
 * outcome型を汎用化する変更は#92のスコープでは行わなかった。
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

/** runGreedyAllocation の結果。収束(局所最適に到達)したのか、貪欲分割数(greedySteps)を
 *  使い切って打ち切られただけなのかを明示的に区別する(boss指摘・2026-08-05: 「無制限側の
 *  Σx*=1.000は収束ではなくgreedyStepsを使い切ったという意味であり、品質の基準線にならない」)。 */
export interface GreedyAllocationResult {
  /** 各候補の連続最適比率 x*_i(0〜1。候補配列と同じ順序)。 */
  readonly fractions: number[];
  /**
   * 増分の最大値が0以下になり、貪欲法が自然に停止した(局所最適に到達した)ら true。
   * false は greedySteps を使い切って打ち切られたことを意味し、「収束した」とは言えない
   * (まだ改善の余地があったのに予算が尽きただけの可能性がある)。
   */
  readonly converged: boolean;
}

/**
 * 貪欲逐次配分で連続最適比率(ケリー基準のバンクロール比率 x*_i、0〜1)を求める。
 * 目的関数 F(x) = Σ_T P(T)·log(1 − Σx_i + Σ_{i∈T}x_i·o_i)。
 * 総資金・1レース上限には一切依存しない(スケール不変)。候補が「馬」か「馬の組」かには
 * 一切依存しない(odds・outcomeIndexSetsだけを参照する。的中判定は呼び出し側で既に済んで
 * いる前提。**構築元は`buildOutcomeIndexSets`とは限らない**(Issue #92)。win候補があり
 * 順序が決定できた呼び出しは`buildOutcomeIndexSets`を通さず、順序付きoutcome空間から
 * 直接`indices`を構築する。**Issue #96以降は`foldOutcomeIndexSetsBySignature`(署名畳み込み)
 * を経由した`OutcomeIndexSet[]`が渡ることもある。** 本関数自身はどの構築元・畳み込みの
 * 有無でも同じロジックで動作し区別しない)。
 *
 * 貪欲法に大域最適の理論保証は無い(bet-allocation.ts 由来の既知の注記。目的関数Fはlogの内側で
 * 変数x_iが結合しており分離可能ではないため)。試した範囲では全探索の最適格子点と経験的に
 * 一致した(bet-allocation.test.ts参照)。
 *
 * ## 計算量最適化(機能D-2a・boss指摘2026-08-05への対応)
 *
 * 旧実装は1ステップあたり「候補数×outcome数」の評価が必要で、現実的なオッズ分布
 * (`scripts/bench-allocation.ts` で再現可能。正EV候補が数百〜987件規模になりうる)では
 * 無制限(candidateCapを外した場合)で数秒〜十数秒かかることが実測で判明した
 * (`pnpm tsx scripts/bench-allocation.ts` の出力参照)。
 *
 * ### 高速化の根拠: 厳密な共通部分式の除去(近似ではない)
 *
 * 候補iをδだけ増やす試行で、outcome Tのwealthは「T∌i: 一律に−δ」「T∋i: −δ+δ·o_i」の
 * 2パターンにしか分岐しない。**T∌iの場合、trialXとxの差は第i成分だけであり、i∉Tである以上
 * その差はTのpayout(Σ_{idx∈T}trialX[idx]·o[idx])には一切現れない。** つまりT∌iのwealthは
 * 候補iの選び方に依存せず、**全候補で厳密にビット単位で同一の値**になる(近似でも
 * 「丸め誤差の再現」でもない。旧実装が候補ごとにこの値を毎回計算し直していたのは、
 * 単に同じ式を候補数だけ重複計算していただけであり、1ステップに1回だけ計算するのは
 * 教科書的な共通部分式の除去そのものである)。
 *
 * 一方T∋iのwealth(候補iが実際に属すoutcomeでの値。1つのoutcomeが的中しうる候補数は
 * 高々2^topFinishCount−1という定数で頭打ちになる)は候補iごとに異なる値になる
 * (変化する部分)。具体的には、outcome Tごとに
 *   - 現在のxでの payout P_T = Σ_{idx∈T} x[idx]·o[idx]
 *   - commonWealth_T = 1 − trialSumX + P_T
 * を1ステップに1回だけ計算し(T∌iの場合の値そのもの)、T∋iの場合だけ候補iに対応する
 * freshWealth_T(下記「Issue #96」節参照)に置き換える。候補iのtrialF相当値は
 *   trialLogSum_i = commonLogSum − Σ_{T∋i} P(T)·log(commonWealth_T) + Σ_{T∋i} P(T)·log(freshWealth_T)
 * (commonLogSum = Σ_T P(T)·log(commonWealth_T)、1ステップに1回だけ計算)。
 *
 * **EPSガード(wealth≤EPSで除外)の扱い**: 上記の構成が使えるのは、(a) 一様シフト後の
 * 全outcomeの最小commonWealth、(b) 各候補の接触先でのfreshWealthの最小値、の両方がEPSを
 * 上回る場合に限る(どちらか一方でも0以下になるとlogの定義域外になる)。これを毎ステップ
 * O(outcome数+総接触数)で判定し、安全なら高速パス、そうでなければ旧来のブルートフォース
 * (O(候補数×outcome数))へフォールバックする(高オッズ×低確率などEPSに近づく極端な入力の
 * 稀なステップでのみ発生。頻度が低いため全体の実測時間への影響は軽微)。
 *
 * **状態更新(x・sumX・currentF)は常に`computeF`(ブルートフォースと同一の関数。未改変)による
 * フレッシュな再計算で行う**(高速パスの中間値は候補選択〈bestIdxの決定〉にのみ使う)。
 *
 * ## Issue #96: win候補混在時の計算量再増加への対応
 *
 * #92で単勝(win)候補を扱えるようにした際、win候補が1件でもあると集合空間(`C(候補数,3)`)
 * ではなく順序付きoutcome空間(`P(候補数,3)`。6倍)がそのまま本関数へ渡るようになり、
 * `buildMixedAllocationDisplay`が実測で約7.9倍遅くなった(再現: `pnpm tsx
 * scripts/bench-mixed-allocation.ts`)。#96はこれを次の2点で緩和する。
 *
 * 1. **署名畳み込み(呼び出し側の責務。`foldOutcomeIndexSetsBySignature`)**: `indices`が
 *    完全一致するoutcome同士は`wealth`が常に同一になるため確率を合算でき、実測で
 *    outcome数を3360→1023(中央16頭の実オッズ)へ削減する。本関数自体を変更するものでは
 *    なく、`OutcomeIndexSet[]`を受け取る契約は変わらない。
 * 2. **ビット厳密なメモ化**: `Math.log(commonWealth[j])`を`commonLogSum`算出時に1回だけ
 *    計算して配列に保持し、候補評価ループで再利用する。同様に`freshWealth`(旧実装と全く
 *    同じ式・操作列で計算する。下記参照)もworstFresh算出パスで1回だけ計算して配列に保持し、
 *    候補評価ループで再利用する。**どちらも「同じ引数に対する同じ関数値を1回だけ計算して
 *    使い回す」だけなので、値そのものは構成上ビット同一になる**(D-2aのcommonWealth再利用と
 *    同種の共通部分式除去。したがって上記1点目〈署名畳み込み〉を適用しない限り、本関数
 *    単体の挙動はこのIssueの前後で1ビットも変わらない)。
 *
 * ### 検討したが採用しなかった案: computeFreshWealthのO(1)化
 *
 * `fresh = commonWealth[j] + delta·odds[i]`という恒等式(前提:
 * `i`が`outcomeIndexSets[j].indices`に重複なくちょうど1回含まれること。`OutcomeIndexSet`の
 * JSDoc参照)を使えば`computeFreshWealth`をO(1)化できる。数学的には旧実装(該当outcomeの
 * `indices`をループしてpayoutを再構成する版)と厳密に同値だが、**浮動小数演算としては
 * ビット一致するとは限らない**(`(a+δ)·o`と`a·o+δ·o`は数学的には等しいが、IEEE754の
 * 乗算・加算は分配則を厳密には満たさないため)。
 *
 * このビット差は、`x`・`sumX`・`currentF`の更新が常に未改変の`computeF`によるフレッシュな
 * 再計算で行われる(上記「状態更新」参照)ため状態に直接蓄積しないが、高速パスの候補評価
 * ループで求めた`increment`の**argmax(`bestIdx`)が反転する**経路で最終的な`fractions`に
 * 伝わりうる。**実際にこの反転を`bet-allocation.test.ts`「キャップでbetCountが2頭→1頭に
 * 減り、notDiversifiedが立つこと」で実測した**(全odds=3で目的関数が平坦になる退化ケース。
 * 同ファイルのJSDocが「貪欲の評価順序・加算順序が生む丸め誤差というタイブレークがたまたま
 * 選んだ1点」の検知用番人と明記している。O(1)化を適用するとbetCountが2→1に変化し、
 * `pnpm --filter @keiba/core test`が赤くなった。O(1)化を外し旧来のループ版に戻すと
 * 全件緑に戻ることも実測済み)。AC-3(既存テストの非破壊)を満たせないため不採用とした
 * (boss確認済み。署名畳み込み〈上記1点目〉だけでも実測3360→1023outcomeの削減効果があり、
 * #96の目的は達成できる)。
 *
 * ### 確認できた範囲(鉄則8: 観測していないことを断定しない)
 *
 * 確認できているのは次の点である:
 *   1. 既存 `bet-allocation.test.ts` の80件超(複勝経路。無改変)が、D-2a・#96いずれの
 *      置き換えの前後でも出力がビット一致すること(`toBe` による厳密等価)
 *   2. `allocation-primitives.test.ts`の「高速パスとブルートフォースが同じ結果になること」
 *      (テーブル駆動。候補数・outcome数・接触密度・オッズ分布の異なる複数条件×greedySteps
 *      複数水準)が、Issue #96のメモ化導入後もブルートフォース参照実装(未改変)と`toEqual`で
 *      厳密一致すること
 * この確認範囲を超えて「あらゆる入力で常にビット一致する」とは主張しない。
 *
 * 実測: `pnpm tsx scripts/bench-allocation.ts`(D-2a時点)・
 * `pnpm tsx scripts/bench-mixed-allocation.ts`(Issue #96時点)。具体的な数値は実行環境に
 * 依存するため、再現コマンドで都度確認すること(固定の数値をここに書き込まない)。
 */
export function runGreedyAllocation(
  n: number,
  odds: readonly number[],
  outcomeIndexSets: readonly OutcomeIndexSet[],
  greedySteps: number,
): GreedyAllocationResult {
  if (n === 0) {
    return { fractions: [], converged: true };
  }

  const outcomeCount = outcomeIndexSets.length;

  // 候補→接触先outcomeの逆引き(「総接触数」分だけ。ステップループの外で1回だけ構築する)。
  const contactsByCandidate: number[][] = Array.from({ length: n }, () => [] as number[]);
  for (let j = 0; j < outcomeCount; j++) {
    for (const idx of outcomeIndexSets[j]!.indices) {
      contactsByCandidate[idx]!.push(j);
    }
  }

  const x = new Array<number>(n).fill(0);
  const delta = 1 / greedySteps;
  let sumX = 0;

  // 旧来のブルートフォース計算。フォールバック専用として温存する(EPSガードがきわどい
  // 稀なステップと、状態更新〈currentFの再計算〉の両方で使う。既存実装と完全に同じ式)。
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
  let converged = false;

  for (let step = 0; step < greedySteps; step++) {
    const trialSumX = sumX + delta;

    // commonWealth_T = 1 - trialSumX + P_T(現在のxでのpayout)。
    const commonWealth = new Array<number>(outcomeCount);
    for (let j = 0; j < outcomeCount; j++) {
      let payout = 0;
      for (const idx of outcomeIndexSets[j]!.indices) {
        payout += x[idx]! * odds[idx]!;
      }
      commonWealth[j] = 1 - trialSumX + payout;
    }

    // 安全性チェック(O(outcome数+総接触数)): commonWealthの最小値と、各候補の接触先での
    // freshWealthの最小値をどちらも求める。両方がEPSを上回っていれば高速パスが使える。
    let worstCommon = Infinity;
    for (let j = 0; j < outcomeCount; j++) {
      if (commonWealth[j]! < worstCommon) {
        worstCommon = commonWealth[j]!;
      }
    }

    // 採用B(2)(Issue #96): 接触先outcome1件分のfreshWealthを、旧実装(bet-allocation.test.ts
    // 抽出前からの既存式)と全く同じ式・操作列で1回だけ計算し、候補ごとの配列に保存して
    // 下記の候補評価ループ(高速パス)で再利用する(同じ値を2回計算しない。「同じ引数に対する
    // 同じ関数値を1回だけ計算する」だけなので値はビット同一になる)。
    //
    // 【採用C(fresh = commonWealth[j] + delta*odds[i]というO(1)の恒等式)は不採用】
    // (Issue #96・boss確認済み)。数学的には同値だが、浮動小数演算としては旧来のループ版と
    // ビット一致しない(IEEE754の乗算・加算は分配則を厳密には満たさないため)。この差が
    // argmax(bestIdx)の反転を実際に引き起こすことを`bet-allocation.test.ts`「キャップで
    // betCountが2頭→1頭に減り、notDiversifiedが立つこと」(全odds=3で目的関数が平坦になる
    // 退化ケース。同ファイルのJSDocが「貪欲の評価順序・加算順序が生む丸め誤差というタイブレーク
    // がたまたま選んだ1点」の検知用番人と明記している)で実測した(betCountが2→1に変化し
    // `pnpm --filter @keiba/core test`が赤くなった。C抜き・旧来のループ版に戻すと全2544件が
    // 緑に戻ることも実測済み)。AC-3(既存テストの非破壊)を満たせないため、Cは採用しない
    // (署名畳み込み〈採用A〉だけでも実測3360→1023outcomeの削減効果があり、#96の目的は
    // A+Bで達成できる)。
    let worstFresh = Infinity;
    const freshByCandidate: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const contacts = contactsByCandidate[i]!;
      const freshValues = new Array<number>(contacts.length);
      for (let k = 0; k < contacts.length; k++) {
        const j = contacts[k]!;
        let payout = 0;
        for (const idx of outcomeIndexSets[j]!.indices) {
          const v = idx === i ? x[idx]! + delta : x[idx]!;
          payout += v * odds[idx]!;
        }
        const fresh = 1 - trialSumX + payout;
        freshValues[k] = fresh;
        if (fresh < worstFresh) {
          worstFresh = fresh;
        }
      }
      freshByCandidate[i] = freshValues;
    }
    const safe = Math.min(worstCommon, worstFresh) > NUMERIC_EPS;

    let bestIdx = -1;
    let bestIncrement = 0; // 増分の最大値が0以下になったら停止するため、初期値は0(厳密に上回る候補のみ採用)。

    if (safe) {
      // 高速パス: O(outcome数+総接触数)。
      // 採用B(1)(Issue #96): commonLogSum(全候補共通)の算出と同じループで
      // Math.log(commonWealth[j])を1回だけ計算して配列に保持し、候補評価ループで再利用する
      // (旧実装は候補ごとに同じlogを再計算していた)。
      let commonLogSum = 0;
      const commonLogWealth = new Array<number>(outcomeCount);
      for (let j = 0; j < outcomeCount; j++) {
        const logW = Math.log(commonWealth[j]!);
        commonLogWealth[j] = logW;
        commonLogSum += outcomeIndexSets[j]!.probability * logW;
      }
      for (let i = 0; i < n; i++) {
        let trialLogSum = commonLogSum;
        const contacts = contactsByCandidate[i]!;
        const freshValues = freshByCandidate[i]!;
        for (let k = 0; k < contacts.length; k++) {
          const j = contacts[k]!;
          const prob = outcomeIndexSets[j]!.probability;
          trialLogSum = trialLogSum - prob * commonLogWealth[j]! + prob * Math.log(freshValues[k]!);
        }
        const increment = trialLogSum - currentF;
        if (increment > bestIncrement) {
          bestIncrement = increment;
          bestIdx = i;
        }
      }
    } else {
      // フォールバック: 旧来のブルートフォース(O(候補数×outcome数))。EPSガードがきわどい
      // 稀なステップでのみ発生する。既存実装と完全に同じ式・同じ走査順のため、この分岐が
      // 選ばれるステップの結果は旧実装とビット一致する。
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
    }

    if (bestIdx === -1) {
      converged = true; // 増分の最大値が0以下 → 局所最適に到達して自然停止(「使い切らない」の実現)。
      break;
    }
    // 状態(x・sumX・currentF)の更新は常に旧実装と同じcomputeFによるフレッシュな再計算で行う
    // (高速パスの中間値はbestIdxの選択にのみ使い、状態更新には使わない)。
    x[bestIdx] = x[bestIdx]! + delta;
    sumX = trialSumX;
    currentF = computeF(sumX, x)!;
  }

  return { fractions: x, converged };
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
 * オッズの値域の下限(1.0)。オッズは「賭け金が最低でも戻ってくる倍率」であり1.0未満の値は
 * 値域外(Issue #74)。`0`は構文上は正当な数値だが値域外であり、旧基準`value > 0`は
 * `[0,1)`をすべて通してしまっていた(#31→#74で1.0へ引き上げ)。
 *
 * **この定数を変えたら、以下も同時に直すこと(boss裁定Q1(b)・2026-09-04)**:
 *   - `expected-value.ts` の除外理由文言「複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外」
 *   - 値域を断定している散文(`combo-bet-allocation.ts`・`bet-allocation.ts`・`verify.ts`の
 *     「1.0未満」表記。#74 AC-11で是正した箇所)
 * 定数だけを変えると `allocation-primitives.test.ts` の「値域の定数と文言は同時に直す」テストが
 * 赤くなる(1つの `it()` の中で定数と文言の両方をハードコードしたリテラルとして固定しているため)。
 */
export const MIN_VALID_ODDS = 1.0;

/**
 * オッズとして使える値か(1.0以上の有限値)を判定する(Issue #31→#74で基準を`>0`から
 * `>=MIN_VALID_ODDS`(1.0)へ引き上げ)。
 *
 * 背景(Issue #31): `combo-bet-allocation.ts` の `validateCandidates`(門番・throw基準)と
 * `resolveComboOdds`(分類器・`malformed`基準)が `!Number.isFinite(x) || x <= 0` を独立に
 * 2回実装していた(将来どちらか一方だけ基準を変えて他方が古いまま残る、本リポジトリが
 * 繰り返してきた事故形)。複勝経路(`bet-allocation.ts`)の候補フィルタも同じ基準を必要と
 * したため(候補外の1頭に `NaN`/`Infinity` が混じると `runGreedyAllocation` の増分がNaN汚染され、
 * 健全な他の馬の配分まで巻き添えで消える)、本述語へ1本化した。
 *
 * 背景(Issue #74): オッズの値域は「1.0以上」であり`0`は値域外だが、旧基準`value > 0`は
 * `[0,1)`を通してしまい、複勝EV側(`expected-value.ts`)が `oddsMin=0` を
 * `ev = placeProb×0 = 0` という「正常な判定結果」に潰していた(判定不能と判定結果の混同。
 * #31の原則違反)。基準を`value >= MIN_VALID_ODDS`へ引き上げ、全呼び出し元に同時適用する。
 * **数(単位を明記。呼び出し箇所=実際に`isUsableOdds(...)`を呼ぶ式の数、モジュール=そのファイル数。
 * 定義自身の行・コメント内の言及は含まない)**:
 *   - **#74着手前**: 呼び出し6・モジュール3(`combo-bet-allocation.ts`2・`bet-allocation.ts`3・
 *     `verify.ts`1)
 *   - **#74で追加**: `probability-quality-metrics.ts`1・`expected-value.ts`1・
 *     `build-prompt.ts`1(いずれも本Issueで新規に委譲)
 *   - **#74後**: 呼び出し9・モジュール6
 * 再現(このファイルを含む`packages/core/src`全体を対象にすること。`ev/`だけに絞ると
 * `analyzer/build-prompt.ts`の1件を取りこぼす):
 * `grep -c "isUsableOdds(" <各ファイルパス>` でファイルごとの出現**行数**を数え、
 * コメント内出現(`bet-allocation.ts`1件・`expected-value.ts`1件。加えて本ファイル自身の
 * この段落にも「isUsableOdds(」という字面が複数回登場する)を除いた行が実呼び出し。
 *
 * **`grep -rhoE "isUsableOdds\(" packages/core/src | wc -l`(定義・コメント内言及を含む
 * 総出現数)は、この段落を編集するたびに変わる自己参照値である。固定の数として本文に
 * 書き込まない(#73 R5・本Issueで一度実際にここで13→14の食い違いを起こした教訓)。
 * 呼び出し箇所・モジュールの数(上記「#74後: 呼び出し9・モジュール6」)だけが安定した
 * 意味のある数であり、確認したいときはその都度上記コマンドで数え直すこと。**
 *
 * **null判定は含まない(呼び出し側の責務)**: 引数の型を `number` のみとし `number | null` を
 * 受け取らないのは意図的。「未確定(null)」と「不正値(数値だが使えない)」は意味が異なり、
 * この区別を呼び出し側が保持し続けることで、excludedReason等の文言分岐(判定不能の内訳)を
 * 呼び出し側で作り分けられるようにする(本述語に混ぜるとその区別が失われる)。
 *
 * **適用範囲は「オッズ」に限る(馬番の検証には使わない)**: `validateCandidates` の馬番検証
 * (`umabans`)も式としては同一の `!Number.isFinite(u) || u <= 0` だが、これは「馬番として
 * 妥当か」という別概念であり、式が同じなのは偶然に過ぎない。ここへ本述語を流用すると、
 * 将来オッズ側の基準だけを変えた際に馬番の検証まで意図せず道連れで変わってしまう
 * (#74でオッズ側の基準を1.0へ引き上げた際も、馬番側の散文・基準は一切変更していない)。
 */
export function isUsableOdds(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_VALID_ODDS;
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
 * `SkipReasonCode`の全メンバーの一覧(Issue #80・AC-A5)。
 *
 * この配列自体はテストの期待値ではなく、`SkipReasonCode`という**型**が今後増えていないことを
 * 機械的に検査するための唯一の正である(`packages/core/test/ev/allocation-primitives.test.ts`が
 * 独立したリテラル配列と`toEqual`で突き合わせる)。
 *
 * 下記`AssertAllSkipReasonCodesCovered`は、`SkipReasonCode`に新しい値を追加してこの配列の
 * 更新を忘れると型検査(`pnpm typecheck`)がコンパイルエラーで検出する仕掛け
 * (`Exclude<SkipReasonCode, 本配列の要素型>`が`never`にならなければ、`= true`の代入が失敗する)。
 * 逆方向(本配列が`SkipReasonCode`に無い値を含む)は`satisfies readonly SkipReasonCode[]`が
 * 型検査時点で弾く。両方向により本配列は`SkipReasonCode`と過不足なく一致する。
 */
export const ALL_SKIP_REASON_CODES = [
  "bankroll-unset",
  "cap-unset",
  "cap-too-small",
  "kelly-zero",
  "no-candidates",
  "no-edge",
] as const satisfies readonly SkipReasonCode[];

type MissingSkipReasonCodes = Exclude<SkipReasonCode, (typeof ALL_SKIP_REASON_CODES)[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 型検査だけが目的の代入(値は使わない)。
const _assertAllSkipReasonCodesCovered: MissingSkipReasonCodes extends never
  ? true
  : ["SkipReasonCodeに値を追加したらALL_SKIP_REASON_CODESも更新すること", MissingSkipReasonCodes] = true;
void _assertAllSkipReasonCodesCovered;

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
