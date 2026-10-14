/**
 * 見込みの的中数の表示(Issue #264)。**依存を持たない純モジュール**: Worker(Discord の日報)と、ブラウザのクライアント(日報の画面)の両方が import する(`recovery-format.ts` と同じ位置づけ)。
 *
 * 「見込み」は、判定できた買い目それぞれの分析時点の的中確率の合計。「実際」は、見込みと同じ買い目(確率を導けたもの)の中の的中数(分母をそろえる。`DayStats.expectedBaseHits`)。
 * 確率を導ける買い目が 1 点も無いときは null(見込みを捏造しない)。
 *
 * **項目が欠けた入力でも投げない**: デプロイをまたいで動くジョブは、旧コードが永続化した record(この項目を持つ前の `DayStats`)を新コードの通知が読む。
 * 型の上では必須でも、実行時には undefined のことがある。3 項目がそろって有限の数でなければ(欠けている・null・NaN・Infinity・数でない)、null を返して見込みの部分を出さない。
 */
export function formatExpectedHits(s: { readonly expectedBetCount?: unknown; readonly expectedHits?: unknown; readonly expectedBaseHits?: unknown }): string | null {
  const { expectedBetCount: count, expectedHits: hits, expectedBaseHits: base } = s;
  if (typeof count !== "number" || typeof hits !== "number" || typeof base !== "number" || !Number.isFinite(count) || !Number.isFinite(hits) || !Number.isFinite(base)) {
    return null;
  }
  return count === 0 ? null : `見込み ${hits.toFixed(2)} 点・実際 ${base} 点`;
}
