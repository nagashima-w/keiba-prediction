/**
 * combo-bet-allocation — 買い目が「馬の組」になる券種(ワイド・三連複)への配分最適化の一般化
 * (機能D-2a・Issue #14)。
 *
 * 背景: 機能C-1/C-2で複勝専用に実装した `bet-allocation.ts` の配分ロジックを、ワイド・三連複が
 * 扱えるよう一般化する。boss着手前ゲート(2026-08-05)の決定に基づき、次の方針で実装した。
 *
 * 1. `bet-allocation.ts` の公開契約(allocateBetsのシグネチャ・AllocationHorse/BetAllocation/
 *    BetAllocationResult/BetAllocationConfigの各フィールド名・型・resolveEffectivePerRaceCapの
 *    公開場所)は一切変更しない。既存 `bet-allocation.test.ts` の73件は無改変のまま全件パスする
 *    (`git diff` で確認済み。報告参照)。`packages/app/**` も一切変更しない。
 * 2. 防御関数群・貪欲最適化・畳み込み・betUnit丸め・キャップ比例縮小・最低額ロジック・
 *    見送り理由の判定ロジック(文言を除く)は `allocation-primitives.ts` を通じて
 *    `bet-allocation.ts` と共有する(重複実装しない)。
 * 3. 見送り理由・advisoryの文言、券種固有フィールドは複勝側と独立して定義する(意図的な分離)。
 *
 * 2層構成:
 *   - 汎用エンジン `allocateGeneralBets`: 買い目候補(`AllocationCandidate`。umabans配列で
 *     券種非依存)を受け取り配分を最適化する。候補が単一馬(複勝)か組(ワイド・三連複)かに
 *     一切依存しない。**券種混在**(複勝1頭候補・ワイド2頭組・三連複3頭組を同じ配列に混ぜる)にも
 *     対応する(受け入れ条件8)。ただし本タスクでは renderer 配線・UI・設定は行わない
 *     (API形状のみ用意する)。
 *   - 候補ビルダー `buildComboCandidates`: ワイド・三連複向けに、出走馬番からの組合せ列挙・
 *     オッズMapからの3状態解決(present/missing/unfetched)・EV算出(既存
 *     `expected-value.ts` の `EvConfig`/`DEFAULT_EV_CONFIG` を再利用し閾値を二重定義しない)を
 *     行い、`allocateGeneralBets` への入力(`AllocationCandidate[]`)を作る。
 *
 * k(topFinishCount)についての重要な注意:
 *   ワイド・三連複の的中判定は「同時分布モデルが返す上位k着の集合に、買い目の全馬番が
 *   含まれるか(部分集合包含)」である。boss着手前ゲートで実測したフィクスチャ(5頭立てで
 *   複勝2点・ワイド3点=C(3,2))が示すとおり、ワイド・三連複はkが7頭以下でも常に3である。
 *   これは複勝の払戻対象人数(`resolvePlaceBetTarget().placeCount`。5〜7頭は対象外/4頭以下は
 *   非発売という別の判定)とは**無関係の独立した概念**である。呼び出し側は
 *   `resolvePlaceBetTarget` の結果をそのまま `topFinishCount` に流用してはならない
 *   (誤用するとワイド・三連複の的中確率が構造的に0になる。症状はテストで固定している。
 *   `combo-bet-allocation.test.ts`「kとplaceCountの分離」参照)。
 */

import {
  DEFAULT_EV_CONFIG,
  type EvConfig,
} from "./expected-value.js";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type PlaceJointModel,
  type PlaceOutcome,
} from "./place-joint-model.js";
import {
  applyMinimumStake,
  buildOutcomeIndexSets,
  computeKellyTarget,
  DEFAULT_BET_UNIT,
  DEFAULT_GREEDY_STEPS,
  DEFAULT_KELLY_FRACTION,
  determineSkipReasonCode,
  foldToCandidateSubsets,
  resolveBankroll,
  resolveBetUnit,
  resolveEffectivePerRaceCap,
  resolveGreedySteps,
  resolveKellyFraction,
  roundStakes,
  runGreedyAllocation,
  type OutcomeIndexSet,
  type SkipReasonCode,
} from "./allocation-primitives.js";

export type { JointModelHorse, PlaceJointModel, PlaceOutcome, EvConfig };
export { CONDITIONAL_BERNOULLI_MODEL, DEFAULT_EV_CONFIG };

// ============================================================================
// 汎用エンジン(券種非依存)
// ============================================================================

/**
 * 券種一般の買い目候補(構造的最小型)。複勝なら `umabans.length===1`、ワイドなら2、
 * 三連複なら3。odds/ev/isPositiveは呼び出し側(buildComboCandidates等)が算出済みの値を渡す。
 *
 * 契約: umabansは**昇順・重複なし**であること。違反する候補が1件でも含まれる場合、
 * `allocateGeneralBets` は例外を投げる(黙って通さない。受け入れ条件7)。
 */
export interface AllocationCandidate {
  /** 買い目を構成する馬番の組(昇順・重複なし)。 */
  readonly umabans: readonly number[];
  /**
   * 採用したオッズ(単一値)。
   *
   * **ワイドは下限を使う(保守的見積り)**。既存 `expected-value.ts` の
   * `computeRaceEv`(複勝EV = placeProb × placeOddsMin)が複勝オッズの下限を採用している流儀を
   * 踏襲する。ワイドは最終配当が下限〜上限のレンジで確定する券種であり(仕様「4. ev — 期待値計算」
   * のコメント参照)、下限を使うとEVを過小評価する方向に倒れるため、EVプラス判定・配分計算が
   * 楽観的にならない(妙味を過大評価しない)。三連複はオッズが単一値で確定しているため、
   * そのまま採用する(下限/上限の選択問題自体が存在しない。
   * `docs/wide-trio-odds-investigation.md` §2.3「ワイドは幅(下限-上限)、3連複は単一値」参照)。
   *
   * **本モジュールはスカラー(既に1つに決まったオッズ値)を受け取る契約であり、
   * レンジ(下限-上限)から下限を選び出す変換ロジック自体は本モジュールに存在しない。**
   * その変換は呼び出し側(D-2b、Issue #27でのオッズ取得・配線実装)の責務である。
   * 誤解を避けるための明記: `buildComboCandidates` の `oddsByKey: ReadonlyMap<string, number | null>`
   * も同様にスカラー値を受け取るのみで、ワイドのレンジ表現(例: `[下限, 上限, 人気]`)から
   * 下限を取り出す処理は呼び出し側が済ませてから渡す必要がある。
   */
  readonly odds: number;
  /** 期待値(的中確率×odds)。 */
  readonly ev: number;
  /** EVプラス判定。falseの候補は最適化対象から除外される。 */
  readonly isPositive: boolean;
}

/** 候補上限の既定値。18頭全頭(複勝候補数の最大)では発動せず、混在時の987候補級で効く値として
 *  実測(報告参照)に基づき暫定採用した(boss着手前ゲート決定5・本実装で確定)。 */
export const DEFAULT_CANDIDATE_CAP = 50;

/** 券種一般の配分最適化設定。bet-allocation.tsのBetAllocationConfigに candidateCap を加えた形。 */
export interface GeneralBetAllocationConfig {
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly betUnit: number;
  readonly greedySteps: number;
  /** 最適化に渡す候補数の上限(EV降順・同値は馬番配列の辞書順でタイブレークして選抜)。 */
  readonly candidateCap: number;
}

/** 既定の券種一般配分設定。数値既定値は allocation-primitives.ts を参照し二重定義しない。 */
export const DEFAULT_GENERAL_BET_ALLOCATION_CONFIG: GeneralBetAllocationConfig = {
  bankroll: 0,
  perRaceCap: 0,
  kellyFraction: DEFAULT_KELLY_FRACTION,
  betUnit: DEFAULT_BET_UNIT,
  greedySteps: DEFAULT_GREEDY_STEPS,
  candidateCap: DEFAULT_CANDIDATE_CAP,
};

/**
 * 1買い目分の配分結果。
 * bet-allocation.tsのBetAllocationとの違い(意図的な分離):
 *   - umaban(number) ではなく umabans(number[])。
 *   - 「全出走馬を0円で含める」契約は採らない。最適化に載せた買い目(候補cap適用後)だけを
 *     行として返す(候補外・オッズ欠損・未取得の買い目は診断値の件数で表現し、行としては
 *     出さない。決定: 組合せ券種は「候補として最適化に載せた買い目」だけを行として返す)。
 *   - placeProb(入力echo)ではなく hitProb(同時分布から**導出**した値)。組合せ候補の的中確率は
 *     外部から与えられる入力ではなく、同時分布から計算するしかないため。
 */
export interface GeneralBetAllocation {
  /** 買い目を構成する馬番の組(昇順・重複なし)。 */
  readonly umabans: readonly number[];
  /** 実際の配分額(円。betUnitの倍数)。 */
  readonly stake: number;
  /** λ縮小前の連続最適比率 x*_i。 */
  readonly continuousFraction: number;
  /** λ縮小後の比率(cap前の理論値)。 */
  readonly scaledFraction: number;
  /** 同時分布から導出したこの買い目の的中確率。 */
  readonly hitProb: number;
  /** 採用したオッズ。 */
  readonly odds: number;
  /** 期待値。 */
  readonly ev: number;
  /** 正の連続配分を得たが丸めで0円になったか。 */
  readonly droppedBelowMinimum: boolean;
}

/**
 * 券種一般の配分最適化の診断値。判定結果(judged)と判定不能(unjudged)を型レベルで
 * 混同させない(決定6)。本エンジン自体は「isPositiveな入力候補」しか受け取らないため、
 * EV非プラス/オッズ欠損/未取得の内訳は候補ビルダー側(ComboCandidateDiagnostics)が持つ。
 * 本エンジンが独自に持つのは「候補cap適用前後」の件数のみ。
 */
export interface GeneralBetAllocationDiagnostics {
  /** isPositiveな入力候補の数(candidateCap適用前)。 */
  readonly inputCandidateCount: number;
  /** candidateCapにより最適化から切り捨てられた候補数。 */
  readonly truncatedByCapCount: number;
  /** 実際に最適化に載せた候補数(= min(inputCandidateCount, candidateCap))。 */
  readonly candidateCount: number;
}

/** 券種一般の配分最適化結果。 */
export interface GeneralBetAllocationResult {
  /** 最適化に載せた買い目だけ(馬番配列の辞書順で決定的)。 */
  readonly allocations: readonly GeneralBetAllocation[];
  readonly totalStake: number;
  readonly bankrollInput: number;
  readonly perRaceCapInput: number;
  readonly resolvedBankroll: number;
  readonly effectivePerRaceCap: number;
  readonly kellyTargetStake: number;
  readonly plannedStake: number;
  readonly capApplied: boolean;
  readonly minimumStakeApplied: boolean;
  readonly exceedsKellyTarget: boolean;
  readonly advisory: string | null;
  readonly kellyFraction: number;
  readonly betCount: number;
  readonly isSkip: boolean;
  readonly skipReason: string | null;
  readonly notDiversified: boolean;
  readonly modelId: string;
  readonly modelApproximate: boolean;
  readonly diagnostics: GeneralBetAllocationDiagnostics;
}

/** 見送り理由(券種一般。決定3: 語は「買い目」に統一)。 */
const REASON_BANKROLL_UNSET = "総資金が未設定のため配分を提案していません";
const REASON_CAP_UNSET = "1レースの上限が未設定のため配分を提案していません";
const REASON_KELLY_ZERO = "ケリー係数が0のため配分しません";
const REASON_NO_CANDIDATES = "EVプラスの買い目がないため見送りです";
const REASON_NO_EDGE = "妙味が小さく、賭ける価値のある配分が見つかりませんでした";

function buildCapTooSmallReason(betUnit: number): string {
  return `1レースの上限が${betUnit}円未満のため配分できません`;
}

/** 見送り理由コード(allocation-primitives.ts)を券種一般の日本語文言へ変換する。 */
function skipReasonText(code: SkipReasonCode, betUnit: number): string {
  switch (code) {
    case "bankroll-unset":
      return REASON_BANKROLL_UNSET;
    case "cap-unset":
      return REASON_CAP_UNSET;
    case "cap-too-small":
      return buildCapTooSmallReason(betUnit);
    case "kelly-zero":
      return REASON_KELLY_ZERO;
    case "no-candidates":
      return REASON_NO_CANDIDATES;
    case "no-edge":
      return REASON_NO_EDGE;
  }
}

/** 適正額超過の警告文言(bet-allocation.tsと同内容だが、決定3により独立して定義する)。 */
function buildAdvisory(exceedsKellyTarget: boolean, kellyTargetStake: number, betUnit: number): string | null {
  if (!exceedsKellyTarget) {
    return null;
  }
  const kellyTargetYen = Math.round(kellyTargetStake);
  return (
    `ケリー適正額 ¥${kellyTargetYen} に対し、最小単位の${betUnit}円を配分しています。` +
    "適正額を上回る賭け方であり、長期的な資産成長率を下げます。"
  );
}

/**
 * candidateCap(候補上限)を防御する。非有限・0以下・非整数は既定値(50)へフォールバックする
 * (resolveBetUnit等と同じ流儀)。
 */
function resolveCandidateCap(candidateCap: number): number {
  if (!Number.isFinite(candidateCap) || candidateCap <= 0 || !Number.isInteger(candidateCap)) {
    return DEFAULT_CANDIDATE_CAP;
  }
  return candidateCap;
}

/** 馬番配列を辞書順(要素ごとの昇順、長さが異なれば短い方を先)で比較する。 */
function compareUmabansLex(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

/** 候補cap選抜用の比較(EV降順、同値は馬番配列の辞書順=決定5)。 */
function compareCandidatesForCap(a: AllocationCandidate, b: AllocationCandidate): number {
  if (a.ev !== b.ev) {
    return b.ev - a.ev;
  }
  return compareUmabansLex(a.umabans, b.umabans);
}

/**
 * 候補の正規化を検証する(受け入れ条件7)。馬番の組が「厳密な昇順」(=重複なし)でない候補、
 * または同じ組が複数回登場する場合は例外を投げる(黙って通さない)。
 */
function validateCandidates(candidates: readonly AllocationCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { umabans } = candidate;
    if (umabans.length === 0) {
      throw new Error("不正な買い目です: 馬番の組が空です");
    }
    for (let i = 1; i < umabans.length; i++) {
      if (umabans[i]! <= umabans[i - 1]!) {
        throw new Error(
          `不正な買い目です: 馬番の組は昇順・重複なしである必要があります(${umabans.join(",")})`,
        );
      }
    }
    const key = umabans.join(",");
    if (seen.has(key)) {
      throw new Error(`重複した買い目が含まれています(${key})`);
    }
    seen.add(key);
  }
}

/** 畳み込み済みoutcomeから各候補の的中確率(周辺確率)を導出する。 */
function computeHitProbabilities(n: number, outcomeIndexSets: readonly OutcomeIndexSet[]): number[] {
  const hitProbs = new Array<number>(n).fill(0);
  for (const outcome of outcomeIndexSets) {
    for (const idx of outcome.indices) {
      hitProbs[idx] = hitProbs[idx]! + outcome.probability;
    }
  }
  return hitProbs;
}

/**
 * 券種一般の馬券配分を最適化する。買い目候補(AllocationCandidate)は単一馬(複勝)・
 * 2頭組(ワイド)・3頭組(三連複)のいずれでもよく、**混在してもよい**(受け入れ条件8)。
 *
 * @param horses 出走全頭(候補に限らない。同時分布は全頭の複勝圏内確率に依存するため)
 * @param topFinishCount 上位何着までを的中判定に使うか。**複勝の払戻対象人数
 *   (resolvePlaceBetTarget().placeCount)とは別概念**。ワイド・三連複では常に3を渡すこと
 *   (誤って複勝の対象人数を流用すると的中確率が構造的に0になる。JSDoc冒頭参照)。
 * @param candidates 買い目候補。isPositive===falseの候補は最適化対象から除外される
 *   (0件行としても出力されない。判定結果の内訳は呼び出し側〈候補ビルダー〉の診断値が持つ)。
 * @param config 配分設定(省略時は既定・bankroll=perRaceCap=0=未設定)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ)
 */
export function allocateGeneralBets(
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  candidates: readonly AllocationCandidate[],
  config: GeneralBetAllocationConfig = DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): GeneralBetAllocationResult {
  validateCandidates(candidates);

  const bankrollInput = config.bankroll;
  const perRaceCapInput = config.perRaceCap;
  const betUnit = resolveBetUnit(config.betUnit);
  const greedySteps = resolveGreedySteps(config.greedySteps);
  const kellyFraction = resolveKellyFraction(config.kellyFraction);
  const candidateCap = resolveCandidateCap(config.candidateCap);

  const resolvedBankroll = resolveBankroll(bankrollInput);
  const effectivePerRaceCap = resolveEffectivePerRaceCap(perRaceCapInput, betUnit);

  // isPositiveな候補だけを対象にする(bet-allocation.tsのStep1と同じ思想)。
  const positiveCandidates = candidates.filter((c) => c.isPositive);

  // 候補cap: EV降順・同値は馬番配列の辞書順で選抜する(決定5)。
  const rankedForCap = [...positiveCandidates].sort(compareCandidatesForCap);
  const truncatedByCapCount = Math.max(0, rankedForCap.length - candidateCap);
  const selected = rankedForCap.slice(0, candidateCap);

  // 最適化・出力の順序は馬番配列の辞書順で安定させる(受け入れ条件11: 出力の決定性)。
  const finalCandidates = [...selected].sort((a, b) => compareUmabansLex(a.umabans, b.umabans));

  const candidateUmabanSet = new Set<number>();
  for (const c of finalCandidates) {
    for (const u of c.umabans) {
      candidateUmabanSet.add(u);
    }
  }

  const rawDistribution = model.buildDistribution(horses, topFinishCount);
  const foldedOutcomes = foldToCandidateSubsets(rawDistribution, candidateUmabanSet);
  const outcomeIndexSets = buildOutcomeIndexSets(finalCandidates, foldedOutcomes, (c, outcome) =>
    c.umabans.every((u) => outcome.placed.includes(u)),
  );
  const hitProbs = computeHitProbabilities(finalCandidates.length, outcomeIndexSets);
  const odds = finalCandidates.map((c) => c.odds);
  const continuousFractions = runGreedyAllocation(finalCandidates.length, odds, outcomeIndexSets, greedySteps);
  const sumContinuousFractions = continuousFractions.reduce((acc, x) => acc + x, 0);

  const { kellyTargetStake, plannedStake, capApplied, s } = computeKellyTarget(
    kellyFraction,
    sumContinuousFractions,
    resolvedBankroll,
    effectivePerRaceCap,
  );

  const rounded = roundStakes(continuousFractions, kellyFraction, s, resolvedBankroll, betUnit);
  let rawStakes = rounded.rawStakes;
  let totalStake = rounded.totalStake;

  const minimumStakeResult = applyMinimumStake(
    rawStakes,
    continuousFractions,
    totalStake,
    finalCandidates.length,
    resolvedBankroll,
    effectivePerRaceCap,
    betUnit,
    kellyTargetStake,
  );
  rawStakes = minimumStakeResult.rawStakes;
  totalStake = minimumStakeResult.totalStake;
  const minimumStakeApplied = minimumStakeResult.minimumStakeApplied;

  // 丸め判定に到達したかどうか(bet-allocation.tsと同じ防御)。
  const reachedRoundingDecision = resolvedBankroll > 0 && effectivePerRaceCap >= betUnit;

  const allocations: GeneralBetAllocation[] = finalCandidates.map((c, i) => {
    const continuousFraction = continuousFractions[i]!;
    const stake = rawStakes[i]!;
    return {
      umabans: c.umabans,
      stake,
      continuousFraction,
      scaledFraction: kellyFraction * continuousFraction,
      hitProb: hitProbs[i]!,
      odds: c.odds,
      ev: c.ev,
      droppedBelowMinimum: continuousFraction > 0 && stake === 0 && reachedRoundingDecision,
    };
  });

  const betCount = allocations.filter((a) => a.stake > 0).length;
  const isSkip = totalStake === 0;
  const exceedsKellyTarget = totalStake > kellyTargetStake;
  const advisory = buildAdvisory(exceedsKellyTarget, kellyTargetStake, betUnit);

  const skipReason = isSkip
    ? skipReasonText(
        determineSkipReasonCode(
          bankrollInput,
          perRaceCapInput,
          effectivePerRaceCap,
          betUnit,
          kellyTargetStake,
          kellyFraction,
          finalCandidates.length,
        ),
        betUnit,
      )
    : null;

  const positiveContinuousCount = continuousFractions.filter((x) => x > 0).length;
  const notDiversified = betCount === 1 && positiveContinuousCount >= 2;

  return {
    allocations,
    totalStake,
    bankrollInput,
    perRaceCapInput,
    resolvedBankroll,
    effectivePerRaceCap,
    kellyTargetStake,
    plannedStake,
    capApplied,
    minimumStakeApplied,
    exceedsKellyTarget,
    advisory,
    kellyFraction,
    betCount,
    isSkip,
    skipReason,
    notDiversified,
    modelId: model.id,
    modelApproximate: model.approximate,
    diagnostics: {
      inputCandidateCount: positiveCandidates.length,
      truncatedByCapCount,
      candidateCount: finalCandidates.length,
    },
  };
}

// ============================================================================
// 候補ビルダー(ワイド・三連複固有)
// ============================================================================

/**
 * ワイド・三連複等のオッズMapキーを生成する唯一の正規化関数(決定2)。
 * netkeibaの実キー形式(`docs/wide-trio-odds-investigation.md` §2.3。ワイド"0102"・
 * 3連複"010203")に一致させる: 馬番昇順ソート後、2桁ゼロ埋めで連結する。
 * 呼び出し側にキー文字列を組み立てさせない(キー形式の二重定義を防ぐ)。
 */
export function buildComboOddsKey(umabans: readonly number[]): string {
  return [...umabans]
    .sort((a, b) => a - b)
    .map((u) => String(u).padStart(2, "0"))
    .join("");
}

/**
 * combo オッズの解決結果(判別共用体)。取得済み/欠損(null)/未取得(キー不在)の3状態を
 * 区別する(決定2)。`Map#get(...) ?? null` のような未取得と欠損の同一視を禁止する
 * (本リポジトリが繰り返した「判定不能を判定結果と誤ラベルする」欠陥クラスの再発防止)。
 */
export type ComboOddsResolution =
  | { readonly state: "present"; readonly odds: number }
  | { readonly state: "missing" }
  | { readonly state: "unfetched" };

/** oddsByKeyから馬番の組のオッズを3状態判別共用体で解決する唯一の関数。 */
export function resolveComboOdds(
  oddsByKey: ReadonlyMap<string, number | null>,
  umabans: readonly number[],
): ComboOddsResolution {
  const key = buildComboOddsKey(umabans);
  if (!oddsByKey.has(key)) {
    return { state: "unfetched" };
  }
  // has()で存在を確認済みのため、get()の戻り値は number | null に限られる
  // (undefinedの可能性はMap#getの型シグネチャ上の保険であり、ここでは到達しない)。
  const value = oddsByKey.get(key)!;
  if (value === null) {
    return { state: "missing" };
  }
  return { state: "present", odds: value };
}

/** 候補ビルダーの診断値。判定結果(judged)と判定不能(unjudged)を型レベルで分離する(決定6)。 */
export interface ComboCandidateDiagnostics {
  /** 列挙した買い目の総数(= C(出走頭数, comboSize))。 */
  readonly enumeratedCount: number;
  /** 判定結果(オッズを取得でき、EVを計算できた買い目)。 */
  readonly judged: {
    /** EVプラスと判定し候補にした数(= candidates.length)。 */
    readonly positiveCount: number;
    /** EV非プラスで候補外にした数。 */
    readonly notPositiveCount: number;
  };
  /** 判定不能(オッズが取得できずEVを計算できなかった買い目)。 */
  readonly unjudged: {
    /** オッズ欠損(Mapの値がnull)で評価できなかった数。 */
    readonly oddsMissingCount: number;
    /** 未取得(Mapにキーが存在しない)のため評価していない数。 */
    readonly oddsUnfetchedCount: number;
  };
}

/** 候補ビルダーの結果。 */
export interface ComboCandidateBuildResult {
  /** EVプラスと判定した候補(allocateGeneralBetsへそのまま渡せる)。 */
  readonly candidates: readonly AllocationCandidate[];
  readonly diagnostics: ComboCandidateDiagnostics;
}

/** items(昇順)から要素数kの組合せを列挙する(順序は決定的。place-joint-model.tsの
 *  kCombinationsと同じアルゴリズムだが、券種非依存モジュール間の依存を増やさないため
 *  独立して持つ)。 */
function kCombinationsOfUmabans(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
  if (k <= 0 || k > items.length) {
    return results;
  }
  const current: number[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

/**
 * combo(馬番の組)の的中確率を、同時分布(畳み込み前の生の分布)から直接導出する。
 * combo.length===topFinishCountの場合(例: 三連複×k=3)は「T=combo」の1点のみが該当し、
 * combo.length<topFinishCountの場合(例: ワイド×k=3)は「combo⊆T」を満たす全Tの確率を合算する。
 */
function computeComboHitProb(combo: readonly number[], rawDistribution: readonly PlaceOutcome[]): number {
  let total = 0;
  for (const outcome of rawDistribution) {
    if (combo.every((u) => outcome.placed.includes(u))) {
      total += outcome.probability;
    }
  }
  return total;
}

/**
 * ワイド・三連複向けの買い目候補を構築する(列挙+オッズ3状態解決+EV算出)。
 *
 * @param horses 出走全頭(複勝圏内確率。同時分布構築に使う)
 * @param topFinishCount 上位何着までを的中判定に使うか(ワイド・三連複は常に3。JSDoc冒頭参照)
 * @param comboSize 買い目を構成する頭数(ワイド=2、三連複=3)
 * @param oddsByKey buildComboOddsKeyで生成したキーへのオッズMap(値がnullなら欠損、
 *   キーが無ければ未取得)。**値はスカラー(既に1つに決まったオッズ)であること。**
 *   ワイドのレンジ表現(下限-上限)から下限を選び出す変換は本関数の責務ではなく、
 *   呼び出し側(D-2b・Issue #27)が済ませてから渡すこと(AllocationCandidate.oddsのJSDoc参照)。
 * @param evConfig EV判定の設定(省略時は既存expected-value.tsの既定閾値1.0・厳密不等号を再利用。
 *   閾値を二重定義しない)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ)
 */
export function buildComboCandidates(
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  comboSize: number,
  oddsByKey: ReadonlyMap<string, number | null>,
  evConfig: EvConfig = DEFAULT_EV_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): ComboCandidateBuildResult {
  const umabans = [...horses].map((h) => h.umaban).sort((a, b) => a - b);
  const combos = kCombinationsOfUmabans(umabans, comboSize);
  const rawDistribution = model.buildDistribution(horses, topFinishCount);

  const candidates: AllocationCandidate[] = [];
  let notPositiveCount = 0;
  let oddsMissingCount = 0;
  let oddsUnfetchedCount = 0;

  for (const combo of combos) {
    const resolution = resolveComboOdds(oddsByKey, combo);
    if (resolution.state === "unfetched") {
      oddsUnfetchedCount++;
      continue;
    }
    if (resolution.state === "missing") {
      oddsMissingCount++;
      continue;
    }
    const hitProb = computeComboHitProb(combo, rawDistribution);
    const ev = hitProb * resolution.odds;
    const isPositive = ev > evConfig.threshold;
    if (!isPositive) {
      notPositiveCount++;
      continue;
    }
    candidates.push({ umabans: combo, odds: resolution.odds, ev, isPositive: true });
  }

  return {
    candidates,
    diagnostics: {
      enumeratedCount: combos.length,
      judged: { positiveCount: candidates.length, notPositiveCount },
      unjudged: { oddsMissingCount, oddsUnfetchedCount },
    },
  };
}
