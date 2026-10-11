/**
 * 共有秘密の照合(Issue #159〈#21-A〉)。
 *
 * スパイクの Worker は公開 URL になるため、実行ごとにランダムな共有秘密を `x-spike-secret` ヘッダで
 * 要求し、一致しなければ何もせず 403 を返す。
 */

/**
 * ヘッダ値 `provided` が、Worker の secret `expected` と一致するかを定数時間で比較する。
 *
 * - **期待値が未設定・空のときは、何を送っても false**(secret の設定漏れで「空 == 空」が通り、
 *   公開エンドポイントが無認可で開いてしまう事故を防ぐ)
 * - 長さの違いも、比較時間から漏れないよう長い方に合わせて全バイトを走査する
 */
export function isAuthorized(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (expected === undefined || expected === null || expected === "") {
    return false;
  }
  if (provided === undefined || provided === null) {
    return false;
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
