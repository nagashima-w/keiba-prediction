/**
 * parse-jra-odds-index(JRA のオッズの入口の頁〈開催選択・レース選択〉のパーサ。Issue #673 段階 A)のテスト。
 * フィクスチャは `fixtures/jra_odds_oli_20261108.html`(開催選択)・`fixtures/jra_odds_orl_tokyo_20261108.html`(東京のレース選択)。
 * 実サイトへのリクエストは含まない。
 */
import { describe, expect, it } from "vitest";
import {
  JRA_ODDS_PAGES,
  parseJraOddsCname,
  parseJraOddsRaceListPage,
  parseJraOddsVenueListPage,
} from "../../src/scraper/parse-jra-odds-index.js";
import { loadShiftJisFixture } from "../support/fixtures.js";

describe("parseJraOddsCname(オッズの頁の CNAME の分解)", () => {
  it("東京 8R の 3連単は race_id 202605050208(年 + 場 + 回 + 日 + R)・式別 sanrentan・開催日 20261108", () => {
    expect(parseJraOddsCname("pw158ouS305202605020820261108Z/45")).toEqual({
      page: "sanrentan",
      venueCode: "05",
      year: "2026",
      kai: "05",
      day: "02",
      race: "08",
      date: "20261108",
      raceId: "202605050208",
    });
  });

  it.each([
    ["pw151ouS305202605020820261108Z/A9", "tanpuku"],
    ["pw153ouS305202605020820261108Z/B1", "wakuren"],
    ["pw154ouS305202605020820261108Z/35", "umaren"],
    ["pw155ouS305202605020820261108Z/B9", "wide"],
    ["pw156ouS305202605020820261108Z/3D", "umatan"],
    ["pw157ouS305202605020820261108Z99/23", "sanrenpuku"],
  ] as const)("%s は %s", (cname, page) => {
    const parsed = parseJraOddsCname(cname);
    expect(parsed).not.toBeNull();
    expect(parsed?.page).toBe(page);
    expect(parsed?.raceId).toBe("202605050208");
  });

  it("11/7(終了日)の `10` 区分も読める", () => {
    expect(parseJraOddsCname("pw151ou1005202605010120261107Z/00")?.raceId).toBe("202605050101");
  });

  it.each([
    "",
    "pw152ouS305202605020820261108Z/45", // 欠番の式別
    "pw151opS305202605020820261108Z/45", // 人気順は使わない
    "pw158ouS305202605020820261108Z/4", // 符号が 1 桁
    "pw158ouS30520260502082026110Z/45", // 開催日が 7 桁
    "pw01dde0105202605020820261108/45",
    "pw158ouS305202605020820261108Z/zz",
  ])("形が違えば null: %j", (cname) => {
    expect(parseJraOddsCname(cname)).toBeNull();
  });
});

describe("parseJraOddsVenueListPage(開催選択)", () => {
  const html = loadShiftJisFixture("jra_odds_oli_20261108.html");

  it("11/8 は福島(03)・東京(05)・京都(08)のレース選択。回と日は場ごとに読む", () => {
    const venues = parseJraOddsVenueListPage(html, "20261108");
    expect(venues).toEqual([
      { venueCode: "03", year: "2026", kai: "03", day: "02", date: "20261108", racesCname: "pw15orl00032026030220261108/B4" },
      { venueCode: "05", year: "2026", kai: "05", day: "02", date: "20261108", racesCname: "pw15orl00052026050220261108/AA" },
      { venueCode: "08", year: "2026", kai: "05", day: "02", date: "20261108", racesCname: "pw15orl00082026050220261108/88" },
    ]);
  });

  it("11/7 は 3 場で、11/8 と別の cname(日が 01)", () => {
    const venues = parseJraOddsVenueListPage(html, "20261107");
    expect(venues).not.toBeNull();
    expect(venues!.map((v) => `${v.venueCode}:${v.kai}:${v.day}`)).toEqual(["03:03:01", "05:05:01", "08:05:01"]);
    expect(venues!.every((v) => v.racesCname.startsWith("pw15orl1"))).toBe(true);
  });

  it("開催の無い日は空。日付の形が違えば throw(呼び出し側のバグ)", () => {
    expect(parseJraOddsVenueListPage(html, "20261109")).toEqual([]);
    expect(() => parseJraOddsVenueListPage(html, "2026-11-08")).toThrow();
  });

  it("入口のリンクが 1 つも無い頁(別の頁・壊れた頁)は null(空の一覧と区別する)", () => {
    expect(parseJraOddsVenueListPage("<html><title>x</title></html>", "20261108")).toBeNull();
  });
});

describe("parseJraOddsRaceListPage(東京のレース選択)", () => {
  const html = loadShiftJisFixture("jra_odds_orl_tokyo_20261108.html");
  const races = parseJraOddsRaceListPage(html, "20261108", "05");

  it("12 レース。race_id は 202605050201〜202605050212(R の順)", () => {
    expect(races).toHaveLength(12);
    expect(races.map((r) => r.raceId)).toEqual(Array.from({ length: 12 }, (_, i) => `2026050502${String(i + 1).padStart(2, "0")}`));
  });

  it("各レースに 7 つの式別の cname が揃い、すべて自分のレースの cname である", () => {
    expect(JRA_ODDS_PAGES).toEqual(["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"]);
    for (const race of races) {
      expect(Object.keys(race.cnames).sort()).toEqual([...JRA_ODDS_PAGES].sort());
      for (const page of JRA_ODDS_PAGES) {
        const parsed = parseJraOddsCname(race.cnames[page]);
        expect(parsed?.page, `${race.raceId} ${page}`).toBe(page);
        expect(parsed?.raceId, `${race.raceId} ${page}`).toBe(race.raceId);
      }
    }
  });

  it("8R の cname は調査記録の値と一致する(3連単 `…0820261108Z/45`、3連複は `Z99`)", () => {
    const r8 = races.find((r) => r.raceId === "202605050208");
    expect(r8?.cnames.sanrentan).toBe("pw158ouS305202605020820261108Z/45");
    expect(r8?.cnames.sanrenpuku).toBe("pw157ouS305202605020820261108Z99/23");
    expect(r8?.cnames.tanpuku).toBe("pw151ouS305202605020820261108Z/A9");
  });

  it("別の場・別の日を指定すると空(東京のページに京都のレースは無い)", () => {
    expect(parseJraOddsRaceListPage(html, "20261108", "08")).toEqual([]);
    expect(parseJraOddsRaceListPage(html, "20261107", "05")).toEqual([]);
  });

  it("式別が欠けたレースは返さない(7 つ揃わないレースの一部だけを使わない)", () => {
    const broken = html.replace(/pw158ouS305202605020520261108Z\/[0-9A-F]{2}/g, "");
    const got = parseJraOddsRaceListPage(broken, "20261108", "05");
    expect(got).toHaveLength(11);
    expect(got.some((r) => r.raceId === "202605050205")).toBe(false);
  });
});
