/**
 * 期間バッチのフォーム(from/to/取得対象)ロック判定(純関数、タスクC2重大修正)。
 *
 * code-reviewer指摘の不変条件:「確定実行される内容は、常に画面に表示中の
 * from/to/target(=収集済みスナップショット)と一致していなければならない」。
 * 収集(phase1)開始後もフォームが編集可能だと、collectResult(収集時のスナップショット)と
 * 画面表示中の入力値がズレ、ユーザーが「表示中の内容で実行される」と誤認したまま
 * 意図しない範囲でLLM分析(課金)が走ってしまう。
 *
 * これを構造で防ぐため、収集開始(collecting)以降はフォームをロックする。ロックを解くには
 * periodBatchReducer の「期間バッチリセット」アクションでidleへ戻す(=表示と実行対象が
 * 必ず一致する状態からしか再編集できない)。
 */

import type { PeriodBatchPhase } from "./batch-analysis-reducer.js";

/**
 * 指定フェーズでフォーム(from/to/取得対象)をロックすべきか判定する。
 * idle のみ false(編集可能)。collecting/collected/running/done はすべて true(ロック)。
 */
export function isPeriodFormLocked(phase: PeriodBatchPhase): boolean {
  return phase !== "idle";
}
