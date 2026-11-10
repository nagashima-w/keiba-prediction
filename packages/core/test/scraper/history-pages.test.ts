import { describe, expect, it } from "vitest";
import {
  historyCalendarUrl,
  historyListUrl,
  parseCalendarKaisaiDates,
  parseJpnListRaceIds,
  parseListRaceIds,
  validateHistoryPage,
} from "../../src/scraper/history-pages.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #554(#549-A3-1): 過去の結果の取得(開発用スクリプトと、本番の Cloudflare の取得)が共有するページ判定。
 * 実サイトには出ない。実物のフィクスチャ(2021-11 のカレンダー・一覧・結果)で固定する。
 */

describe("historyCalendarUrl / historyListUrl", () => {
  it("中央のカレンダーは race.netkeiba.com の年・月つき、地方は nar.netkeiba.com", () => {
    expect(historyCalendarUrl("central", "2021-11")).toBe("https://race.netkeiba.com/top/calendar.html?year=2021&month=11");
    expect(historyCalendarUrl("nar", "2021-01")).toBe("https://nar.netkeiba.com/top/calendar.html?year=2021&month=1");
  });
  it("一覧は開催日(YYYYMMDD)つきのサブ HTML", () => {
    expect(historyListUrl("central", "20211107")).toBe("https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20211107");
    expect(historyListUrl("nar", "20211103")).toBe("https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20211103");
  });
});

describe("parseCalendarKaisaiDates", () => {
  it("2021-11 の中央のカレンダーから、その月の開催日 8 日を昇順・重複なしで返す", () => {
    const dates = parseCalendarKaisaiDates(loadFixture("history_central_calendar_2021_11.html"), "2021-11");
    expect(dates).toEqual(["20211106", "20211107", "20211113", "20211114", "20211120", "20211121", "20211127", "20211128"]);
  });
  it("別の月の日付は除く(前提: 別の月を指定すると 0 件になる入力である)", () => {
    const html = loadFixture("history_central_calendar_2021_11.html");
    expect(parseCalendarKaisaiDates(html, "2021-11").length).toBeGreaterThan(0);
    expect(parseCalendarKaisaiDates(html, "2021-10")).toEqual([]);
  });
  it("表の無いページは空配列", () => {
    expect(parseCalendarKaisaiDates("<html></html>", "2021-11")).toEqual([]);
  });
});

describe("parseListRaceIds", () => {
  it("2021-11-07 の中央の一覧から、中央の race_id だけを文書の順に重複なしで返す", () => {
    const ids = parseListRaceIds(loadFixture("history_central_list_20211107.html"), "central");
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^\d{12}$/);
      expect(Number(id.slice(4, 6))).toBeGreaterThanOrEqual(1);
      expect(Number(id.slice(4, 6))).toBeLessThanOrEqual(10);
    }
  });
  it("地方の race_id は、中央を指定したときには含まれない", () => {
    const html = `<div class="RaceList_Body"><li class="RaceList_DataItem"><a href="../race/result.html?race_id=202144110101">x</a></li><li class="RaceList_DataItem"><a href="../race/result.html?race_id=202105040811">x</a></li></div>`;
    expect(parseListRaceIds(html, "central")).toEqual(["202105040811"]);
    expect(parseListRaceIds(html, "nar")).toEqual(["202144110101"]);
  });
});

describe("validateHistoryPage(保存前の検査。問題があれば理由、無ければ null)", () => {
  it("実物の中央の結果ページ・一覧・カレンダーは通る", () => {
    expect(validateHistoryPage("central", "result", loadFixture("history_central_result_202105040811.html"))).toBeNull();
    expect(validateHistoryPage("central", "list", loadFixture("history_central_list_20211107.html"))).toBeNull();
    expect(validateHistoryPage("central", "calendar", loadFixture("history_central_calendar_2021_11.html"))).toBeNull();
  });
  it.each([
    ["0 バイト", "central", "result", "   ", "0 バイト"],
    ["文字化け", "central", "result", "<html>�</html>", "文字化け"],
    ["カレンダーの表なし", "central", "calendar", "<html>x</html>", "Calendar_Table"],
    ["一覧のコンテナなし", "central", "list", "<html>x</html>", "RaceList_Body"],
    ["中央の一覧が 0 件", "central", "list", `<div class="RaceList_Body"></div>`, "0 件"],
    ["結果の表に行なし", "central", "result", `<html><table id="All_Result_Table"><tbody></tbody></table></html>`, "行がありません"],
  ] as const)("%s は理由つきで弾く", (_name, kind, stage, text, expected) => {
    expect(validateHistoryPage(kind, stage, text)).toContain(expected);
  });
  it("地方の一覧は 0 件でも通る(開催のない日)", () => {
    expect(validateHistoryPage("nar", "list", `<div class="RaceList_Body"></div>`)).toBeNull();
  });
  it("頭数と行数が合わない結果・頭数が読めない結果は弾く", () => {
    const table = `<table id="All_Result_Table"><tbody><tr><td>1</td></tr></tbody></table>`;
    expect(validateHistoryPage("central", "result", `<div class="RaceData02"><span>15頭</span></div>${table}`)).toMatch(/頭数 15.*行 1/);
    expect(validateHistoryPage("central", "result", table)).toContain("頭数が読めません");
    expect(validateHistoryPage("central", "result", `<div class="RaceData02"><span>1頭</span></div>${table}`)).toBeNull();
  });
});

describe("parseJpnListRaceIds(地方の一覧から交流重賞〈Jpn〉の race_id だけ。Issue #635)", () => {
  const nar = loadFixture("history_nar_list_20211103.html");
  it("2021-11-03 の地方の一覧(40 件)から Jpn の 4 件だけを文書の順に返す(Jpn3 の門別 1 件と JBC の Jpn1 3 件)", () => {
    expect(parseListRaceIds(nar, "nar")).toHaveLength(40);
    expect(parseJpnListRaceIds(nar)).toEqual(["202130110305", "202146110308", "202146110309", "202146110310"]);
  });
  it("ローマ数字の表記(JpnⅠ)も Jpn として拾う", () => {
    const roman = nar.replaceAll(">Jpn1<", ">JpnⅠ<").replaceAll(">Jpn3<", ">JpnⅢ<");
    expect(roman).not.toBe(nar);
    expect(parseJpnListRaceIds(roman)).toHaveLength(4);
  });
  it("Jpn の表記を 1 つも含まない一覧(Jpn が 0 件の日)は空配列", () => {
    const none = nar.replaceAll(">Jpn1<", ">重賞<").replaceAll(">Jpn3<", ">重賞<");
    expect(none).not.toBe(nar);
    expect(parseJpnListRaceIds(none)).toEqual([]);
  });
  it("レース一覧の入れ物が無いページは空配列(例外にしない)", () => {
    expect(parseJpnListRaceIds("<html></html>")).toEqual([]);
  });
});
