/**
 * スマホ画面の日付の純関数(Issue #184)。開催日は JST の YYYYMMDD。`<input type="date">` の値は YYYY-MM-DD。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の今日(YYYYMMDD)。UTC に 9 時間を足した暦日(UTC の 15:00 以降は JST の翌日)。 */
export function todayJst(now: Date): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const y = String(jst.getUTCFullYear()).padStart(4, "0");
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** YYYYMMDD の 8 桁で、実在する日付か(サーバの `parseKaisaiDate` と同じ判定。うるう年を含む)。 */
export function isRealYmd(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** YYYYMMDD → YYYY-MM-DD(`<input type="date">` の値)。 */
export function ymdToInput(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** `<input type="date">` の値(YYYY-MM-DD)→ YYYYMMDD。形が違う・実在しない日付・空は null。 */
export function inputToYmd(value: string): string | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (m === null) {
    return null;
  }
  const ymd = `${m[1]}${m[2]}${m[3]}`;
  return isRealYmd(ymd) ? ymd : null;
}
