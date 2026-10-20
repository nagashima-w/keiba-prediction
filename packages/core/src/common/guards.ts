/**
 * 型ガードの共通部品(Issue #397・R-5)。**import を持たない純モジュール**(クライアントの束にも入れてよい)。
 * 以前は `isRecord`(`isObject`・`isObj` の名前も含め 8 か所)・`isFiniteNumber`/`isNum`(6 か所)・`finiteOrNull`(2 か所)が、同じ式で別々に定義されていた。
 *
 * 統合していないもの(名前は似ていても中身が違う): `isCount`(`isInteger` と `isSafeInteger` で 2 通り)・`rateOrNull`・`numberOrNull`(範囲付き・`typeof` だけ・文字列を読むものがある)。
 */

/** 配列でないオブジェクト(`null` は除く)。`Date` など配列でない object は通る。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 有限の数(NaN・Infinity・数値でないものを弾く)。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 有限の数ならそのまま、そうでなければ null(JSON に NaN・Infinity・undefined を載せない)。 */
export function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}
