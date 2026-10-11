/**
 * 検証の集計(Issue #219)が D1 から読む行と、その行から core の `computeVerifyReport` が使う読み取り口(`VerifyDataSource`)を作る純関数。
 * D1・R2 には触れない(行の配列を受け取るだけ。Worker の型も使わない。ルートの `scripts/test/cloud-verify-parity.test.ts` が、exe と同じスキーマの SQLite に
 * 同じ SQL を流して行を取り、exe の `AnalysisStore` の集計と JSON 往復込みで一致することを固定している)。
 *
 * ## 読み方(表ごとに 1 クエリ。D1 の「1 回の呼び出しで 50 クエリ」に収まる)
 * 集計は同期の読み取り口(`listAnalyses`・`getResult`・`getComboPayouts`・`getAllocationForVerify`)を前提にしているので、必要な表を先にすべて読んでメモリに置く。
 * - 分析: 要約の列だけ(大きな列の `raw_response`・`race_snapshot_json` は D1 では NULL で、読まない)。**発走時刻は `start_time` 列(migration 0009)から、
 *   `{race:{startTime}}` のスナップショットを SQL で組み立てて渡す**(`toStoredAnalysis` が JSON を復元し、先読み判定 `classifyLookaheadSuspicion` が `race.startTime` を読む。
 *   core の判定は変えない)。`HH:MM` の形の値だけを時刻として渡し、NULL(未確認)・''(詳細に発走時刻が無い)・'?'(詳細が無い・壊れていて確認できなかった)は
 *   スナップショットなし(NULL)として渡す(形で判定するので、将来 '' や '?' 以外の印を足しても、時刻として誤読しない)。
 *   **NULL の行が残っている間は集計してはならない**(`VerifyCore` が補完の完了を待つ。ここでは判定しない)。
 * - 馬: 集計が使う列だけ(寄与度・理由・強調材料・懸念事項は NULL)。
 * - 配分: メタ(route・skip_reason_code)と買い目(券種・キー・賭け金。`odds`/`ev` は読まない。exe の `getAllocationForVerify` と同じ)。
 * - 結果: 着順・複勝/単勝の払戻。組合せ払戻と取込印。
 *
 * ## 並び順(exe と同じにする)
 * 浮動小数の加算順が変わると合計の最下位ビットが変わりうるので、exe の SELECT と同じ並びにする: 買い目は (bet_type, combo_key)、組合せ払戻は combo_key、馬と結果は馬番、分析は id。
 * どの ORDER BY も主キーの順(`analysis_bets`・`race_combo_payouts`・`analysis_horses`・`race_results` の主キーは、いずれも先頭が id/race_id で、続く列がこの順)なので、並べ替えの一時領域は使わない。
 */

import type { ComboBetType } from "../../packages/core/src/scraper/combo-odds-key.js";
import { toStoredAnalysis, type AnalysisRow, type HorseRow } from "../../packages/core/src/ev/analysis-store-codec.js";
import { isLookaheadGuarded } from "../../packages/core/src/ev/lookahead-suspicion.js";
import type {
  RaceComboPayoutsReadResult,
  RaceResultEntry,
  StoredAllocationBet,
  StoredAllocationSummary,
  StoredAnalysis,
  StoredComboPayout,
  VerifyDataSource,
} from "../../packages/core/src/ev/analysis-store-types.js";

/** 集計が D1 から読む表ごとの SQL(束縛値なし)。 */
export const VERIFY_READ_SQL = {
  analyses: `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
       prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
       kaisai_date AS kaisaiDate, NULL AS model, NULL AS rawResponse,
       CASE WHEN start_time GLOB '[0-9]*:[0-9][0-9]'
            THEN json_object('race', json_object('startTime', start_time)) ELSE NULL END AS raceSnapshotJson,
       history_cutoff_date AS historyCutoffDate, prompt_lookahead_guarded AS promptLookaheadGuarded,
       start_time AS startTime
  FROM analyses ORDER BY id`,
  horses: `SELECT analysis_id AS analysisId, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive,
       NULL AS contributions_json, mark, NULL AS reason, NULL AS highlights_json, NULL AS concerns_json
  FROM analysis_horses ORDER BY analysis_id, umaban`,
  allocationMeta: `SELECT analysis_id AS analysisId, route, skip_reason_code AS skipReasonCode FROM analysis_allocation_meta`,
  bets: `SELECT analysis_id AS analysisId, bet_type AS betType, combo_key AS comboKey, stake
  FROM analysis_bets ORDER BY analysis_id, bet_type, combo_key`,
  results: `SELECT race_id AS raceId, umaban, finish_position AS finishPosition, place_payout AS placePayout, win_payout AS winPayout
  FROM race_results ORDER BY race_id, umaban`,
  comboPayouts: `SELECT race_id AS raceId, bet_type AS betType, combo_key AS comboKey, payout
  FROM race_combo_payouts ORDER BY race_id, bet_type, combo_key`,
  comboImports: `SELECT race_id AS raceId, bet_type AS betType FROM race_combo_payout_imports`,
} as const;

/** 分析の行。`startTime` は D1 の `start_time` の生の値(NULL・''・'?'・'HH:MM')。 */
export interface VerifyAnalysisRow extends AnalysisRow {
  readonly startTime: string | null;
}
export interface VerifyHorseRow extends HorseRow {
  readonly analysisId: number;
}
export interface VerifyAllocationMetaRow {
  readonly analysisId: number;
  readonly route: string;
  readonly skipReasonCode: string | null;
}
export interface VerifyBetRow {
  readonly analysisId: number;
  readonly betType: string;
  readonly comboKey: string;
  readonly stake: number;
}
export interface VerifyResultRow {
  readonly raceId: string;
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly placePayout: number | null;
  readonly winPayout: number | null;
}
export interface VerifyComboPayoutRow {
  readonly raceId: string;
  readonly betType: string;
  readonly comboKey: string;
  readonly payout: number;
}
export interface VerifyComboImportRow {
  readonly raceId: string;
  readonly betType: string;
}

/** {@link VERIFY_READ_SQL} の各 SQL の結果の行。 */
export interface VerifyReadRows {
  readonly analyses: readonly VerifyAnalysisRow[];
  readonly horses: readonly VerifyHorseRow[];
  readonly allocationMeta: readonly VerifyAllocationMetaRow[];
  readonly bets: readonly VerifyBetRow[];
  readonly results: readonly VerifyResultRow[];
  readonly comboPayouts: readonly VerifyComboPayoutRow[];
  readonly comboImports: readonly VerifyComboImportRow[];
}

/** キーごとに行を束ねる(入力の並びを保つ)。 */
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = map.get(key);
    if (group === undefined) {
      map.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return map;
}

/**
 * 読んだ行から、core の集計が使う読み取り口を作る。**読み取りは入力の行のコピーを返さずそのまま参照する**(集計は書き換えない)。
 * 行が無いレースの `getResult` は undefined(exe と同じ)。組合せ払戻は取込印があれば `imported`(払戻が 0 行でも)、無ければ `not_imported`。
 */
export function buildVerifySource(rows: VerifyReadRows): VerifyDataSource {
  const horsesByAnalysis = groupBy(rows.horses, (h) => h.analysisId);
  const analyses: StoredAnalysis[] = rows.analyses.map((a) => toStoredAnalysis(a, horsesByAnalysis.get(a.id) ?? []));
  const resultsByRace = new Map<string, RaceResultEntry[]>();
  for (const [raceId, group] of groupBy(rows.results, (r) => r.raceId)) {
    resultsByRace.set(
      raceId,
      group.map((r) => ({ umaban: r.umaban, finishPosition: r.finishPosition, placePayout: r.placePayout, winPayout: r.winPayout })),
    );
  }
  const importedKeys = new Set(rows.comboImports.map((i) => `${i.raceId}:${i.betType}`));
  const payoutsByKey = new Map<string, StoredComboPayout[]>();
  for (const [key, group] of groupBy(rows.comboPayouts, (p) => `${p.raceId}:${p.betType}`)) {
    payoutsByKey.set(key, group.map((p) => ({ comboKey: p.comboKey, payout: p.payout })));
  }
  const betsByAnalysis = groupBy(rows.bets, (b) => b.analysisId);
  const allocationByAnalysis = new Map<number, StoredAllocationSummary>();
  for (const meta of rows.allocationMeta) {
    const bets: StoredAllocationBet[] = (betsByAnalysis.get(meta.analysisId) ?? []).map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake }));
    allocationByAnalysis.set(meta.analysisId, { route: meta.route, skipReasonCode: meta.skipReasonCode, bets });
  }

  return {
    listAnalyses: (filter) => (filter?.raceId === undefined ? analyses : analyses.filter((a) => a.raceId === filter.raceId)),
    getResult: (raceId) => resultsByRace.get(raceId),
    getComboPayouts: (raceId: string, betType: ComboBetType): RaceComboPayoutsReadResult => {
      const key = `${raceId}:${betType}`;
      return importedKeys.has(key) ? { state: "imported", payouts: payoutsByKey.get(key) ?? [] } : { state: "not_imported" };
    },
    getAllocationForVerify: (analysisId) => allocationByAnalysis.get(analysisId),
  };
}

/** `start_time` の印(migration 0009)。 */
export const START_TIME_UNCHECKED = null;
/** 詳細(R2)はあるが、スナップショットに発走時刻が無い(または読める形でない)。exe でも時刻なしと判定される。 */
export const START_TIME_ABSENT = "";
/** 詳細が無い・壊れている・別のレースのものだったため、確認できなかった(exe には時刻があったかもしれない)。 */
export const START_TIME_LOST = "?";

/**
 * 発走時刻の写しを確認できなかった行の数(Issue #219)。exe には発走時刻があったはずの行が、web では時刻なしとして判定される場合の検出。
 * - `lost`: 印が '?' の分析の数(詳細〈R2〉を失った・壊れていた・詳細の無い保存)
 * - `affecting`: そのうち、**判定が時刻に依る**もの(遮断済みでない行。遮断済みの行は時刻を見ずに clean になるので、欠落は結果を変えない)
 * 集計は分析の行ごとに数える(最新選択・結果の有無の前の、保存された分析の総数。集計に入るかどうかは見ない)。
 */
export function countStartTimeGaps(analyses: readonly VerifyAnalysisRow[]): { readonly lost: number; readonly affecting: number } {
  let lost = 0;
  let affecting = 0;
  for (const a of analyses) {
    if (a.startTime !== START_TIME_LOST) continue;
    lost += 1;
    if (!isLookaheadGuarded({ historyCutoffDate: a.historyCutoffDate, promptVersion: a.promptVersion, promptLookaheadGuarded: a.promptLookaheadGuarded === null ? null : a.promptLookaheadGuarded === 1 })) {
      affecting += 1;
    }
  }
  return { lost, affecting };
}
