/**
 * #258 第1段: 頭数正規化(旧=乗算 / 加算シフト〈参考〉/ ロジットシフト〈採用〉)の前後比較。
 *
 * 入力は `docs/investigations/prior-normalization-258/dataset.json`(馬ごとの rawPrior・結果・人気・複勝オッズ・
 * LLM 補正量。**名前は含まない**)だけで、**ネットワークには出ない**。
 * データセットは `build-dataset.ts` が #41 の観測と戦績(--raw-dir)から作る。
 *
 * 使い方:
 *   pnpm tsx scripts/prior-normalization-258/compare.ts
 * 出力: Markdown の表(`docs/investigations/prior-normalization-258/report.md` の数値の出所)。
 *
 * ## 指標
 * - **Brier**: 頭数加重のプール値。旧との差は `buildPairedBrierComparison`(レース単位のブートストラップ。
 *   反復 10000・シード 20261001〈#41 と同じ〉)で、差は **新 − 旧**(正なら新が悪い)。
 * - **広がり**: レース内の母標準偏差 sd。sd(prior)/sd(raw)・sd(prior)/sd(旧 prior)・sd(prior)/sd(市場含意)
 *   〈市場含意は 1/複勝オッズ下限を Σ=min(3,頭数) に正規化。#41 の sd 比と同じ定義〉の各レース値の中央値。
 * - **床・天井**: prior が minPrior / maxPrior ちょうどの馬の数、同値の馬対の数。
 * - **人気順ごとの平均 prior**(診断用。各行は数件〜百数十件で、行間の小さな差に意味を読まない)。
 * - **PL(Plackett-Luce)フィットの失敗**(#84 との相互作用): 3 通りの入力で `fitPlackettLuceStrengths` を回し、
 *   失敗の件数を数える。標本は 33 レース由来で、独立な標本は 33 件(疑似標本を増やしても 33 件を超えない)。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SCORER_CONFIG, type PriorConfig } from "../../packages/core/src/scorer/config.js";
import { normalizeFieldPriors } from "../../packages/core/src/scorer/prior.js";
import { fitPlackettLuceStrengths } from "../../packages/core/src/ev/plackett-luce-strength.js";
import {
  buildPairedBrierComparison,
  type PairedBrierInputHorse,
} from "../../packages/core/src/ev/probability-quality.js";
import {
  computeMarketImpliedPlaceProbabilities,
  computeVarianceRatioMetrics,
  spearmanRankCorrelation,
} from "../../packages/core/src/ev/probability-quality-metrics.js";
import {
  additiveShiftNormalize,
  legacyMultiplicativeNormalize,
} from "./normalizers.js";

/** データセットの 1 頭(名前を含めない)。 */
export interface DatasetHorse {
  readonly umaban: number;
  /** クランプ・正規化前の prior(中立確率 + 13 項目の補正合計)。 */
  readonly rawPrior: number;
  /** 中立確率(min(3,頭数)/頭数)。 */
  readonly neutralProb: number;
  /** 3 着以内なら 1。 */
  readonly placed: number;
  /** 1 着なら 1。 */
  readonly won: number;
  /** 単勝人気順(確定単勝オッズの昇順。同オッズは馬番順)。 */
  readonly popularity: number;
  readonly winOdds: number;
  readonly placeOddsMin: number;
  readonly placeOddsMax: number;
  /** subagent 近似の LLM 補正量(補正後確率 − 当時の prior)。LLM が補正を捨てた(fallback)レースは null。 */
  readonly llmDelta: number | null;
}

export interface DatasetRace {
  readonly raceId: string;
  readonly region: "central" | "nar";
  readonly kaisaiDate: string;
  readonly fieldSize: number;
  readonly horses: readonly DatasetHorse[];
}

export interface PriorNormalizationDataset {
  readonly schemaVersion: 1;
  /** 作り方・限界の説明(数値の出所をデータ側にも残す)。 */
  readonly description: string;
  readonly races: readonly DatasetRace[];
}

/** 比較する正規化。 */
export interface NormalizerSpec {
  readonly name: string;
  readonly apply: (rawPriors: readonly number[], config: PriorConfig) => number[];
}

export const NORMALIZERS: readonly NormalizerSpec[] = [
  { name: "旧(乗算)", apply: legacyMultiplicativeNormalize },
  { name: "加算シフト(参考)", apply: additiveShiftNormalize },
  { name: "ロジットシフト(採用)", apply: normalizeFieldPriors },
];

const BOOTSTRAP = { iterations: 10000, seed: 20261001 } as const;

const RANK_BUCKETS: ReadonlyArray<{ readonly label: string; readonly test: (rank: number) => boolean }> = [
  { label: "1", test: (r) => r === 1 },
  { label: "2", test: (r) => r === 2 },
  { label: "3", test: (r) => r === 3 },
  { label: "4-5", test: (r) => r >= 4 && r <= 5 },
  { label: "6-9", test: (r) => r >= 6 && r <= 9 },
  { label: "10以下", test: (r) => r >= 10 },
];

const mean = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
function populationSd(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 決定的な疑似乱数(LCG)。bench-joint-model.ts と同じ形。 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** PL フィットの失敗数の集計 1 行。 */
export interface PlFailureRow {
  readonly scenario: string;
  readonly failures: number;
  readonly fits: number;
}

export interface VariantResult {
  readonly name: string;
  readonly brier: number;
  /** 新 − 旧 の Brier 差(buildPairedBrierComparison。旧自身は 0)。 */
  readonly brierDiffVsLegacy: { readonly value: number | null; readonly lower: number | null; readonly upper: number | null };
  readonly sdOverRawMedian: number;
  readonly sdOverRawMin: number;
  readonly sdVsLegacyMedian: number;
  readonly sdRatioMarketMedian: number;
  readonly spearmanRhoMarketMedian: number;
  readonly sumRatioMin: number;
  readonly sumRatioMax: number;
  readonly atFloor: number;
  readonly atCeiling: number;
  readonly racesWithTies: number;
  readonly tiePairs: number;
  /** 床の馬の実際の 3 着内率(床の馬が 0 頭なら null)と頭数。 */
  readonly floorHorses: { readonly n: number; readonly actualPlaceRate: number | null };
  readonly priorMax: number;
  readonly rankMeans: Readonly<Record<string, number>>;
  readonly pairInversionsVsLegacy: number;
  readonly plFailures: readonly PlFailureRow[];
}

export interface Comparison {
  readonly raceCount: number;
  readonly horseCount: number;
  readonly legacyNormalizedRaceCount: number;
  readonly rankActual: Readonly<Record<string, { readonly n: number; readonly actualPlaceRate: number }>>;
  readonly variants: readonly VariantResult[];
}

/** 1 レースの (prior の配列) を、正規化ごとに作る。 */
function priorsFor(spec: NormalizerSpec, race: DatasetRace, config: PriorConfig): number[] {
  return spec.apply(
    race.horses.map((h) => h.rawPrior),
    config,
  );
}

function clipToWindow(prior: number, value: number, maxAdjust: number): number {
  return Math.min(Math.min(1, prior + maxAdjust), Math.max(Math.max(0, prior - maxAdjust), value));
}

/** bench-joint-model.ts と同じ「窓の外に答える LLM」のスナップ(窓の外なら端点)。 */
function snapToWindow(prior: number, value: number, maxAdjust: number): number {
  const lower = Math.max(0, prior - maxAdjust);
  const upper = Math.min(1, prior + maxAdjust);
  if (value > upper + 1e-9) return upper;
  if (value < lower - 1e-9) return lower;
  return Math.min(upper, Math.max(lower, value));
}

function plRows(
  races: readonly DatasetRace[],
  priors: readonly (readonly number[])[],
): PlFailureRow[] {
  const fit = (p: readonly number[]): boolean =>
    fitPlackettLuceStrengths(
      p.map((x, i) => ({ umaban: i + 1, placeProb: x })),
      Math.min(3, p.length),
    ).ok;

  // (1) prior のみ(LLM なし)。
  let fits = 0;
  let failures = 0;
  races.forEach((_r, i) => {
    fits++;
    if (!fit(priors[i]!)) failures++;
  });
  const rows: PlFailureRow[] = [{ scenario: "prior のみ", failures, fits }];

  // (2) prior + subagent 近似の LLM 補正量(prior±0.10 にクリップ)。fallback のレースは除く。
  fits = 0;
  failures = 0;
  races.forEach((r, i) => {
    if (r.horses.some((h) => h.llmDelta === null)) return;
    const p = priors[i]!.map((x, j) => clipToWindow(x, x + r.horses[j]!.llmDelta!, 0.1));
    fits++;
    if (!fit(p)) failures++;
  });
  rows.push({ scenario: "prior + LLM 補正量(実測の対応・±0.10)", failures, fits });

  // (3) bench と同じ「窓の外に答える LLM」(応答値を prior±0.6 の一様乱数で引き、±maxAdjust の端点にスナップ)。
  for (const maxAdjust of [0.1, 0.15]) {
    const rand = makeRng(20260909);
    fits = 0;
    failures = 0;
    races.forEach((_r, i) => {
      for (let k = 0; k < 600; k++) {
        const p = priors[i]!.map((x) => snapToWindow(x, x - 0.6 + rand() * 1.2, maxAdjust));
        fits++;
        if (!fit(p)) failures++;
      }
    });
    rows.push({ scenario: `窓の外に答える LLM(±${maxAdjust.toFixed(2)}・各レース 600 回)`, failures, fits });
  }
  return rows;
}

/** 純関数: データセットから比較の数値を作る(乱数は固定シード)。 */
export function computeComparison(
  dataset: PriorNormalizationDataset,
  config: PriorConfig = DEFAULT_SCORER_CONFIG.prior,
): Comparison {
  const races = dataset.races;
  const horseCount = races.reduce((s, r) => s + r.horses.length, 0);
  const allPriors = NORMALIZERS.map((spec) => races.map((r) => priorsFor(spec, r, config)));
  const legacy = allPriors[0]!;

  // 旧の正規化が発動した(Σ が ±10% を超えた)レース数。
  const legacyNormalizedRaceCount = races.filter((r) => {
    const target = Math.min(config.targetPlaceCount, r.fieldSize);
    const clampedSum = r.horses.reduce(
      (s, h) => s + Math.min(config.maxPrior, Math.max(config.minPrior, h.rawPrior)),
      0,
    );
    return Math.abs(clampedSum - target) / target > 0.1;
  }).length;

  const rankActual: Record<string, { n: number; actualPlaceRate: number }> = {};
  for (const b of RANK_BUCKETS) {
    const hs = races.flatMap((r) => r.horses.filter((h) => b.test(h.popularity)));
    rankActual[b.label] = { n: hs.length, actualPlaceRate: mean(hs.map((h) => h.placed)) };
  }

  const variants: VariantResult[] = NORMALIZERS.map((spec, v) => {
    const priors = allPriors[v]!;
    const flat = races.flatMap((r, i) =>
      r.horses.map((h, j) => ({ raceId: r.raceId, h, p: priors[i]![j]!, i, j })),
    );

    const brier = mean(flat.map((x) => (x.p - x.h.placed) ** 2));

    const pairedHorses: PairedBrierInputHorse[] = flat.map((x) => ({
      raceId: x.raceId,
      umaban: x.h.umaban,
      modelProb: x.p,
      referenceProb: legacy[x.i]![x.j]!,
      occurred: x.h.placed === 1,
    }));
    const paired = buildPairedBrierComparison({
      horses: pairedHorses,
      modelSource: "prior-only",
      referenceSource: "prior-only",
      bootstrap: BOOTSTRAP,
    });
    const diff = paired.brierDifference;

    const sdOverRaw: number[] = [];
    const sdVsLegacy: number[] = [];
    const sdRatioMarket: number[] = [];
    const rhoMarket: number[] = [];
    const sumRatios: number[] = [];
    let atFloor = 0;
    let atCeiling = 0;
    let racesWithTies = 0;
    let tiePairs = 0;
    let pairInversions = 0;
    races.forEach((r, i) => {
      const p = priors[i]!;
      const target = Math.min(config.targetPlaceCount, r.fieldSize);
      sdOverRaw.push(populationSd(p) / populationSd(r.horses.map((h) => h.rawPrior)));
      sdVsLegacy.push(populationSd(p) / populationSd(legacy[i]!));
      sumRatios.push(p.reduce((s, x) => s + x, 0) / target);
      const floor = p.filter((x) => x <= config.minPrior).length;
      atFloor += floor;
      atCeiling += p.filter((x) => x >= config.maxPrior).length;
      if (floor >= 2) racesWithTies++;
      tiePairs += (floor * (floor - 1)) / 2;
      for (let a = 0; a < p.length; a++) {
        for (let b = a + 1; b < p.length; b++) {
          if ((p[a]! - p[b]!) * (legacy[i]![a]! - legacy[i]![b]!) < 0) pairInversions++;
        }
      }
      const market = computeMarketImpliedPlaceProbabilities(
        r.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.placeOddsMin })),
      );
      if (market.values !== null) {
        const m = r.horses.map((h) => market.values!.get(h.umaban)!);
        const sr = computeVarianceRatioMetrics(p, m).sdRatio;
        if (sr.value !== null) sdRatioMarket.push(sr.value);
        const rho = spearmanRankCorrelation(p, m);
        if (rho.value !== null) rhoMarket.push(rho.value);
      }
    });

    const floorHs = flat.filter((x) => x.p <= config.minPrior);
    const rankMeans: Record<string, number> = {};
    for (const b of RANK_BUCKETS) {
      rankMeans[b.label] = mean(flat.filter((x) => b.test(x.h.popularity)).map((x) => x.p));
    }

    return {
      name: spec.name,
      brier,
      brierDiffVsLegacy: { value: diff.value, lower: diff.lower, upper: diff.upper },
      sdOverRawMedian: median(sdOverRaw),
      sdOverRawMin: Math.min(...sdOverRaw),
      sdVsLegacyMedian: median(sdVsLegacy),
      sdRatioMarketMedian: median(sdRatioMarket),
      spearmanRhoMarketMedian: median(rhoMarket),
      sumRatioMin: Math.min(...sumRatios),
      sumRatioMax: Math.max(...sumRatios),
      atFloor,
      atCeiling,
      racesWithTies,
      tiePairs,
      floorHorses: {
        n: floorHs.length,
        actualPlaceRate: floorHs.length === 0 ? null : mean(floorHs.map((x) => x.h.placed)),
      },
      priorMax: Math.max(...flat.map((x) => x.p)),
      rankMeans,
      pairInversionsVsLegacy: pairInversions,
      plFailures: plRows(races, priors),
    };
  });

  return { raceCount: races.length, horseCount, legacyNormalizedRaceCount, rankActual, variants };
}

const f = (x: number | null, d = 4): string => (x === null ? "―" : x.toFixed(d));

/** 比較結果を Markdown の表にする。 */
export function formatComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`対象: ${c.raceCount} レース・${c.horseCount} 頭(旧の正規化が発動したレース: ${c.legacyNormalizedRaceCount})`);
  lines.push("");
  lines.push("| 方式 | Brier | 旧との差 [95%区間] | sd(prior)/sd(raw) 中央値(最小) | sd(prior)/sd(旧) 中央値 | sd 比(対市場)中央値 | ρ(対市場)中央値 | Σ/目標 | 床/天井 | 床の同値の馬対(レース数) | prior の最大 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const v of c.variants) {
    const d = v.brierDiffVsLegacy;
    lines.push(
      `| ${v.name} | ${f(v.brier)} | ${f(d.value, 5)} [${f(d.lower, 5)}, ${f(d.upper, 5)}] | ${f(v.sdOverRawMedian, 3)}(${f(v.sdOverRawMin, 3)}) | ${f(v.sdVsLegacyMedian, 3)} | ${f(v.sdRatioMarketMedian, 3)} | ${f(v.spearmanRhoMarketMedian, 3)} | ${f(v.sumRatioMin, 3)}〜${f(v.sumRatioMax, 3)} | ${v.atFloor} / ${v.atCeiling} | ${v.tiePairs}(${v.racesWithTies}) | ${f(v.priorMax, 3)} |`,
    );
  }
  lines.push("");
  lines.push("床(minPrior)の馬の実際の 3 着内率:");
  for (const v of c.variants) {
    lines.push(`- ${v.name}: ${v.floorHorses.n} 頭・${f(v.floorHorses.actualPlaceRate, 3)}`);
  }
  lines.push("");
  lines.push("人気順ごとの平均 prior(診断用。行間の小さな差に意味を読まない):");
  lines.push("");
  lines.push(`| 人気 | n | 実際の3着内率 | ${c.variants.map((v) => v.name).join(" | ")} |`);
  lines.push(`|---|---|---|${c.variants.map(() => "---").join("|")}|`);
  for (const b of RANK_BUCKETS) {
    lines.push(
      `| ${b.label} | ${c.rankActual[b.label]!.n} | ${f(c.rankActual[b.label]!.actualPlaceRate, 3)} | ${c.variants.map((v) => f(v.rankMeans[b.label]!, 3)).join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push(`旧との順位の入れ替わり(レース内の馬対で大小が逆転した数): ${c.variants.map((v) => `${v.name}=${v.pairInversionsVsLegacy}`).join(" / ")}`);
  lines.push("");
  lines.push("PL(Plackett-Luce)フィットの失敗(失敗数 / フィット回数。独立な標本は 33 レース):");
  lines.push("");
  lines.push(`| 入力 | ${c.variants.map((v) => v.name).join(" | ")} |`);
  lines.push(`|---|${c.variants.map(() => "---").join("|")}|`);
  const scenarios = c.variants[0]!.plFailures.map((r) => r.scenario);
  scenarios.forEach((sc, k) => {
    lines.push(`| ${sc} | ${c.variants.map((v) => `${v.plFailures[k]!.failures} / ${v.plFailures[k]!.fits}`).join(" | ")} |`);
  });
  return lines.join("\n");
}

const DEFAULT_DATASET_PATH = fileURLToPath(
  new URL("../../docs/investigations/prior-normalization-258/dataset.json", import.meta.url),
);

function main(): void {
  const path = process.argv[2] ?? DEFAULT_DATASET_PATH;
  if (!existsSync(path)) {
    throw new Error(`データセットが見つかりません: ${path}`);
  }
  const dataset = JSON.parse(readFileSync(path, "utf-8")) as PriorNormalizationDataset;
  console.log(formatComparison(computeComparison(dataset)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
