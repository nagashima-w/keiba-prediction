/**
 * 過去の結果の取得(カレンダー → 開催日の一覧 → 結果ページ)が共有するページの URL とページ判定。
 * Issue #554(#549-A3-1)で `scripts/history-results/fetch-lib.ts` から core へ移した
 * (開発用スクリプトと、本番の Cloudflare の取得〈cloud/src/race-archive-fetch-core.ts〉の両方が使う)。
 * ネットワークには出ない純関数だけ(cheerio で読む)。取得そのもの・保存・間隔は呼び出し側。
 */

import * as cheerio from "cheerio";
import { parseKaisaiDate, parseRaceId, venueKindOfRaceId, type RaceIdVenueKind } from "./ids.js";
import { parseRaceFieldSize } from "./parse-race-result.js";
import { filterJpnOnlyEntries } from "./jpn-grade.js";
import { parseRaceList } from "./parse-race-list.js";
import { PATTERNS, RACE_LIST_SELECTORS } from "./selectors.js";
import { narRaceListSubUrl, raceListSubUrl } from "./urls.js";

/** 中央か地方か。 */
export type HistoryKind = RaceIdVenueKind;

/** 取得の段階。 */
export type HistoryStage = "calendar" | "list" | "result";

/** 中央・地方のホスト(urls.ts のビルダから導く。ホストの定数を二重に持たない)。 */
function originOf(kind: HistoryKind): string {
  const probe = parseKaisaiDate("20200101");
  return new URL(kind === "nar" ? narRaceListSubUrl(probe) : raceListSubUrl(probe)).origin;
}

/** 月のカレンダーの URL。`month` は `YYYY-MM`(月はゼロ埋めしない形で渡される)。 */
export function historyCalendarUrl(kind: HistoryKind, month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${originOf(kind)}/top/calendar.html?year=${y}&month=${m}`;
}

/** 開催日(`YYYYMMDD`)の一覧(サブ HTML)の URL。 */
export function historyListUrl(kind: HistoryKind, kaisaiDate: string): string {
  const d = parseKaisaiDate(kaisaiDate);
  return kind === "nar" ? narRaceListSubUrl(d) : raceListSubUrl(d);
}

/** カレンダーのページから、その月(`YYYY-MM`)の開催日(`YYYYMMDD`)を昇順・重複なしで返す。表が無ければ空。 */
export function parseCalendarKaisaiDates(html: string, month: string): string[] {
  const prefix = month.replace("-", "");
  const $ = cheerio.load(html);
  return [
    ...new Set(
      $(".Calendar_Table a[href*='kaisai_date=']")
        .map((_, a) => /kaisai_date=(\d{8})/.exec($(a).attr("href") ?? "")?.[1])
        .get()
        .filter((d): d is string => d !== undefined && d.startsWith(prefix)),
    ),
  ].sort();
}

/** race_id が、その種別(中央 = 場コード 01〜10、地方 = 30〜64。ばんえい 65 は含まない)のものか。 */
function isIdOfKind(kind: HistoryKind, raceId: string): boolean {
  try {
    return venueKindOfRaceId(parseRaceId(raceId)) === kind;
  } catch {
    return false;
  }
}

/** 一覧の項目のリンクから、その種別の race_id を文書の順に重複なしで取る。 */
export function parseListRaceIds(html: string, kind: HistoryKind): string[] {
  const $ = cheerio.load(html);
  return [
    ...new Set(
      $(RACE_LIST_SELECTORS.item)
        .map((_, li) => PATTERNS.raceIdFromHref.exec($(li).find(RACE_LIST_SELECTORS.itemLink).first().attr("href") ?? "")?.[1])
        .get()
        .filter((id): id is string => id !== undefined && /^\d{12}$/.test(id) && isIdOfKind(kind, id)),
    ),
  ];
}

/**
 * 地方の一覧から、**交流重賞(Jpn1・Jpn2・Jpn3。ローマ数字の表記も)のレースだけ**の race_id を文書の順に重複なしで返す(Issue #635)。
 * 地方の過去の結果は交流重賞に限って取るので、一覧の 1 日 40 件前後のうち Jpn だけを結果ページの取得の対象にする。
 * Jpn の判定は `parseRaceList` → `filterJpnOnlyEntries`(`isJpnGrade`)に任せ、地方の race_id だけを通す。入れ物が無いページ・Jpn が 0 件のページは空配列。
 */
export function parseJpnListRaceIds(html: string): string[] {
  return [...new Set(filterJpnOnlyEntries(parseRaceList(html)).map((e) => String(e.raceId)).filter((id) => isIdOfKind("nar", id)))];
}

/**
 * 保存前の検査。問題があれば理由、無ければ null。
 * 結果は、頭数(`.RaceData02` の N頭)と結果の表の行数が合うものだけ通す(合わない・頭数が読めないものは途中の結果とみなす)。
 * 中央の一覧に race_id が 0 件のものは異常(中央のカレンダーには開催日しか載らない)。地方の 0 件は通す(開催のない日)。
 */
export function validateHistoryPage(kind: HistoryKind, stage: HistoryStage, text: string): string | null {
  if (text.trim() === "") {
    return "0 バイト(または空白のみ)の応答";
  }
  if (text.includes("�")) {
    return "文字化け(U+FFFD を含む)";
  }
  if (stage === "calendar" && !text.includes("Calendar_Table")) {
    return "カレンダーの表(Calendar_Table)がありません";
  }
  if (stage === "list") {
    if (!text.includes("RaceList_Body")) {
      return "レース一覧のコンテナ(RaceList_Body)がありません";
    }
    if (kind === "central" && parseListRaceIds(text, kind).length === 0) {
      return "中央の一覧に race_id が 0 件です(カレンダーには開催日しか載らないので異常)";
    }
  }
  if (stage === "result") {
    const rows = cheerio.load(text)("#All_Result_Table tbody > tr").length;
    if (rows === 0) {
      return "結果の表(#All_Result_Table)に行がありません";
    }
    const size = parseRaceFieldSize(text);
    if (size === null) {
      return "頭数が読めません(.RaceData02 に N頭 の span がありません)。途中の結果か、構造が変わった可能性があります";
    }
    if (size !== rows) {
      return `頭数 ${size} と結果の行 ${rows} が合いません(途中の結果の可能性)`;
    }
  }
  return null;
}
