/**
 * 月報(Issue #265・#279)の依頼の計画。cron の実行(`scheduled.ts`)が、**どの月の月報を依頼するか**を決める**純関数**(時計・D1 を持たない)。
 *
 *  - 最終日(今日が月の最終日)なら、当月を `auto` で依頼する(21:00・23:00 のどちらの実行でも)。開始は同日 22:00 JST(`startAt`。ユーザーの決定: 毎月最終日の 22 時ごろ)。
 *    21:00 の実行が出す依頼で 22:00 に始まり、23:00 の実行の依頼は保険(21:00 の依頼が落ちていたとき。22:00 は過ぎているので、コアが今すぐ始める。受理済みなら `in-progress`)。
 *  - 月が明けて {@link MONTHLY_CATCHUP_DAYS} 日以内の 23:00 の実行(retry)は、前月を `catchup` で依頼する(取り残しの補完。日報の補完と同じ上限)。作成済みならコアが `exists` で断る。
 * **新しい cron は足さない**(21:00 は `first`、23:00 は `retry`。`scheduledRunKind` の区分をそのまま使う)。
 */
import { jstMsOf, isLastDayOfMonth, monthOfYmd, previousMonth } from "./monthly-month";
import { MONTHLY_MAX_AGE_DAYS } from "./monthly-report-core";
import type { ScheduledRunKind } from "./auto-run-plan";

/** 月報を作り始める時刻(最終日の JST の時)。 */
export const MONTHLY_START_JST_HOUR = 22;
/** 月が明けてから、前月の取り残しを補完する日数(1 日〜この日まで)。コアの `too-old` の上限と同じ値。 */
export const MONTHLY_CATCHUP_DAYS = MONTHLY_MAX_AGE_DAYS;

export interface MonthlyRequest {
  readonly month: string;
  readonly mode: "auto" | "catchup";
  /** 開始の時刻(エポックミリ秒)。`auto` だけ。 */
  readonly startAt?: number;
}

/** @param today cron の JST の今日(YYYYMMDD) */
export function monthlyRequestsFor(today: string, kind: ScheduledRunKind): MonthlyRequest[] {
  const out: MonthlyRequest[] = [];
  if (isLastDayOfMonth(today)) {
    out.push({ month: monthOfYmd(today), mode: "auto", startAt: jstMsOf(today, MONTHLY_START_JST_HOUR) });
  }
  if (kind === "retry" && Number(today.slice(6, 8)) <= MONTHLY_CATCHUP_DAYS) {
    out.push({ month: previousMonth(monthOfYmd(today)), mode: "catchup" });
  }
  return out;
}
