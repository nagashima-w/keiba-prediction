/**
 * 残ったアラームの判定(Durable Object の `kick` が共通で使う)。
 *
 * DO のアラームは、ハンドラが例外で終わったあと Cloudflare が数分のうちに再試行する。
 * それでも `getAlarm()` が今より十分前の時刻を返し続けるなら、そのアラームはもう動かない
 * (2026-11-04 3:48 JST、DO の SQLite の 1 日の読み取りの上限に当たって以降、取得の DO が動かなくなった)。
 * そのため `kick` は、これを「アラームが無い」のと同じに扱って張り直す。
 */

/** 再試行が済んだとみなす余裕。Cloudflare の再試行(数分)より十分長くとる。 */
export const STALE_ALARM_MARGIN_MS = 15 * 60_000;

/** `getAlarm()` の値が「残ったアラーム」(今より 15 分以上前)か。ちょうど 15 分前も残ったとみなす。 */
export function isStaleAlarm(alarm: number, now: number): boolean {
  return alarm <= now - STALE_ALARM_MARGIN_MS;
}

/**
 * `kick` が張り直してよいか。アラームが無い、または残ったアラームなら true。
 * 残ったアラームだったときは `onStale` に時刻(ISO)を渡す(ログ用)。
 */
export function shouldRearm(alarm: number | null, now: number, onStale: (iso: string) => void): boolean {
  if (alarm === null) return true;
  if (!isStaleAlarm(alarm, now)) return false;
  onStale(new Date(alarm).toISOString());
  return true;
}
