/**
 * 分析履歴ストアの「SQL と値の変換」(Issue #168・#163-a で `analysis-store.ts` から切り出した純関数群)。
 *
 * exe の `AnalysisStore`(better-sqlite3。同期)と、後続 #169 の D1 実装(cloud。非同期)が**同じ変換を共有する**ための層。
 * 2実装で変換が食い違うと、同じ分析が実装によって違う値で保存・復元される(NULL を false に潰す等。#31・#152 の原則)。
 * - SQL 文(INSERT・SELECT)の文字列。テーブル名・列の順序はここが唯一のソース
 * - `AnalysisRecord` → 各表の束縛値の並び(NULL / 0 / 1、undefined → null、JSON 化)
 * - DB の行 → `StoredAnalysis` / `StoredAllocation`(NULL の復元、0/1 → 真偽値、JSON の復元)
 *
 * **このファイルは better-sqlite3 に依存しない**(型は `analysis-store-types.ts` から `import type` するだけ。
 * `test/ev/native-free-modules.test.ts` が機械的に固定している)。DB へ実際に発行する処理(prepare・transaction)は持たない。
 *
 * ★exe の性能を変えないための約束: exe の `AnalysisStore` は、ここの SQL を従来と**同じ文・同じ回数・同じ順序**で発行する
 * (行ごとに prepare し直さない。`test/ev/analysis-store-sql-sequence.test.ts` が発行列を固定している)。
 */

import type { PredictionMark } from "../analyzer/parse-response.js";
import type {
  AnalysisAllocationMetaRecord,
  AnalysisBetRecord,
  AnalysisHorseRecord,
  AnalysisRecord,
  StoredAllocation,
  StoredAllocationBetDetail,
  StoredAnalysis,
  StoredAnalysisHorse,
} from "./analysis-store-types.js";

export const ANALYSES_TABLE = "analyses";
export const ANALYSIS_HORSES_TABLE = "analysis_horses";
export const RACE_RESULTS_TABLE = "race_results";
export const RACE_RESULT_META_TABLE = "race_result_meta";
export const RACE_COMBO_PAYOUTS_TABLE = "race_combo_payouts";
export const RACE_COMBO_PAYOUT_IMPORTS_TABLE = "race_combo_payout_imports";
export const ANALYSIS_ALLOCATION_META_TABLE = "analysis_allocation_meta";
export const ANALYSIS_BETS_TABLE = "analysis_bets";

/** SQL へ束縛する値(better-sqlite3・D1 のどちらにも渡せる範囲: 文字列・数値・NULL)。 */
export type SqlValue = string | number | null;
/** 1文ぶんの束縛値の並び(SQL の `?` の順)。 */
export type SqlParams = readonly SqlValue[];

// ---------------------------------------------------------------------------
// 保存(INSERT)
// ---------------------------------------------------------------------------

/** analyses への INSERT(11列)。束縛値は {@link analysisParams}。 */
export const INSERT_ANALYSIS_SQL = `INSERT INTO ${ANALYSES_TABLE}
         (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction, kaisai_date,
          model, raw_response, race_snapshot_json, history_cutoff_date, prompt_lookahead_guarded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** analysis_horses への INSERT(12列)。束縛値は {@link horseParams}。 */
export const INSERT_ANALYSIS_HORSE_SQL = `INSERT INTO ${ANALYSIS_HORSES_TABLE}
         (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason,
          highlights_json, concerns_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** analysis_allocation_meta への INSERT(24列。配分提案〈Issue #59〉のレース単位メタ行)。束縛値は {@link allocationMetaParams}。 */
export const INSERT_ALLOCATION_META_SQL = `INSERT INTO ${ANALYSIS_ALLOCATION_META_TABLE}
         (analysis_id, route, unavailable_reason, fallback_reason, skip_reason_code,
          combo_odds_wide, combo_odds_trio, bankroll, per_race_cap, kelly_fraction, ev_threshold,
          include_combo_odds, include_wide, include_trio, include_quinella, include_exacta,
          include_trifecta, include_bracket_quinella, bet_unit, greedy_steps, candidate_cap,
          model_id, model_approximate, odds_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** analysis_bets への INSERT(6列。買い目明細)。束縛値は {@link allocationBetParams}。 */
export const INSERT_ALLOCATION_BET_SQL = `INSERT INTO ${ANALYSIS_BETS_TABLE}
         (analysis_id, bet_type, combo_key, stake, odds, ev)
       VALUES (?, ?, ?, ?, ?, ?)`;

/** 未定義(undefined)・null を null に揃える(`?? null`)。空文字・0・false は保つ。 */
function orNull<T extends string | number>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** JSON を保存する列の値。undefined・null は NULL(文字列 "null" にしない)、それ以外は JSON 文字列(0・false も JSON 化)。 */
function toJsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * 強調材料・懸念事項(Issue #197)を保存する列の値。省略・null・空配列は NULL(「項目なし」を NULL で表す)、
 * それ以外は JSON 配列の文字列。
 */
function itemsToJsonOrNull(items: readonly string[] | null | undefined): string | null {
  return items === undefined || items === null || items.length === 0 ? null : JSON.stringify(items);
}

/**
 * 強調材料・懸念事項の列から項目の配列を復元する(Issue #197)。NULL・壊れた JSON・配列でない値は `[]`
 * (例外にしない)。配列の文字列でない要素は捨てる。
 */
export function itemsFromJson(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * analyses 1行ぶんの束縛値({@link INSERT_ANALYSIS_SQL} の `?` の順)。
 * - `evEstimated`: 省略・false → 0、true → 1(省略は確定EV扱い)
 * - `promptLookaheadGuarded`: 省略・null → NULL(記録なし)、true → 1、false → 0(明示的に未遮断。NULL と区別する。#152)
 * - 文字列の任意項目: 省略・null → NULL(空文字は空文字のまま)
 * - `raceSnapshot`: 省略・null → NULL、それ以外は JSON 文字列
 */
export function analysisParams(rec: AnalysisRecord): SqlParams {
  return [
    rec.raceId,
    rec.analyzedAt,
    rec.evEstimated ? 1 : 0,
    orNull(rec.promptVersion),
    orNull(rec.additionalInstruction),
    orNull(rec.kaisaiDate),
    orNull(rec.model),
    orNull(rec.rawResponse),
    toJsonOrNull(rec.raceSnapshot),
    orNull(rec.historyCutoffDate),
    rec.promptLookaheadGuarded === undefined || rec.promptLookaheadGuarded === null
      ? null
      : rec.promptLookaheadGuarded
        ? 1
        : 0,
  ];
}

/** analysis_horses 1行ぶんの束縛値({@link INSERT_ANALYSIS_HORSE_SQL} の `?` の順)。 */
export function horseParams(analysisId: number, h: AnalysisHorseRecord): SqlParams {
  return [
    analysisId,
    h.umaban,
    h.prior,
    h.adjustedProb,
    h.placeOddsMin,
    h.ev,
    h.isPositive ? 1 : 0,
    toJsonOrNull(h.contributions),
    h.mark,
    orNull(h.reason),
    itemsToJsonOrNull(h.highlights),
    itemsToJsonOrNull(h.concerns),
  ];
}

/** analysis_allocation_meta 1行ぶんの束縛値({@link INSERT_ALLOCATION_META_SQL} の `?` の順)。 */
export function allocationMetaParams(
  analysisId: number,
  m: AnalysisAllocationMetaRecord,
): SqlParams {
  return [
    analysisId,
    m.route,
    m.unavailableReason,
    m.fallbackReason,
    m.skipReasonCode,
    m.comboOddsWide,
    m.comboOddsTrio,
    m.bankroll,
    m.perRaceCap,
    m.kellyFraction,
    m.evThreshold,
    m.includeComboOdds ? 1 : 0,
    m.includeWide ? 1 : 0,
    m.includeTrio ? 1 : 0,
    m.includeQuinella ? 1 : 0,
    m.includeExacta ? 1 : 0,
    m.includeTrifecta ? 1 : 0,
    m.includeBracketQuinella ? 1 : 0,
    m.betUnit,
    m.greedySteps,
    m.candidateCap,
    m.modelId,
    m.modelApproximate === null ? null : m.modelApproximate ? 1 : 0,
    m.oddsStatus,
  ];
}

/** analysis_bets 1行ぶんの束縛値({@link INSERT_ALLOCATION_BET_SQL} の `?` の順)。 */
export function allocationBetParams(analysisId: number, b: AnalysisBetRecord): SqlParams {
  return [analysisId, b.betType, b.comboKey, b.stake, b.odds, b.ev];
}

/** 分析1件の子の行(analyses の採番 id が決まってから書く行)の束縛値。 */
export interface AnalysisChildParams {
  /** analysis_horses の行(入力の馬の順)。 */
  readonly horses: readonly SqlParams[];
  /**
   * analysis_allocation_meta の行。`record.allocation` が**無いときだけ null**(旧分析と区別できない「未到達」のまま
   * 行を書かない。#59 AC4)。配分があれば、買い目が0件でも必ず1行ある(全経路で1行書く契約。#31)。
   */
  readonly allocationMeta: SqlParams | null;
  /** analysis_bets の行(入力の買い目の順)。配分が無ければ空。 */
  readonly allocationBets: readonly SqlParams[];
}

/**
 * 分析1件の子の行の束縛値を組み立てる(書く順序は 馬 → 配分メタ → 買い目。呼び出し側はこの順に書く)。
 * @param rec 保存する分析
 * @param analysisId analyses に採番された id
 */
export function buildChildParams(rec: AnalysisRecord, analysisId: number): AnalysisChildParams {
  return {
    horses: rec.horses.map((h) => horseParams(analysisId, h)),
    allocationMeta:
      rec.allocation === undefined ? null : allocationMetaParams(analysisId, rec.allocation.meta),
    allocationBets:
      rec.allocation === undefined
        ? []
        : rec.allocation.bets.map((b) => allocationBetParams(analysisId, b)),
  };
}

// ---------------------------------------------------------------------------
// 取得(SELECT)と復元
// ---------------------------------------------------------------------------

/** analyses の SELECT の列と FROM(絞り込みと並びは {@link SELECT_ANALYSES_SQL}・{@link SELECT_ANALYSES_BY_RACE_SQL})。 */
const SELECT_ANALYSES_HEAD = `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
                      prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
                      kaisai_date AS kaisaiDate, model, raw_response AS rawResponse,
                      race_snapshot_json AS raceSnapshotJson,
                      history_cutoff_date AS historyCutoffDate,
                      prompt_lookahead_guarded AS promptLookaheadGuarded
                 FROM ${ANALYSES_TABLE}`;

/** 全分析(id 昇順)。 */
export const SELECT_ANALYSES_SQL = `${SELECT_ANALYSES_HEAD} ORDER BY id`;

/** レースIDで絞った分析(id 昇順。束縛値は raceId 1つ)。 */
export const SELECT_ANALYSES_BY_RACE_SQL = `${SELECT_ANALYSES_HEAD} WHERE race_id = ? ORDER BY id`;

/** 分析1件の馬(馬番昇順。束縛値は analysis_id 1つ)。行は {@link HorseRow}。 */
export const SELECT_ANALYSIS_HORSES_SQL = `SELECT umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason,
                highlights_json, concerns_json
         FROM ${ANALYSIS_HORSES_TABLE} WHERE analysis_id = ? ORDER BY umaban`;

/** 配分メタ1行(束縛値は analysis_id 1つ)。行は {@link AllocationMetaRow}。 */
export const SELECT_ALLOCATION_META_SQL = `SELECT route, unavailable_reason AS unavailableReason, fallback_reason AS fallbackReason,
                skip_reason_code AS skipReasonCode, bankroll, per_race_cap AS perRaceCap,
                kelly_fraction AS kellyFraction, ev_threshold AS evThreshold,
                include_combo_odds AS includeComboOdds, include_wide AS includeWide,
                include_trio AS includeTrio, include_quinella AS includeQuinella,
                include_exacta AS includeExacta, include_trifecta AS includeTrifecta,
                include_bracket_quinella AS includeBracketQuinella,
                bet_unit AS betUnit, odds_status AS oddsStatus
           FROM ${ANALYSIS_ALLOCATION_META_TABLE} WHERE analysis_id = ?`;

/** 買い目明細(束縛値は analysis_id 1つ)。行はそのまま {@link StoredAllocationBetDetail}。 */
export const SELECT_ALLOCATION_BETS_SQL = `SELECT bet_type AS betType, combo_key AS comboKey, stake, odds, ev
           FROM ${ANALYSIS_BETS_TABLE} WHERE analysis_id = ? ORDER BY bet_type, combo_key`;

/** analyses の行の DB 表現({@link SELECT_ANALYSES_SQL} の列別名どおり)。 */
export interface AnalysisRow {
  id: number;
  raceId: string;
  analyzedAt: string;
  evEstimated: number | null;
  promptVersion: string | null;
  additionalInstruction: string | null;
  kaisaiDate: string | null;
  model: string | null;
  rawResponse: string | null;
  raceSnapshotJson: string | null;
  historyCutoffDate: string | null;
  promptLookaheadGuarded: number | null;
}

/** 分析馬行のDB表現。 */
export interface HorseRow {
  umaban: number;
  prior: number;
  adjusted_prob: number;
  place_odds_min: number | null;
  ev: number | null;
  is_positive: number;
  contributions_json: string | null;
  mark: string | null;
  reason: string | null;
  highlights_json: string | null;
  concerns_json: string | null;
}

/** 配分メタ行の DB 表現({@link SELECT_ALLOCATION_META_SQL} の列別名どおり)。 */
export interface AllocationMetaRow {
  route: string;
  unavailableReason: string | null;
  fallbackReason: string | null;
  skipReasonCode: string | null;
  bankroll: number;
  perRaceCap: number;
  kellyFraction: number;
  evThreshold: number;
  includeComboOdds: number;
  includeWide: number;
  includeTrio: number;
  includeQuinella: number | null;
  includeExacta: number | null;
  includeTrifecta: number | null;
  includeBracketQuinella: number | null;
  betUnit: number | null;
  oddsStatus: string;
}

/** DB行から復元済み馬レコードへ変換する(is_positive の 0/1、JSON の復元を含む)。 */
export function toStoredHorse(row: HorseRow): StoredAnalysisHorse {
  return {
    umaban: row.umaban,
    prior: row.prior,
    adjustedProb: row.adjusted_prob,
    placeOddsMin: row.place_odds_min,
    ev: row.ev,
    isPositive: row.is_positive !== 0,
    contributions:
      row.contributions_json === null ? null : JSON.parse(row.contributions_json),
    // DBには自前で書き込んだ値(またはNULL)のみが入るため、素通しでキャストする
    // (未知の文字列が紛れ込む経路は無い。念のため未知値でも「印なし扱い」にはせず型どおり通す)。
    mark: row.mark as PredictionMark | null,
    reason: row.reason,
    highlights: itemsFromJson(row.highlights_json),
    concerns: itemsFromJson(row.concerns_json),
  };
}

/**
 * analyses.race_snapshot_json(JSON文字列)をレース情報スナップショットへ復元する(Issue#10)。
 * NULL(未保存・旧レコード)・JSON parseの失敗は、silentにthrowせず null にフォールバックする
 * (getRaceResultDetail/toStoredPassingと同じ防御的復元方針)。スキーマの妥当性検証は行わない
 * (呼び出し側〈main/analysis-export.ts〉が必要に応じて構造を検証する)。
 */
export function toStoredRaceSnapshot(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * analyses の行と、その馬の行から `StoredAnalysis` を復元する。
 * - `evEstimated`: NULL(旧レコード・未指定保存)は false(確定EV扱い)、1 は true
 * - `promptLookaheadGuarded`: NULL は null のまま、1 は true、0 は false(NULL を false に潰さない。#152)
 * - 文字列の任意列: NULL(旧レコード・列追加前の保存・LLM未使用など)は null のまま
 */
export function toStoredAnalysis(row: AnalysisRow, horseRows: readonly HorseRow[]): StoredAnalysis {
  return {
    id: row.id,
    raceId: row.raceId,
    analyzedAt: row.analyzedAt,
    horses: horseRows.map(toStoredHorse),
    // NULL(旧レコード・未指定保存)は false(確定EV扱い)として復元する。
    evEstimated: row.evEstimated === 1,
    // NULL(旧レコード・列追加前の保存・LLM未使用)は版不明としてnullのまま復元する。
    promptVersion: row.promptVersion,
    // NULL(旧レコード・列追加前の保存・設定が空・LLM未使用)は追加指示なしとしてnullのまま復元する。
    additionalInstruction: row.additionalInstruction,
    // NULL(旧レコード・列追加前の保存・選択済み開催日が渡らなかった分析)は日付不明としてnullのまま復元する。
    kaisaiDate: row.kaisaiDate,
    // NULL(旧レコード・列追加前の保存・LLM未使用)はモデル不明としてnullのまま復元する(Issue#10)。
    model: row.model,
    // NULL(旧レコード・列追加前の保存・LLM未使用)は応答なしとしてnullのまま復元する(Issue#10)。
    rawResponse: row.rawResponse,
    // NULL・破損JSON(旧レコード・未保存)はスナップショットなしとしてnullで復元する(Issue#10。
    // 防御的復元。getRaceResultDetailと同方針)。
    raceSnapshot: toStoredRaceSnapshot(row.raceSnapshotJson),
    // NULL(旧レコード・列追加前の保存・是正前の呼び出し元)は遮断の記録なしとしてnullのまま復元する(Issue #152)。
    historyCutoffDate: row.historyCutoffDate,
    // NULL は null のまま、1 は true、0 は false(明示的に未遮断)。NULL を false に潰さない(Issue #152)。
    promptLookaheadGuarded:
      row.promptLookaheadGuarded === null ? null : row.promptLookaheadGuarded === 1,
  };
}

/**
 * 配分メタ行と買い目から `StoredAllocation` を復元する。
 * 後付け列(include_quinella・include_exacta・include_trifecta・include_bracket_quinella)は、NULL(列追加前の保存=
 * 「設定を記録していない」)を null のまま、0 を false、1 を true にする(NULL を OFF と断定しない。#31)。
 */
export function toStoredAllocation(
  metaRow: AllocationMetaRow,
  bets: readonly StoredAllocationBetDetail[],
): StoredAllocation {
  return {
    route: metaRow.route,
    unavailableReason: metaRow.unavailableReason,
    fallbackReason: metaRow.fallbackReason,
    skipReasonCode: metaRow.skipReasonCode,
    bankroll: metaRow.bankroll,
    perRaceCap: metaRow.perRaceCap,
    kellyFraction: metaRow.kellyFraction,
    evThreshold: metaRow.evThreshold,
    includeComboOdds: metaRow.includeComboOdds !== 0,
    includeWide: metaRow.includeWide !== 0,
    includeTrio: metaRow.includeTrio !== 0,
    includeQuinella: metaRow.includeQuinella === null ? null : metaRow.includeQuinella !== 0,
    includeExacta: metaRow.includeExacta === null ? null : metaRow.includeExacta !== 0,
    includeTrifecta: metaRow.includeTrifecta === null ? null : metaRow.includeTrifecta !== 0,
    includeBracketQuinella:
      metaRow.includeBracketQuinella === null ? null : metaRow.includeBracketQuinella !== 0,
    betUnit: metaRow.betUnit,
    oddsStatus: metaRow.oddsStatus,
    bets,
  };
}
