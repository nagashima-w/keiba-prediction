/**
 * JST(UTC+9。夏時間なし)の時刻計算の共通部品(Issue #397・R-5)。**import を持たない純モジュール**(クライアントの束にも入れてよい)。
 * 以前は `JST_OFFSET_*` が 11 か所に独立して定義され、`jstDay`(YYYY-MM-DD)・`nextJstMidnight` ほかが複製されていた。
 *
 * 暦日の文字列は 2 通りの形があり、**名前を分けてある**: ここの {@link jstIsoDate} は `YYYY-MM-DD`。`YYYYMMDD`(開催日の形)を返す関数は、
 * 範囲外の入力(NaN・年が 4 桁に収まらない)での挙動が実装ごとに違うので、統合していない(`horse-runs.ts` の `jstDay`・`baba-conditions.ts` の `jstDateOf`・`client/date.ts` の `todayJst`・`auto-run-plan.ts` の `jstKaisaiDate`)。
 */

/** JST は UTC+9(夏時間なし)。時で持つ。 */
export const JST_OFFSET_HOURS = 9;

/** JST は UTC+9(夏時間なし)。ミリ秒で持つ(32,400,000)。 */
export const JST_OFFSET_MS = JST_OFFSET_HOURS * 60 * 60 * 1000;

/** 1 日のミリ秒。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * JST の暦日時刻 → エポックミリ秒。`Date.UTC` で UTC として組み立ててから 9 時間引く(日付をまたぐ換算は `Date.UTC` が正規化する。`hour=24` で翌日 0:00 JST)。
 * 入力の検査はしない(呼び出し側が行う)。
 * @param month 1〜12
 */
export function jstEpochMs(year: number, month: number, day: number, hour: number = 0, minute: number = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
}

/** JST の暦日(`YYYY-MM-DD`)。 */
export function jstIsoDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 次の JST 0:00 の時刻(ms)。ちょうど JST 0:00 のときは、その次の日(入力より必ず大きい)。 */
export function nextJstMidnight(ms: number): number {
  return Date.parse(`${jstIsoDate(ms)}T00:00:00.000Z`) - JST_OFFSET_MS + DAY_MS;
}

/** JST の時(0〜23)。 */
export function jstHour(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCHours();
}

/** JST の `HH:mm`(ゼロ埋め)。 */
export function jstHm(ms: number): string {
  const jst = new Date(ms + JST_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}
