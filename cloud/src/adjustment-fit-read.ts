/**
 * 月報の「補正の当たり具合」(Issue #509)の D1 の読み出し。**読み取り専用・R2 に触れない**。計算は `adjustment-fit.ts`(純関数)。
 *
 * ## 読み方(2 回のラウンドトリップ。月報の DO の read 段階のサブリクエストは、成績の batch 1 と合わせて 3)
 *  1. **候補の分析**(1 文): 月の開催日の範囲で、結果のあるレースの分析を、先読みの分類と最新の選択に要る列つきで読む(`idx_analyses_kaisai_date`)。
 *     母集団の選択は JS(`classifyLookaheadSuspicion` が JST の時刻計算を含むため。SQL では書かない)。
 *  2. **選んだ分析の馬と結果**(batch 2 文): どちらも `IN (SELECT value FROM json_each(?))` で、主キーの索引を引く(配分用・統計モデル用の書き出し〈`prior-export-store.ts`〉と同じ形)。
 *     選んだ分析が 0 件なら、この batch は発行しない。
 * 読み取り行数の見積もり: レース数 N に対して、約 N × (分析 1.5 件 + 結果の存在確認 1.5 行 + 馬 14 頭 + 結果 14 頭) ≒ N × 31 行。成績の再集計(約 N × 100 行)の約 3 割増し。
 *
 * ## 上限
 * 候補の分析が {@link FIT_CANDIDATES_LIMIT} を超えたら {@link FitTooManyError}(**一部だけの集計は返さない**。成績の再集計の `PERIOD_ANALYSES_LIMIT` と同じ流儀)。
 */
import type { ReportDb } from "./daily-report-repository";
import { selectFitAnalyses, type FitCandidate, type FitHorseRow, type FitResultRow, type FitSelection } from "./adjustment-fit";

/** 候補の分析の上限。月に分析するレースの上限(`PERIOD_ANALYSES_LIMIT` 3,000)に、同じレースの再分析を数倍見込んだ値。 */
export const FIT_CANDIDATES_LIMIT = 10_000;

/**
 * 候補の分析(束縛値は `[from, to, 上限 + 1]`)。列は配分用の書き出しの候補と同じ(`CandidateRow`)に、LLM が効いたかの `model` を足したもの。
 * 結果の行が 1 つでもあるレースの分析だけ(検証画面は結果の無いレースの分析を集計しない)。
 */
export const FIT_CANDIDATES_SQL = `SELECT a.id AS id, a.race_id AS raceId, a.analyzed_at AS analyzedAt, a.kaisai_date AS kaisaiDate, a.prompt_version AS promptVersion,
  a.detail_key AS detailKey, a.ev_estimated AS evEstimated, a.prompt_lookahead_guarded AS promptLookaheadGuarded, a.history_cutoff_date AS historyCutoffDate,
  a.start_time AS startTime, a.model AS model
  FROM analyses a
 WHERE a.kaisai_date >= ? AND a.kaisai_date <= ?
   AND EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
 ORDER BY a.id
 LIMIT ?`;

/** 選んだ分析の馬(束縛値は分析 id の JSON 配列 1 つ)。 */
export const FIT_HORSES_SQL = `SELECT analysis_id AS analysisId, umaban, prior, adjusted_prob AS adjustedProb
  FROM analysis_horses WHERE analysis_id IN (SELECT value FROM json_each(?)) ORDER BY analysis_id, umaban`;

/** 選んだレースの結果(束縛値はレース ID の JSON 配列 1 つ)。 */
export const FIT_RESULTS_SQL = `SELECT race_id AS raceId, umaban, finish_position AS finishPosition, scratched, ninki
  FROM race_results WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, umaban`;

/** 候補の分析が上限を超えた(一部だけの集計を返さないための例外)。 */
export class FitTooManyError extends Error {
  constructor(limit: number) {
    super(`補正の当たり具合の候補の分析が上限(${limit} 件)を超えています。一部だけの集計は返しません`);
    this.name = "FitTooManyError";
  }
}

export interface FitRows {
  readonly selection: FitSelection;
  readonly horses: readonly FitHorseRow[];
  readonly results: readonly FitResultRow[];
  /** D1 が報告した読み取り行数(`meta.rows_read`)の合計(実測用)。 */
  readonly rowsRead: number;
}

/** 月 `[fromDate, toDate]` の、集計の材料を読む。候補が `limit` を超えたら {@link FitTooManyError}。 */
export async function readAdjustmentFitRows(db: ReportDb, fromDate: string, toDate: string, limit: number = FIT_CANDIDATES_LIMIT): Promise<FitRows> {
  const candidates = await db.prepare(FIT_CANDIDATES_SQL).bind(fromDate, toDate, limit + 1).all<FitCandidate>();
  if (candidates.results.length > limit) {
    throw new FitTooManyError(limit);
  }
  let rowsRead = candidates.meta?.rows_read ?? 0;
  const selection = selectFitAnalyses(candidates.results);
  if (selection.chosen.length === 0) {
    return { selection, horses: [], results: [], rowsRead };
  }
  const analysisIds = JSON.stringify(selection.chosen.map((c) => c.id));
  const raceIds = JSON.stringify(selection.chosen.map((c) => c.raceId));
  const [horseRes, resultRes] = await db.batch([db.prepare(FIT_HORSES_SQL).bind(analysisIds), db.prepare(FIT_RESULTS_SQL).bind(raceIds)]);
  rowsRead += (horseRes?.meta?.rows_read ?? 0) + (resultRes?.meta?.rows_read ?? 0);
  return {
    selection,
    horses: (horseRes?.results ?? []) as FitHorseRow[],
    results: (resultRes?.results ?? []) as FitResultRow[],
    rowsRead,
  };
}
