/**
 * 「その日が静かになった」の判定(Issue #235。日報を作ってよい時点)。**純関数**: DO・SQL・時計を持たない。
 *
 * **時刻・曜日を一切見ない。** 夏の昼休み開催(最終レースが 19 時ごろ)、平日・祝日の開催、地方の交流重賞(20:50 ごろ)でも、その日の計画と状態だけで決まる:
 *  - 計画が確定している(会場の一覧の取得・確定の途中でない)
 *  - 期限を待つ計画中(`planned`)の行が無い(まだ発走前の分析が行われていないレースが残っていない。例: 中央の結果が揃っても、20:50 発走の地方の重賞が `planned` のあいだは静かでない)
 *  - 発走前のタスク(`queued`・`fetched`)が無い
 *  - 結果の取り込みの行があり、待ち(`queued`)が無い(全部が取り込み済みか、取り込みの上限〈当日は発走+60 分まで 10 回〉に達して諦めた〈`gave_up`〉)
 * 打ち切り(結果が取れないレースが残って永久に揃わない場合)は、結果の取り込みの既存の上限が行う: 当日の行は最大 10 回(5 分おき)で諦めるので、`queued` は必ず有限の時間で無くなる。
 */
export interface DayQuietInput {
  /** 計画が確定済み(`PlanStore.finalizedAt() !== null`)。 */
  readonly planFinalized: boolean;
  /** 計画の表で、期限を待っている(`state = 'planned'`)行の数。 */
  readonly plannedRows: number;
  /** 発走前・朝のタスクのうち、未了(`queued`・`fetched`)の数。 */
  readonly pendingTasks: number;
  /** 結果の取り込みの行の数(状態を問わない)。 */
  readonly resultRows: number;
  /** 結果の取り込みの行のうち、待ち(`queued`)の数。 */
  readonly queuedResults: number;
}

export function isDayQuiet(input: DayQuietInput): boolean {
  return input.planFinalized && input.plannedRows === 0 && input.pendingTasks === 0 && input.resultRows > 0 && input.queuedResults === 0;
}
