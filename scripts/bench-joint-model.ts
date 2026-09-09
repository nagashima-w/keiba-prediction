/**
 * bench-joint-model — Plackett-Luce モデル(PLACKETT_LUCE_MODEL)のベンチマーク(Issue #77・#20-A)。
 *
 * ## 目的(2層構成。boss着手前ゲート第2回)
 * - **モデル層(必須。AC-3/AC-9の根拠はここから引く)**: 両モデルの marginalDeviationMax・
 *   上位k集合分布の総変動距離・outcome数・所要ms・θフィットの反復数と残差・not-converged発生率。
 * - **配分層(任意・#20-Bで拡張する想定)**: 本スクリプトでは出していない。配分結果(Σx*・
 *   betCount・totalStake)をテストの期待値にすると、#20-Bが既定モデルを切り替えた瞬間に
 *   同じ数値が2箇所で管理される二重定義になるため(#20-A着手前ゲート第2回の裁定)。
 *   `scripts/bench-allocation.ts`(配分結果の性能計測。別目的)は本スクリプトで置き換えない
 *   (両者は併存する)。
 *
 * ## 入力の作り方(production 到達可能域を模す)
 * `scorer/prior.ts` の [minPrior=0.02, maxPrior=0.95] と `analyzer/clip-variants.ts` の
 * CLIP_VARIANTS(既定±0.10・wide15±0.15)を組み合わせ、決定的な疑似乱数(LCG。外部ライブラリ
 * 不使用)で 18頭・複勝人数3 のレースを大量に生成する。各馬の prior を [0.02,0.95] から一様に
 * 引き、それぞれ ±maxAdjust の範囲でさらに一様乱数を加えて adjustedProb(=placeProb)とする
 * (p=0/p=1の境界にも実際に到達する。CLIP_VARIANTSのmaxAdjust・prior.tsのminPrior/maxPrior
 * どちらも実装から値を読み込み、転記しない)。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-joint-model.ts
 *
 * 出力される ms 値は本スクリプトの実行結果そのものであり、再現手段は「このスクリプトを実行する」
 * こと自体である(JSDocに再現手段のない ms 値を書かない、というAC-9の要求への対応)。
 */

import {
  CONDITIONAL_BERNOULLI_MODEL,
  PLACKETT_LUCE_MODEL,
  fitPlackettLuceStrengths,
  MAX_FIT_ITERATIONS,
  FIT_TOLERANCE,
  type JointModelHorse,
  type PlaceOutcome,
} from "../packages/core/src/ev/place-joint-model.js";
import { DEFAULT_SCORER_CONFIG } from "../packages/core/src/scorer/config.js";
import { CLIP_VARIANTS } from "../packages/core/src/analyzer/clip-variants.js";

/** 決定的な疑似乱数生成器(LCG)。 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** [min,max]で一様乱数を引く。 */
function uniform(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

/** production 相当の18頭・複勝人数3のレースを1件生成する(clipVariantで±maxAdjustを切替)。 */
function buildRaceHorses(
  rand: () => number,
  clipVariantId: keyof typeof CLIP_VARIANTS,
): JointModelHorse[] {
  const { minPrior, maxPrior } = DEFAULT_SCORER_CONFIG.prior;
  const maxAdjust = CLIP_VARIANTS[clipVariantId].maxAdjust;
  const n = 18;
  return Array.from({ length: n }, (_, i) => {
    const prior = uniform(rand, minPrior, maxPrior);
    const lower = Math.max(0, prior - maxAdjust);
    const upper = Math.min(1, prior + maxAdjust);
    const placeProb = uniform(rand, lower, upper);
    return { umaban: i + 1, placeProb };
  });
}

/** 分布からの周辺確率(馬iを含むoutcomeの確率合計)。 */
function marginalOf(distribution: readonly PlaceOutcome[], umaban: number): number {
  return distribution
    .filter((o) => o.placed.includes(umaban))
    .reduce((a, o) => a + o.probability, 0);
}

/** marginalDeviationMax = max_i |周辺確率 - 入力placeProb|。 */
function marginalDeviationMax(
  horses: readonly JointModelHorse[],
  distribution: readonly PlaceOutcome[],
): number {
  let maxDev = 0;
  for (const h of horses) {
    const marginal = marginalOf(distribution, h.umaban);
    maxDev = Math.max(maxDev, Math.abs(marginal - h.placeProb));
  }
  return maxDev;
}

/** 2つの分布(同じoutcome集合を仮定)の総変動距離(TV距離)= (1/2)Σ|p_i - q_i|。 */
function totalVariationDistance(
  a: readonly PlaceOutcome[],
  b: readonly PlaceOutcome[],
): number {
  const bByKey = new Map(b.map((o) => [o.placed.join(","), o.probability]));
  let sum = 0;
  for (const o of a) {
    const bp = bByKey.get(o.placed.join(",")) ?? 0;
    sum += Math.abs(o.probability - bp);
  }
  return sum / 2;
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

function runModelLayer(clipVariantId: keyof typeof CLIP_VARIANTS, sampleCount: number): void {
  console.log(`\n=== モデル層: clipVariant=${clipVariantId}(N=${sampleCount}) ===`);
  const rand = makeRng(clipVariantId === "default" ? 20260909 : 20260910);

  // JIT のウォームアップ(V8の最適化コンパイルが済むまでの最初の数回は遅い。計測対象から外す
  // ため、別の乱数系列で20件のウォームアップを先に走らせる。計測本体の乱数系列には影響しない)。
  const warmupRand = makeRng(clipVariantId === "default" ? 999001 : 999002);
  for (let i = 0; i < 20; i++) {
    const h = buildRaceHorses(warmupRand, clipVariantId);
    const f = fitPlackettLuceStrengths(h, 3);
    if (f.ok) PLACKETT_LUCE_MODEL.buildDistribution(h, 3);
  }

  const plFitMs: number[] = [];
  const plDistMs: number[] = [];
  const plDeviations: number[] = [];
  const cbDeviations: number[] = [];
  const tvDistances: number[] = [];
  const iterationsList: number[] = [];
  const residuals: number[] = [];
  let notConvergedCount = 0;
  let otherFailureCount = 0;
  let plWorseCount = 0;
  let successCount = 0;

  for (let i = 0; i < sampleCount; i++) {
    const horses = buildRaceHorses(rand, clipVariantId);
    const k = 3;

    const t0 = performance.now();
    const fit = fitPlackettLuceStrengths(horses, k);
    const t1 = performance.now();

    if (!fit.ok) {
      if (fit.reason === "not-converged") notConvergedCount++;
      else otherFailureCount++;
      continue;
    }

    const t2 = performance.now();
    const plDistribution = PLACKETT_LUCE_MODEL.buildDistribution(horses, k);
    const t3 = performance.now();

    const cbDistribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses, k);

    const plDev = marginalDeviationMax(horses, plDistribution);
    const cbDev = marginalDeviationMax(horses, cbDistribution);
    const tv = totalVariationDistance(plDistribution, cbDistribution);

    plFitMs.push(t1 - t0);
    plDistMs.push(t3 - t2);
    plDeviations.push(plDev);
    cbDeviations.push(cbDev);
    tvDistances.push(tv);
    iterationsList.push(fit.iterations);
    residuals.push(fit.residualMax);
    if (plDev > cbDev) plWorseCount++;
    successCount++;
  }

  const totalMs = plFitMs.map((v, i) => v + plDistMs[i]!).sort((a, b) => a - b);
  const sortedIterations = [...iterationsList].sort((a, b) => a - b);

  console.log(`  成功: ${successCount}/${sampleCount}`);
  console.log(
    `  not-converged: ${notConvergedCount}/${sampleCount}(${((notConvergedCount / sampleCount) * 100).toFixed(1)}%)`,
  );
  console.log(`  その他の失敗(invalid-probability等): ${otherFailureCount}/${sampleCount}`);
  if (successCount > 0) {
    console.log(
      `  フィット+分布生成 合計ms: 中央値=${percentile(totalMs, 0.5).toFixed(3)} / 95%点=${percentile(totalMs, 0.95).toFixed(3)} / 最悪=${totalMs[totalMs.length - 1]!.toFixed(3)}`,
    );
    console.log(
      `  θフィット反復回数: 中央値=${percentile(sortedIterations, 0.5)} / 95%点=${percentile(sortedIterations, 0.95)} / 最悪=${sortedIterations[sortedIterations.length - 1]}`,
    );
    console.log(
      `  marginalDeviationMax: PL中央値=${percentile([...plDeviations].sort((a, b) => a - b), 0.5).toFixed(6)} / CB中央値=${percentile([...cbDeviations].sort((a, b) => a - b), 0.5).toFixed(6)}`,
    );
    console.log(
      `  PLがCBより悪化した割合: ${plWorseCount}/${successCount}(${((plWorseCount / successCount) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  上位k集合分布の総変動距離(PL vs CB): 中央値=${percentile([...tvDistances].sort((a, b) => a - b), 0.5).toFixed(6)}`,
    );
    console.log(`  outcome数: C(18,3)=816(両モデル共通)`);
  }
}

/** AC-9: 18頭・k=3で「フィット+分布生成」が5ms未満であることを確認する(Σp=kちょうどの単発計測)。 */
function runSingleShotPerformanceCheck(): void {
  console.log("\n=== AC-9: 18頭・k=3の単発性能計測(Σp=kちょうど) ===");
  const n = 18;
  const raw = Array.from({ length: n }, (_, i) => 0.05 + (i % 6) * 0.03);
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const horses: JointModelHorse[] = raw.map((p, i) => ({
    umaban: i + 1,
    placeProb: (p / rawSum) * 3, // Σp=3ちょうどに正規化する。
  }));
  const sum = horses.reduce((a, h) => a + h.placeProb, 0);
  console.log(`  Σp=${sum.toFixed(6)}(k=3に正規化済み)`);

  // JIT ウォームアップ(コールドスタートの計測値は既に別途報告済み。ここでは定常状態を測る。
  // 1回だけの呼び出しではV8の最適化コンパイルが済み切らないことがあるため20回回す)。
  for (let i = 0; i < 20; i++) {
    const warmupFit = fitPlackettLuceStrengths(horses, 3);
    if (warmupFit.ok) PLACKETT_LUCE_MODEL.buildDistribution(horses, 3);
  }

  const t0 = performance.now();
  const fit = fitPlackettLuceStrengths(horses, 3);
  const t1 = performance.now();
  if (!fit.ok) {
    console.log(`  フィット失敗: reason=${fit.reason}`);
    return;
  }
  const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses, 3);
  const t2 = performance.now();
  console.log(`  フィットms=${(t1 - t0).toFixed(3)} / 分布生成ms=${(t2 - t1).toFixed(3)} / 合計ms=${(t2 - t0).toFixed(3)}`);
  console.log(`  反復回数=${fit.iterations} / 残差=${fit.residualMax}`);
  console.log(`  outcome数=${distribution.length}(C(18,3)=816)`);
}

/**
 * コールドスタート(このNodeプロセスで初めてこれらの関数を呼ぶときのJITウォームアップ込みの
 * 実測値)を単独で報告する。本番(Electronアプリ)ではプロセス起動後に何度も呼ばれるため、
 * 定常状態(ウォームアップ後)の値がAC-9の実質的な判定対象になるが、「1回目がどれだけ遅いか」
 * も隠さず報告する。
 */
function runColdStartMeasurement(): void {
  console.log("\n=== コールドスタート実測(このプロセスで最初の1回。JITウォームアップ込み) ===");
  const n = 18;
  const raw = Array.from({ length: n }, (_, i) => 0.05 + (i % 6) * 0.03);
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const horses: JointModelHorse[] = raw.map((p, i) => ({
    umaban: i + 1,
    placeProb: (p / rawSum) * 3,
  }));
  const t0 = performance.now();
  const fit = fitPlackettLuceStrengths(horses, 3);
  const t1 = performance.now();
  if (!fit.ok) {
    console.log(`  フィット失敗: reason=${fit.reason}`);
    return;
  }
  const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses, 3);
  const t2 = performance.now();
  console.log(
    `  フィットms=${(t1 - t0).toFixed(3)} / 分布生成ms=${(t2 - t1).toFixed(3)} / 合計ms=${(t2 - t0).toFixed(3)}`,
  );
  console.log(`  outcome数=${distribution.length}(C(18,3)=816)`);
}

console.log(`MAX_FIT_ITERATIONS=${MAX_FIT_ITERATIONS} / FIT_TOLERANCE=${FIT_TOLERANCE}`);
runColdStartMeasurement();
runSingleShotPerformanceCheck();
runModelLayer("default", 200);
runModelLayer("wide15", 200);
