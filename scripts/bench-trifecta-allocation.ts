/**
 * 三連単を含む配分計算の性能実測スクリプト(Issue #129・#25-C)。
 *
 * ## 位置づけ
 *
 * `scripts/bench-mixed-allocation.ts`(D-2c・#28。券種横断の候補構築+配分の1レース所要時間)、
 * `scripts/bench-run-greedy-allocation.ts`(#107・#24-C。`runGreedyAllocation`単体の内訳)の
 * どちらも三連単(`trifecta`)を測っていない。三連単は `AllocationBetType` に既に存在するが
 * (`combo-bet-allocation.ts`。Issue #128)、`buildMixedCandidates`(`mixed-candidates.ts`)は
 * まだ三連単を配線していない(Issue #132のスコープ)。したがって本スクリプトは
 * `buildTrifectaCandidates`(core)を直接呼び、`buildMixedCandidates`が作った既存6券種
 * (複勝・単勝・ワイド・3連複・馬連・馬単)の候補にその場で連結してから`allocateGeneralBets`へ
 * 渡す(coreの型・門番は一切変更しない。`packages`配下の各パッケージの`src`は不変という制約)。
 *
 * ## 着手前ゲート合意事項(メイン裁定。2026-09-26)
 *
 * 1. **AC2(発売中フィクスチャ)のprior流用**: `fixtures/odds_trifecta_presale_202606040901_20260926.json`
 *    (race_id=202606040901・翌日開催予定・9/27 10:00発走予定1R)自身の`RaceData`は本タスクでは
 *    取得していない(#127の9発火中この1本のみがJSON APIレスポンスで、出走馬表・戦績等の
 *    元データが無い)。そのため本スクリプトのAC2測定は**別レース(202603020211。中央16頭・確定)の
 *    実priorと、発売中オッズ(202606040901)を組み合わせた合成値**である。両レースとも馬番が
 *    1〜16で頭数が一致することは`node -e`で事前確認済み(下記§AC2参照)。出力・docsのいずれにも
 *    「合成値」であることを明記する(メイン裁定)。
 * 2. **Workerプール(#119)の12レース一括見積もり**: 実際にWorker Poolを起動して測るのではなく、
 *    単一レースの実測平均時間から算術的に見積もる(`ceil(12/並列数)×1レース平均時間`)。
 *    `mixed-allocation-worker-pool.ts`はブラウザのWeb Worker前提でNode/tsxから素朴には動かせず、
 *    実機Electron測定(#119の`verify-worker-pool-electron.mjs`相当)は本タスクの射程外という
 *    メイン裁定。並列数の上限式は`computeAllocationWorkerPoolCap`
 *    (`mixed-allocation-worker-pool.ts`)の`max(1, min(hardwareConcurrency−1, maxWorkers=4))`
 *    に基づき、**2並列(3コア機相当)・4並列(5コア以上相当)の両方**を見積もる(メイン指定)。
 *    見積もりであり実測ではないことを出力に明記する。
 * 3. **反復回数**: 三連単込みの配分計算は#96の署名畳み込みが効かず大きく遅くなる見込み
 *    (`docs/issue-order.md` §1-3)であるため、既存ベンチのような固定反復回数(30回)を
 *    そのまま使わない。まず1回のウォームアップ実行時間を測り、時間予算(1シナリオあたり
 *    目安5秒)に収まるよう反復回数を`chooseIterationCount`で決める(下限3回・上限30回)。
 *    採用した反復回数は出力に必ず明記する(メイン指定)。
 * 4. **AC5の自己検査は失敗したら非ゼロ終了する**(メイン指定。複製が古くなったまま数値を
 *    出すことを防ぐ。`bench-run-greedy-allocation.ts`のAC-1bと同じ設計)。
 *
 * ## 計測条件
 *
 * - AC1・AC5: `docs/investigations/combo-odds-real-fetch/central-on.json`(中央16頭・確定オッズ・
 *   実レース日2026/06/28)+`fixtures/odds_trifecta_202603020211.json`(同レースの三連単確定オッズ・
 *   3360件=P(16,3))。ネットワークには一切出ない。`kaisaiDate`明示・LLM未使用等の詳細は
 *   `scripts/bench-mixed-allocation.ts`のJSDocと同じ(繰り返さない)。
 * - AC2: 上記1参照。
 * - AC3: 合成データ(n=18頭)。的中確率は`PLACKETT_LUCE_MODEL.buildOrderedDistribution`から
 *   直接導出した真値で、オッズは`(1/真の的中確率)×1.35`という固定倍率(`scripts/bench-allocation.ts`の
 *   `ALL_POSITIVE_NOISE`・`scripts/bench-run-greedy-allocation.ts`の`buildQuinellaExactaExtra`と
 *   同じ流儀)で構成する。**「合成である」ことを出力に明記する。**
 * - 数値は再現コマンド(`pnpm tsx scripts/bench-trifecta-allocation.ts`)で都度確認すること。
 *   固定の数値をコード・JSDoc等に書き込まない(既存方針)。
 * - メモリ計測(AC3)は`process.memoryUsage()`を使う。`global.gc()`が使える場合
 *   (`NODE_OPTIONS=--expose-gc pnpm tsx scripts/bench-trifecta-allocation.ts`)は計測前後で
 *   明示的にGCを走らせてから差分を取り、使えない場合はその旨を出力に明記した上でGC無しの
 *   値を出す(参考値であることを明記する)。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-trifecta-allocation.ts
 *   (メモリ計測をGC込みで行う場合) NODE_OPTIONS=--expose-gc pnpm tsx scripts/bench-trifecta-allocation.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAnalysisResult } from "./bench-mixed-allocation.js";
import type { AnalysisResult } from "../packages/app/src/shared/analysis-types.js";
import { buildMixedCandidates, type MixedCandidateBuildInput } from "../packages/app/src/shared/mixed-candidates.js";
import {
  allocateGeneralBets,
  buildTrifectaCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationBetType,
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
import { parseComboOdds } from "../packages/core/src/scraper/parse-combo-odds.js";
import { buildOrderedComboOddsKey, toComboOddsScalarMap } from "../packages/core/src/scraper/combo-odds-key.js";

// ============================================================================
// フィクスチャ読み込み
// ============================================================================

const TRIFECTA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_trifecta_202603020211.json",
);

const TRIFECTA_PRESALE_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_trifecta_presale_202606040901_20260926.json",
);

/** 三連単オッズフィクスチャを読み、`buildTrifectaCandidates`の`oddsByKey`(キーは`buildOrderedComboOddsKey`と同形)を作る。 */
function loadTrifectaOddsByKey(fixturePath: string): Map<string, number | null> {
  const json = readFileSync(fixturePath, "utf-8");
  const parsed = parseComboOdds(json, "trifecta");
  if (parsed.state !== "available") {
    throw new Error(`三連単フィクスチャが available ではありません(state=${parsed.state}, path=${fixturePath})`);
  }
  return toComboOddsScalarMap(parsed.odds);
}

/** AnalysisResultから、buildMixedCandidates/buildTrifectaCandidatesが要求する最小構造を取り出す
 *  (`bench-mixed-allocation.ts`・`bench-run-greedy-allocation.ts`と同じ複製。単一定義にはしない
 *  ——各ベンチが自己完結することを優先する既存の流儀)。 */
function toMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  return {
    oddsStatus: result.oddsStatus,
    rows: result.rows,
    ...(result.wideCombo !== undefined ? { wideCombo: result.wideCombo } : {}),
    ...(result.trioCombo !== undefined ? { trioCombo: result.trioCombo } : {}),
    ...(result.comboOdds !== undefined ? { comboOdds: result.comboOdds } : {}),
  };
}

/** 既存2本のベンチと同じ馬連・馬単フィクスチャ(中央16頭・同レース)を読み、Recordへ変換する。 */
function loadComboRecord(fixturePath: string, betType: "quinella" | "exacta"): Record<string, number | null> {
  const json = readFileSync(fixturePath, "utf-8");
  const parsed = parseComboOdds(json, betType);
  if (parsed.state !== "available") {
    throw new Error(`${betType}フィクスチャが available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

const QUINELLA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_quinella_202603020211.json",
);
const EXACTA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_exacta_202603020211.json",
);

// ============================================================================
// 共通ヘルパ
// ============================================================================

const EV_CONFIG = { threshold: 1.0 };

function buildConfig(overrides: Partial<GeneralBetAllocationConfig> = {}): GeneralBetAllocationConfig {
  return {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
    ...overrides,
  };
}

/** 券種別(betType)の候補件数を数える(全7券種)。 */
function countByBetType(
  candidates: readonly { readonly betType: AllocationBetType }[],
): Record<AllocationBetType, number> {
  const types: AllocationBetType[] = ["place", "win", "wide", "quinella", "exacta", "trio", "trifecta"];
  const result = {} as Record<AllocationBetType, number>;
  for (const t of types) {
    result[t] = candidates.filter((c) => c.betType === t).length;
  }
  return result;
}

/** 券種別(betType)にstakeを集計する(全7券種)。 */
function summarizeByBetType(
  allocations: readonly { readonly betType: AllocationBetType; readonly stake: number }[],
): Record<AllocationBetType, number> {
  const types: AllocationBetType[] = ["place", "win", "wide", "quinella", "exacta", "trio", "trifecta"];
  const result = {} as Record<AllocationBetType, number>;
  for (const t of types) {
    result[t] = allocations.filter((a) => a.betType === t).reduce((s, a) => s + a.stake, 0);
  }
  return result;
}

/**
 * candidateCapによる切り詰め(`combo-bet-allocation.ts`1019〜1025行。EV降順で`candidateCap`件に
 * 切り詰める)の券種別内訳を計算する(メイン追加指示・2026-09-26)。`positiveCandidates`は
 * cap適用前の全EVプラス候補(`AllocationCandidate.isPositive===true`のみ。候補ビルダーは
 * 元々isPositiveな候補しか返さないため、追加のフィルタは不要)。
 */
function computeCandidateCapBreakdown(
  positiveCandidates: readonly AllocationCandidate[],
  candidateCap: number,
): {
  readonly beforeByType: Record<AllocationBetType, number>;
  readonly afterByType: Record<AllocationBetType, number>;
  readonly droppedByType: Record<AllocationBetType, number>;
  readonly boundaryEv: number | null;
  readonly firstDroppedEv: number | null;
  readonly nonTrifectaDroppedCount: number;
} {
  const ranked = [...positiveCandidates].sort(compareCandidatesForCap);
  const selected = ranked.slice(0, candidateCap);
  const dropped = ranked.slice(candidateCap);

  const beforeByType = countByBetType(positiveCandidates);
  const afterByType = countByBetType(selected);
  const droppedByType = countByBetType(dropped);

  // 境界のEV: cap内最後(rank=candidateCap)と、cap外最初(rank=candidateCap+1)。
  // ranked[candidateCap-1]が「採用された最後の候補」、ranked[candidateCap]が「最初に切り捨てられた候補」。
  const boundaryEv = ranked.length >= candidateCap && candidateCap > 0 ? ranked[candidateCap - 1]!.ev : null;
  const firstDroppedEv = ranked.length > candidateCap ? ranked[candidateCap]!.ev : null;

  const nonTrifectaDroppedCount = dropped.filter((c) => c.betType !== "trifecta").length;

  return { beforeByType, afterByType, droppedByType, boundaryEv, firstDroppedEv, nonTrifectaDroppedCount };
}

function formatComposition(total: number, byType: Record<AllocationBetType, number>): string {
  const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
  return (
    `単勝${pct(byType.win)} / 複勝${pct(byType.place)} / ワイド${pct(byType.wide)} / ` +
    `三連複${pct(byType.trio)} / 馬連${pct(byType.quinella)} / 馬単${pct(byType.exacta)} / ` +
    `三連単${pct(byType.trifecta)}`
  );
}

/**
 * 時間予算(既定5000ms)に収まるよう反復回数を決める(下限3・上限30)。
 * ウォームアップ1回にかかった時間から単純に逆算する(着手前ゲート合意3)。
 */
function chooseIterationCount(warmupMs: number, budgetMs = 5000): number {
  if (warmupMs <= 0) {
    return 30;
  }
  const raw = Math.floor(budgetMs / warmupMs);
  return Math.min(30, Math.max(3, raw));
}

interface TimingResult {
  readonly iterations: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly warmupMs: number;
}

/** ウォームアップ1回 → 反復回数を決定 → 計測、という共通手順(着手前ゲート合意3)。 */
function measureWithBudget(fn: () => void): TimingResult {
  const warmupStart = performance.now();
  fn();
  const warmupMs = performance.now() - warmupStart;
  const iterations = chooseIterationCount(warmupMs);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  const maxMs = Math.max(...samples);
  return { iterations, avgMs, maxMs, warmupMs };
}

// ============================================================================
// production 並び替え・isHit判定の複製(#107方式を#128後の現行仕様に合わせて更新)
// combo-bet-allocation.ts の非exportヘルパ・determined枝の複製。ロジックの複製であって
// 委譲ではないため、production側が変わるたびに追従が必要(下記自己検査で検出する)。
// ============================================================================

function compareUmabansLex(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

function compareCandidatesForCap(a: AllocationCandidate, b: AllocationCandidate): number {
  if (a.ev !== b.ev) {
    return b.ev - a.ev;
  }
  return compareUmabansLex(a.umabans, b.umabans);
}

/**
 * productionの`finalCandidates`と同じ並び順・同じ候補cap選抜(EV降順→candidateCap件に
 * 切り詰め→馬番辞書順の安定ソート)を再現する(`combo-bet-allocation.ts`1019〜1025行の複製)。
 * **三連単を足すとcandidateCap(既定2000)を超える候補数になりうる**(AC1で実測: 607件→2637件)ため、
 * `#107`当時の複製(切り詰め無し。候補が常にcandidateCap未満という前提)のままでは
 * `sortedProdCandidates`の件数・並びがproductionと食い違う。ここで切り詰めまで複製する。
 */
function sortLikeProduction(candidates: readonly AllocationCandidate[], candidateCap: number): AllocationCandidate[] {
  const rankedForCap = [...candidates].sort(compareCandidatesForCap);
  const selected = rankedForCap.slice(0, candidateCap);
  return [...selected].sort((a, b) => compareUmabansLex(a.umabans, b.umabans));
}

/**
 * production の`determined`枝のisHit式(`combo-bet-allocation.ts`1082〜1094行)の複製。
 * `bench-run-greedy-allocation.ts`の`isHitProdCandidate`(#107当時。win/place/wide/trioのみ)は
 * quinella/exacta/trifecta追加前の古い複製であり、そのまま使うと三連単はおろか馬連・馬単の
 * 的中判定も誤る(このスクリプトでは使わない・複製し直す)。
 */
function isHitProdCandidate(c: AllocationCandidate, order: readonly number[], orderSet: ReadonlySet<number>): boolean {
  if (c.betType === "win") {
    return order[0]! === c.umabans[0]!;
  }
  if (c.betType === "quinella") {
    return (
      (order[0]! === c.umabans[0]! && order[1]! === c.umabans[1]!) ||
      (order[0]! === c.umabans[1]! && order[1]! === c.umabans[0]!)
    );
  }
  if (c.betType === "exacta") {
    return order[0]! === c.umabans[0]! && order[1]! === c.umabans[1]!;
  }
  if (c.betType === "trifecta") {
    return order[0]! === c.umabans[0]! && order[1]! === c.umabans[1]! && order[2]! === c.umabans[2]!;
  }
  return c.umabans.every((u) => orderSet.has(u));
}

function buildIndexSets(
  orderedRaw: readonly OrderedOutcome[],
  sortedProdCandidates: readonly AllocationCandidate[],
): OutcomeIndexSet[] {
  const raw: OutcomeIndexSet[] = orderedRaw.map((outcome) => {
    const orderSet = new Set(outcome.order);
    const indices: number[] = [];
    for (let i = 0; i < sortedProdCandidates.length; i++) {
      if (isHitProdCandidate(sortedProdCandidates[i]!, outcome.order, orderSet)) {
        indices.push(i);
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

/**
 * 自前複製が本家`allocateGeneralBets`とビット一致することを検証する(`bench-run-greedy-allocation.ts`の
 * AC-1bと同型)。**着手前ゲート合意4により、不一致なら非ゼロ終了する**(複製が古いまま数値を
 * 出すことを防ぐ)。
 */
function selfCheckAgainstProduction(
  label: string,
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  positiveCandidates: readonly AllocationCandidate[],
  config: GeneralBetAllocationConfig,
): { readonly sortedProdCandidates: AllocationCandidate[]; readonly outcomeIndexSets: OutcomeIndexSet[] } {
  // candidateCapによる切り詰め(#107当時は候補数がcandidateCap未満という前提で切り詰め無しだったが、
  // 三連単を足すと超えうる。上記sortLikeProductionのJSDoc参照)。
  const sortedProdCandidates = sortLikeProduction(positiveCandidates, config.candidateCap);
  const expectedTruncatedByCapCount = Math.max(0, positiveCandidates.length - config.candidateCap);
  const orderedRaw = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, topFinishCount);
  if (orderedRaw === null) {
    console.error(`[${label}] AC5自己検査 失敗: buildOrderedDistributionがnullを返した(想定外の縮退)。`);
    process.exit(1);
  }
  const outcomeIndexSets = buildIndexSets(orderedRaw, sortedProdCandidates);
  const odds = sortedProdCandidates.map((c) => c.odds);

  const prodResult = allocateGeneralBets(horses, topFinishCount, positiveCandidates, config, PLACKETT_LUCE_MODEL);
  if (prodResult.diagnostics.truncatedByCapCount !== expectedTruncatedByCapCount) {
    console.error(
      `[${label}] AC5自己検査 失敗: production側candidateCap切り捨て数${prodResult.diagnostics.truncatedByCapCount} !== ` +
        `自前計算${expectedTruncatedByCapCount}(candidateCap=${config.candidateCap}・入力候補${positiveCandidates.length}件)。`,
    );
    process.exit(1);
  }
  if (expectedTruncatedByCapCount > 0) {
    console.log(
      `[${label}] candidateCap(=${config.candidateCap})により${expectedTruncatedByCapCount}件が切り捨てられている` +
        `(入力${positiveCandidates.length}件 → 採用${sortedProdCandidates.length}件)。`,
    );
  }
  if (prodResult.allocations.length !== sortedProdCandidates.length) {
    console.error(
      `[${label}] AC5自己検査 失敗: production側候補数${prodResult.allocations.length} !== 自前構築候補数${sortedProdCandidates.length}`,
    );
    process.exit(1);
  }

  const { fractions: ownFractions } = runGreedyAllocation(
    sortedProdCandidates.length,
    odds,
    outcomeIndexSets,
    config.greedySteps,
  );

  let mismatchCount = 0;
  for (let i = 0; i < sortedProdCandidates.length; i++) {
    const own = sortedProdCandidates[i]!;
    const prod = prodResult.allocations[i]!;
    const sameIdentity =
      own.betType === prod.betType &&
      own.umabans.length === prod.umabans.length &&
      own.umabans.every((u, k) => u === prod.umabans[k]);
    if (!sameIdentity) {
      console.error(
        `[${label}] AC5自己検査 失敗(識別不一致 i=${i}): 自前=${own.betType}:${own.umabans.join(",")} / ` +
          `production=${prod.betType}:${prod.umabans.join(",")}`,
      );
      mismatchCount++;
      continue;
    }
    if (ownFractions[i] !== prod.continuousFraction) {
      console.error(
        `[${label}] AC5自己検査 失敗(値不一致 i=${i}, ${own.betType}:${own.umabans.join(",")}): ` +
          `自前fractions=${ownFractions[i]} / production continuousFraction=${prod.continuousFraction}`,
      );
      mismatchCount++;
    }
  }
  if (mismatchCount > 0) {
    console.error(`[${label}] AC5自己検査: ${mismatchCount}件の不一致。複製がproductionと乖離している。非ゼロ終了する。`);
    process.exit(1);
  }
  console.log(`[${label}] AC5自己検査: 全${sortedProdCandidates.length}件がproductionのcontinuousFractionとビット一致(===)。`);
  return { sortedProdCandidates, outcomeIndexSets };
}

// ============================================================================
// AC1: 中央16頭・実オッズでの比較(現行6券種 vs +三連単)
// ============================================================================

/** AC1で使う「現行(三連単を含まない)」6券種。既定`ALL_MIXED_CANDIDATE_BET_TYPES`と集合として一致するが、
 *  将来その定数の並びが変わっても本スクリプトの意味を固定するため明示的に列挙する。 */
const BASELINE_BET_TYPES: readonly AllocationBetType[] = ["place", "win", "wide", "trio", "quinella", "exacta"];

interface Ac1Scenario {
  readonly race: MixedCandidateBuildInput;
  readonly horses: readonly JointModelHorse[];
  readonly topFinishCount: number;
  readonly buildCandidates: () => readonly AllocationCandidate[];
}

// ============================================================================
// AC2: 発売中フィクスチャ(合成: 別レースの実prior × 発売中オッズ)
// ============================================================================

function runAc2(result: AnalysisResult): void {
  console.log("");
  console.log("=== AC2: 発売中の三連単フィクスチャ(race_id=202606040901・9/27発走予定) ===");
  console.log(
    "  ⚠️ 合成値: 別レース(202603020211。中央16頭・確定)の実priorと、発売中オッズ" +
      "(202606040901)を組み合わせている。202606040901自身のRaceDataは未取得のため、" +
      "実際のそのレースの勝率・複勝率ではない(頭数16・馬番1〜16が一致することのみ確認済み)。",
  );

  const horses: JointModelHorse[] = result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));
  const presaleUmabans = new Set<number>();
  const oddsByKey = loadTrifectaOddsByKey(TRIFECTA_PRESALE_FIXTURE_PATH);
  for (const key of oddsByKey.keys()) {
    presaleUmabans.add(Number(key.slice(0, 2)));
    presaleUmabans.add(Number(key.slice(2, 4)));
    presaleUmabans.add(Number(key.slice(4, 6)));
  }
  const centralUmabans = new Set(horses.map((h) => h.umaban));
  const sameUmabans =
    presaleUmabans.size === centralUmabans.size && [...presaleUmabans].every((u) => centralUmabans.has(u));
  if (!sameUmabans) {
    console.error(
      `  ⚠️ 頭数・馬番が一致しない(presale=${[...presaleUmabans].sort((a, b) => a - b).join(",")} / ` +
        `central=${[...centralUmabans].sort((a, b) => a - b).join(",")})。合成の前提が崩れている。`,
    );
    process.exit(1);
  }

  const topFinishCount = 3;
  const buildResult = buildTrifectaCandidates(horses, topFinishCount, oddsByKey, EV_CONFIG);
  console.log(
    `  候補ビルド診断: 列挙${buildResult.diagnostics.enumeratedCount}件 / ` +
      `判定済(EVプラス${buildResult.diagnostics.judged.positiveCount}・EV非プラス${buildResult.diagnostics.judged.notPositiveCount}) / ` +
      `未判定(オッズ欠損${buildResult.diagnostics.unjudged.oddsMissingCount}・未取得${buildResult.diagnostics.unjudged.oddsUnfetchedCount}・不正値${buildResult.diagnostics.unjudged.oddsMalformedCount})`,
  );

  const timingBuild = measureWithBudget(() => {
    buildTrifectaCandidates(horses, topFinishCount, oddsByKey, EV_CONFIG);
  });
  console.log(
    `  所要時間(buildTrifectaCandidates単体): 平均${timingBuild.avgMs.toFixed(1)}ms / 最大${timingBuild.maxMs.toFixed(1)}ms` +
      `(反復${timingBuild.iterations}回・ウォームアップ${timingBuild.warmupMs.toFixed(1)}ms)`,
  );

  const config = buildConfig();
  const timingAlloc = measureWithBudget(() => {
    const built = buildTrifectaCandidates(horses, topFinishCount, oddsByKey, EV_CONFIG);
    allocateGeneralBets(horses, topFinishCount, built.candidates, config, PLACKETT_LUCE_MODEL);
  });
  const finalAlloc = allocateGeneralBets(horses, topFinishCount, buildResult.candidates, config, PLACKETT_LUCE_MODEL);
  console.log(
    `  所要時間(buildTrifectaCandidates+allocateGeneralBets、三連単単体): 平均${timingAlloc.avgMs.toFixed(1)}ms / ` +
      `最大${timingAlloc.maxMs.toFixed(1)}ms(反復${timingAlloc.iterations}回・ウォームアップ${timingAlloc.warmupMs.toFixed(1)}ms)`,
  );
  console.log(`  配分(三連単単体): 総額${finalAlloc.totalStake.toLocaleString()}円 / ${finalAlloc.betCount}点`);
}

// ============================================================================
// AC3: 18頭合成データ(全候補EVプラスの最悪ケース)
// ============================================================================

/** 決定的な疑似乱数生成器(LCG)。`scripts/bench-allocation.ts`の`makeRng`と同じ実装(再現性のため複製)。 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** n頭の合成馬集団を作る(`scripts/bench-allocation.ts`の`buildRaceData`と同じ生成規則。placeProbはΣ=3に正規化)。 */
function buildSyntheticHorses(n: number, seed: number): JointModelHorse[] {
  const rand = makeRng(seed);
  const raw = Array.from({ length: n }, () => 0.05 + rand() * 0.3);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((p, i) => ({ umaban: i + 1, placeProb: (p / sum) * 3 }));
}

/** n!/(n-3)! = P(n,3)。 */
function permutationCount3(n: number): number {
  return n * (n - 1) * (n - 2);
}

function measureMemory(fn: () => void): { readonly heapUsedDeltaMb: number; readonly rssDeltaMb: number; readonly gcUsed: boolean } {
  const gcFn = (global as { gc?: () => void }).gc;
  const gcUsed = typeof gcFn === "function";
  if (gcUsed) {
    gcFn!();
  }
  const before = process.memoryUsage();
  fn();
  if (gcUsed) {
    gcFn!();
  }
  const after = process.memoryUsage();
  return {
    heapUsedDeltaMb: (after.heapUsed - before.heapUsed) / (1024 * 1024),
    rssDeltaMb: (after.rss - before.rss) / (1024 * 1024),
    gcUsed,
  };
}

function runAc3(): void {
  console.log("");
  console.log("=== AC3: 18頭・合成データの最悪ケース(⚠️ 実データではなく合成値) ===");
  console.log(
    "  合成規則: placeProbは`scripts/bench-allocation.ts`のbuildRaceDataと同じ決定的LCGで生成(seed=18)。" +
      "オッズは(1/真の的中確率)×1.35固定倍率で、EV=1.35>閾値1.0を全候補に保証する" +
      "(同ファイルのALL_POSITIVE_NOISEと同じ流儀)。",
  );

  const n = 18;
  const horses = buildSyntheticHorses(n, 18);
  const topFinishCount = 3;
  const orderedRaw = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, topFinishCount);
  if (orderedRaw === null) {
    console.error("  AC3: buildOrderedDistributionがnullを返した(想定外の縮退)。合成入力を見直すこと。");
    process.exit(1);
  }
  const expectedCount = permutationCount3(n);
  if (orderedRaw.length !== expectedCount) {
    console.error(`  AC3: orderedRaw件数(${orderedRaw.length})がP(${n},3)=${expectedCount}と一致しない。`);
    process.exit(1);
  }

  const NOISE = 1.35;
  const oddsByKey = new Map<string, number | null>();
  let skippedZeroProb = 0;
  for (const outcome of orderedRaw) {
    if (outcome.probability <= 0) {
      skippedZeroProb++;
      continue;
    }
    const key = buildOrderedComboOddsKey(outcome.order);
    if (oddsByKey.has(key)) {
      console.error(`  AC3: キー衝突を検出(${key})。合成入力が一意でない。`);
      process.exit(1);
    }
    oddsByKey.set(key, (1 / outcome.probability) * NOISE);
  }
  if (skippedZeroProb > 0) {
    console.log(`  (的中確率0のため除外した順列: ${skippedZeroProb}件)`);
  }

  const buildResult = buildTrifectaCandidates(horses, topFinishCount, oddsByKey, EV_CONFIG);
  console.log(
    `  候補: 列挙${buildResult.diagnostics.enumeratedCount}件(=P(18,3)) / ` +
      `EVプラス${buildResult.diagnostics.judged.positiveCount}件(想定: 列挙数と一致)`,
  );
  if (buildResult.diagnostics.judged.positiveCount !== expectedCount - skippedZeroProb) {
    console.error(
      `  AC3: 「全候補EVプラス」の前提が崩れている(EVプラス${buildResult.diagnostics.judged.positiveCount} !== ` +
        `期待値${expectedCount - skippedZeroProb})。`,
    );
    process.exit(1);
  }

  for (const candidateCap of [DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap, 5000] as const) {
    const config = buildConfig({ candidateCap });
    const label = candidateCap === DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap ? `candidateCap=${candidateCap}(既定)` : `candidateCap=${candidateCap}(実質無制限。${expectedCount}候補全件を対象にする)`;

    // #96の署名畳み込みが理論上の最悪ケース(全候補が自分自身のoutcomeにしか反応しない)で
    // どこまで効かなくなるかを、AC5と同じ自己検査付きの複製で直接確かめる(候補が三連単のみ、
    // 全件EVプラスという構成のため、`isHitProdCandidate`のtrifecta分岐だけが働く)。
    const { sortedProdCandidates, outcomeIndexSets } = selfCheckAgainstProduction(
      label,
      horses,
      topFinishCount,
      buildResult.candidates,
      config,
    );
    console.log(`--- ${label} ---`);
    console.log(
      `  畳み込み後outcome数${outcomeIndexSets.length}(採用候補${sortedProdCandidates.length}件中) / ` +
        `Σ|indices|=${sumIndices(outcomeIndexSets)}`,
    );

    let lastAlloc: ReturnType<typeof allocateGeneralBets> | null = null;
    const timing = measureWithBudget(() => {
      lastAlloc = allocateGeneralBets(horses, topFinishCount, buildResult.candidates, config, PLACKETT_LUCE_MODEL);
    });
    console.log(
      `  所要時間: 平均${timing.avgMs.toFixed(1)}ms / 最大${timing.maxMs.toFixed(1)}ms` +
        `(反復${timing.iterations}回・ウォームアップ${timing.warmupMs.toFixed(1)}ms)`,
    );
    console.log(
      `  診断: candidateCapで${lastAlloc!.diagnostics.truncatedByCapCount}件切り捨て、converged=${lastAlloc!.diagnostics.converged}、` +
        `betCount=${lastAlloc!.betCount}、totalStake=${lastAlloc!.totalStake.toLocaleString()}円`,
    );

    const mem = measureMemory(() => {
      allocateGeneralBets(horses, topFinishCount, buildResult.candidates, config, PLACKETT_LUCE_MODEL);
    });
    if (mem.gcUsed) {
      console.log(`  メモリ差分(GC込み): heapUsed ${mem.heapUsedDeltaMb.toFixed(1)}MB / rss ${mem.rssDeltaMb.toFixed(1)}MB`);
    } else {
      console.log(
        `  メモリ差分(⚠️ GC未使用・参考値。NODE_OPTIONS=--expose-gcで再実行するとGC込みの値が取れる): ` +
          `heapUsed ${mem.heapUsedDeltaMb.toFixed(1)}MB / rss ${mem.rssDeltaMb.toFixed(1)}MB`,
      );
    }
  }

  // ★上記(既定greedySteps=1000)はいずれもbetCount=0・totalStake=0円だった(実測して気付いた。
  // メイン指摘で追加調査)。原因を切り分けるため、まずconfig側(bankroll/perRaceCap)を疑ったが、
  // 上記のとおりbankroll=100万円・perRaceCap=10万円のいずれも0ではない。実際の原因は
  // `skipReasonCode`診断値(`allocation-primitives.ts`)が示す`"no-edge"`——貪欲法の最初の1ステップ
  // (delta=1/greedySteps=1/1000=0.1%の賭け金)ですら、期待対数資産の増分がプラスにならない。
  // これは本合成データ固有の性質: 4896候補は互いに素な出来事(1つのoutcomeに対応する候補は
  // 高々1つ)で、各候補の的中確率は的中確率レンジ(オッズ947〜250875に対応する的中確率
  // 約1.4e-3〜5.4e-6)と非常に小さい。EV=1.35(真の的中確率×オッズ)は的中時の話であり、
  // delta=0.1%という粗い刻みで賭けると「ほぼ確実にdeltaを失う」コストが「低確率で大きく勝つ」
  // 期待値を上回ってしまう(離散化が確率スケールに対して粗すぎる)。連続極限(delta→0)では
  // 導関数がEV-1=0.35>0で確実にプラスになるはずだが、貪欲法は`delta`未満の刻みを扱えない。
  // ここで`greedySteps`を引き上げてdeltaを細かくすると、実際に配分が発生する
  // (下記参照)。**「候補が全件EVプラス」という合成条件自体は正しく成立している
  // (buildTrifectaCandidatesの診断が示すとおり)。0点になるのは資金設定の問題ではなく、
  // 既定greedySteps=1000の粗さとこの合成データの確率スケールが噛み合わない、という
  // 合成条件固有の副作用である。**
  console.log("");
  console.log(
    "  ⚠️ 上記(既定greedySteps=1000)がbetCount=0・totalStake=0円になる理由: 貪欲法の1ステップ" +
      "(delta=1/1000)ですら期待対数資産の増分がプラスにならない(skipReasonCode='no-edge')。" +
      "資金(bankroll=100万円・perRaceCap=10万円)は0ではなく設定の問題ではない。原因は本合成" +
      "データの的中確率が極小(オッズ947〜250875に対応する的中確率は約1.4e-3〜5.4e-6)で、" +
      "greedySteps=1000の刻み幅(0.1%)がこのスケールに対して粗すぎるという合成条件固有の" +
      "副作用。以下、greedySteps を引き上げ、実際に配分が発生する条件で1回測る" +
      "(candidateCap=5000固定。時間予算の都合上5000/20000のみ・100000は割愛)。",
  );
  for (const greedySteps of [5000, 20000] as const) {
    const config = buildConfig({ candidateCap: 5000, greedySteps });
    let lastAlloc: ReturnType<typeof allocateGeneralBets> | null = null;
    const timing = measureWithBudget(() => {
      lastAlloc = allocateGeneralBets(horses, topFinishCount, buildResult.candidates, config, PLACKETT_LUCE_MODEL);
    });
    console.log(`--- greedySteps=${greedySteps}(candidateCap=5000・実際に配分が発生する条件) ---`);
    console.log(
      `  所要時間: 平均${timing.avgMs.toFixed(1)}ms / 最大${timing.maxMs.toFixed(1)}ms` +
        `(反復${timing.iterations}回・ウォームアップ${timing.warmupMs.toFixed(1)}ms)`,
    );
    console.log(
      `  診断: betCount=${lastAlloc!.betCount}、totalStake=${lastAlloc!.totalStake.toLocaleString()}円、` +
        `converged=${lastAlloc!.diagnostics.converged}、capApplied(perRaceCap)=${lastAlloc!.capApplied}、` +
        `candidateCapで${lastAlloc!.diagnostics.truncatedByCapCount}件切り捨て`,
    );
  }
}

// ============================================================================
// AC5: 署名畳み込み後のoutcome数・Σ|indices|・時間、Workerプール見積もり
// ============================================================================

function runAc5(
  baseline: Ac1Scenario,
  withTrifecta: Ac1Scenario,
  ac1WithTrifectaAvgMs: number,
): void {
  console.log("");
  console.log("=== AC5: 署名畳み込み後のoutcome数・Σ|indices|・runGreedyAllocation単体の時間 ===");

  const config = buildConfig();
  // +trifectaの候補数(AC1実測: 2637件)は既定candidateCap(2000)を超えるため、既定candidateCapの
  // シナリオだけを見ると「candidateCapによって偶然一部の順序付き候補が間引かれた後」の
  // outcome数・Σ|indices|になり、#96の署名畳み込みが三連単本来の候補規模でどう振る舞うかを
  // 覆い隠してしまう。**candidateCapを外した(uncapped相当)シナリオも別途出す**(AC5の趣旨
  // 「畳み込みがスケールしないことを確かめる」に対して、cap由来の間引き効果と分離するため)。
  const uncappedConfig = buildConfig({ candidateCap: 3000 });

  for (const [label, scenario, scenarioConfig] of [
    ["baseline(place/win/wide/trio/quinella/exacta)", baseline, config],
    ["+trifecta(三連単を追加。candidateCap既定2000)", withTrifecta, config],
    ["+trifecta(三連単を追加。candidateCap無制限相当=3000)", withTrifecta, uncappedConfig],
  ] as const) {
    const candidates = scenario.buildCandidates();
    const positiveCandidates = candidates.filter((c) => c.isPositive);
    const { sortedProdCandidates, outcomeIndexSets } = selfCheckAgainstProduction(
      label,
      scenario.horses,
      scenario.topFinishCount,
      positiveCandidates,
      scenarioConfig,
    );
    const odds = sortedProdCandidates.map((c) => c.odds);
    const timing = measureWithBudget(() => {
      runGreedyAllocation(sortedProdCandidates.length, odds, outcomeIndexSets, scenarioConfig.greedySteps);
    });
    console.log(`--- ${label} ---`);
    console.log(
      `  候補${sortedProdCandidates.length}件 / 畳み込み後outcome数${outcomeIndexSets.length} / ` +
        `Σ|indices|=${sumIndices(outcomeIndexSets)}`,
    );
    console.log(
      `  runGreedyAllocation単体の所要時間: 平均${timing.avgMs.toFixed(1)}ms / 最大${timing.maxMs.toFixed(1)}ms` +
        `(反復${timing.iterations}回・ウォームアップ${timing.warmupMs.toFixed(1)}ms)`,
    );
  }

  console.log("");
  console.log(
    "  ⚠️ Workerプール(#119)の12レース一括見積もり(算術見積もりであり、実際にWorker Poolを" +
      "起動して測ったものではない)。並列数の上限式: max(1, min(hardwareConcurrency−1, 4))" +
      "(mixed-allocation-worker-pool.tsのcomputeAllocationWorkerPoolCap)。" +
      "AC1の「+trifecta」条件(buildMixedCandidates+buildTrifectaCandidates+allocateGeneralBets)の" +
      `1レース平均${ac1WithTrifectaAvgMs.toFixed(1)}msを使う。`,
  );
  for (const concurrency of [2, 4] as const) {
    const races = 12;
    const rounds = Math.ceil(races / concurrency);
    const estimateMs = rounds * ac1WithTrifectaAvgMs;
    console.log(
      `  並列数${concurrency}(${concurrency === 2 ? "3コア機相当" : "5コア以上相当"}): ` +
        `ceil(12/${concurrency})=${rounds}ラウンド × ${ac1WithTrifectaAvgMs.toFixed(1)}ms ≈ ${estimateMs.toFixed(0)}ms`,
    );
  }
}

// ============================================================================
// main
// ============================================================================

async function main(): Promise<void> {
  const result = await loadAnalysisResult();
  console.log(`raceId=${result.raceId} rows=${result.rows.length}頭 oddsStatus=${result.oddsStatus}`);

  // AC1で使う馬連・馬単フィクスチャを読み込み、raceへ足し込む(loadAnalysisResult自体は
  // wideCombo/trioComboしか持たないため。toMixedCandidateInputはresultからwideCombo/trioCombo/
  // comboOddsしか読まないため、quinellaCombo/exactaComboは別途足す必要がある。
  // bench-mixed-allocation.tsのAC1条件と同じ形)。
  const quinellaCombo = loadComboRecord(QUINELLA_FIXTURE_PATH, "quinella");
  const exactaCombo = loadComboRecord(EXACTA_FIXTURE_PATH, "exacta");
  const baseRace = toMixedCandidateInput(result);
  const raceWithCombos: MixedCandidateBuildInput = { ...baseRace, quinellaCombo, exactaCombo };

  const { baseline, withTrifecta, withTrifectaAvgMs } = runAc1(result, raceWithCombos);
  runAc2(result);
  runAc3();
  runAc5(baseline, withTrifecta, withTrifectaAvgMs);
}

/**
 * AC1: 中央16頭・実オッズで、現行6券種(複勝・単勝・ワイド・3連複・馬連・馬単)と
 * それに三連単を足した条件を比較する。`race`は呼び出し側(`main`)が馬連・馬単フィクスチャを
 * 混ぜ込んだ`MixedCandidateBuildInput`を渡す(`toMixedCandidateInput(result)`だけでは
 * `quinellaCombo`/`exactaCombo`を持たないため)。
 */
function runAc1(
  result: AnalysisResult,
  race: MixedCandidateBuildInput,
): {
  readonly baseline: Ac1Scenario;
  readonly withTrifecta: Ac1Scenario;
  readonly baselineAvgMs: number;
  readonly withTrifectaAvgMs: number;
} {
  console.log("");
  console.log("=== AC1: 中央16頭・実オッズ(現行6券種 vs +三連単) ===");

  const horses: JointModelHorse[] = result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));
  const trifectaOddsByKey = loadTrifectaOddsByKey(TRIFECTA_FIXTURE_PATH);

  const baselineOnce = buildMixedCandidates(race, { evConfig: EV_CONFIG, betTypes: BASELINE_BET_TYPES });
  const topFinishCount = baselineOnce.topFinishCount;

  const baseline: Ac1Scenario = {
    race,
    horses,
    topFinishCount,
    buildCandidates: () => buildMixedCandidates(race, { evConfig: EV_CONFIG, betTypes: BASELINE_BET_TYPES }).candidates,
  };
  const withTrifecta: Ac1Scenario = {
    race,
    horses,
    topFinishCount,
    buildCandidates: () => {
      const mixed = buildMixedCandidates(race, { evConfig: EV_CONFIG, betTypes: BASELINE_BET_TYPES });
      const trifecta = buildTrifectaCandidates(horses, mixed.topFinishCount, trifectaOddsByKey, EV_CONFIG);
      return [...mixed.candidates, ...trifecta.candidates];
    },
  };

  const config = buildConfig();
  const avgMsByLabel = new Map<"baseline" | "withTrifecta", number>();

  for (const [key, label, scenario] of [
    ["baseline", "baseline(place/win/wide/trio/quinella/exacta)", baseline],
    ["withTrifecta", "+trifecta(三連単を追加)", withTrifecta],
  ] as const) {
    let lastCandidates: readonly AllocationCandidate[] = [];
    const timing = measureWithBudget(() => {
      const candidates = scenario.buildCandidates();
      allocateGeneralBets(scenario.horses, scenario.topFinishCount, candidates, config, PLACKETT_LUCE_MODEL);
      lastCandidates = candidates;
    });
    avgMsByLabel.set(key, timing.avgMs);
    const alloc = allocateGeneralBets(scenario.horses, scenario.topFinishCount, lastCandidates, config, PLACKETT_LUCE_MODEL);
    const counts = countByBetType(lastCandidates);
    const byType = summarizeByBetType(alloc.allocations);
    const total = alloc.totalStake;
    console.log(`--- ${label} ---`);
    console.log(
      `  候補数: 単勝${counts.win} / 複勝${counts.place} / ワイド${counts.wide} / 三連複${counts.trio} / ` +
        `馬連${counts.quinella} / 馬単${counts.exacta} / 三連単${counts.trifecta}(合計${lastCandidates.length}件)`,
    );
    console.log(
      `  所要時間: 平均${timing.avgMs.toFixed(1)}ms / 最大${timing.maxMs.toFixed(1)}ms` +
        `(反復${timing.iterations}回・ウォームアップ${timing.warmupMs.toFixed(1)}ms。反復回数は時間予算から自動決定)`,
    );
    console.log(
      `  配分: 総額${total.toLocaleString()}円 / ${alloc.betCount}点 / ${formatComposition(total, byType)}`,
    );
    console.log(
      `  診断: candidateCapで${alloc.diagnostics.truncatedByCapCount}件切り捨て(candidateCap=${config.candidateCap})、` +
        `converged=${alloc.diagnostics.converged}`,
    );

    // メイン追加指示(2026-09-26): +trifecta条件でcandidateCapに切り捨てられた候補の券種別内訳。
    // 「単勝16.6%→11.1%等の構成比変化が、既存券種の候補が押し出されたからか」を確かめる材料。
    if (key === "withTrifecta") {
      const breakdown = computeCandidateCapBreakdown(lastCandidates, config.candidateCap);
      const types: AllocationBetType[] = ["win", "place", "wide", "trio", "quinella", "exacta", "trifecta"];
      const labelOf: Record<AllocationBetType, string> = {
        win: "単勝",
        place: "複勝",
        wide: "ワイド",
        trio: "三連複",
        quinella: "馬連",
        exacta: "馬単",
        trifecta: "三連単",
      };
      console.log(`  candidateCap切り詰めの券種別内訳(cap前→cap後、[切り捨て件数]):`);
      for (const t of types) {
        console.log(
          `    ${labelOf[t]}: ${breakdown.beforeByType[t]}件 → ${breakdown.afterByType[t]}件 ` +
            `[切り捨て${breakdown.droppedByType[t]}件]`,
        );
      }
      console.log(
        `  境界のEV: cap内最後(rank=${config.candidateCap})のEV=${breakdown.boundaryEv?.toFixed(4) ?? "N/A"} / ` +
          `cap外最初(rank=${config.candidateCap + 1})のEV=${breakdown.firstDroppedEv?.toFixed(4) ?? "N/A"}`,
      );
      console.log(
        `  三連単以外(既存6券種)の候補のうち、三連単追加によりcandidateCapで押し出された件数: ` +
          `${breakdown.nonTrifectaDroppedCount}件`,
      );
    }
  }

  return {
    baseline,
    withTrifecta,
    baselineAvgMs: avgMsByLabel.get("baseline")!,
    withTrifectaAvgMs: avgMsByLabel.get("withTrifecta")!,
  };
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
