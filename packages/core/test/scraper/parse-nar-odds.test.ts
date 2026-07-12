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

/** #odds_tan_block/#odds_fuku_block の最小行(単勝または複勝の1頭分)を組み立てる。 */
function buildOddsRow(oddsText: string): string {
  return `
    <tr>
      <td class="Waku1">1</td>
      <td>1</td>
      <td class="Mark_User"><span class="MarkIcon Mark00"></span></td>
      <td class="Horse_Name">テスト馬</td>
      <td class="Odds"><span class="Odds ">${oddsText}</span></td>
    </tr>`;
}

/** ヘッダ行(thのみ)を持つ最小オッズテーブル。 */
function buildOddsTable(rows: string): string {
  return `
    <table class="RaceOdds_HorseList_Table">
      <tr><th class="Waku">枠</th><th class="W31">馬番</th><th class="Mark">印</th><th>馬名</th><th>オッズ</th></tr>
      ${rows}
    </table>`;
}

describe("parseNarOdds(単勝ブロックのみ・複勝ブロックが無いケース)", () => {
  it("#odds_tan_blockのみ存在する場合、place:{}(空)として返すこと(仕様として固定)", () => {
    const html = `<div id="odds_tan_block">${buildOddsTable(
      buildOddsRow("5.0"),
    )}</div>`;
    const odds = parseNarOdds(html);
    expect(odds.oddsStatus).toBe("middle");
    expect(odds.win[1]).toEqual({ odds: 5.0, ninki: null });
    expect(odds.place).toEqual({});
  });
});

describe("parseNarOdds(複勝ブロックのみ・単勝ブロックが無いケース)", () => {
  it("#odds_fuku_blockのみ存在する場合、単勝も予想オッズも無い構造異常としてNarOddsParseErrorになること", () => {
    // 実サイトでは単勝(odds_tan_block)を欠いて複勝のみが存在する構成は無い
    // (発売前後どちらの正常系にも当てはまらない)ため、silentに受理せず失敗させる。
    const html = `<div id="odds_fuku_block">${buildOddsTable(
      buildOddsRow("3.0 - 4.0"),
    )}</div>`;
    expect(() => parseNarOdds(html)).toThrow(NarOddsParseError);
  });
});
