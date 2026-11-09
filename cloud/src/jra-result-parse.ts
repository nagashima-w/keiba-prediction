/**
 * JRA の過去の結果の頁(`accessS.html` の `pw01sde10…`。Issue #698。親は #695)から、頭数とブリンカー着用の馬を読む(純関数)。根拠は `docs/investigations/past-blinker-695.md` §2〜§4。
 *
 * - 判定は `<title>`: `パラメータエラー` は誤りの頁(状態コード 200 のまま返る)。行(`td.place`)が 1 つも無い頁は読めない。
 * - 頭数は `td.place` の行の全部。着順が数字でない行(取消・除外。中止・失格・降着は未観測)も数える。着順の文字は読まない。
 * - ブリンカーの印は `td.horse` の中の `div.icon.blinker`(出馬表の `span.horse_icon.blinker` とは別の形。#639 のパーサは使えない)。取消・除外の馬に印が出るかは未観測だが、同じ規則で読む。
 * - 馬の ID は `td.horse` の馬名リンク `pw01dud10<10桁>/…`。**取れない行が 1 つでもあれば頁ごと読めない扱い(unparsable)**にする:
 *   「取り終えたレースにいて、印の表に行が無い = 着けていない」という保存の約束(`past-blinker-repository.ts`)を、黙って頭数だけ数えて崩さないため。
 * - race_id は結果の cname の `sde10` 以降から組む(年4・場2・回2・日2・R2。netkeiba の race_id と同じ。cname の中の並びは 場・年・回・日・R・開催日)。
 */
import * as cheerio from "cheerio";

export type ResultPageFailure = "param-error" | "unparsable";

export type ResultPageParse =
  | { readonly ok: true; readonly headCount: number; readonly blinkerHorseIds: readonly string[] }
  | { readonly ok: false; readonly reason: ResultPageFailure };

const HORSE_LINK = /pw01dud10(\d{10})\//;

export function parseResultPage(html: string): ResultPageParse {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  if (title.startsWith("パラメータエラー")) return { ok: false, reason: "param-error" };
  if (!title.startsWith("レース結果")) return { ok: false, reason: "unparsable" };

  const rows = $("td.place").toArray();
  if (rows.length === 0) return { ok: false, reason: "unparsable" };
  const blinkerHorseIds: string[] = [];
  for (const place of rows) {
    const horse = $(place).closest("tr").find("td.horse").first();
    const href = horse.find("a[href]").first().attr("href") ?? "";
    const id = HORSE_LINK.exec(href)?.[1];
    if (id === undefined) return { ok: false, reason: "unparsable" };
    if (horse.find("div.icon.blinker").length > 0) blinkerHorseIds.push(id);
  }
  return { ok: true, headCount: rows.length, blinkerHorseIds };
}

/** 結果の頁の cname(`pw01sde10<場2><年4><回2><日2><R2><開催日8>/<16進2桁>`)。 */
const RESULT_CNAME = /^pw01sde10(0[1-9]|10)(\d{4})(\d{2})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}$/;

/** 結果の cname から netkeiba の race_id(12 桁)と開催日(YYYYMMDD)を作る。結果の cname の形でなければ null。 */
export function raceIdFromResultCname(cname: string): { readonly raceId: string; readonly date: string } | null {
  const m = RESULT_CNAME.exec(cname);
  if (m === null) return null;
  const [, venue, year, kai, day, race, date] = m;
  return { raceId: `${year}${venue}${kai}${day}${race}`, date: date! };
}
