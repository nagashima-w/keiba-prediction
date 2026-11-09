/**
 * JRA の過去の結果への道筋(`accessS.html`。Issue #698。根拠は `docs/investigations/past-blinker-695.md` §2)で、次の頁の cname を頁から拾う(純関数)。
 *
 *  1. 過去検索の頁 {@link PAST_SEARCH_CNAME}(固定)→ `objParam["2101"]="0F"` の表(年の下 2 桁 + 月 → 月の頁の cname の末尾の 2 桁)
 *  2. 月の頁 `pw01skl10YYYYMM/<2桁>`(2026-11 以降は `pw01skl00`。{@link monthCname})→ その月の場日 `pw01srl10<場2><年4><回2><日2><開催日8>/<2桁>`
 *  3. 場日の頁 → その場日の 12 レースの結果 `pw01sde10<場2><年4><回2><日2><R2><開催日8>/<2桁>`
 *
 * 場日の頁には別の場のリンクも入る(中山の頁に中京の場日)ので、拾うのは**渡された場日の接頭辞に合うものだけ**にする。
 * 今月(2026-11)の月の頁は、`pw01skl00202611/91` を POST すると過去検索の頁がそのまま返る(2026-11-09 に確かめた。`docs/investigations/past-blinker-695.md` §11)。場日が 0 件なら no-days で、呼び出し側が飛ばす。
 */
import * as cheerio from "cheerio";

import { raceIdFromResultCname } from "./jra-result-parse";

export const PAST_SEARCH_CNAME = "pw01skl00999999/B3";

/** 月の頁の cname の先頭が `skl00` に変わる月(過去検索の頁の JS の `yearMonth = "202611"`)。 */
const SKL00_FROM_YYYYMM = "202611";

export function monthCname(yyyymm: string, code: string): string {
  return `${yyyymm >= SKL00_FROM_YYYYMM ? "pw01skl00" : "pw01skl10"}${yyyymm}/${code}`;
}

export type LinkFailure = "param-error" | "unparsable";

/** 過去検索の頁の表(キーは年の下 2 桁 + 月 2 桁。値は 16 進 2 桁)。 */
export function parseParamTable(html: string): { readonly ok: true; readonly table: ReadonlyMap<string, string> } | { readonly ok: false; readonly reason: LinkFailure } {
  const title = cheerio.load(html)("title").first().text().trim();
  if (title.startsWith("パラメータエラー")) return { ok: false, reason: "param-error" };
  const table = new Map<string, string>();
  for (const m of html.matchAll(/objParam\["(\d{4})"\]\s*=\s*"([0-9A-F]{2})"/g)) table.set(m[1]!, m[2]!);
  return table.size === 0 ? { ok: false, reason: "unparsable" } : { ok: true, table };
}

const DAY_CNAME = /pw01srl10(\d{2})(\d{4})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}/g;

export interface MonthDay {
  readonly cname: string;
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
}

/** 月の頁から、その月(YYYYMM)の場日を、開催日・cname の昇順で返す。 */
export function parseMonthDays(html: string, yyyymm: string): { readonly ok: true; readonly days: readonly MonthDay[] } | { readonly ok: false; readonly reason: "param-error" | "no-days" } {
  const title = cheerio.load(html)("title").first().text().trim();
  if (title.startsWith("パラメータエラー")) return { ok: false, reason: "param-error" };
  const seen = new Map<string, MonthDay>();
  for (const m of html.matchAll(DAY_CNAME)) {
    const date = m[5]!;
    if (!date.startsWith(yyyymm)) continue;
    seen.set(m[0], { cname: m[0], date });
  }
  const days = [...seen.values()].sort((a, b) => (a.date + a.cname < b.date + b.cname ? -1 : 1));
  return days.length === 0 ? { ok: false, reason: "no-days" } : { ok: true, days };
}

export interface DayRace {
  readonly cname: string;
  readonly raceId: string;
}

/** 場日の頁から、その場日(`dayCname`)の結果の cname を、R の昇順で返す(別の場・別の日のものは拾わない)。 */
export function parseDayRaces(html: string, dayCname: string): { readonly ok: true; readonly races: readonly DayRace[] } | { readonly ok: false; readonly reason: "param-error" | "no-races" } {
  const title = cheerio.load(html)("title").first().text().trim();
  if (title.startsWith("パラメータエラー")) return { ok: false, reason: "param-error" };
  const day = /^pw01srl10(\d{2})(\d{4})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}$/.exec(dayCname);
  if (day === null) return { ok: false, reason: "no-races" };
  const [, venue, year, kai, dayNo] = day;
  const prefix = `pw01sde10${venue}${year}${kai}${dayNo}`;
  const seen = new Map<string, DayRace>();
  for (const m of html.matchAll(/pw01sde10\d{20}\/[0-9A-F]{2}/g)) {
    const cname = m[0];
    const id = raceIdFromResultCname(cname);
    if (id === null || !cname.startsWith(prefix)) continue;
    seen.set(cname, { cname, raceId: id.raceId });
  }
  const races = [...seen.values()].sort((a, b) => (a.raceId < b.raceId ? -1 : 1));
  return races.length === 0 ? { ok: false, reason: "no-races" } : { ok: true, races };
}
