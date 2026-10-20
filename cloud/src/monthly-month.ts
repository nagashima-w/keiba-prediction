/**
 * 月報(Issue #265・#279)の「月」(YYYYMM)の暦の計算。**純関数**(時計・D1 を持たない)。
 * 月の範囲は当月 1 日〜最終日(ユーザーの決定・2026-10-13)。暦日の足し引きは UTC の暦で行う(JST は夏時間が無いので同じ)。
 */
import { isRealYmd } from "../client/date";
import { jstEpochMs } from "../../packages/core/src/common/jst";
import { addDaysToKaisaiDate } from "./result-dispatch";

/** YYYYMM の 6 桁で、実在する月(01〜12)か。 */
export function isValidMonth(month: string): boolean {
  return /^[0-9]{6}$/.test(month) && isRealYmd(`${month}01`);
}

/** 開催日(YYYYMMDD)の月(YYYYMM)。 */
export function monthOfYmd(ymd: string): string {
  return ymd.slice(0, 6);
}

/** 月の翌月の 1 日(YYYYMMDD)。 */
function firstOfNextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  return `${m === 12 ? year + 1 : year}${String(m === 12 ? 1 : m + 1).padStart(2, "0")}01`;
}

/** 月の範囲 `[月初, 月末]`(両端を含む。開催日 YYYYMMDD)。 */
export function monthRange(month: string): { readonly fromDate: string; readonly toDate: string } {
  return { fromDate: `${month}01`, toDate: addDaysToKaisaiDate(firstOfNextMonth(month), -1) };
}

/** 前月(YYYYMM)。 */
export function previousMonth(month: string): string {
  return monthOfYmd(addDaysToKaisaiDate(`${month}01`, -1));
}

/** その日が月の最終日か。 */
export function isLastDayOfMonth(ymd: string): boolean {
  return monthRange(monthOfYmd(ymd)).toDate === ymd;
}

/** `202610` → `2026年10月`(プロンプト・Discord の見出し)。月の形でなければそのまま。 */
export function formatMonthLabel(month: string): string {
  return /^[0-9]{6}$/.test(month) ? `${Number(month.slice(0, 4))}年${Number(month.slice(4, 6))}月` : month;
}

/** JST の日付(YYYYMMDD)と時刻 → エポックミリ秒。 */
export function jstMsOf(ymd: string, hour: number, minute: number = 0): number {
  return jstEpochMs(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)), Number(ymd.slice(6, 8)), hour, minute);
}
