/**
 * R2 の操作回数の安全柵(Issue #173・#169-c)。**純関数だけ**で、D1・R2・時計に触れない(回数は呼び出し側が D1 の `r2_ops` から読んで渡す)。
 *
 * ユーザーの条件(2026-10-06): バケットへの操作が増えても、**無料枠に確実に収める**。R2 の Free 枠(毎月)は Class A(PUT・LIST など)が 100 万回、
 * Class B(GET・HEAD など)が 1,000 万回(2026-10-06 に公式ドキュメントから確認した値)。柵は無料枠の {@link FENCE_PERCENT}%。
 * - **Class A(書き込み)の柵を超えたら**: R2 に書かず、D1 に要約だけを保存する(`detail: "skipped"`)
 * - **Class B(読み出し)の柵を超えたら**: 詳細の読み出しだけを拒否する(要約は出す)
 * 通常の見込みは PUT が月 300 回前後で、柵(10 万回)の約 300 分の 1。実際の使用量の約 100 倍以上の余裕がある。
 *
 * 回数の数え方は `analysis-repository.ts`(保存と同じ batch で Class A を +1。読み出しは best-effort で Class B を +1)。
 */

/** R2 の Free 枠(月)。 */
export const R2_FREE_TIER = { classA: 1_000_000, classB: 10_000_000 } as const;

/** 柵は無料枠の何 % か。 */
export const FENCE_PERCENT = 10;

/** 柵の上限(月)。**この回数に達したら止める**(上限 −1 まではまだ使う)。Class A は書き込み、Class B は読み出し。 */
export const R2_FENCE_LIMITS = {
  classA: (R2_FREE_TIER.classA * FENCE_PERCENT) / 100,
  classB: (R2_FREE_TIER.classB * FENCE_PERCENT) / 100,
} as const;

/** 今月の操作回数(D1 の `r2_ops` の1行)。 */
export interface R2Usage {
  readonly classA: number;
  readonly classB: number;
}

export interface FenceStatus {
  /** R2 への書き込み(PUT。Class A)を続けてよいか。 */
  readonly writeAllowed: boolean;
  /** R2 からの読み出し(GET。Class B)を続けてよいか。 */
  readonly readAllowed: boolean;
}

/** 書き込みを続けてよいか(Class A が上限に達していない)。Class B は見ない。 */
export function isWriteAllowed(usage: R2Usage): boolean {
  return usage.classA < R2_FENCE_LIMITS.classA;
}

/** 読み出しを続けてよいか(Class B が上限に達していない)。Class A は見ない。 */
export function isReadAllowed(usage: R2Usage): boolean {
  return usage.classB < R2_FENCE_LIMITS.classB;
}

export function fenceStatus(usage: R2Usage): FenceStatus {
  return { writeAllowed: isWriteAllowed(usage), readAllowed: isReadAllowed(usage) };
}

/** 月の区切り: **UTC** の yyyymm(例: 2026-10-31T23:59:59Z → 202610、2026-11-01T00:00:00Z → 202611)。端末のタイムゾーンによらない。 */
export function monthKey(date: Date): number {
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
}
