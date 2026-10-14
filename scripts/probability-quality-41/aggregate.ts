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

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { RunManifest } from "./run.js";
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

/** レース別の記述(取得後に追加。#35-2 の材料)。 */
export interface PerRaceSummary {
  readonly raceId: string;
  readonly runnerCount: number;
  /** prior の合計。 */
  readonly priorSum: number;
  /** 期待される合計 `min(3, 頭数)`(`computeFieldPriors` の目標)。 */
  readonly expectedPriorSum: number;
  /** 全馬の戦績が0走(遮断後に使った走数が0)。新馬戦に相当。 */
  readonly allHorsesZeroRuns: boolean;
  /** Spearman ρ(出走8頭以上かつ確定オッズのレースだけ。算出不能は null)。 */
  readonly spearmanRho: number | null;
  /** sd 比(同上)。 */
  readonly sdRatio: number | null;
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
  /** 全馬の戦績が0走のレース(新馬戦に相当)。 */
  readonly allZeroRunRaces: readonly string[];
  /**
   * 感度: **全馬の戦績が0走のレースを除いた集計。計画に無い、取得後に追加した感度(post-hoc)**。
   * 主表(`brier`)は変えない。
   */
  readonly brierExcludingAllZeroRunRaces: BrierQualityReport;
  /** レース別の記述(Σprior・戦績0走・ρ・sd比)。 */
  readonly perRace: readonly PerRaceSummary[];
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
    /** 計画に無い、取得後に追加した感度(post-hoc)の項目名。 */
    readonly posthocSensitivities: readonly string[];
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

/** レース別の `buildProbabilityQualityReport`。市場側は出走8頭以上かつ確定オッズのレースだけ(§5.2)。 */
function perRaceReports(races: readonly RaceObservationOk[]) {
  return races.map((r) => {
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
}

function metrics40(reports: ReturnType<typeof perRaceReports>): Metrics40Summary {
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
  const reports = perRaceReports(ok);
  const isAllZeroRun = (r: RaceObservationOk) => r.horses.every((h) => h.usedRunCount === 0);
  const allZeroRunIds = ok.filter(isAllZeroRun).map((r) => r.raceId);
  const allZeroSet = new Set(allZeroRunIds);

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
    allZeroRunRaces: allZeroRunIds,
    brierExcludingAllZeroRunRaces: brierReport(ok.filter((r) => !allZeroSet.has(r.raceId))),
    perRace: ok.map((r, i) => ({
      raceId: r.raceId,
      runnerCount: r.horses.length,
      priorSum: r.horses.reduce((s, h) => s + h.prior, 0),
      expectedPriorSum: Math.min(3, r.horses.length),
      allHorsesZeroRuns: isAllZeroRun(r),
      spearmanRho: reports[i]!.spearmanRho.value,
      sdRatio: reports[i]!.sdRatio.value,
    })),
    metrics40: metrics40(reports),
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
      posthocSensitivities: ["brierExcludingAllZeroRunRaces"],
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

/** 取得の実行記録(manifest の runs)の要約。 */
export interface FetchRunsSummary {
  readonly runCount: number;
  readonly gitCommits: readonly string[];
  readonly anyHalted: boolean;
  /** フェッチャへ渡した要求数の合計(キャッシュ命中も含む上限)。 */
  readonly requestCountTotal: number;
  /** 選定した開催日・会場・レース(再実行では同じ開催日の記録を後の実行で置き換える)。 */
  readonly days: RunManifest["days"];
  /**
   * 観測 JSON を保存しなかったまま残っているレース(最終状態。再実行で保存されたものは含まない)。
   * 理由と文言は最後の実行のもの。`attempts` は not-saved になった回数。
   */
  readonly notSavedRaces: ReadonlyArray<{
    readonly raceId: string;
    readonly reason: string;
    readonly detail: string;
    readonly attempts: number;
  }>;
}

/** manifest の実行記録を要約する。保存済み(観測がある)のレースは、保存しなかったレースに数えない。 */
export function summarizeFetchRuns(
  runs: readonly RunManifest[],
  observations: readonly RaceObservation[],
): FetchRunsSummary {
  const saved = new Set(observations.map((o) => o.raceId));
  const notSaved = new Map<string, { reason: string; detail: string; attempts: number }>();
  for (const run of runs) {
    for (const p of run.processed) {
      if (p.status === "not-saved") {
        const prev = notSaved.get(p.raceId);
        notSaved.set(p.raceId, {
          reason: p.reason ?? "",
          detail: p.detail ?? "",
          attempts: (prev?.attempts ?? 0) + 1,
        });
      }
    }
  }
  const days = new Map<string, RunManifest["days"][number]>();
  for (const run of runs) {
    for (const d of run.days) {
      days.set(`${d.region}:${d.requestedDate}`, d);
    }
  }
  return {
    runCount: runs.length,
    gitCommits: [...new Set(runs.map((r) => r.gitCommit))],
    anyHalted: runs.some((r) => r.halted),
    requestCountTotal: runs.reduce((s, r) => s + r.requestCount, 0),
    days: [...days.values()],
    notSavedRaces: [...notSaved]
      .filter(([raceId]) => !saved.has(raceId))
      .map(([raceId, v]) => ({ raceId, ...v }))
      .sort((a, b) => (a.raceId < b.raceId ? -1 : 1)),
  };
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
  const manifestPath = path.join(dir, "..", "manifest.json");
  const runs: RunManifest[] = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf-8")) as { runs: RunManifest[] }).runs
    : [];
  const fetch = summarizeFetchRuns(runs, observations);
  const outPath = path.join(dir, "..", "aggregate.json");
  writeFileSync(outPath, JSON.stringify({ ...aggregate, fetch }, null, 2), "utf-8");
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
