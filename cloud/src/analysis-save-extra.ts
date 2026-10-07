/**
 * 発走前の分析を保存するとき、分析のレコード(core の `AnalysisRecord`。exe と共有)とは別に渡す情報(Issue #194)。
 * 型だけの小さなモジュール: `RaceDayCore`(D1・R2 の実体を知らない)と `D1AnalysisStore`(保存先)の両方が、お互いを import せずに共有するため。
 */
export interface AnalysisSaveExtra {
  /**
   * LLM が使われなかった・一部しか使われなかった理由(**固定文言**。`llm-run.ts` の `LLM_NOTE_*` と core の `FALLBACK_REASON_*`。API のエラーの本文は入れない)。
   * 問題なく効いたとき・LLM を使わない旧い経路は null(省略も同じ)。D1 の `analyses.llm_note` に保存される。
   */
  readonly llmNote: string | null;
}
