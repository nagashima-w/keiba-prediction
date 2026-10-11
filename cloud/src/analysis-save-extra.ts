import type { LlmCallRecord } from "./llm-calls";

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
  /**
   * LLM を呼んだ1回ごとの記録(所要時間・usage・stop_reason・失敗の説明。Issue #197 段2)。呼び出しの順。LLM を呼ばなかった(キー未登録)・旧い経路は null・省略・空配列(いずれも NULL で保存)。
   * D1 の `analyses.llm_calls_json` に保存される。
   */
  readonly llmCalls?: readonly LlmCallRecord[] | null;
}

/**
 * 保存済みの分析の要約のうち、手動の分析との重複の確認(Issue #204)に要る列だけ。`AnalysisSink.findRecentByRace` の戻り値(D1 の `listRecentForRace` が作る)。
 * ここに置くのは `AnalysisSaveExtra` と同じ理由(`RaceDayCore` は保存先の実体を知らないので、型だけを小さなモジュールで共有する)。
 */
export interface RecentAnalysis {
  readonly id: number;
  /** 分析時刻(ISO 8601 の UTC)。 */
  readonly analyzedAt: string;
  /** LLM を呼んだ分析だけ入る(キー未登録は null)。 */
  readonly promptVersion: string | null;
  /** LLM の補正が実際に採用された分析だけ入る(fallback・キー未登録は null)。 */
  readonly model: string | null;
}
