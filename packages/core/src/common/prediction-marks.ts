/**
 * 予想印の並びの共通部品(Issue #397・R-5)。**import を持たない純モジュール**(クライアントの束にも入れてよい。parse-response を引き込まずに印の並びを使える)。
 * 以前は、配列が parse-response・notify-embeds・client/result・client/api-verify・view/format(2 要素を足した版)に別々にあり、一致を各テストが固定していた。
 *
 * 統合していないもの: `daily-report-digest.ts` の `markRank`(null を最後尾に回し、`indexOf` が文字列なので `""` や部分文字列が先頭と同順位になる。範囲外の入力の挙動を変えないため)。
 */

/**
 * 予想印(Task#22: ユーザー要望)。
 * ◎本命/〇対抗/▲単穴/△連下/☆星/注注意。定義・頭数制約は build-prompt.ts のプロンプト指示を参照。
 * 「〇」は U+3007(○ U+25CB ではない)。
 */
export const PREDICTION_MARKS = ["◎", "〇", "▲", "△", "☆", "注"] as const;

/** 予想印の型({@link PREDICTION_MARKS} のいずれか)。 */
export type PredictionMark = (typeof PREDICTION_MARKS)[number];

/** 印の順位(既知の印は {@link PREDICTION_MARKS} の添字、未知の印はその後ろ = 印の数)。 */
export function markRank(mark: string): number {
  const i = (PREDICTION_MARKS as readonly string[]).indexOf(mark);
  return i === -1 ? PREDICTION_MARKS.length : i;
}
