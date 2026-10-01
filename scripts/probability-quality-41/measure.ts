/**
 * 1レースの観測(`docs/investigations/probability-quality-41/measurement-plan.md` §3)。
 *
 * 結果ページを**先に**取り、取消・除外の馬を出走馬から除いてから `runAnalysis`(LLM なし)で prior を
 * 計算する。ネットワークは注入された関数だけが行う(テストでは保存済みフィクスチャで置き換える)。
 *
 * - 取得した応答(結果 HTML・取消除外前の `RaceData`)は**解析より先に**保存関数へ渡す
 *   (過去に「取得したのに保存しなかった」失敗が起きているため。保存先はリポジトリの外)。
 *   (2026-10-01・Issue #154 追記: `scrapeRace` が出馬表の取消・除外の馬を出走馬から除くように
 *   なったため、今後の取得では「取消除外前」の `RaceData` に取消馬は含まれない〈`meta.scratched`
 *   に残る〉。本スクリプトの取消の判別は結果ページが正で、出馬表に取消馬がいない場合は
 *   `classifyRaceFinishes` が `inShutuba: false` として扱うため動作は変わらない。実取得は
 *   d04a0ea で済んでおり、その結果にも影響しない。)
 * - 観測から外すレースは理由を記録して `excluded` として返す(全体は止めない)。
 *   ただし `FetchHaltedError`(HTTP 400・403・429 の連続による停止)は**除外にせず**そのまま投げる
 *   (途中までのデータで観測を作らない)。
 */

import {
  parseKaisaiDate,
  parseRaceResult,
  RaceResultNotConfirmedError,
  RaceResultParseError,
  type KaisaiDate,
  type RaceData,
  type RaceId,
  type RaceListEntry,
  type RaceResult,
} from "../../packages/core/src/index.js";
import {
  excludeOwnRaceResults,
  filterRaceDataBefore,
} from "../../packages/core/src/scorer/snapshot-filter.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../packages/app/src/main/analysis-pipeline.js";
import type { AnalysisResult } from "../../packages/app/src/shared/analysis-types.js";
import { FetchHaltedError } from "./guarded-fetcher.js";
import {
  classifyRaceFinishes,
  OBSERVATION_SCHEMA_VERSION,
  type ExcludedReason,
  type HorseObservation,
  type RaceIdentity,
  type RaceObservation,
} from "./observation.js";
import { venueCodeOf } from "./selection.js";

/** 観測の対象1レース。 */
export interface MeasureTarget {
  /** 一覧のエントリ(頭数は取消前)。 */
  readonly entry: RaceListEntry;
  readonly region: "central" | "nar";
  /** 要求した開催日(YYYYMMDD)。 */
  readonly requestedDate: string;
  /** 実際に使った開催日(YYYYMMDD。`runAnalysis` の `kaisaiDate` に渡す)。 */
  readonly kaisaiDate: string;
}

/** 保存する raw の種別。 */
export type RawKind = "result-html" | "race-data";

/** 注入する依存(ネットワークはここだけ)。 */
export interface MeasureDeps {
  /** 結果ページ(`result.html`)を取得する。 */
  readonly fetchResultHtml: (raceId: RaceId) => Promise<string>;
  /** 出馬表・各馬戦績・調教・オッズを取得する(`scrapeRace` を `includeComboOdds:false` で呼ぶ)。 */
  readonly scrape: (raceId: RaceId) => Promise<RaceData>;
  /** 結果 HTML の解析(既定は `parseRaceResult`。テストで差し替える)。 */
  readonly parseResult?: (html: string) => RaceResult;
  /** raw の保存(リポジトリの外)。 */
  readonly saveRaw?: (kind: RawKind, raceId: string, content: string) => void;
  /** `runAnalysis` の差し替え(テスト用。既定は本物)。 */
  readonly runAnalysisFn?: (
    raceId: RaceId,
    kaisaiDate: KaisaiDate | null,
    deps: AnalysisPipelineDeps,
  ) => Promise<AnalysisResult>;
  readonly now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** YYYYMMDD → YYYY/MM/DD(`HorseRaceResult.date` と同じ形式)。 */
function toSlashDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

/** 1レースを観測する。 */
export async function measureRace(
  target: MeasureTarget,
  deps: MeasureDeps,
): Promise<RaceObservation> {
  const now = deps.now ?? (() => new Date());
  const raceId = target.entry.raceId;
  const identity: RaceIdentity = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    raceId,
    region: target.region,
    requestedDate: target.requestedDate,
    kaisaiDate: target.kaisaiDate,
    venueCode: venueCodeOf(raceId),
    raceNumber: target.entry.raceNumber,
    raceName: target.entry.name,
    listedEntryCount: target.entry.entryCount,
  };
  const exclude = (reason: ExcludedReason, detail: string): RaceObservation => ({
    ...identity,
    status: "excluded",
    reason,
    detail,
    fetchedAt: now().toISOString(),
  });

  // (1) 結果ページ(先に取る。取消・除外の馬を prior の計算前に除くため)。
  let resultHtml: string;
  try {
    resultHtml = await deps.fetchResultHtml(raceId);
  } catch (error) {
    if (error instanceof FetchHaltedError) {
      throw error;
    }
    return exclude("result-fetch-error", errorMessage(error));
  }
  deps.saveRaw?.("result-html", raceId, resultHtml);

  let result: RaceResult;
  try {
    result = (deps.parseResult ?? parseRaceResult)(resultHtml);
  } catch (error) {
    if (error instanceof RaceResultNotConfirmedError) {
      return exclude("result-not-confirmed", errorMessage(error));
    }
    if (error instanceof RaceResultParseError) {
      return exclude("result-parse-error", errorMessage(error));
    }
    throw error;
  }

  // (2) 出馬表・各馬戦績・調教・オッズ。
  let race: RaceData;
  try {
    race = await deps.scrape(raceId);
  } catch (error) {
    if (error instanceof FetchHaltedError) {
      throw error;
    }
    return exclude("scrape-error", errorMessage(error));
  }
  deps.saveRaw?.("race-data", raceId, JSON.stringify(race));

  // (3) 着順の分類。取消・除外の馬を出走馬から除く。
  const classification = classifyRaceFinishes(
    race.horses.map((h) => h.shutuba.umaban),
    result,
  );
  if (!classification.ok) {
    return exclude(classification.reason, classification.detail);
  }
  const scratchedInShutuba = new Set(
    classification.scratched.filter((s) => s.inShutuba).map((s) => s.umaban),
  );
  const runnerRace: RaceData = {
    ...race,
    horses: race.horses.filter((h) => !scratchedInShutuba.has(h.shutuba.umaban)),
  };

  // (4) prior(LLM なし。リーク遮断は runAnalysis が行う。#39)。
  const analysisDeps: AnalysisPipelineDeps = {
    scrape: async () => runnerRace,
    analyze: null,
    saveAnalysis: () => 0,
    allocationSettings: null,
  };
  let analysis: AnalysisResult;
  try {
    analysis = await (deps.runAnalysisFn ?? runAnalysis)(
      raceId,
      parseKaisaiDate(target.kaisaiDate),
      analysisDeps,
    );
  } catch (error) {
    if (error instanceof FetchHaltedError) {
      throw error;
    }
    return exclude("analysis-error", errorMessage(error));
  }
  if (analysis.dateApproximate) {
    return exclude("date-approximate", "分析日が近似(kaisaiDate が渡っていない)");
  }
  if (analysis.rows.length !== classification.runners.length) {
    return exclude(
      "analysis-error",
      `runAnalysis の行数(${analysis.rows.length})が出走頭数(${classification.runners.length})と一致しない`,
    );
  }

  // (5) リーク遮断の診断値(計測側が生の戦績に filterRaceDataBefore を掛けた実際の戻り値)。
  const cutoff = toSlashDate(target.kaisaiDate);
  const leak = filterRaceDataBefore(runnerRace, cutoff).diagnostics;
  // prior の計算に実際に使った走数(runAnalysis と同じ順: 自レース除外 → 日付で絞る)。
  const usedRunCountByUmaban = new Map(
    filterRaceDataBefore(excludeOwnRaceResults(runnerRace, raceId).raceData, cutoff).raceData.horses.map(
      (h) => [h.shutuba.umaban, h.results === null ? null : h.results.length] as const,
    ),
  );

  const runnerByUmaban = new Map(classification.runners.map((r) => [r.umaban, r]));
  const horseByUmaban = new Map(runnerRace.horses.map((h) => [h.shutuba.umaban, h]));
  const horses: HorseObservation[] = [];
  for (const row of analysis.rows) {
    const runner = runnerByUmaban.get(row.umaban);
    const horse = horseByUmaban.get(row.umaban);
    if (runner === undefined || horse === undefined) {
      return exclude("analysis-error", `runAnalysis の馬番${row.umaban}が出走馬に対応しない`);
    }
    const place = race.odds.place[row.umaban];
    horses.push({
      umaban: row.umaban,
      horseName: horse.shutuba.name,
      prior: row.prior,
      placeOddsMin: place?.oddsMin ?? null,
      placeOddsMax: place?.oddsMax ?? null,
      finish: runner.finish,
      outcome: runner.outcome,
      resultsFetched: horse.results !== null,
      usedRunCount: usedRunCountByUmaban.get(row.umaban) ?? null,
    });
  }

  return {
    ...identity,
    status: "ok",
    courseType: race.race.courseType,
    distance: race.race.distance,
    runnerCount: horses.length,
    placedCount: horses.filter((h) => h.outcome === 1).length,
    oddsStatus: race.odds.oddsStatus,
    horses,
    scratched: classification.scratched,
    conditions: {
      priorSource: "prior-only",
      dateApproximate: false,
      leakFilter: {
        cutoffDate: leak.cutoffDate,
        totalResultCount: leak.totalResultCount,
        removedCount: leak.removedCount,
        removedByCutoffCount: leak.removedByCutoffCount,
        removedByInvalidDateCount: leak.removedByInvalidDateCount,
      },
      placeOddsKind: "placeOddsMinLowerBound",
    },
    warnings: race.meta.warnings.map((w) => ({
      kind: w.kind,
      message: w.message,
      ...(w.horseId !== undefined ? { horseId: w.horseId } : {}),
    })),
    resultsFailedHorseCount: horses.filter((h) => !h.resultsFetched).length,
    fetchedAt: now().toISOString(),
  };
}
