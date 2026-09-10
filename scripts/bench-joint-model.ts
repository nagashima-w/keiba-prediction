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
 *
 * ## LLM応答のクリップ再現(要修正3で追加)
 * `analyzer/parse-response.ts`(:294-309)は、LLMの生の応答値が窓 `[lower,upper]` の外に
 * あれば**値そのものではなく窓の端点にスナップ**する。是正前(#77初回実装)は LLM 応答を
 * 窓の内側 `[lower,upper]` から一様乱数で引いていたため、端点(p=0/p=1)に一致する確率が
 * 測度0で、この差分の中核である縮約経路(degenerateZeroCount 等)を bench が一度も
 * 通っていなかった(code-reviewer・メインの指摘)。是正後は LLM 応答を窓よりずっと広い
 * 範囲(`prior±0.6`。`[0,1]`の外にもはみ出す)から引き、`applyProductionClip` で実際に
 * クリップする。raw prior も「大半0〜0.25・5%が0.9〜0.99の突出馬」という混合分布に変更した
 * (独立一様分布1本だと正規化の一律スケールが強く効きすぎ、突出馬がいても maxPrior=0.95 に
 * 届かずp=1に構造的に到達できなかったため)。
 *
 * **この是正により明らかになったこと(#78の材料)**: p=0を含むレースは98.5〜100%、p=1を
 * 含むレースは12〜14%に達し(自分の実測。下記「使い方」で再現可能)、
 * `degenerateFixedCount`/`rescaleInducedFixedCount` も平均0より大きくなる(縮約経路を
 * 実際に通るようになった)。一方で `not-converged` も 0%ではなくなり(default 0.5%程度)、
 * **フィット+分布生成のms分布は中央値こそ2〜3ms台に留まるが、95%点は8〜12ms、最悪値は
 * p=1近傍の内点ターゲットを含むレースで30〜80ms台に達することがある**(θフィット反復回数が
 * 数百〜1000超になるケースが実在する)。
 *
 * **AC-9(18頭・k=3のフィット+分布生成が5ms未満)は、この本番相当分布に対しては未達である
 * (要修正Bで明記。「別物として明記する」という読み替えは boss メタレビューで差し戻された)。**
 * AC-9 の5msが実際に成立するのは `runSingleShotPerformanceCheck`(Σp=kちょうどの単発計測。
 * 反復5回・実測1.3〜1.4ms)だけであり、`runModelLayer` が測るこの現実的な入力分布では
 * 95%点10.6ms・最悪36.7ms(default)/78.1ms(wide15)で、5msの2〜16倍に達する。
 * `MAX_FIT_ITERATIONS=2000`(`plackett-luce-strength.ts`)は「5msの予算より
 * `not-converged`率を優先した」選択である。**この上限を50〜20000まで振ったときの
 * not-converged率・フィット所要msの表(Issue #80・#78-A・実測是正)は、二重管理を避けるため
 * `plackett-luce-strength.ts` の `MAX_FIT_ITERATIONS` JSDocに一本化して置いた**
 * (旧版がここに書いていた「上限200では最悪3.56ms・非収束14.5%」という単一の数字は、
 * `runModelLayer`〈頭数18固定・N=200〉と母集団が異なる旧世代の試作実装での値であり
 * HEADでは再現しない。#78のゲートで検出・是正した。この表を得る `runFitPerformanceSweep`
 * を本スクリプト末尾に追加した)。この未達は **#20-A では `PLACKETT_LUCE_MODEL` の
 * production 呼び出し元がゼロのため実害が無く**、既定モデルの切替(#81)を検討する際の
 * 前提として申し送る。
 *
 * **`marginalDeviationMax`(下記`runModelLayer`が出力する中央値・PL劣化割合)についての
 * 申し送りの経緯**: 以前このJSDoc・`docs/issue-order.md`に書かれていた「57.5% / 75.5%」
 * 「PL 0.018619 / CB 0.018329」は、bench がLLM応答のクリップ経路(p=0/p=1への到達)を
 * まだ再現していなかった`f6cc6d4`世代の値を、オーケストレーターが「是正後」と誤って
 * ラベル付けし転記したものだった(#78のゲートでboss が検出・是正。詳細は
 * `docs/issue-order.md`「#80に着手する前に必ず読むもの」参照)。**HEAD(`f2312ae`)の実測は
 * PL 0.061835 / CB 0.046275(中央値)・PLが悪化する割合 default 58.8% / wide15 71.5%**
 * であり、本スクリプトの`runModelLayer`実行結果として毎回再現できる(下記「使い方」参照)。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-joint-model.ts
 *
 * 出力される ms 値は本スクリプトの実行結果そのものであり、再現手段は「このスクリプトを実行する」
 * こと自体である(JSDocに再現手段のない ms 値を書かない、というAC-9の要求への対応)。
 * `computePlackettLuceMarginals`(閉形式)と「816通りの分布を毎回構築する素朴な実装」の速度差
 * (要修正2)も本スクリプトの `runNaiveVsClosedFormComparison` で測り、実測比を出力する。
 * `MAX_FIT_ITERATIONS`を振った8段階の表(Issue #80 AC-A8)を再現するには、
 * `plackett-luce-strength.ts`の`MAX_FIT_ITERATIONS`を一時的に書き換えてから本スクリプトを
 * 実行し、出力の`Issue #80(#78-A)AC-A8`セクションを読む(同ファイルのJSDoc「再現手順」参照)。
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
 * `analyzer/parse-response.ts`(:294-309)と同じクリップ規則を再現する。
 * LLMの生の応答値(value)が窓[lower,upper]の外にあれば、値そのものではなく**窓の端点に
 * スナップ**する(value>upper+EPSならupper、value<lower-EPSならlower)。lowerはprior<=maxAdjust
 * のとき厳密に0、upperはprior>=1-maxAdjustのとき厳密に1になるため、**窓の外に答えるLLM**を
 * 再現して初めてp=0/p=1に実際に到達する(要修正3で追加。是正前はvalueを窓の内側
 * [lower,upper]からしか引いておらず、端点に一致する確率が測度0だった)。
 */
const CLIP_EPS = 1e-9; // parse-response.ts の EPS(非公開定数)と同じ値を再現する。
function applyProductionClip(
  prior: number,
  value: number,
  maxAdjust: number,
): { adjusted: number; clipped: boolean } {
  const lower = Math.max(0, prior - maxAdjust);
  const upper = Math.min(1, prior + maxAdjust);
  if (value > upper + CLIP_EPS) return { adjusted: upper, clipped: true };
  if (value < lower - CLIP_EPS) return { adjusted: lower, clipped: true };
  return { adjusted: Math.min(upper, Math.max(lower, value)), clipped: false };
}

/**
 * production 相当の18頭・複勝人数3のレースを1件生成する(clipVariantで±maxAdjustを切替)。
 * 要修正5: raw prior → computeNormalizedRawPriors(Σを min(3,頭数) へ正規化) → ±maxAdjust の
 * クリップ、という production と同じ順序(prior.ts のクランプ→正規化→再クランプ、
 * その後 parse-response.ts の ±maxAdjust クリップ)で生成する。
 * 要修正3: LLMの生の応答値(value)は、窓[lower,upper]よりずっと広い範囲(prior±0.6。
 * [0,1]の外にはみ出すことも許す)から引き、`applyProductionClip` で実際にクリップする。
 */
function buildRaceHorses(
  rand: () => number,
  clipVariantId: keyof typeof CLIP_VARIANTS,
  n = 18,
): { horses: JointModelHorse[]; clippedToZeroCount: number; clippedToOneCount: number } {
  const maxAdjust = CLIP_VARIANTS[clipVariantId].maxAdjust;
  // raw prior(正規化前)は「大半は0〜0.25の一般馬・5%は0.9〜0.99の突出馬(混合分布)」から
  // 引く(独立一様分布1本だと正規化のΣ合わせが強く効きすぎ、突出馬がいてもscaleで
  // maxPrior=0.95に届かなくなり、p=1に構造的に到達できないことが判明した。要修正3で
  // 訂正。この混合なら実測で約28.6%のレースで最大priorが0.9以上に達する)。
  const rawPriors = Array.from({ length: n }, () =>
    rand() < 0.05 ? uniform(rand, 0.9, 0.99) : uniform(rand, 0, 0.25),
  );
  const priors = computeNormalizedRawPriors(rawPriors);
  let clippedToZeroCount = 0;
  let clippedToOneCount = 0;
  const horses = priors.map((prior, i) => {
    // LLMの生の応答値: 窓幅(2*maxAdjust)よりずっと広い±0.6の一様乱数で、[0,1]の外にも
    // はみ出しうる(実際のLLMが窓の外に答えるケースを模す)。
    const value = uniform(rand, prior - 0.6, prior + 0.6);
    const { adjusted, clipped } = applyProductionClip(prior, value, maxAdjust);
    if (clipped && adjusted === 0) clippedToZeroCount++;
    if (clipped && adjusted === 1) clippedToOneCount++;
    return { umaban: i + 1, placeProb: adjusted };
  });
  return { horses, clippedToZeroCount, clippedToOneCount };
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
    const { horses: h } = buildRaceHorses(warmupRand, clipVariantId);
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
  // 要修正3: 入力クラスの統計(bench が「窓の外に答えるLLM」を実際に生成しているかを示す)。
  let racesWithZeroCount = 0;
  let racesWithOneCount = 0;
  let totalClippedToZero = 0;
  let totalClippedToOne = 0;
  const degenerateZeroCounts: number[] = [];
  const degenerateFixedCounts: number[] = [];
  const rescaleInducedFixedCounts: number[] = [];
  let notConvergedWithZeroOrOne = 0;

  for (let i = 0; i < sampleCount; i++) {
    const { horses, clippedToZeroCount, clippedToOneCount } = buildRaceHorses(rand, clipVariantId);
    const k = 3;
    const hasZero = horses.some((h) => h.placeProb === 0);
    const hasOne = horses.some((h) => h.placeProb === 1);
    if (hasZero) racesWithZeroCount++;
    if (hasOne) racesWithOneCount++;
    totalClippedToZero += clippedToZeroCount;
    totalClippedToOne += clippedToOneCount;

    const t0 = performance.now();
    const fit = fitPlackettLuceStrengths(horses, k);
    const t1 = performance.now();

    if (!fit.ok) {
      if (fit.reason === "not-converged") {
        notConvergedCount++;
        if (hasZero || hasOne) notConvergedWithZeroOrOne++;
      } else otherFailureCount++;
      continue;
    }

    degenerateZeroCounts.push(fit.degenerateZeroCount);
    degenerateFixedCounts.push(fit.degenerateFixedCount);
    rescaleInducedFixedCounts.push(fit.rescaleInducedFixedCount);

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
    `  not-converged: ${notConvergedCount}/${sampleCount}(${((notConvergedCount / sampleCount) * 100).toFixed(1)}%)` +
      `(うちp=0/p=1を含むレース: ${notConvergedWithZeroOrOne}件)`,
  );
  console.log(`  その他の失敗(invalid-probability等): ${otherFailureCount}/${sampleCount}`);
  // 要修正3: この bench がどの入力クラスを実際に生成しているかを統計で示す
  // (p=0/p=1に到達しない「窓の内側だけに答えるLLM」の世界で測っていないことの根拠)。
  console.log(
    `  p=0を含むレース: ${racesWithZeroCount}/${sampleCount}(${((racesWithZeroCount / sampleCount) * 100).toFixed(1)}%)` +
      ` / p=1を含むレース: ${racesWithOneCount}/${sampleCount}(${((racesWithOneCount / sampleCount) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  クリップで0に丸められた頭数の合計: ${totalClippedToZero} / 1に丸められた頭数の合計: ${totalClippedToOne}`,
  );
  if (degenerateZeroCounts.length > 0) {
    const avg = (arr: readonly number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(
      `  縮退頭数の平均(ok:trueの${degenerateZeroCounts.length}件中): ` +
        `degenerateZeroCount=${avg(degenerateZeroCounts).toFixed(3)} / ` +
        `degenerateFixedCount=${avg(degenerateFixedCounts).toFixed(3)} / ` +
        `rescaleInducedFixedCount=${avg(rescaleInducedFixedCounts).toFixed(3)}`,
    );
  }
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

/**
 * Issue #80(#78-A)AC-A8: `MAX_FIT_ITERATIONS`の値ごとの性能(not-converged率・
 * フィット所要msの99%点・最悪値)を、頭数を18/16/14/12/10/8/6/5と振って計測する
 * (k=3固定・頭数ごとに`samplesPerHeadcount`件=既定400件、variantあたり合計N=3200)。
 *
 * `MAX_FIT_ITERATIONS`自体はこの関数の引数にしない(`fitPlackettLuceStrengths`へ
 * 上限を注入する経路を新設しない。Issue #80 Q6裁定: 定数の定義箇所を2箇所に増やす
 * ことを避けるため)。**このスクリプトが今インポートしている`MAX_FIT_ITERATIONS`の値
 * そのものを使って計測する**——つまり8段階の表を得るには、`plackett-luce-strength.ts`の
 * `MAX_FIT_ITERATIONS`を手作業で書き換えたうえで本スクリプトを実行し直す、という
 * 再現手順そのものが実測手段である(下記「使い方」参照)。
 */
function runFitPerformanceSweep(clipVariantId: keyof typeof CLIP_VARIANTS, samplesPerHeadcount: number): void {
  const headcounts = [18, 16, 14, 12, 10, 8, 6, 5];
  const rand = makeRng(clipVariantId === "default" ? 20260909100 : 20260910100);

  // ウォームアップ(JIT最適化。計測対象から外す)。
  const warmupRand = makeRng(clipVariantId === "default" ? 999101 : 999102);
  for (let i = 0; i < 20; i++) {
    const { horses } = buildRaceHorses(warmupRand, clipVariantId, 18);
    fitPlackettLuceStrengths(horses, 3);
  }

  const fitMs: number[] = [];
  let notConvergedCount = 0;
  let sampleCount = 0;

  for (const n of headcounts) {
    const k = Math.min(3, n);
    for (let i = 0; i < samplesPerHeadcount; i++) {
      const { horses } = buildRaceHorses(rand, clipVariantId, n);
      sampleCount++;
      const t0 = performance.now();
      const fit = fitPlackettLuceStrengths(horses, k);
      const t1 = performance.now();
      fitMs.push(t1 - t0);
      if (!fit.ok && fit.reason === "not-converged") {
        notConvergedCount++;
      }
    }
  }

  const sorted = [...fitMs].sort((a, b) => a - b);
  const p99 = percentile(sorted, 0.99);
  const worst = sorted[sorted.length - 1]!;
  const notConvergedRate = (notConvergedCount / sampleCount) * 100;
  console.log(
    `  MAX_FIT_ITERATIONS=${MAX_FIT_ITERATIONS} clipVariant=${clipVariantId} ` +
      `(頭数${headcounts.join("/")}×各${samplesPerHeadcount}件=N=${sampleCount}): ` +
      `not-converged=${notConvergedRate.toFixed(2)}% fit99%点=${p99.toFixed(2)}ms fit最悪=${worst.toFixed(1)}ms`,
  );
}

console.log(`MAX_FIT_ITERATIONS=${MAX_FIT_ITERATIONS} / FIT_TOLERANCE=${FIT_TOLERANCE}`);
runColdStartMeasurement();
runSingleShotPerformanceCheck();
runNaiveVsClosedFormComparison();
console.log("\n=== Issue #80(#78-A)AC-A8: MAX_FIT_ITERATIONS別の性能(現在の値のみ。8段階の表は手作業で書き換えて再実行) ===");
runFitPerformanceSweep("default", 400);
runFitPerformanceSweep("wide15", 400);
runModelLayer("default", 200);
runModelLayer("wide15", 200);
