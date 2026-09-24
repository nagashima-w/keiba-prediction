/**
 * runGreedyAllocation(`packages/core/src/ev/allocation-primitives.ts`)単体の計測スクリプト
 * (Issue #107・#24-C)。
 *
 * ## 位置づけ(AC-1・AC-1b・AC-4'への対応)
 *
 * 既存の2本のベンチはどちらも本Issueが測りたい経路を測れない:
 * - `scripts/bench-allocation.ts` は複勝・ワイド・三連複だけで単勝(win)候補を作らないため、
 *   `combo-bet-allocation.ts`の「順序付きoutcome空間」門番(`candidates.some(c=>c.betType==="win")`)
 *   を一度も通らない(集合空間止まり)。
 * - `scripts/bench-mixed-allocation.ts` は `buildMixedAllocationDisplay` 全体(候補構築・EV算出・
 *   キャッシュ等込み)しか測らず、`runGreedyAllocation` 単体の内訳が読めない。
 *
 * 本スクリプトは `runGreedyAllocation` を直接呼び、次の3点を満たす:
 * 1. **AC-1**: 単勝候補を含む順序付きoutcome空間(実フィクスチャ・実オッズ相当)で
 *    `runGreedyAllocation` 単体を測り、outcome数・Σ|indices|・使用ステップ数・converged・
 *    所要msに加え、**フェーズ別内訳**(後述)をプロファイラ無しで出力する。
 * 2. **AC-1b(自己検査)**: 本スクリプトが自前で組み立てた `OutcomeIndexSet[]` に対する
 *    `runGreedyAllocation` の結果が、**同じ入力に対する `allocateGeneralBets(...)` の
 *    `continuousFraction`(===比較・ビット一致)と一致することを実行時に検証**し、
 *    不一致なら非ゼロ終了する。これにより「本スクリプトの的中判定ロジックの複製が
 *    productionとずれている」という唯一の穴を塞ぐ。
 * 3. **AC-4'**: 馬連(全120通り)・馬単(全240通り)相当の候補を、本スクリプト内で純粋な
 *    組合せ計算により追加し、765件相当の規模で同様に測る。
 *
 * ## ★馬連・馬単の的中判定は本スクリプト専用の複製である(production の下書きではない)
 *
 * `AllocationBetType`(`combo-bet-allocation.ts:161`)には馬連・馬単が無く、
 * production側の的中判定ロジックはまだ存在しない(#24-D・#24-E のスコープ)。
 * 本スクリプトが使う判定(馬連{a,b}=`order[0]`・`order[1]`の集合が`{a,b}`に一致、
 * 馬単(a,b)=`order[0]===a && order[1]===b`)は**このベンチだけのための単純な組合せ計算**であり、
 * #24-D/#24-Eの実装はこれを流用せず、そこで改めて設計すること(#107ゲート裁定§0)。
 * また馬連・馬単は**EVによる絞り込みを一切行わない全組合せ**(全120・全240)であり、
 * 実際に#24-D/#24-Eが実装されるとEV閾値で絞られるぶん、実際の候補数はこれより
 * 少なくなる見込みである(本スクリプトはあくまで「絞り込み前の最悪規模」を測る)。
 * この理由により、馬連・馬単側はAC-1bの自己検査の対象外とする(production に対応物が無い)。
 *
 * ## ★候補の並び順について
 *
 * `allocateGeneralBets`(`combo-bet-allocation.ts:723`)は最終的に候補を「馬番配列の辞書順」
 * (`compareUmabansLex`。同ファイル内の非exportヘルパ)へ並べ替えてから`runGreedyAllocation`へ
 * 渡す。`indices`の値(候補配列内の位置)が変わると加算順序が変わりビット一致が壊れうるため、
 * AC-1bの自己検査を意味あるものにするには、本スクリプト側も**productionと同じ並び順**で
 * 候補を組み立てる必要がある。`compareUmabansLex`・`compareCandidatesForCap`(candidateCap
 * 選抜用のEV降順ソート。candidateCapが発動しない前提では実質「並び順に影響しない」が、
 * productionの2段ソート〈EV降順→辞書順〉を安定ソートの挙動まで含めて正確に再現するために
 * 両方複製する)は非exportのため、**このスクリプトに複製する**(ロジックの複製ではなく
 * 単純な配列比較関数の複製であり、上記「馬連・馬単の判定」とは性質が異なる)。
 *
 * ## フェーズ別内訳について(プロファイラ無しで支配項の当たりをつける)
 *
 * `--cpu-prof`のようなプロファイラを使わずに支配項を特定するため、`runGreedyAllocation`と
 * 構造的に同一のコードを複製した`runGreedyAllocationInstrumented`(本ファイル内)で
 * ステップループ内の各フェーズを`performance.now()`で計測する。**この複製の出力
 * (`fractions`・`converged`)が本物の`runGreedyAllocation`とビット一致することを毎回
 * 検証してから**内訳を信頼する(複製自体にバグがあれば内訳の意味が無いため)。
 *
 * ## 計測条件
 * - `docs/investigations/combo-odds-real-fetch/central-on.json`(中央16頭・確定オッズ・
 *   実レース日2026/06/28)を使う。ネットワークには一切出ない。詳細な計測条件
 *   (kaisaiDate明示・LLM未使用・先読みリーク遮断なし等)は`scripts/bench-mixed-allocation.ts`
 *   のJSDocと同じなので繰り返さない。
 * - 数値は再現コマンド(`pnpm tsx scripts/bench-run-greedy-allocation.ts`)で都度確認すること。
 *   固定の数値をここにもJSDoc等にも書き込まない(既存方針・AC-5)。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-run-greedy-allocation.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseKaisaiDate, type RaceData } from "../packages/core/src/index.js";
import { runAnalysis, type AnalysisPipelineDeps } from "../packages/app/src/main/analysis-pipeline.js";
import type { AnalysisResult } from "../packages/app/src/shared/analysis-types.js";
import {
  buildMixedCandidates,
  type MixedCandidateBuildInput,
} from "../packages/app/src/shared/mixed-candidates.js";
import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationCandidate,
  type GeneralBetAllocationConfig,
  type JointModelHorse,
} from "../packages/core/src/ev/combo-bet-allocation.js";
import { PLACKETT_LUCE_MODEL } from "../packages/core/src/ev/plackett-luce-model.js";
import type { OrderedOutcome } from "../packages/core/src/ev/place-joint-model.js";
import {
  foldOutcomeIndexSetsBySignature,
  runGreedyAllocation,
  type OutcomeIndexSet,
} from "../packages/core/src/ev/allocation-primitives.js";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "investigations",
  "combo-odds-real-fetch",
  "central-on.json",
);

/** フィクスチャ(保存済みRaceData)を読み、runAnalysisを実LLM無しで実行してAnalysisResultを得る
 *  (`scripts/bench-mixed-allocation.ts`と同じ計測条件。詳細は同ファイルのJSDoc参照)。 */
async function loadAnalysisResult(): Promise<AnalysisResult> {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const raceData = JSON.parse(raw) as RaceData;

  const deps: AnalysisPipelineDeps = {
    scrape: async () => raceData,
    analyze: null,
    saveAnalysis: () => 0,
    allocationSettings: null,
  };
  return runAnalysis(raceData.raceId, parseKaisaiDate("20260628"), deps);
}

/** AnalysisResultから、buildMixedCandidatesが要求する最小構造を取り出す(bench-mixed-allocation.tsと同じ)。 */
function toMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  return {
    oddsStatus: result.oddsStatus,
    rows: result.rows,
    ...(result.wideCombo !== undefined ? { wideCombo: result.wideCombo } : {}),
    ...(result.trioCombo !== undefined ? { trioCombo: result.trioCombo } : {}),
    ...(result.comboOdds !== undefined ? { comboOdds: result.comboOdds } : {}),
  };
}

// ============================================================================
// production の並び替えロジックの複製(compareUmabansLex・compareCandidatesForCap)
// combo-bet-allocation.tsの非exportヘルパ。ロジックの複製ではなく単純な配列比較関数の複製。
// ============================================================================

/** 馬番配列を辞書順で比較する(combo-bet-allocation.ts の compareUmabansLex の複製)。 */
function compareUmabansLex(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

/** 候補cap選抜用の比較(EV降順、同値は馬番配列の辞書順)。compareCandidatesForCapの複製。 */
function compareCandidatesForCap(a: AllocationCandidate, b: AllocationCandidate): number {
  if (a.ev !== b.ev) {
    return b.ev - a.ev;
  }
  return compareUmabansLex(a.umabans, b.umabans);
}

/** productionの finalCandidates と同じ並び順(EV降順選抜→馬番辞書順の安定ソート)を再現する。 */
function sortLikeProduction(candidates: readonly AllocationCandidate[]): AllocationCandidate[] {
  const rankedForCap = [...candidates].sort(compareCandidatesForCap);
  return [...rankedForCap].sort((a, b) => compareUmabansLex(a.umabans, b.umabans));
}

// ============================================================================
// 馬連・馬単相当の追加候補(AC-4'。production に対応物が無い、ベンチ専用の組み立て)
// ============================================================================

interface ExtraCandidate {
  readonly kind: "umaren" | "umatan";
  readonly umabans: readonly number[];
  readonly odds: number;
}

/**
 * 馬連(全C(n,2))・馬単(全n×(n-1))相当の候補を、`orderedRaw`(順序付きoutcome空間)から
 * 直接計算した真の的中確率を使って組み立てる(AC-4'。ベンチ専用・production非対応)。
 * オッズは「真の的中確率の逆数×1.35固定」という決定的な生成規則
 * (`scripts/bench-allocation.ts`のALL_POSITIVE_NOISEと同じ固定倍率の流儀)を使う。
 */
function buildQuinellaExactaExtra(
  horses: readonly JointModelHorse[],
  orderedRaw: readonly OrderedOutcome[],
): { readonly list: readonly ExtraCandidate[]; readonly skippedZeroProbCount: number } {
  const umabans = horses.map((h) => h.umaban).sort((a, b) => a - b);

  // 真の的中確率をorderedRawから1回の走査で集計する(候補ごとにorderedRawを再走査しない)。
  const umatanProb = new Map<string, number>(); // key: "1着-2着"
  const umarenProb = new Map<string, number>(); // key: "小さい方-大きい方"
  for (const outcome of orderedRaw) {
    const first = outcome.order[0];
    const second = outcome.order[1];
    if (first === undefined || second === undefined) {
      continue;
    }
    const tanKey = `${first}-${second}`;
    umatanProb.set(tanKey, (umatanProb.get(tanKey) ?? 0) + outcome.probability);
    const renKey = first < second ? `${first}-${second}` : `${second}-${first}`;
    umarenProb.set(renKey, (umarenProb.get(renKey) ?? 0) + outcome.probability);
  }

  const NOISE = 1.35;
  const list: ExtraCandidate[] = [];
  let skippedZeroProbCount = 0;

  for (const a of umabans) {
    for (const b of umabans) {
      if (a === b) continue;
      const p = umatanProb.get(`${a}-${b}`) ?? 0;
      if (p <= 0) {
        skippedZeroProbCount++;
        continue;
      }
      list.push({ kind: "umatan", umabans: [a, b], odds: (1 / p) * NOISE });
    }
  }
  for (let i = 0; i < umabans.length; i++) {
    for (let j = i + 1; j < umabans.length; j++) {
      const a = umabans[i]!;
      const b = umabans[j]!;
      const p = umarenProb.get(`${a}-${b}`) ?? 0;
      if (p <= 0) {
        skippedZeroProbCount++;
        continue;
      }
      list.push({ kind: "umaren", umabans: [a, b], odds: (1 / p) * NOISE });
    }
  }

  return { list, skippedZeroProbCount };
}

// ============================================================================
// OutcomeIndexSet[] の構築(production の determined 枝〈combo-bet-allocation.ts:840-853〉の複製)
// ============================================================================

/** win/place/wide/trio の的中判定(combo-bet-allocation.ts の determined 枝と同じ判定式)。 */
function isHitProdCandidate(
  c: AllocationCandidate,
  order: readonly number[],
  orderSet: ReadonlySet<number>,
): boolean {
  return c.betType === "win" ? order[0]! === c.umabans[0]! : c.umabans.every((u) => orderSet.has(u));
}

/** 馬連・馬単相当の的中判定(AC-4'。ベンチ専用の組み立て。上記JSDoc参照)。 */
function isHitExtraCandidate(e: ExtraCandidate, order: readonly number[]): boolean {
  if (e.kind === "umatan") {
    return order[0]! === e.umabans[0]! && order[1]! === e.umabans[1]!;
  }
  const top2 = new Set([order[0]!, order[1]!]);
  return top2.has(e.umabans[0]!) && top2.has(e.umabans[1]!);
}

/**
 * `orderedRaw`(順序付きoutcome空間)から、`sortedProdCandidates`(production順に並べた
 * win/place/wide/trio候補)と`extra`(馬連・馬単相当。AC-4'のみ非空)の`OutcomeIndexSet[]`を
 * 構築し、署名畳み込み(`foldOutcomeIndexSetsBySignature`)を適用する
 * (production の determined 枝〈combo-bet-allocation.ts:839-854〉と同じ手順)。
 * 候補のインデックスは `[...sortedProdCandidates, ...extra]` の連結順。
 */
function buildIndexSets(
  orderedRaw: readonly OrderedOutcome[],
  sortedProdCandidates: readonly AllocationCandidate[],
  extra: readonly ExtraCandidate[],
): OutcomeIndexSet[] {
  const base = sortedProdCandidates.length;
  const raw: OutcomeIndexSet[] = orderedRaw.map((outcome) => {
    const orderSet = new Set(outcome.order);
    const indices: number[] = [];
    for (let i = 0; i < sortedProdCandidates.length; i++) {
      if (isHitProdCandidate(sortedProdCandidates[i]!, outcome.order, orderSet)) {
        indices.push(i);
      }
    }
    for (let k = 0; k < extra.length; k++) {
      if (isHitExtraCandidate(extra[k]!, outcome.order)) {
        indices.push(base + k);
      }
    }
    return { indices, probability: outcome.probability };
  });
  return foldOutcomeIndexSetsBySignature(raw);
}

function sumIndices(sets: readonly OutcomeIndexSet[]): number {
  let total = 0;
  for (const s of sets) {
    total += s.indices.length;
  }
  return total;
}

// ============================================================================
// AC-1b: production allocateGeneralBets との自己検査
// ============================================================================

/**
 * 本スクリプトが自前で組み立てた `OutcomeIndexSet[]` に対する `runGreedyAllocation` の結果が、
 * 同じ入力に対する `allocateGeneralBets(...)` の `continuousFraction` と**ビット一致(===)**する
 * ことを検証する(AC-1b)。不一致なら `process.exitCode = 1` を設定して詳細をログに出す。
 * 馬連・馬単(AC-4')側はこの自己検査の対象外(production に対応物が無いため)。
 */
function selfCheckAgainstProduction(
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  fullPositiveCandidates: readonly AllocationCandidate[],
  sortedProdCandidates: readonly AllocationCandidate[],
  ownOutcomeIndexSets: readonly OutcomeIndexSet[],
  ownOdds: readonly number[],
  greedySteps: number,
): boolean {
  const config: GeneralBetAllocationConfig = {
    bankroll: 1_000_000,
    perRaceCap: 1_000_000,
    kellyFraction: 0.5,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
  };
  const result = allocateGeneralBets(horses, topFinishCount, fullPositiveCandidates, config, PLACKETT_LUCE_MODEL);

  if (result.diagnostics.truncatedByCapCount !== 0) {
    console.error(
      `AC-1b自己検査 失敗: candidateCapで${result.diagnostics.truncatedByCapCount}件が切り捨てられた(想定外)。`,
    );
    return false;
  }
  if (result.winOutcome.kind !== "determined") {
    console.error(`AC-1b自己検査 失敗: winOutcome.kindが"determined"ではない(kind=${result.winOutcome.kind})。`);
    return false;
  }
  if (result.allocations.length !== sortedProdCandidates.length) {
    console.error(
      `AC-1b自己検査 失敗: production側候補数${result.allocations.length} !== 自前構築候補数${sortedProdCandidates.length}`,
    );
    return false;
  }

  const { fractions: ownFractions } = runGreedyAllocation(
    sortedProdCandidates.length,
    ownOdds,
    ownOutcomeIndexSets,
    greedySteps,
  );

  let mismatchCount = 0;
  for (let i = 0; i < sortedProdCandidates.length; i++) {
    const own = sortedProdCandidates[i]!;
    const prod = result.allocations[i]!;
    const sameIdentity =
      own.betType === prod.betType &&
      own.umabans.length === prod.umabans.length &&
      own.umabans.every((u, k) => u === prod.umabans[k]);
    if (!sameIdentity) {
      console.error(
        `AC-1b自己検査 失敗(識別不一致 i=${i}): 自前=${own.betType}:${own.umabans.join(",")} / ` +
          `production=${prod.betType}:${prod.umabans.join(",")}`,
      );
      mismatchCount++;
      continue;
    }
    if (ownFractions[i] !== prod.continuousFraction) {
      console.error(
        `AC-1b自己検査 失敗(値不一致 i=${i}, ${own.betType}:${own.umabans.join(",")}): ` +
          `自前fractions=${ownFractions[i]} / production continuousFraction=${prod.continuousFraction}`,
      );
      mismatchCount++;
    }
  }
  if (mismatchCount > 0) {
    console.error(`AC-1b自己検査: ${mismatchCount}件の不一致。ベンチの複製ロジックがproductionと乖離している。`);
    return false;
  }
  console.log(`AC-1b自己検査: 全${sortedProdCandidates.length}件がproductionのcontinuousFractionとビット一致(===)。`);
  return true;
}

// ============================================================================
// AC-1・AC-4': 所要時間・使用ステップ数等の計測
// ============================================================================

function reportScenario(
  label: string,
  n: number,
  outcomeIndexSets: readonly OutcomeIndexSet[],
  odds: readonly number[],
  greedySteps: number,
): void {
  // ウォームアップ(JITの影響を減らす)。
  runGreedyAllocation(n, odds, outcomeIndexSets, greedySteps);
  const iterations = 10;
  const samples: number[] = [];
  let last: ReturnType<typeof runGreedyAllocation> | null = null;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    last = runGreedyAllocation(n, odds, outcomeIndexSets, greedySteps);
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  const sumX = last!.fractions.reduce((a, b) => a + b, 0);
  // Σx* = 使用ステップ数 × (1/greedySteps)(bench-allocation.tsと同じ逆算方法。表示用の参考値)。
  const stepsUsed = Math.round(sumX * greedySteps);
  console.log(
    `[${label}] 候補${n}件 / outcome数${outcomeIndexSets.length} / Σ|indices|=${sumIndices(outcomeIndexSets)} / ` +
      `使用ステップ${stepsUsed}/${greedySteps} / converged=${last!.converged} / ` +
      `平均${avg.toFixed(1)}ms / 最大${max.toFixed(1)}ms(n=${iterations})`,
  );
}

// ============================================================================
// フェーズ別内訳(プロファイラ無しで支配項の当たりをつける。本ファイルJSDoc参照)
// ============================================================================

interface PhaseTimings {
  commonWealthMs: number;
  worstCommonScanMs: number;
  freshByCandidateMs: number;
  commonLogWealthMs: number;
  candidateEvalMs: number;
  fallbackBruteforceMs: number;
  stateUpdateMs: number;
  stepCount: number;
  unsafeStepCount: number;
}

/** allocation-primitives.ts の NUMERIC_EPS(非export)と同じ値のベンチ内複製。 */
const BENCH_NUMERIC_EPS = 1e-9;

/**
 * `runGreedyAllocation`(allocation-primitives.ts:438、Issue #107最適化後)と**構造的に
 * 同一の演算列**を複製し、ステップループ内の各フェーズを`performance.now()`で計測する
 * (本ファイルJSDoc参照)。CSR化・バッファ再利用・接頭辞和の再利用を含め、本家の実装と
 * 同じ構造にする(加算順序・走査順序・分岐条件は一切変えず、各フェーズの前後にタイマーを
 * 挟んだだけ)。呼び出し側が本家の出力とのビット一致を検証してから内訳を信頼すること
 * (`reportPhaseBreakdown`参照)。
 *
 * ★このベンチ専用の複製は、production側`runGreedyAllocation`のアルゴリズムが変わるたびに
 * 追従が必要である(Issue #107の最初のドラフトでは最適化前の構造のまま残っており、
 * `reportPhaseBreakdown`のビット一致検証自体は通っていた〈両アルゴリズムが数学的に
 * 同値なため〉が、内訳の中身が最適化前のものになってしまっていた。この事実は報告に明記する)。
 */
function runGreedyAllocationInstrumented(
  n: number,
  odds: readonly number[],
  outcomeIndexSets: readonly OutcomeIndexSet[],
  greedySteps: number,
): { fractions: number[]; converged: boolean; timings: PhaseTimings } {
  const timings: PhaseTimings = {
    commonWealthMs: 0,
    worstCommonScanMs: 0,
    freshByCandidateMs: 0,
    commonLogWealthMs: 0,
    candidateEvalMs: 0,
    fallbackBruteforceMs: 0,
    stateUpdateMs: 0,
    stepCount: 0,
    unsafeStepCount: 0,
  };
  if (n === 0) {
    return { fractions: [], converged: true, timings };
  }

  const outcomeCount = outcomeIndexSets.length;

  // CSR化(outcome-major)。production版と同じ構築手順。
  const outcomeOffsets = new Int32Array(outcomeCount + 1);
  for (let j = 0; j < outcomeCount; j++) {
    outcomeOffsets[j + 1] = outcomeOffsets[j]! + outcomeIndexSets[j]!.indices.length;
  }
  const totalEdges = outcomeOffsets[outcomeCount]!;
  const outcomeIndicesFlat = new Int32Array(totalEdges);
  const outcomeProbabilities = new Float64Array(outcomeCount);
  {
    let g = 0;
    for (let j = 0; j < outcomeCount; j++) {
      outcomeProbabilities[j] = outcomeIndexSets[j]!.probability;
      for (const idx of outcomeIndexSets[j]!.indices) {
        outcomeIndicesFlat[g] = idx;
        g++;
      }
    }
  }

  // CSR化(candidate-major)。production版と同じ構築手順(位置pも記録)。
  const contactCountByCandidate = new Int32Array(n);
  for (let g = 0; g < totalEdges; g++) {
    contactCountByCandidate[outcomeIndicesFlat[g]!]!++;
  }
  const contactOffsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    contactOffsets[i + 1] = contactOffsets[i]! + contactCountByCandidate[i]!;
  }
  const contactOutcomeFlat = new Int32Array(totalEdges);
  const contactPositionFlat = new Int32Array(totalEdges);
  {
    const cursor = contactOffsets.slice(0, n);
    for (let j = 0; j < outcomeCount; j++) {
      const start = outcomeOffsets[j]!;
      const end = outcomeOffsets[j + 1]!;
      for (let g = start; g < end; g++) {
        const idx = outcomeIndicesFlat[g]!;
        const w = cursor[idx]!;
        contactOutcomeFlat[w] = j;
        contactPositionFlat[w] = g - start;
        cursor[idx] = w + 1;
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  const delta = 1 / greedySteps;
  let sumX = 0;

  const commonWealth = new Float64Array(outcomeCount);
  const prefixSum = new Float64Array(totalEdges);
  const commonLogWealth = new Float64Array(outcomeCount);
  const freshFlat = new Float64Array(totalEdges);

  const computeF = (trialSumX: number, trialX: readonly number[]): number | null => {
    let total = 0;
    for (let j = 0; j < outcomeCount; j++) {
      const start = outcomeOffsets[j]!;
      const end = outcomeOffsets[j + 1]!;
      let payout = 0;
      for (let g = start; g < end; g++) {
        const idx = outcomeIndicesFlat[g]!;
        payout += trialX[idx]! * odds[idx]!;
      }
      const wealth = 1 - trialSumX + payout;
      if (wealth <= BENCH_NUMERIC_EPS) {
        return null;
      }
      total += outcomeProbabilities[j]! * Math.log(wealth);
    }
    return total;
  };

  let currentF = computeF(sumX, x)!;
  let converged = false;

  for (let step = 0; step < greedySteps; step++) {
    timings.stepCount++;
    const trialSumX = sumX + delta;

    // commonWealth計算+接頭辞和の記録(★接頭辞和の再利用。1つのフェーズにまとめて計測する。
    // productionでも同じ1本のループでprefixSumを記録している)。
    let t0 = performance.now();
    for (let j = 0; j < outcomeCount; j++) {
      const start = outcomeOffsets[j]!;
      const end = outcomeOffsets[j + 1]!;
      let payout = 0;
      for (let g = start; g < end; g++) {
        prefixSum[g] = payout;
        const idx = outcomeIndicesFlat[g]!;
        payout += x[idx]! * odds[idx]!;
      }
      commonWealth[j] = 1 - trialSumX + payout;
    }
    timings.commonWealthMs += performance.now() - t0;

    t0 = performance.now();
    let worstCommon = Infinity;
    for (let j = 0; j < outcomeCount; j++) {
      if (commonWealth[j]! < worstCommon) {
        worstCommon = commonWealth[j]!;
      }
    }
    timings.worstCommonScanMs += performance.now() - t0;

    // freshByCandidate相当(接頭辞和の再利用でΣ|indices_j|(|indices_j|+1)/2程度に削減)。
    t0 = performance.now();
    let worstFresh = Infinity;
    for (let i = 0; i < n; i++) {
      const cStart = contactOffsets[i]!;
      const cEnd = contactOffsets[i + 1]!;
      const freshTerm = (x[i]! + delta) * odds[i]!;
      for (let c = cStart; c < cEnd; c++) {
        const j = contactOutcomeFlat[c]!;
        const p = contactPositionFlat[c]!;
        const start = outcomeOffsets[j]!;
        const end = outcomeOffsets[j + 1]!;
        const g = start + p;
        let payout = prefixSum[g]!;
        payout += freshTerm;
        for (let g2 = g + 1; g2 < end; g2++) {
          const idx2 = outcomeIndicesFlat[g2]!;
          payout += x[idx2]! * odds[idx2]!;
        }
        const fresh = 1 - trialSumX + payout;
        freshFlat[c] = fresh;
        if (fresh < worstFresh) {
          worstFresh = fresh;
        }
      }
    }
    timings.freshByCandidateMs += performance.now() - t0;

    const safe = Math.min(worstCommon, worstFresh) > BENCH_NUMERIC_EPS;

    let bestIdx = -1;
    let bestIncrement = 0;

    if (safe) {
      t0 = performance.now();
      let commonLogSum = 0;
      for (let j = 0; j < outcomeCount; j++) {
        const logW = Math.log(commonWealth[j]!);
        commonLogWealth[j] = logW;
        commonLogSum += outcomeProbabilities[j]! * logW;
      }
      timings.commonLogWealthMs += performance.now() - t0;

      t0 = performance.now();
      for (let i = 0; i < n; i++) {
        let trialLogSum = commonLogSum;
        const cStart = contactOffsets[i]!;
        const cEnd = contactOffsets[i + 1]!;
        for (let c = cStart; c < cEnd; c++) {
          const j = contactOutcomeFlat[c]!;
          const prob = outcomeProbabilities[j]!;
          trialLogSum = trialLogSum - prob * commonLogWealth[j]! + prob * Math.log(freshFlat[c]!);
        }
        const increment = trialLogSum - currentF;
        if (increment > bestIncrement) {
          bestIncrement = increment;
          bestIdx = i;
        }
      }
      timings.candidateEvalMs += performance.now() - t0;
    } else {
      timings.unsafeStepCount++;
      t0 = performance.now();
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
      timings.fallbackBruteforceMs += performance.now() - t0;
    }

    if (bestIdx === -1) {
      converged = true;
      break;
    }
    t0 = performance.now();
    x[bestIdx] = x[bestIdx]! + delta;
    sumX = trialSumX;
    currentF = computeF(sumX, x)!;
    timings.stateUpdateMs += performance.now() - t0;
  }

  return { fractions: x, converged, timings };
}

/**
 * フェーズ別内訳を出力する。まず`runGreedyAllocationInstrumented`の出力が本家
 * `runGreedyAllocation`とビット一致することを検証し(不一致なら例外を投げ、内訳を出さない)、
 * 一致した場合のみ内訳を表示する。
 */
function reportPhaseBreakdown(
  label: string,
  n: number,
  outcomeIndexSets: readonly OutcomeIndexSet[],
  odds: readonly number[],
  greedySteps: number,
): void {
  const real = runGreedyAllocation(n, odds, outcomeIndexSets, greedySteps);
  const instrumented = runGreedyAllocationInstrumented(n, odds, outcomeIndexSets, greedySteps);

  if (real.fractions.length !== instrumented.fractions.length || real.converged !== instrumented.converged) {
    throw new Error(`フェーズ計測用複製がconverged/長さで本家と一致しない(${label})。内訳は表示しない。`);
  }
  let mismatch = 0;
  for (let i = 0; i < real.fractions.length; i++) {
    if (real.fractions[i] !== instrumented.fractions[i]) {
      mismatch++;
    }
  }
  if (mismatch > 0) {
    throw new Error(
      `フェーズ計測用複製がrunGreedyAllocationとビット一致しない(${label}, 不一致${mismatch}件)。` +
        "複製にバグがあるため内訳は信頼できない。表示しない。",
    );
  }

  const t = instrumented.timings;
  const total =
    t.commonWealthMs +
    t.worstCommonScanMs +
    t.freshByCandidateMs +
    t.commonLogWealthMs +
    t.candidateEvalMs +
    t.fallbackBruteforceMs +
    t.stateUpdateMs;
  const pct = (ms: number): string => (total > 0 ? `${((ms / total) * 100).toFixed(1)}%` : "0.0%");
  console.log(
    `[${label}] フェーズ別内訳(候補${n}件・outcome数${outcomeIndexSets.length}・` +
      `ステップ${t.stepCount}回・うちフォールバック${t.unsafeStepCount}回。本家とビット一致検証済み)`,
  );
  console.log(`  commonWealth計算        : ${t.commonWealthMs.toFixed(1)}ms (${pct(t.commonWealthMs)})`);
  console.log(`  worstCommon走査         : ${t.worstCommonScanMs.toFixed(1)}ms (${pct(t.worstCommonScanMs)})`);
  console.log(`  freshByCandidate計算    : ${t.freshByCandidateMs.toFixed(1)}ms (${pct(t.freshByCandidateMs)})`);
  console.log(`  commonLogWealth+Sum算出 : ${t.commonLogWealthMs.toFixed(1)}ms (${pct(t.commonLogWealthMs)})`);
  console.log(`  候補評価ループ(高速path): ${t.candidateEvalMs.toFixed(1)}ms (${pct(t.candidateEvalMs)})`);
  console.log(`  フォールバック(bruteforce): ${t.fallbackBruteforceMs.toFixed(1)}ms (${pct(t.fallbackBruteforceMs)})`);
  console.log(`  状態更新(computeF)      : ${t.stateUpdateMs.toFixed(1)}ms (${pct(t.stateUpdateMs)})`);
  console.log(
    `  合計(自前計測。タイマー挿入自体のオーバーヘッドを含むため reportScenario の壁時計値とは単純比較しない): ${total.toFixed(1)}ms`,
  );
}

// ============================================================================
// main
// ============================================================================

async function main(): Promise<void> {
  const result = await loadAnalysisResult();
  const race = toMixedCandidateInput(result);
  const mixed = buildMixedCandidates(race, { evConfig: { threshold: 1.0 } });
  const horses: JointModelHorse[] = result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));
  const topFinishCount = mixed.topFinishCount;
  const greedySteps = DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps;

  const positiveCandidates = mixed.candidates.filter((c) => c.isPositive);
  const countOf = (betType: AllocationCandidate["betType"]): number =>
    positiveCandidates.filter((c) => c.betType === betType).length;

  console.log(`raceId=${result.raceId} rows=${result.rows.length}頭 oddsStatus=${result.oddsStatus}`);
  console.log(
    `候補: 単勝${countOf("win")}件 / 複勝${countOf("place")}件 / ワイド${countOf("wide")}件 / ` +
      `三連複${countOf("trio")}件 / 合計${positiveCandidates.length}件`,
  );

  const sortedProdCandidates = sortLikeProduction(positiveCandidates);

  const orderedRaw = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, topFinishCount);
  if (orderedRaw === null) {
    throw new Error(
      "PLACKETT_LUCE_MODEL.buildOrderedDistribution が null を返した(想定外の縮退)。フィクスチャを見直すこと。",
    );
  }

  // ===== AC-1: 単体ベースライン =====
  console.log("");
  console.log("=== AC-1: runGreedyAllocation単体ベースライン(実フィクスチャの正EV候補相当) ===");
  const baselineOutcomeIndexSets = buildIndexSets(orderedRaw, sortedProdCandidates, []);
  const baselineOdds = sortedProdCandidates.map((c) => c.odds);
  reportScenario("baseline", sortedProdCandidates.length, baselineOutcomeIndexSets, baselineOdds, greedySteps);

  // ===== AC-1b: production allocateGeneralBets との自己検査 =====
  console.log("");
  const selfCheckOk = selfCheckAgainstProduction(
    horses,
    topFinishCount,
    positiveCandidates,
    sortedProdCandidates,
    baselineOutcomeIndexSets,
    baselineOdds,
    greedySteps,
  );
  if (!selfCheckOk) {
    process.exitCode = 1;
    return;
  }

  // ===== AC-4': 馬連(全120)・馬単(全240)相当を足した規模 =====
  console.log("");
  console.log("=== AC-4': 馬連(全120通り)・馬単(全240通り)相当を足した規模 ===");
  console.log(
    "(注: 馬連・馬単はEVによる絞り込みを一切行わない全組合せ。#24-Dで実装されると" +
      "EV閾値で絞られるため、実際の候補数はこれより少なくなる見込み)",
  );
  const { list: extra, skippedZeroProbCount } = buildQuinellaExactaExtra(horses, orderedRaw);
  if (skippedZeroProbCount > 0) {
    console.log(`(的中確率0のため除外した馬連・馬単候補: ${skippedZeroProbCount}件)`);
  }
  const extendedOutcomeIndexSets = buildIndexSets(orderedRaw, sortedProdCandidates, extra);
  const extendedOdds = [...baselineOdds, ...extra.map((e) => e.odds)];
  reportScenario(
    "extended(+馬連馬単)",
    sortedProdCandidates.length + extra.length,
    extendedOutcomeIndexSets,
    extendedOdds,
    greedySteps,
  );

  // ===== フェーズ別内訳 =====
  console.log("");
  console.log("=== フェーズ別内訳(自前計測。runGreedyAllocationと構造的に同一のコードを複製して計測) ===");
  reportPhaseBreakdown("baseline", sortedProdCandidates.length, baselineOutcomeIndexSets, baselineOdds, greedySteps);
  reportPhaseBreakdown(
    "extended(+馬連馬単)",
    sortedProdCandidates.length + extra.length,
    extendedOutcomeIndexSets,
    extendedOdds,
    greedySteps,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
