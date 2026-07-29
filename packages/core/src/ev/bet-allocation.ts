/**
 * bet-allocation — 複勝の馬券配分最適化(馬券配分「機能C-1」の中核)。
 *
 * 背景(ユーザー要望): 1レースあたりに使える予算(上限)を設定しておき、その中で的中率と配当の
 * 妙味から最適と思われる配分をケリー基準で提示する。予算は「上限」であり使い切らなくてよい。
 * 妙味が薄ければ「見送り」も答えとして出す。券種は当面複勝のみ。
 *
 * アルゴリズム全体(仕様「3. アルゴリズムの手順」):
 *   Step0 実効予算 = floor(budget / betUnit) × betUnit
 *   Step1 候補馬の選定(isPositive && placeOddsMin!==null のみ)
 *   Step2 出走全頭でPlaceJointModelの同時分布を構築
 *   Step3 同時分布を「複勝圏に入った候補馬の部分集合T」ごとに畳み込む
 *   Step4 貪欲逐次配分で連続最適比率(ケリー基準)を求める
 *   Step5 λ縮小 → 100円(betUnit)単位への切り捨て。剰余は再配分しない
 *   Step6 見送り判定(5分類)・notDiversified判定
 *
 * 設計判断(なぜこう作ったか):
 *
 * 1. なぜ条件付きベルヌーイモデルを採用したか(独立ケリー正規化を却下した理由):
 *    各馬の複勝的中を独立事象として個別にケリー計算し、後から予算内に正規化する設計は却下した。
 *    複勝は「同時に複数頭が当たりうる」券種であり、頭数・複勝人数という強い制約(必ずちょうど
 *    placeCount頭が当たる)が的中同士に相関を生む。独立仮定で各馬を計算すると、複数の的中を
 *    過度に見込んだ過大な配分になりうる。そこで同時分布モデル(PlaceJointModel)を明示的な
 *    差し替え可能コンポーネントとして切り出し、本ファイル(最適化ロジック)は同時分布が返す
 *    確率だけを使い、馬同士の独立性を一切仮定しない(受け入れ条件6。テストではスタブモデルに
 *    差し替え、完全相関/完全排反で最適化結果が変わることを構造的に検証する)。
 *
 * 2. なぜ剰余を再配分しないか:
 *    100円単位への切り捨てで生じた剰余を他の候補馬に補填(最大剰余法などで繰り上げ)する設計は
 *    却下した。「予算は上限であり使い切らなくてよい」というユーザー要望の直接的な実装として、
 *    切り捨てられた分はそのまま賭けない(totalStake ≤ λ×effectiveBudget ≤ effectiveBudget が
 *    無条件に成立する)。剰余を再配分すると、妙味が薄い馬に無理に賭ける結果になり「見送り」の
 *    選択肢と矛盾する。
 *
 * 3. なぜ貪欲逐次配分(大域最適の保証なし)を採用したか:
 *    目的関数 F(x) = Σ_T P(T)·log(1 − Σx_i + Σ_{i∈T}x_i·o_i) は x について凹関数だが、候補馬が
 *    複数のときの多次元最適化に整数計画・凸最適化ソルバを追加導入するのは「依存パッケージを
 *    追加しない」という制約に反する。そこで、予算をgreedySteps分割し、各ステップで目的関数の
 *    増分が最大の候補に割り当てる貪欲法を採用した。凹関数であっても貪欲法は大域最適の保証がない
 *    (差の上界をテストで固定して明示する。テスト「貪欲配分と全探索の突き合わせ」参照)。
 *
 * 4. Step0/Step1の判定とStep2〜4(診断値・連続最適比率)の計算は独立に行う:
 *    「予算が0(未設定)」「予算不足」「候補0頭」であっても、診断値(placeProbSum等)や各候補の
 *    連続最適比率(kellyFraction)は必ず算出する。理由は次の2点:
 *    (a) placeProbSumDeviation・marginalDeviationMax は予算・候補数と無関係にモデルの性質から
 *        決まる値であり、これらを見送り時に欠落させると、C-2のUIが「なぜ見送りになったか」の
 *        文脈(モデルの乖離状況)を提示できなくなる。
 *    (b) kellyFraction(連続最適比率)は予算の絶対値に依存しない(スケール不変)ため、予算が
 *        不足していても計算コストはゼロに等しい。見送り時にも埋めておくことで、C-2のUIで
 *        「予算があればこう配分したはず」という参考情報を示せる。
 *
 * 5. 見送り理由(skipReason)5分類の優先順位(重要な設計判断):
 *    優先順位は ①予算未設定 → ②予算不足 → ③候補0頭 → ④連続最適解ゼロ → ⑤丸めでゼロ の順。
 *    ①(budget===0)は仕様上の既定値(未設定・opt-in)であり、②(0<budget<betUnit)とは明確に
 *    意味が異なるため分離した。予算未設定は「妙味なし」ではなく「まだ判定していない」状態で
 *    あり、これを③(EVプラスの馬がいないため見送り)と同じ文言で報告すると、ユーザーは
 *    「このレースには妙味がない」と受け取ってしまうが、実際には妙味の評価結果を配分に
 *    反映していないだけである。判定していないことを判定結果として報告してはならない。
 *    そのため、予算不足(①②)は候補の有無(③以降)より常に優先して報告する。
 *
 * 6. 診断値の符号規約(重要。両者で規約が異なる):
 *    - placeProbSumDeviation: 符号付き(placeProbSum − placeProbSumTarget)。正なら合計が目標
 *      (placeCount)を上回る方向、負なら下回る方向に偏っていることを示す。既存 verify.ts の
 *      overconfidenceGap と同じ「乖離は符号付きで残す」規約に合わせた(絶対値からは符号付き値を
 *      復元できないが、逆は可能なため情報を捨てない方を選ぶ)。
 *    - marginalDeviationMax: 絶対値の最大。条件付けにより合計が保存される(周辺確率の合計は
 *      常に一定)ため、各馬の乖離には必ず正負両方が現れ、符号付き最大値を取っても指標として
 *      意味を持たない。よって「乖離の大きさ」だけを表す絶対値の最大とした。
 *
 * C-1のスコープ境界: 本ファイルは packages/core 配下の純関数のみ。設定画面・IPC・renderer表示・
 * verify.ts・analysis-pipeline.ts への配線は C-2/C-3 のスコープであり、本ファイルはそれらに一切
 * 依存しない(入力は AllocationHorse という構造的最小型のみで受け取る)。
 */

import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type PlaceJointModel,
  type PlaceOutcome,
} from "./place-joint-model.js";

// Phase 2 で同時分布モデルを差し替える際、C-2/C-3 が1本のサブパスで完結できるように
// place-joint-model.ts の主要な型・既定モデルを re-export する。
export type { JointModelHorse, PlaceJointModel, PlaceOutcome };
export { CONDITIONAL_BERNOULLI_MODEL };

/** 数値誤差を許容する微小値(浮動小数比較のガードに使う)。 */
const NUMERIC_EPS = 1e-9;

/** 配分最適化に渡す1頭分の情報(構造的最小型。AnalysisRow等shared型には依存しない)。 */
export interface AllocationHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 複勝圏内確率。 */
  readonly placeProb: number;
  /** 複勝オッズ下限。欠損なら null(候補外)。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損なら null。 */
  readonly ev: number | null;
  /** EVプラス判定。 */
  readonly isPositive: boolean;
}

/** 馬券配分の設定。 */
export interface BetAllocationConfig {
  /** 予算上限(円)。既定0(未設定=提案を出さない・opt-in)。 */
  readonly budget: number;
  /** ケリー係数λ(0〜1)。既定0.5。 */
  readonly kellyFraction: number;
  /** 賭け金の最小単位(円)。既定100。 */
  readonly betUnit: number;
  /** 貪欲逐次配分の分割数。既定1000(1ステップ=予算の0.1%)。 */
  readonly greedySteps: number;
}

/** 既定の馬券配分設定。 */
export const DEFAULT_BET_ALLOCATION_CONFIG: BetAllocationConfig = {
  budget: 0,
  kellyFraction: 0.5,
  betUnit: 100,
  greedySteps: 1000,
};

/** 1頭分の配分結果。 */
export interface HorseAllocation {
  /** 馬番。 */
  readonly umaban: number;
  /** 実際の配分額(円。betUnitの倍数)。 */
  readonly stake: number;
  /**
   * λ縮小前の連続最適比率 x*_i(0〜1。予算に依存しないスケール不変値)。
   * 注意(C-2への申し送り): `BetAllocationResult.kellyFraction`(λ・設定値)と同名だが意味が
   * 異なる。ブリーフの型定義をそのまま踏襲したための名前衝突であり、C-2 でUI表示名を決める際に
   * 改称(例: continuousFraction 等)を検討すること。
   */
  readonly kellyFraction: number;
  /** λ縮小後の比率 λ·x*_i。 */
  readonly scaledFraction: number;
  /** 入力の複勝圏内確率(書き換えない)。 */
  readonly placeProb: number;
  /** 複勝オッズ下限。候補外なら null。 */
  readonly placeOddsMin: number | null;
  /** 期待値。候補外なら null。 */
  readonly ev: number | null;
  /** 正の連続配分を得たが100円単位への丸めで0円になったか。 */
  readonly droppedBelowMinimum: boolean;
  /** 候補外の理由。候補なら null。 */
  readonly excludedReason: string | null;
}

/**
 * 配分最適化の診断値。
 * placeProbSumDeviation と marginalDeviationMax は符号規約が異なる(JSDoc参照)。
 */
export interface BetAllocationDiagnostics {
  /** 全出走馬(候補に限らない)の入力placeProbの単純合計。 */
  readonly placeProbSum: number;
  /** placeProbSumの目標値(= placeCount。理論上Σp_i=placeCountが成立すべき値)。 */
  readonly placeProbSumTarget: number;
  /**
   * placeProbSum − placeProbSumTarget(符号付き)。
   * 正なら合計が目標を上回る方向(確率を上げる方向)に偏っている、負なら下回る方向に偏っている。
   * LLM補正後は合計が保証されないため、見送り時も含め必ず算出する。
   */
  readonly placeProbSumDeviation: number;
  /**
   * 同時分布モデル(条件付けにより周辺確率が入力と厳密には一致しないPhase1の既知の不完全性)の
   * 乖離の大きさの最大値(絶対値)。各馬の乖離には方向(正負)が入り混じるため符号は持たない。
   */
  readonly marginalDeviationMax: number;
  /** 候補馬(isPositive && placeOddsMin!==null)の頭数。 */
  readonly candidateCount: number;
  /** 候補外の頭数。 */
  readonly excludedCount: number;
}

/** 馬券配分の最適化結果。 */
export interface BetAllocationResult {
  /** 全出走馬・馬番昇順。候補外も0円で含める。 */
  readonly allocations: readonly HorseAllocation[];
  /** 配分総額(円)。 */
  readonly totalStake: number;
  /** betUnitの倍数に切り捨てた実効予算。 */
  readonly effectiveBudget: number;
  /** 予算の入力値(そのまま。サニタイズしない)。 */
  readonly budgetInput: number;
  /**
   * 実際に適用したケリー係数λ。config.kellyFractionが非有限(NaN/Infinity)または[0,1]範囲外
   * だった場合は既定値(0.5)へフォールバックした後の値(resolveKellyFraction参照)。
   * 入力値そのものではなく、実際に計算へ使われた値である点に注意。
   */
  readonly kellyFraction: number;
  /** 実際に配分された(stake>0の)頭数。 */
  readonly betCount: number;
  /** 見送りか(totalStake===0)。 */
  readonly isSkip: boolean;
  /** 見送り理由。見送りでなければ null。 */
  readonly skipReason: string | null;
  /** 1点配分だが分散できる余地があった(分散できていない)旨の注記。 */
  readonly notDiversified: boolean;
  /** 使用した同時分布モデルの識別子。 */
  readonly modelId: string;
  /** 使用した同時分布モデルが近似か。 */
  readonly modelApproximate: boolean;
  /** 診断値。 */
  readonly diagnostics: BetAllocationDiagnostics;
}

/** 見送り理由(優先順位順)。理由の選定ロジックはコメント「5. 見送り理由...」を参照。 */
const REASON_BUDGET_UNSET = "予算が未設定のため配分を提案していません";
const REASON_BUDGET_TOO_SMALL = "予算が100円未満のため配分できません";
const REASON_NO_CANDIDATES = "EVプラスの馬がいないため見送りです";
const REASON_NO_EDGE = "妙味が小さく、賭ける価値のある配分が見つかりませんでした";
const REASON_ROUNDED_TO_ZERO = "妙味に対して予算が小さく、100円単位で配分できませんでした";

/** 候補外の理由。 */
const EXCLUDED_NOT_POSITIVE = "EVがプラスではないため対象外";
const EXCLUDED_NO_ODDS = "複勝オッズ下限が未確定のため対象外";

/**
 * 複勝の馬券配分を最適化する。
 * @param horses 出走全頭(候補馬に限らない。同時分布は全頭に依存するため)
 * @param placeCount 複勝の対象人数(何着まで複勝圏内か。3をハードコードしない)
 * @param config 馬券配分の設定(省略時は既定・budget=0=未設定)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ。Phase 2の差し替え単位)
 */
export function allocateBets(
  horses: readonly AllocationHorse[],
  placeCount: number,
  config: BetAllocationConfig = DEFAULT_BET_ALLOCATION_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): BetAllocationResult {
  const betUnit = config.betUnit;
  const budgetInput = config.budget;

  // λ(ケリー係数)の防御。budgetと同じ内部一貫性で、非有限(NaN/Infinity)・[0,1]範囲外は
  // 既定値(0.5)へフォールバックする(resolveClipVariant等、本リポジトリの防御的フォールバックの
  // 流儀に合わせる)。λ>1を無防御に許すと totalStake が effectiveBudget を超過しうる
  // (受け入れ条件1違反)。NaN/Infinityを無防御に許すと stake に NaN が混入し、しかも
  // isSkip/skipReasonがそれを検知できずサイレントに破損した結果を返してしまう。
  // 採用した値は BetAllocationResult.kellyFraction に反映し、実際に使われたλを追跡可能にする。
  const kellyFraction = resolveKellyFraction(config.kellyFraction);

  // 出力を馬番昇順にする(入力を書き換えないよう新しい配列を作る)。
  const sortedHorses = [...horses].sort((a, b) => a.umaban - b.umaban);

  // Step0: 実効予算。負値・非有限(NaN/Infinity)は0として扱う(即skip理由①へつながる)。
  const effectiveBudget = computeEffectiveBudget(budgetInput, betUnit);

  // Step1: 候補選定。Step0/Step1の判定結果に関わらず常に行う(設計判断4)。
  const candidateHorses = sortedHorses.filter(
    (h) => h.isPositive && h.placeOddsMin !== null,
  );
  const candidateUmabanSet = new Set(candidateHorses.map((h) => h.umaban));

  // Step2: 出走全頭で同時分布を構築する(候補馬だけでなくレース全頭を渡す)。
  const jointHorses: JointModelHorse[] = sortedHorses.map((h) => ({
    umaban: h.umaban,
    placeProb: h.placeProb,
  }));
  const rawDistribution = model.buildDistribution(jointHorses, placeCount);

  // 診断値: 全出走馬のplaceProb合計・目標との乖離(符号付き)。
  const placeProbSum = sortedHorses.reduce((acc, h) => acc + h.placeProb, 0);
  const placeProbSumTarget = placeCount;
  const placeProbSumDeviation = placeProbSum - placeProbSumTarget;

  // 診断値: Step2の畳み込み前(全頭)の同時分布から求めた各馬の周辺確率と入力placeProbの
  // 乖離の絶対値の最大(marginalDeviationMaxは符号を持たない。JSDoc参照)。
  const marginalDeviationMax = computeMarginalDeviationMax(sortedHorses, rawDistribution);

  // Step3: 候補馬の部分集合Tへ畳み込む。
  const foldedOutcomes = foldToCandidateSubsets(rawDistribution, candidateUmabanSet);

  // Step4: 貪欲逐次配分で連続最適比率(ケリー基準)を求める。budget/候補数に関わらず常に計算する
  // (設計判断4)。effectiveBudgetに一切依存しないためスケール不変(受け入れ条件5)。
  const continuousFractions = optimizeContinuousFractions(
    candidateHorses,
    foldedOutcomes,
    config.greedySteps,
  );

  // Step5: λ縮小 → betUnit単位への切り捨て。剰余は再配分しない(設計判断2)。
  const allocationByUmaban = new Map<number, HorseAllocation>();
  let totalStake = 0;
  for (let i = 0; i < candidateHorses.length; i++) {
    const horse = candidateHorses[i]!;
    const kelly = continuousFractions[i]!;
    const scaledFraction = kellyFraction * kelly;
    const rawStake = Math.floor((scaledFraction * effectiveBudget) / betUnit) * betUnit;
    const stake = rawStake < betUnit ? 0 : rawStake;
    totalStake += stake;
    allocationByUmaban.set(horse.umaban, {
      umaban: horse.umaban,
      stake,
      kellyFraction: kelly,
      scaledFraction,
      placeProb: horse.placeProb,
      placeOddsMin: horse.placeOddsMin,
      ev: horse.ev,
      // droppedBelowMinimum(要修正3): 「丸め判定に到達した場合」に限定する。effectiveBudget が
      // betUnit未満(予算未設定・予算不足)のときは、そもそも丸め判定に到達しておらず
      // (skipReason①②がその状態を説明する)、この時点でkelly>0の候補全てにtrueが立つと
      // 「丸めで落とされた」という誤った説明になる(excludedReasonの重大バグと同じ欠陥クラス。
      // 判定していないことを判定結果として報告してはならない)。
      droppedBelowMinimum: kelly > 0 && stake === 0 && effectiveBudget >= betUnit,
      excludedReason: null,
    });
  }

  // 候補外の馬も欠落させず0円で含める(受け入れ条件9)。
  for (const horse of sortedHorses) {
    if (allocationByUmaban.has(horse.umaban)) {
      continue;
    }
    allocationByUmaban.set(horse.umaban, {
      umaban: horse.umaban,
      stake: 0,
      kellyFraction: 0,
      scaledFraction: 0,
      placeProb: horse.placeProb,
      placeOddsMin: horse.placeOddsMin,
      ev: horse.ev,
      droppedBelowMinimum: false,
      // placeOddsMin===null(オッズ未確定)を先に判定する。呼び出し規約上、オッズ未確定の馬は
      // ev===null・isPositive===false になる(evaluateHorse/excluded と同じ規約)ため、
      // !isPositive を先に見ると「まだ判定できていない(オッズ未確定)」馬まで「EVがプラスで
      // はない(判定した結果マイナス)」と誤ラベルしてしまう。skipReasonの優先順位(未判定を
      // 判定結果として報告しない)と同じ思想で、判定不能 > 判定結果マイナス の順に判定する。
      excludedReason: horse.placeOddsMin === null ? EXCLUDED_NO_ODDS : EXCLUDED_NOT_POSITIVE,
    });
  }

  const allocations = sortedHorses.map((h) => allocationByUmaban.get(h.umaban)!);
  const betCount = allocations.filter((a) => a.stake > 0).length;
  const isSkip = totalStake === 0;

  // Step6: 見送り理由(5分類・優先順位順)。isSkipのときのみ算出する。
  const skipReason = isSkip
    ? determineSkipReason(budgetInput, effectiveBudget, betUnit, candidateHorses.length, continuousFractions)
    : null;

  // notDiversified(訂正①): betCount===1 のときのみtrueになりうる。betCount===0(見送り)は
  // isSkip/skipReasonが説明責任を負うため常にfalse。
  const positiveContinuousCount = continuousFractions.filter((x) => x > 0).length;
  const notDiversified = betCount === 1 && positiveContinuousCount >= 2;

  return {
    allocations,
    totalStake,
    effectiveBudget,
    budgetInput,
    kellyFraction,
    betCount,
    isSkip,
    skipReason,
    notDiversified,
    modelId: model.id,
    modelApproximate: model.approximate,
    diagnostics: {
      placeProbSum,
      placeProbSumTarget,
      placeProbSumDeviation,
      marginalDeviationMax,
      candidateCount: candidateHorses.length,
      excludedCount: sortedHorses.length - candidateHorses.length,
    },
  };
}

/**
 * Step0: 実効予算を計算する。budgetが非有限(NaN/Infinity)・0以下のときは0を返す
 * (見送り理由①「予算未設定」へ自然につながる。Step5の資金換算も0で安全に完結する)。
 */
function computeEffectiveBudget(budget: number, betUnit: number): number {
  if (!Number.isFinite(budget) || budget <= 0) {
    return 0;
  }
  return Math.floor(budget / betUnit) * betUnit;
}

/**
 * λ(ケリー係数)を防御する。非有限(NaN/Infinity)・[0,1]範囲外は既定値(0.5)へフォールバック
 * する(resolveClipVariant等、本リポジトリの防御的フォールバックの流儀に合わせる。budgetのように
 * 「範囲外を0に落とす」クランプではなく既定値へ戻すのは、λ=0への一律クランプだと「負値だから
 * 何も賭けない」という誤った理由(丸め起因のようなskipReason)を誘発しうるため。既定値
 * フォールバックであれば、以降の計算は「正常なλで判定した結果」として一貫する)。
 */
function resolveKellyFraction(kellyFraction: number): number {
  if (!Number.isFinite(kellyFraction) || kellyFraction < 0 || kellyFraction > 1) {
    return DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction;
  }
  return kellyFraction;
}

/**
 * Step2の畳み込み前(全頭)の同時分布から、各馬がいずれかの複勝圏内の組に含まれる確率
 * (周辺確率)を求め、入力placeProbとの乖離の絶対値の最大を返す。
 * 条件付けにより周辺確率の合計は保存されるため、乖離には正負両方が必ず現れる
 * (符号付き最大値は指標として無意味。よって絶対値の最大とする)。
 */
function computeMarginalDeviationMax(
  horses: readonly AllocationHorse[],
  rawDistribution: readonly PlaceOutcome[],
): number {
  const marginalByUmaban = new Map<number, number>();
  for (const outcome of rawDistribution) {
    for (const umaban of outcome.placed) {
      marginalByUmaban.set(umaban, (marginalByUmaban.get(umaban) ?? 0) + outcome.probability);
    }
  }
  let maxDeviation = 0;
  for (const horse of horses) {
    const marginal = marginalByUmaban.get(horse.umaban) ?? 0;
    const deviation = Math.abs(marginal - horse.placeProb);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
    }
  }
  return maxDeviation;
}

/**
 * Step3: 同時分布を「複勝圏に入った候補馬の部分集合T」ごとに畳み込む。候補馬でない馬は
 * Tから除外される(候補馬に限定した部分集合に確率を合算する)。
 */
function foldToCandidateSubsets(
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
 * Step4: 貪欲逐次配分で連続最適比率(ケリー基準のバンクロール比率 x*_i、0〜1)を求める。
 * 目的関数 F(x) = Σ_T P(T)·log(1 − Σx_i + Σ_{i∈T}x_i·o_i)。
 * 予算(effectiveBudget)には一切依存しない(スケール不変。受け入れ条件5)。
 *
 * 貪欲法は大域最適の保証がない(目的関数は凹だが、多次元の逐次貪欲探索であるため)。
 * これは既知の設計上の限界であり、テスト(全探索との突き合わせ)で差の上界を固定して明示する。
 *
 * 計算量(C-2の判断材料として実測値を残す): 1ステップあたり候補数×畳み込み後outcome数の
 * 評価が必要(greedySteps回繰り返す)。実測では出走頭数18・全頭候補(最悪ケースに近い。
 * 畳み込み後outcome数はC(18,3)=816)・greedySteps=1000で約13ms(開発機実測)。実運用の
 * 候補数(通常は数頭程度)ではさらに軽量。現時点でブロッカーではない。
 */
function optimizeContinuousFractions(
  candidates: readonly AllocationHorse[],
  foldedOutcomes: readonly PlaceOutcome[],
  greedySteps: number,
): number[] {
  const n = candidates.length;
  if (n === 0) {
    return [];
  }

  const odds = candidates.map((c) => c.placeOddsMin!);
  // 各畳み込み済み outcome を候補配列内インデックスの集合として持っておく(高速化)。
  const outcomeIndexSets = foldedOutcomes.map((outcome) => {
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (outcome.placed.includes(candidates[i]!.umaban)) {
        indices.push(i);
      }
    }
    return { indices, probability: outcome.probability };
  });

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

/**
 * Step6: 見送り理由を5分類・優先順位順に決定する(設計判断5参照)。
 * isSkip(totalStake===0)のときにのみ呼び出される。
 */
function determineSkipReason(
  budgetInput: number,
  effectiveBudget: number,
  betUnit: number,
  candidateCount: number,
  continuousFractions: readonly number[],
): string {
  // ①予算が未設定・負値・非有限(NaN/Infinity)。opt-inの既定状態であり「妙味なし」ではない。
  if (!Number.isFinite(budgetInput) || budgetInput <= 0) {
    return REASON_BUDGET_UNSET;
  }
  // ②予算はあるがbetUnit未満(実効予算が1単位に満たない)。
  if (effectiveBudget < betUnit) {
    return REASON_BUDGET_TOO_SMALL;
  }
  // ③候補(EVプラスかつオッズあり)が1頭もいない。
  if (candidateCount === 0) {
    return REASON_NO_CANDIDATES;
  }
  // ④連続最適比率が全て0(妙味が極小で、賭ける価値がないとケリー基準が判断した)。
  if (continuousFractions.every((x) => x === 0)) {
    return REASON_NO_EDGE;
  }
  // ⑤連続最適比率は正だが、100円単位への丸めで全て0円になった。
  return REASON_ROUNDED_TO_ZERO;
}
