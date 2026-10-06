/**
 * 発走時刻(出馬表の `startTime`。JST の HH:MM)から、発走前の分析の時刻(UTC のエポックミリ秒)を求める(Issue #178〈#164-c〉AC-c4)。
 * Worker・DO は UTC で動くので、JST(UTC+9。夏時間なし)から UTC に換算する。**JST 0:00〜8:59 は UTC の前日**になる(日付・月・年をまたぐ)。
 * アラームの予約に使うのは #166(定時の自動実行)。ここは換算の関数だけ。
 */

/** JST は UTC+9(夏時間なし)。 */
const JST_OFFSET_MS = 9 * 3600_000;

/** 発走の何分前に分析するか(既定。ユーザー判断 2026-10-06。設定で変えられるようにするのは #166)。 */
export const DEFAULT_PRE_RACE_OFFSET_MINUTES = 30;

/**
 * 開催日(YYYYMMDD。JST の暦日)と発走時刻(JST の HH:MM)から、発走の瞬間(UTC のエポックミリ秒)を求める。
 * @throws RangeError 開催日・発走時刻の形が違う、または存在しない日
 */
export function startTimeEpochMs(kaisaiDate: string, startTime: string): number {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(kaisaiDate);
  const t = /^(\d{2}):(\d{2})$/.exec(startTime);
  if (d === null) {
    throw new RangeError(`開催日は YYYYMMDD の8桁で指定してください(渡された値: ${kaisaiDate.slice(0, 32)})`);
  }
  if (t === null || Number(t[1]) > 23 || Number(t[2]) > 59) {
    throw new RangeError(`発走時刻は 00:00〜23:59 の HH:MM で指定してください(渡された値: ${startTime.slice(0, 32)})`);
  }
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  // JST の暦日・時刻を、UTC として組み立ててから 9 時間引く(日付をまたぐ換算は Date.UTC が正規化する)。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`存在しない開催日です(${kaisaiDate})`);
  }
  return Date.UTC(year, month - 1, day, Number(t[1]), Number(t[2])) - JST_OFFSET_MS;
}

/** 発走の `offsetMinutes` 分前(UTC のエポックミリ秒)。0 以上の整数。 */
export function preRaceAlarmAt(kaisaiDate: string, startTime: string, offsetMinutes: number = DEFAULT_PRE_RACE_OFFSET_MINUTES): number {
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) {
    throw new RangeError(`分前は 0 以上の整数で指定してください(渡された値: ${String(offsetMinutes)})`);
  }
  return startTimeEpochMs(kaisaiDate, startTime) - offsetMinutes * 60_000;
}
