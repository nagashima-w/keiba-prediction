/**
 * クラウド移行ファイルの行(core の `MigrationAnalysisLine`・`MigrationResultLine`。Issue #215)を、クラウド版の保存の入力に変える純関数(Issue #216・#167-B1)。
 * D1・R2 には触れない。**書き込みの前の検証にも使う**(JSON の列が壊れていれば、ここで {@link MigrationFormatError} になる。取り込みの途中で初めて気づかないため)。
 *
 * ## 分析(`toAnalysisImport`)
 * 既存の保存経路(`D1AnalysisStore` の batch)に渡せる `AnalysisRecord` にする。**元の値を保つ**: `analyzed_at`・`kaisai_date`・`prompt_version`・`model`・
 * `additional_instruction`・`history_cutoff_date`・`prompt_lookahead_guarded`(NULL・0・1 の三値)は record にそのまま載せる(保存経路は now() で上書きしない)。
 *
 * **配分メタは record を経由しない**(`metaParams`): `AnalysisAllocationMetaRecord` の `include_quinella`・`include_exacta`・`include_trifecta`・`include_bracket_quinella` は
 * 非 nullable な boolean で、codec の `allocationMetaParams` は `? 1 : 0` と書くため、exe の NULL(「設定を記録していない」。OFF ではない。#31)が 0 に潰れる。
 * さらに `toStoredAllocation` 経由の復元は 6 列(combo_odds_wide・combo_odds_trio・greedy_steps・candidate_cap・model_id・model_approximate)を読まない。
 * そこで、行の値から codec の INSERT 文の `?` の並び(analysis_id を除く 23 値)を直接作り、`buildSaveStatements` の上書きとして渡す。列の並びは
 * `MIGRATION_TABLES` の定義順で、codec の INSERT 文の列の並びと一致することをテストが固定している。
 *
 * ## 結果(`toResultImport`)
 * 結果の行を、`json_each` で 1 文に入れるための JSON 文字列(行の配列。race_id を除いた列の並びは `MIGRATION_TABLES` の順)にする。値は行のまま(`passing_json` を再解釈しない)。
 */

import type { PredictionMark } from "../../packages/core/src/analyzer/parse-response.js";
import { itemsFromJson, type SqlParams } from "../../packages/core/src/ev/analysis-store-codec.js";
import type { AnalysisAllocationMetaRecord, AnalysisBetRecord, AnalysisHorseRecord, AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import {
  MIGRATION_TABLES,
  MigrationFormatError,
  type MigrationAnalysisLine,
  type MigrationResultLine,
  type MigrationRow,
  type MigrationTableName,
} from "../../packages/core/src/ev/cloud-migration-format";

/** 分析 1 件の取り込みの入力。 */
export interface AnalysisImport {
  /** exe の分析 id(冪等性の鍵。`analyses.exe_analysis_id`)。 */
  readonly exeId: number;
  readonly record: AnalysisRecord;
  /** 配分メタの束縛値(analysis_id を除く 23 値)。配分メタが無い分析は null。 */
  readonly metaParams: SqlParams | null;
}

/** 結果 1 レースの取り込みの入力。無い表は null。 */
export interface ResultImport {
  readonly raceId: string;
  /** race_results の行の配列(race_id を除く列の並び)の JSON。 */
  readonly resultsJson: string | null;
  /** race_result_meta の course_type。 */
  readonly courseType: string | null;
  /** race_combo_payouts の行の配列(race_id を除く列の並び)の JSON。 */
  readonly comboRowsJson: string | null;
  /** race_combo_payout_imports の行の配列(`[bet_type]`)の JSON。 */
  readonly markerRowsJson: string | null;
  /** 行数(進捗の表示と、1 回の alarm の文の見積もりに使う)。 */
  readonly counts: { readonly results: number; readonly comboPayouts: number; readonly comboPayoutImports: number };
}

/** JSON 列を読む。壊れていれば、どの分析のどの列かを含む {@link MigrationFormatError}。NULL は null。 */
function parseJsonColumn(raw: string | number | null | undefined, where: string, column: string): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    throw new MigrationFormatError(`${where}: ${column} が JSON として読めない(${e instanceof Error ? e.message.slice(0, 80) : "不明"})`);
  }
}

/** 主キーの組が重複していないことを確かめる。 */
function assertUnique(rows: readonly MigrationRow[], table: MigrationTableName, where: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(MIGRATION_TABLES[table].keyColumns.map((c) => row[c]));
    if (seen.has(key)) {
      throw new MigrationFormatError(`${where}: ${table} の主キーが重複している(${MIGRATION_TABLES[table].keyColumns.join(", ")} = ${key})`);
    }
    seen.add(key);
  }
}

const num = (row: MigrationRow, column: string): number => row[column] as number;
const numOrNull = (row: MigrationRow, column: string): number | null => (row[column] as number | null) ?? null;
const strOrNull = (row: MigrationRow, column: string): string | null => (row[column] as string | null) ?? null;

/** 0/1/NULL → boolean/null(NULL を false に潰さない)。 */
function triState(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

/**
 * record の型を満たすためだけの配分メタ(`buildSaveStatements` は `allocation` の有無で文を足すため、メタの存在を伝える)。
 * **書き込みには使わない**(束縛値は {@link AnalysisImport.metaParams} が上書きする)。NULL の設定列は false で埋めるが、その値は D1 に届かない。
 */
function placeholderMeta(row: MigrationRow): AnalysisAllocationMetaRecord {
  return {
    route: row["route"] as string,
    unavailableReason: strOrNull(row, "unavailable_reason"),
    fallbackReason: strOrNull(row, "fallback_reason"),
    skipReasonCode: strOrNull(row, "skip_reason_code"),
    comboOddsWide: strOrNull(row, "combo_odds_wide"),
    comboOddsTrio: strOrNull(row, "combo_odds_trio"),
    bankroll: num(row, "bankroll"),
    perRaceCap: num(row, "per_race_cap"),
    kellyFraction: num(row, "kelly_fraction"),
    evThreshold: num(row, "ev_threshold"),
    includeComboOdds: num(row, "include_combo_odds") !== 0,
    includeWide: num(row, "include_wide") !== 0,
    includeTrio: num(row, "include_trio") !== 0,
    includeQuinella: triState(numOrNull(row, "include_quinella")) ?? false,
    includeExacta: triState(numOrNull(row, "include_exacta")) ?? false,
    includeTrifecta: triState(numOrNull(row, "include_trifecta")) ?? false,
    includeBracketQuinella: triState(numOrNull(row, "include_bracket_quinella")) ?? false,
    betUnit: numOrNull(row, "bet_unit"),
    greedySteps: numOrNull(row, "greedy_steps"),
    candidateCap: numOrNull(row, "candidate_cap"),
    modelId: strOrNull(row, "model_id"),
    modelApproximate: triState(numOrNull(row, "model_approximate")),
    oddsStatus: row["odds_status"] as string,
  };
}

/**
 * 分析の行を、保存経路に渡せる入力にする。
 * @throws MigrationFormatError JSON の列が壊れている・馬番/買い目のキーが重複する・配分メタが無いのに買い目がある
 */
export function toAnalysisImport(line: MigrationAnalysisLine): AnalysisImport {
  const a = line.analysis;
  const id = num(a, "id");
  const where = `分析の行(analysis.id=${id})`;
  assertUnique(line.horses, "analysis_horses", where);
  assertUnique(line.bets, "analysis_bets", where);
  if (line.allocationMeta === null && line.bets.length > 0) {
    throw new MigrationFormatError(`${where}: 配分メタが無いのに買い目が ${line.bets.length} 件ある`);
  }
  const raceSnapshot = parseJsonColumn(a["race_snapshot_json"], where, "race_snapshot_json");
  const horses: AnalysisHorseRecord[] = line.horses.map((h) => ({
    umaban: num(h, "umaban"),
    prior: num(h, "prior"),
    adjustedProb: num(h, "adjusted_prob"),
    placeOddsMin: numOrNull(h, "place_odds_min"),
    ev: numOrNull(h, "ev"),
    isPositive: num(h, "is_positive") !== 0,
    contributions: parseJsonColumn(h["contributions_json"], `${where}の馬 ${String(h["umaban"])}`, "contributions_json"),
    mark: strOrNull(h, "mark") as PredictionMark | null,
    reason: strOrNull(h, "reason"),
    highlights: itemsFromJson(strOrNull(h, "highlights_json")),
    concerns: itemsFromJson(strOrNull(h, "concerns_json")),
  }));
  const bets: AnalysisBetRecord[] = line.bets.map((b) => ({
    betType: b["bet_type"] as string,
    comboKey: b["combo_key"] as string,
    stake: num(b, "stake"),
    odds: numOrNull(b, "odds"),
    ev: numOrNull(b, "ev"),
  }));
  const record: AnalysisRecord = {
    raceId: a["race_id"] as string,
    analyzedAt: a["analyzed_at"] as string,
    // NULL は false(確定 EV 扱い)。codec の読み出し(toStoredAnalysis)も NULL を false として扱うので、意味は同じ。
    evEstimated: numOrNull(a, "ev_estimated") === 1,
    promptVersion: strOrNull(a, "prompt_version"),
    additionalInstruction: strOrNull(a, "additional_instruction"),
    kaisaiDate: strOrNull(a, "kaisai_date"),
    historyCutoffDate: strOrNull(a, "history_cutoff_date"),
    promptLookaheadGuarded: triState(numOrNull(a, "prompt_lookahead_guarded")),
    model: strOrNull(a, "model"),
    rawResponse: strOrNull(a, "raw_response"),
    raceSnapshot,
    horses,
    ...(line.allocationMeta === null ? {} : { allocation: { meta: placeholderMeta(line.allocationMeta), bets } }),
  };
  const metaParams: SqlParams | null =
    line.allocationMeta === null ? null : MIGRATION_TABLES.analysis_allocation_meta.columns.slice(1).map((c) => (line.allocationMeta as MigrationRow)[c.name] as string | number | null);
  return { exeId: id, record, metaParams };
}

/** 表の行を、先頭の列(race_id)を除いた列の並びの配列にする。 */
function rowsOf(table: MigrationTableName, rows: readonly MigrationRow[]): (string | number | null)[][] {
  const columns = MIGRATION_TABLES[table].columns.slice(1);
  return rows.map((r) => columns.map((c) => r[c.name] as string | number | null));
}

/**
 * 結果の行を、保存の入力にする。
 * @throws MigrationFormatError 馬番・払戻のキー・取込記録の券種が重複する
 */
export function toResultImport(line: MigrationResultLine): ResultImport {
  const where = `結果の行(raceId=${line.raceId})`;
  assertUnique(line.results, "race_results", where);
  assertUnique(line.comboPayouts, "race_combo_payouts", where);
  assertUnique(line.comboPayoutImports, "race_combo_payout_imports", where);
  return {
    raceId: line.raceId,
    resultsJson: line.results.length === 0 ? null : JSON.stringify(rowsOf("race_results", line.results)),
    courseType: line.meta === null ? null : strOrNull(line.meta, "course_type"),
    comboRowsJson: line.comboPayouts.length === 0 ? null : JSON.stringify(rowsOf("race_combo_payouts", line.comboPayouts)),
    markerRowsJson: line.comboPayoutImports.length === 0 ? null : JSON.stringify(line.comboPayoutImports.map((r) => [r["bet_type"]])),
    counts: { results: line.results.length, comboPayouts: line.comboPayouts.length, comboPayoutImports: line.comboPayoutImports.length },
  };
}
