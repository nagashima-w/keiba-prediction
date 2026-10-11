/**
 * 見込みの的中数の表示(Issue #264)。**依存を持たない純モジュール**: Worker(Discord の日報)と、ブラウザのクライアント(日報の画面)の両方が import する(`recovery-format.ts` と同じ位置づけ)。
 *
 * 「見込み」は、判定できた買い目それぞれの分析時点の的中確率の合計。「実際」は、見込みと同じ買い目(確率を導けたもの)の中の的中数(分母をそろえる。`DayStats.expectedBaseHits`)。
 * 確率を導ける買い目が 1 点も無いときは null(見込みを捏造しない)。
 */
export function formatExpectedHits(s: { readonly expectedBetCount: number; readonly expectedHits: number; readonly expectedBaseHits: number }): string | null {
  return s.expectedBetCount === 0 ? null : `見込み ${s.expectedHits.toFixed(2)} 点・実際 ${s.expectedBaseHits} 点`;
}
