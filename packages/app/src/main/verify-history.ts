/**
 * 保存済み分析(core StoredAnalysis)から検証画面の履歴一覧(AnalysisHistoryItem)を組み立てる純関数。
 *
 * 結果取込済みかの判定は「実結果が保存されているレースIDの集合」を引数で受け、
 * DBアクセス(getResult)は呼び出し側(pipeline-deps)に閉じ込めてここは純粋に保つ。
 */

import type { StoredAnalysis } from "@keiba/core";
import type { AnalysisHistoryItem } from "../shared/analysis-types.js";

/**
 * 分析履歴一覧を組み立てる。
 * @param analyses 保存済み分析(listAnalyses の結果。ID昇順)
 * @param resultRaceIds 実結果(実着順)が取込済みのレースIDの集合
 * @param payoutRaceIds 複勝確定払戻が取込済みのレースIDの集合(実着順とは別に判定)
 */
export function buildAnalysisHistory(
  analyses: readonly StoredAnalysis[],
  resultRaceIds: ReadonlySet<string>,
  payoutRaceIds: ReadonlySet<string>,
): AnalysisHistoryItem[] {
  return analyses.map((a) => ({
    analysisId: a.id,
    raceId: a.raceId,
    analyzedAt: a.analyzedAt,
    horseCount: a.horses.length,
    positiveCount: a.horses.filter((h) => h.isPositive).length,
    hasResult: resultRaceIds.has(a.raceId),
    hasPayout: payoutRaceIds.has(a.raceId),
  }));
}
