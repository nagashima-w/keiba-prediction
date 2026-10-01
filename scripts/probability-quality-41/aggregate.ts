/**
 * #41 の集計(オフライン。ネットワークには出ない)。
 * 観測 JSON(`observations/<raceId>.json`)だけから、中央・地方を**別々に**再計算する
 * (`docs/investigations/probability-quality-41/measurement-plan.md` §5)。
 *
 * 数値の算出は `packages/core/src/ev/probability-quality.ts` の公開エントリポイント
 * (`buildBrierQualityReport`・`buildProbabilityQualityReport`)に委ねる(再実装しない)。
 * このファイルが持つのは、観測 → 入力の組み立てと、レース別の指標の中央値・レンジだけ。
 *
 * ## 実行
 *   pnpm tsx scripts/probability-quality-41/aggregate.ts [観測ディレクトリ]
 * 既定の観測ディレクトリは `docs/investigations/probability-quality-41/observations`。
 * 集計結果は同ディレクトリの親に `aggregate.json` として書く。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildBrierQualityReport,
  buildProbabilityQualityReport,
  MIN_FIELD_SIZE_FOR_PLACE_MARKET,
  type BrierQualityReport,
  type BrierQualityInputHorse,
  type NullableMetric,
} from "../../packages/core/src/ev/probability-quality.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type RaceObservation,
  type RaceObservationExcluded,
  type RaceObservationOk,
} from "./observation.js";

/** ブートストラップの反復回数とシード(取得前の分析計画 §5.1 で固定)。 */
export const AGGREGATE_BOOTSTRAP = { iterations: 10000, seed: 20261001 } as const;
/** resolution の参照値(レース内ラベル並べ替え)の反復回数とシード(同 §5.1)。 */
export const AGGREGATE_PERMUTATION = { iterations: 1000, seed: 20261001 } as const;

/** 市場比較に使える確定オッズか(§3.5)。地方は `middle` のみ(オッズページ単体では確定を判別できない)。 */
function isFinalOdds(region: "central" | "nar", status: string): boolean {
  return region === "central" ? status === "result" : status === "middle";
}

/** レース別の指標1つの要約。 */
export interface MetricSummary {
  /** 算出できたレース数。 */
  readonly n: number;
  /** 算出不能(reason 付き null)だったレース数。 */
  readonly nullCount: number;
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(metrics: readonly NullableMetric[]): MetricSummary {
  const values = metrics
    .map((m) => m.value)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    n: values.length,
    nullCount: metrics.length - values.length,
    median: values.length === 0 ? null : median(values),
    min: values.length === 0 ? null : values[0]!,
    max: values.length === 0 ? null : values[values.length - 1]!,
  };
}

/** #40 の指標のレース別の要約。 */
export interface Metrics40Summary {
  readonly spearmanRho: MetricSummary;
  readonly sdRatio: MetricSummary;
  readonly maxMinRatioModel: MetricSummary;
  readonly maxMinRatioMarket: MetricSummary;
  readonly normalizedJointKlModel: MetricSummary;
  readonly normalizedJointKlMarket: MetricSummary;
  /** 三連複の全点等額購入 EV÷払戻率は測定しない(組合せオッズを取得していないため)。 */
  readonly trioAllPointEvOverPayoutRate: { readonly measured: false; readonly reason: string };
}

/** 1地域分の集計。 */
export interface RegionAggregate {
  readonly region: "central" | "nar";
  readonly okRaceCount: number;
  readonly excludedRaceCount: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly excludedRaces: ReadonlyArray<{ readonly raceId: string; readonly reason: string; readonly detail: string }>;
  /** 観測した出走馬の数(取消・除外を除く)。 */
  readonly observationCount: number;
  readonly scratchedHorseCount: number;
  /** 出走8頭以上のレース数(市場比較の候補)。 */
  readonly eightPlusRaceCount: number;
  readonly runnerCount: MetricSummary;
  readonly oddsStatusCounts: Readonly<Record<string, number>>;
  /** 確定オッズでないため市場比較から外したレース(オッズを使わずに集計した)。 */
  readonly marketOddsNotFinalRaces: readonly string[];
  /** 戦績の取得に失敗した馬を含むレース。 */
  readonly resultsFailedRaces: readonly string[];
  /** 計測側が生の戦績に掛けた `filterRaceDataBefore` の診断値の合計。 */
  readonly leakFilter: {
    readonly totalResultCount: number;
    readonly removedCount: number;
    readonly removedByCutoffCount: number;
    readonly removedByInvalidDateCount: number;
  };
  /** 主表: 観測に成功した全レース。 */
  readonly brier: BrierQualityReport;
  /** 感度: 戦績取得失敗の馬を含むレースを除いた集計。 */
  readonly brierExcludingResultsFailed: BrierQualityReport;
  readonly metrics40: Metrics40Summary;
}

/** 集計結果一式。 */
export interface AggregateResult {
  readonly conditions: {
    readonly priorSource: "prior-only";
    readonly minFieldSizeForMarket: number;
    readonly bootstrap: typeof AGGREGATE_BOOTSTRAP;
    readonly permutation: typeof AGGREGATE_PERMUTATION;
    readonly note: string;
  };
  readonly central: RegionAggregate;
  readonly nar: RegionAggregate;
}

const NOTE =
  "prior の質であって、ツール全体の確率の質ではない(LLM 未使用)。市場は確定オッズの複勝下限を Σ=3 に正規化した近似。";

function toBrierHorses(races: readonly RaceObservationOk[]): BrierQualityInputHorse[] {
  return races.flatMap((r) =>
    r.horses.map((h) => ({
      raceId: r.raceId,
      umaban: h.umaban,
      modelProb: h.prior,
      occurred: h.outcome === 1,
      placeOddsMin: h.placeOddsMin,
      placeOddsMax: h.placeOddsMax,
    })),
  );
}

function brierReport(races: readonly RaceObservationOk[]): BrierQualityReport {
  return buildBrierQualityReport({
    horses: toBrierHorses(races),
    priorSource: "prior-only",
    bootstrap: AGGREGATE_BOOTSTRAP,
    permutation: AGGREGATE_PERMUTATION,
    // 確定オッズでないレースは、複勝オッズの値を使わず「確定でない」として市場比較から外す
    // (core の『複勝オッズの欠損・不正』に二重計上させない)。
    oddsNotFinalRaceIds: races.filter((r) => !isFinalOdds(r.region, r.oddsStatus)).map((r) => r.raceId),
  });
}

function metrics40(races: readonly RaceObservationOk[]): Metrics40Summary {
  const reports = races.map((r) => {
    // 市場側が関わる指標は、出走8頭以上かつ確定オッズのレースだけ(§5.2)。
    const marketEligible =
      r.horses.length >= MIN_FIELD_SIZE_FOR_PLACE_MARKET && isFinalOdds(r.region, r.oddsStatus);
    return buildProbabilityQualityReport({
      horses: r.horses.map((h) => ({
        umaban: h.umaban,
        modelProb: h.prior,
        placeOddsMin: marketEligible ? h.placeOddsMin : null,
      })),
      oddsStatus: r.oddsStatus,
      trioComboOdds: new Map(),
      priorSource: "prior-only",
      leakFilter: { ...r.conditions.leakFilter, perHorse: [] },
    });
  });
  return {
    spearmanRho: summarize(reports.map((x) => x.spearmanRho)),
    sdRatio: summarize(reports.map((x) => x.sdRatio)),
    maxMinRatioModel: summarize(reports.map((x) => x.maxMinRatioModel)),
    maxMinRatioMarket: summarize(reports.map((x) => x.maxMinRatioMarket)),
    normalizedJointKlModel: summarize(reports.map((x) => x.normalizedJointKlModel)),
    normalizedJointKlMarket: summarize(reports.map((x) => x.normalizedJointKlMarket)),
    trioAllPointEvOverPayoutRate: {
      measured: false,
      reason: "三連複の全点EV÷払戻率は組合せオッズの追加取得が必要で、今回は取得していないため測定しない",
    },
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

function aggregateRegion(region: "central" | "nar", all: readonly RaceObservation[]): RegionAggregate {
  const mine = all.filter((o) => o.region === region);
  const ok = mine.filter((o): o is RaceObservationOk => o.status === "ok");
  const excluded = mine.filter((o): o is RaceObservationExcluded => o.status === "excluded");
  const failedRaceIds = ok.filter((r) => r.resultsFailedHorseCount > 0).map((r) => r.raceId);
  const failedSet = new Set(failedRaceIds);
  const sum = (f: (r: RaceObservationOk) => number) => ok.reduce((s, r) => s + f(r), 0);

  return {
    region,
    okRaceCount: ok.length,
    excludedRaceCount: excluded.length,
    excludedByReason: countBy(excluded.map((e) => e.reason)),
    excludedRaces: excluded.map((e) => ({ raceId: e.raceId, reason: e.reason, detail: e.detail })),
    observationCount: sum((r) => r.horses.length),
    scratchedHorseCount: sum((r) => r.scratched.length),
    eightPlusRaceCount: ok.filter((r) => r.horses.length >= MIN_FIELD_SIZE_FOR_PLACE_MARKET).length,
    runnerCount: summarize(ok.map((r) => ({ value: r.horses.length, reason: null }))),
    oddsStatusCounts: countBy(ok.map((r) => r.oddsStatus)),
    marketOddsNotFinalRaces: ok.filter((r) => !isFinalOdds(r.region, r.oddsStatus)).map((r) => r.raceId),
    resultsFailedRaces: failedRaceIds,
    leakFilter: {
      totalResultCount: sum((r) => r.conditions.leakFilter.totalResultCount),
      removedCount: sum((r) => r.conditions.leakFilter.removedCount),
      removedByCutoffCount: sum((r) => r.conditions.leakFilter.removedByCutoffCount),
      removedByInvalidDateCount: sum((r) => r.conditions.leakFilter.removedByInvalidDateCount),
    },
    brier: brierReport(ok),
    brierExcludingResultsFailed: brierReport(ok.filter((r) => !failedSet.has(r.raceId))),
    metrics40: metrics40(ok),
  };
}

/**
 * 観測から集計を作る。入力の並びに依らない(raceId 順に整列してから集計する)。
 * 中央と地方は混ぜない。
 */
export function aggregateObservations(observations: readonly RaceObservation[]): AggregateResult {
  const sorted = [...observations].sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
  return {
    conditions: {
      priorSource: "prior-only",
      minFieldSizeForMarket: MIN_FIELD_SIZE_FOR_PLACE_MARKET,
      bootstrap: AGGREGATE_BOOTSTRAP,
      permutation: AGGREGATE_PERMUTATION,
      note: NOTE,
    },
    central: aggregateRegion("central", sorted),
    nar: aggregateRegion("nar", sorted),
  };
}

/** 観測ディレクトリの `<raceId>.json`(12桁数字のファイル名)を読む。スキーマ版が違えば失敗する。 */
export function loadObservations(dir: string): RaceObservation[] {
  const files = readdirSync(dir)
    .filter((f) => /^[0-9]{12}\.json$/.test(f))
    .sort();
  return files.map((f) => {
    const parsed = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as RaceObservation;
    if (parsed.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
      throw new Error(
        `${f}: schemaVersion が ${String(parsed.schemaVersion)}(期待: ${OBSERVATION_SCHEMA_VERSION})`,
      );
    }
    return parsed;
  });
}

const DEFAULT_OBSERVATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "investigations",
  "probability-quality-41",
  "observations",
);

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_OBSERVATIONS_DIR;
  const observations = loadObservations(dir);
  const aggregate = aggregateObservations(observations);
  const outPath = path.join(dir, "..", "aggregate.json");
  writeFileSync(outPath, JSON.stringify(aggregate, null, 2), "utf-8");
  console.error(`観測 ${observations.length} 件から集計しました: ${outPath}`);
  for (const r of [aggregate.central, aggregate.nar]) {
    console.error(
      `[${r.region}] 観測成功${r.okRaceCount}レース(馬${r.observationCount}頭)・除外${r.excludedRaceCount}レース`,
    );
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
