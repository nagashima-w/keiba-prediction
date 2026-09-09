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
 * ## 入力の作り方(production 到達可能域を模す。要修正5で是正)
 * `scorer/prior.ts` の `computeFieldPriors`(:246-297)と同じ「クランプ → Σを
 * min(targetPlaceCount, 頭数) へ一律スケールで正規化(逸脱が normalizeTolerance を超えるときのみ)
 * → 再クランプ」という順序を、本スクリプトの `computeNormalizedRawPriors` として再現する
 * (`computeFieldPriors` 自体は `DerivedRaceFeature`/`TodayRaceConditions` 等の重い依存を要求し、
 * 過去走を空にすると全馬同一の退化した prior になってしまうため、正規化アルゴリズムだけを
 * ミラーする設計にした。定数〈minPrior/maxPrior/targetPlaceCount/normalizeTolerance〉は
 * `DEFAULT_SCORER_CONFIG.prior` から直接読み込み、二重定義しない)。
 *
 * 是正前(#77初回実装)は各馬の placeProb を `[minPrior,maxPrior]` から独立一様乱色で生成しており、
 * Σが正規化されないまま `avgSumP≈8.8`(目標3の約3倍)という production では起こらない入力で
 * 計測していた(code-reviewerの指摘・メインの実物検算で判明)。是正後は正規化により
 * Σprior が概ね `min(3,頭数)` に寄るため、既定(±0.10)なら Σp∈[3-1.8,3+1.8]=[1.2,4.8]
 * 相当の範囲に収まる(boss 着手前ゲート第2回の実測と算術的に整合する)。
 *
 * `analyzer/clip-variants.ts` の CLIP_VARIANTS(既定±0.10・wide15±0.15)と組み合わせ、
 * 決定的な疑似乱数(LCG。外部ライブラリ不使用)で 18頭・複勝人数3 のレースを大量に生成する。
 * 正規化後の prior に対して ±maxAdjust の範囲でさらに一様乱数を加えて adjustedProb
 * (=placeProb)とする(p=0/p=1の境界にも実際に到達する)。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-joint-model.ts
 *
 * 出力される ms 値は本スクリプトの実行結果そのものであり、再現手段は「このスクリプトを実行する」
 * こと自体である(JSDocに再現手段のない ms 値を書かない、というAC-9の要求への対応)。
 * `computePlackettLuceMarginals`(閉形式)と「816通りの分布を毎回構築する素朴な実装」の速度差
 * (要修正2)も本スクリプトの `runNaiveVsClosedFormComparison` で測り、実測比を出力する。
 */

import {
  CONDITIONAL_BERNOULLI_MODEL,
  PLACKETT_LUCE_MODEL,
  fitPlackettLuceStrengths,
  computePlackettLuceMarginals,
  MAX_FIT_ITERATIONS,
  FIT_TOLERANCE,
  type JointModelHorse,
  type PlaceOutcome,
} from "../packages/core/src/ev/place-joint-model.js";
import { DEFAULT_SCORER_CONFIG } from "../packages/core/src/scorer/config.js";
import { CLIP_VARIANTS } from "../packages/core/src/analyzer/clip-variants.js";

/**
 * `scorer/prior.ts` の `computeFieldPriors` と同じ正規化アルゴリズムを、素の数値配列に対して
 * 再現する(クランプ → Σが目標から `normalizeTolerance` を超えて逸脱していれば一律スケール →
 * 再クランプ)。定数は DEFAULT_SCORER_CONFIG.prior から直接読む(二重定義しない)。
 */
function computeNormalizedRawPriors(rawPriors: readonly number[]): number[] {
  const { minPrior, maxPrior, targetPlaceCount, normalizeTolerance } =
    DEFAULT_SCORER_CONFIG.prior;
  const fieldSize = rawPriors.length;
  const target = Math.min(targetPlaceCount, fieldSize);
  const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
  const clamped = rawPriors.map((v) => clamp(v, minPrior, maxPrior));
  const sumClamped = clamped.reduce((a, b) => a + b, 0);
  let scale = 1;
  if (sumClamped > 0 && Math.abs(sumClamped - target) / target > normalizeTolerance) {
    scale = target / sumClamped;
  }
  return clamped.map((v) => clamp(v * scale, minPrior, maxPrior));
}

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

/**
 * production 相当の18頭・複勝人数3のレースを1件生成する(clipVariantで±maxAdjustを切替)。
 * 要修正5: raw prior → computeNormalizedRawPriors(Σを min(3,頭数) へ正規化) → ±maxAdjust の
 * クリップ、という production と同じ順序(prior.ts のクランプ→正規化→再クランプ、
 * その後 parse-response.ts の ±maxAdjust クリップ)で生成する。
 */
function buildRaceHorses(
  rand: () => number,
  clipVariantId: keyof typeof CLIP_VARIANTS,
): JointModelHorse[] {
  const maxAdjust = CLIP_VARIANTS[clipVariantId].maxAdjust;
  const n = 18;
  // raw prior(正規化前)は neutralProb(=min(3,n)/n≈0.167) 付近を中心に、補正で大きく
  // ぶれる実態を模して [0, 1.2] の一様乱数から引く(clamp→正規化で現実的な散らばりになる)。
  const rawPriors = Array.from({ length: n }, () => uniform(rand, 0, 1.2));
  const priors = computeNormalizedRawPriors(rawPriors);
  return priors.map((prior, i) => {
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

/** items(添字配列)からk個を選ぶ組合せを列挙する(小さいkのみを想定)。 */
function combinationsOf(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
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

/** 配列の順列を全列挙する(小さい配列のみを想定)。 */
function permutationsOf(items: readonly number[]): number[][] {
  if (items.length <= 1) return [items.slice()];
  const results: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutationsOf(rest)) {
      results.push([items[i]!, ...p]);
    }
  }
  return results;
}

/**
 * 「816通りの分布を毎回構築する素朴な実装」で周辺確率を計算する(比較用。本番コードではない)。
 * 各組合せSについてk!通りの並び順の和で確率を求め、馬ごとに含まれる組合せの確率を合算する。
 */
function naiveMarginalsViaFullEnumeration(theta: readonly number[], k: number): number[] {
  const n = theta.length;
  const Theta = theta.reduce((a, b) => a + b, 0);
  const indices = theta.map((_, i) => i);
  const marginals = new Array(n).fill(0);
  for (const combo of combinationsOf(indices, k)) {
    let comboProb = 0;
    for (const perm of permutationsOf(combo)) {
      let denom = Theta;
      let prob = 1;
      for (const idx of perm) {
        prob *= theta[idx]! / denom;
        denom -= theta[idx]!;
      }
      comboProb += prob;
    }
    for (const idx of combo) marginals[idx] += comboProb;
  }
  return marginals;
}

/**
 * 要修正2: 「816通りの分布を毎回構築する素朴な実装」と閉形式(computePlackettLuceMarginals)の
 * 速度差を実測する(反復フィットのループ内で毎回呼ばれる想定を模し、複数回呼んだ平均で比較する)。
 */
function runNaiveVsClosedFormComparison(): void {
  console.log("\n=== 要修正2: 閉形式 vs 素朴な実装(816通り毎回構築)の速度差実測 ===");
  const n = 18;
  const theta = Array.from({ length: n }, (_, i) => 0.3 + (i % 7) * 0.4);
  const k = 3;
  const repeats = 50;

  // ウォームアップ。
  for (let i = 0; i < 10; i++) {
    computePlackettLuceMarginals(theta, k);
    naiveMarginalsViaFullEnumeration(theta, k);
  }

  const t0 = performance.now();
  for (let i = 0; i < repeats; i++) computePlackettLuceMarginals(theta, k);
  const t1 = performance.now();
  for (let i = 0; i < repeats; i++) naiveMarginalsViaFullEnumeration(theta, k);
  const t2 = performance.now();

  const closedFormMs = (t1 - t0) / repeats;
  const naiveMs = (t2 - t1) / repeats;
  console.log(`  閉形式: ${closedFormMs.toFixed(4)}ms/回 / 素朴な実装: ${naiveMs.toFixed(4)}ms/回`);
  console.log(`  速度比(素朴/閉形式): ${(naiveMs / closedFormMs).toFixed(1)}倍`);
}

console.log(`MAX_FIT_ITERATIONS=${MAX_FIT_ITERATIONS} / FIT_TOLERANCE=${FIT_TOLERANCE}`);
runColdStartMeasurement();
runSingleShotPerformanceCheck();
runNaiveVsClosedFormComparison();
runModelLayer("default", 200);
runModelLayer("wide15", 200);
