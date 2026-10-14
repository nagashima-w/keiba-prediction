/**
 * 「その日が静かになった」の判定(Issue #235。日報を作ってよい時点)。**純関数**: DO・SQL・時計を持たない。
 *
 * **時刻・曜日を一切見ない。**(日報の時刻の下限だけは、外で計算した真偽値を入力に足して受け取る。この関数は時計を持たない。) 夏の昼休み開催(最終レースが 19 時ごろ)、平日・祝日の開催、地方の交流重賞(20:50 ごろ)でも、その日の計画と状態だけで決まる:
 *  - 計画が確定している(会場の一覧の取得・確定の途中でない)
 *  - 期限を待つ計画中(`planned`)の行が無い(まだ発走前の分析が行われていないレースが残っていない。例: 中央の結果が揃っても、20:50 発走の地方の重賞が `planned` のあいだは静かでない)
 *  - 発走前のタスク(`queued`・`fetched`)が無い
 *  - 結果の取り込みの行があり、待ち(`queued`)が無い(全部が取り込み済みか、取り込みの上限〈当日は発走+60 分まで 10 回〉に達して諦めた〈`gave_up`〉)
 *  - 日報の時刻の下限(Issue #291)を過ぎている(手動で分析したレースの開催の最終レースの発走時刻。無ければ過ぎているのと同じ)。**この純関数は時刻を見ない**: 時計から計算した真偽値を {@link DayQuietInput.afterReportHold} で受け取る
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
  /**
   * 日報の時刻の下限(Issue #291)を過ぎている、または下限が無い(外で `now >= 下限` を計算して渡す。この関数は時刻を見ない)。
   * false のあいだは静かでない: 手動の分析だけの日に、先に分析したレースの結果がそろっただけで日報が作られ、あとから分析するレースが抜けるのを防ぐ。
   */
  readonly afterReportHold: boolean;
}

export function isDayQuiet(input: DayQuietInput): boolean {
  return (
    input.planFinalized && input.plannedRows === 0 && input.pendingTasks === 0 && input.resultRows > 0 && input.queuedResults === 0 && input.afterReportHold
  );
}
