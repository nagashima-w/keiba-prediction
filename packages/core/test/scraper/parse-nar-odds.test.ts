import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NarOddsParseError,
  parseNarOdds,
} from "../../src/scraper/parse-nar-odds.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("parseNarOdds(発売後: #odds_tan_block/#odds_fuku_blockから抽出)", () => {
  const html = loadFixture("nar_odds_b1_202654071210.html");
  const odds = parseNarOdds(html);

  it("oddsStatusがmiddle相当になること(NARページ単体では確定判別不能のため)", () => {
    expect(odds.oddsStatus).toBe("middle");
  });

  it("officialDatetimeはページに時刻情報が無いためnullになること", () => {
    expect(odds.officialDatetime).toBeNull();
  });

  it("単勝12頭分を馬番→オッズで抽出すること", () => {
    expect(Object.keys(odds.win)).toHaveLength(12);
    expect(odds.win[1]).toEqual({ odds: 24.8, ninki: null });
    expect(odds.win[12]).toEqual({ odds: 9.9, ninki: null });
    expect(odds.win[6]!.odds).toBe(7.0);
  });

  it("複勝12頭分を馬番→下限・上限で抽出すること", () => {
    expect(Object.keys(odds.place)).toHaveLength(12);
    expect(odds.place[1]).toEqual({ oddsMin: 6.8, oddsMax: 8.5, ninki: null });
    expect(odds.place[12]).toEqual({
      oddsMin: 2.9,
      oddsMax: 3.6,
      ninki: null,
    });
    expect(odds.place[9]).toEqual({ oddsMin: 2.6, oddsMax: 3.3, ninki: null });
  });
});

describe("parseNarOdds(発売前: 予想オッズのみ→yosoに正規化)", () => {
  const html = loadFixture("nar_odds_b1_presale_202642071301.html");
  const odds = parseNarOdds(html);

  it("oddsStatusがyosoになること", () => {
    expect(odds.oddsStatus).toBe("yoso");
  });

  it("単勝10頭分を馬番→予想オッズで抽出すること(人気も取得できる)", () => {
    expect(Object.keys(odds.win)).toHaveLength(10);
    expect(odds.win[9]).toEqual({ odds: 1.3, ninki: 1 });
    expect(odds.win[6]).toEqual({ odds: 113.1, ninki: 10 });
    expect(odds.win[1]).toEqual({ odds: 16.4, ninki: 5 });
  });

  it("複勝は未発売のため空になること", () => {
    expect(odds.place).toEqual({});
  });
});

describe("parseNarOdds(構造異常)", () => {
  it("単勝ブロックも予想オッズテーブルも無いHTMLはNarOddsParseErrorになること", () => {
    expect(() => parseNarOdds("<html><body></body></html>")).toThrow(
      NarOddsParseError,
    );
  });
});
