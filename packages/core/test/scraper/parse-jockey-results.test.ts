import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JockeyResultsParseError,
  parseJockeyResults,
} from "../../src/scraper/parse-jockey-results.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 年度別成績の表を最小限の形で組み立てる(ヘッダの列名で列を解決することを確かめるための合成入力)。 */
function table(headerCells: string, rows: string[]): string {
  const body = rows.map((r) => `<tr>${r}</tr>`).join("");
  return `<html><body><table summary="年度別成績"><tr>${headerCells}</tr><tr><th>出走</th></tr>${body}</table></body></html>`;
}
const td = (...cells: (string | number)[]): string => cells.map((c) => `<td>${c}</td>`).join("");
const STANDARD_HEADER =
  '<th rowspan="2">年度</th><th rowspan="2">順位</th><th rowspan="2">1着</th><th rowspan="2">2着</th><th rowspan="2">3着</th><th rowspan="2">着外</th><th colspan="2">重賞</th>';

describe("parseJockeyResults(騎手の年度別成績。実フィクスチャ)", () => {
  it("中央の騎手(横山武史 01170): 年ごとの騎乗数と3着内の回数を新しい年から返す(通算の行は含めない)", () => {
    const years = parseJockeyResults(loadFixture("jockey_results_01170.html"));
    // 2026〜2017 の10年(通算の行は年ではないので入らない)。
    expect(years).toHaveLength(10);
    expect(years.map((y) => y.year)).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017]);
    // 2026: 1着85・2着76・3着65・着外382 → 騎乗608・3着内226。2025: 110・94・81・489 → 774・285。
    expect(years[0]).toEqual({ year: 2026, starts: 608, placed: 226 });
    expect(years[1]).toEqual({ year: 2025, starts: 774, placed: 285 });
  });

  it("騎手が2年目(田山旺佑 01220): 行は2年分だけで、あるだけを返す", () => {
    const years = parseJockeyResults(loadFixture("jockey_results_01220.html"));
    expect(years).toEqual([
      { year: 2026, starts: 624, placed: 136 },
      { year: 2025, starts: 345, placed: 45 },
    ]);
  });

  it("地方の騎手(郷間勇太 05496。syusai=20 のページ): 千位区切りの数も読める", () => {
    const years = parseJockeyResults(loadFixture("nar_jockey_results_05496.html"));
    expect(years[0]).toEqual({ year: 2026, starts: 416, placed: 119 });
    // 2025: 54・60・66・428 → 騎乗608・3着内180。行は2026〜2012の15年。
    expect(years[1]).toEqual({ year: 2025, starts: 608, placed: 180 });
    expect(years).toHaveLength(15);
  });

  it("中央の成績が無い騎手(a01ad): 通算の行しかなく、空配列(取得失敗とは別)", () => {
    expect(parseJockeyResults(loadFixture("jockey_results_a01ad_no_central.html"))).toEqual([]);
  });
});

describe("parseJockeyResults(列はヘッダの文言で解決する。合成入力)", () => {
  it("1着〜着外の列の前に別の列が挟まっても、列名どおりに読む", () => {
    const html = table(
      `<th>年度</th><th>メモ</th><th>順位</th><th>3着</th><th>1着</th><th>着外</th><th>2着</th>`,
      [td(2025, "x", 9, 4, 1, 10, 2)],
    );
    // 1着=1・2着=2・3着=4・着外=10 → 騎乗17・3着内7。
    expect(parseJockeyResults(html)).toEqual([{ year: 2025, starts: 17, placed: 7 }]);
  });

  it("colspan のあるヘッダの後ろにある列の位置も、colspan を足し込んで数える", () => {
    const html = table(
      `<th colspan="2">年度</th><th>1着</th><th>2着</th><th>3着</th><th>着外</th>`,
      [td(2025, "a", 1, 2, 3, 4)],
    );
    expect(parseJockeyResults(html)).toEqual([{ year: 2025, starts: 10, placed: 6 }]);
  });

  it("年の行が1つも無い表は空配列", () => {
    const html = table(STANDARD_HEADER, [td("通算", "", 0, 0, 0, 0, 0, 0)]);
    expect(parseJockeyResults(html)).toEqual([]);
  });

  it("着外が 0 の年(全部3着内)も読める: placed === starts", () => {
    const html = table(STANDARD_HEADER, [td(2024, 1, 2, 3, 4, 0, 0, 0)]);
    expect(parseJockeyResults(html)).toEqual([{ year: 2024, starts: 9, placed: 9 }]);
  });
});

describe("parseJockeyResults(壊れた入力は黙って捨てず失敗させる)", () => {
  it.each([
    ["表が無いページ", "<html><body><p>not found</p></body></html>"],
    ["空文字", ""],
    ["年度別成績の表だが列名(着外)が無い", table('<th>年度</th><th>1着</th><th>2着</th><th>3着</th>', [td(2025, 1, 2, 3)])],
    ["年の行のセル数がヘッダの列より少ない", table(STANDARD_HEADER, [td(2025, 1, 2)])],
    ["年の行の回数が数でない", table(STANDARD_HEADER, [td(2025, 1, "-", 3, 4, 5, 0, 0)])],
  ])("%s → JockeyResultsParseError", (_name, html) => {
    expect(() => parseJockeyResults(html)).toThrow(JockeyResultsParseError);
  });
});
