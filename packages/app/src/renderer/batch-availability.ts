/**
 * 単日一括分析と期間バッチの相互排他予測子(純関数、タスクC2)。
 *
 * 単日一括分析(batchAnalysisReducer)と期間バッチ(periodBatchReducer)は完全に独立した
 * reducerである(タスクC1・C2とも「reducerは統合しない」方針)。しかし両者は
 * main側の実行フェーズ(runBatchAnalysis・analysis:batch-progress・cancelBatchAnalysis)を
 * 共有しているため、同時に両方を起動すると進捗・中断が混線してしまう。
 * この予測子は reducer 自体を変更せず、Appが両トリガーのdisabled propへ渡すための
 * 判定だけを導出するビュー層の純関数。
 */

import type { PeriodBatchPhase } from "./batch-analysis-reducer.js";

/** 相互排他の判定結果。 */
export interface BatchAvailability {
  /** 単日一括分析のトリガー(取得・選択変更・実行ボタン等)を無効化すべきか。 */
  readonly singleDayDisabled: boolean;
  /** 期間バッチのトリガー(収集・確定・実行ボタン等)を無効化すべきか。 */
  readonly periodDisabled: boolean;
}

/**
 * 単日一括分析の実行状態(running)と期間バッチのフェーズ(periodPhase)から、
 * 互いの操作を無効化すべきかを導出する。
 *
 * ルール:
 * - 単日一括分析が実行中(running=true)なら、期間バッチ側を無効化する
 *   (共有チャネルの進捗・中断が単日側のものと混線しないように)。
 * - 期間バッチが「収集中(collecting)」または「実行中(running)」の間は、
 *   単日一括分析側を無効化する(同じ理由)。collected(確定待ち)・done(完了)・idle は
 *   実IOが走っていない/走り終えたフェーズのため無効化しない。
 */
export function deriveBatchAvailability(
  singleDayRunning: boolean,
  periodPhase: PeriodBatchPhase,
): BatchAvailability {
  const periodBusy = periodPhase === "collecting" || periodPhase === "running";
  return {
    singleDayDisabled: periodBusy,
    periodDisabled: singleDayRunning,
  };
}
