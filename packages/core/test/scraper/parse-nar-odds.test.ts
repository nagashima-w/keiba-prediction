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

/** #odds_tan_block/#odds_fuku_block の1行を、馬番を指定して組み立てる(複数頭の合成用)。 */
function buildOddsRowFor(umaban: number, oddsText: string): string {
  return `
    <tr>
      <td class="Waku1">1</td>
      <td>${umaban}</td>
      <td class="Mark_User"><span class="MarkIcon Mark00"></span></td>
      <td class="Horse_Name">テスト馬${umaban}</td>
      <td class="Odds"><span class="Odds ">${oddsText}</span></td>
    </tr>`;
}

describe("parseNarOdds(非数値セル(取消・未確定)は該当馬のみnullで温存する)", () => {
  // 中央(parse-odds.ts の toOddsNumber)と契約を揃える: セル値の異常(取消・未確定等)は
  // 該当馬のオッズをnullにするだけで、行/レース全体を落とさない(WinOdds/PlaceOddsは
  // number|null契約のため)。馬番セル自体が壊れている場合(構造異常)は従来どおり例外。
  const nonNumericCases: Array<[string, string]> = [
    ["取消", "出走取消表記"],
    ["---", "未確定のハイフン表記"],
    ["", "空文字"],
  ];

  it.each(nonNumericCases)(
    "単勝(#odds_tan_block)のオッズセルが「%s」(%s)の場合、該当馬はodds:nullになり、他馬・レース全体は影響を受けないこと",
    (oddsText) => {
      const html = `<div id="odds_tan_block">${buildOddsTable(
        buildOddsRowFor(1, oddsText) + buildOddsRowFor(2, "12.3"),
      )}</div>`;
      const odds = parseNarOdds(html);
      // (c) レース全体は失敗しない(例外が投げられずここに到達する)。
      // (a) 非数値セルの馬はnullで温存される。
      expect(odds.win[1]).toEqual({ odds: null, ninki: null });
      // (b) 他馬の正常値は影響を受けない。
      expect(odds.win[2]).toEqual({ odds: 12.3, ninki: null });
    },
  );

  it.each(nonNumericCases)(
    "複勝(#odds_fuku_block)のオッズセルが「%s」(%s)の場合、該当馬はoddsMin/oddsMax:nullになり、他馬・レース全体は影響を受けないこと",
    (oddsText) => {
      const html = `
        <div id="odds_tan_block">${buildOddsTable(
          buildOddsRowFor(1, "5.0") + buildOddsRowFor(2, "12.3"),
        )}</div>
        <div id="odds_fuku_block">${buildOddsTable(
          buildOddsRowFor(1, oddsText) + buildOddsRowFor(2, "3.0 - 4.0"),
        )}</div>`;
      const odds = parseNarOdds(html);
      expect(odds.place[1]).toEqual({
        oddsMin: null,
        oddsMax: null,
        ninki: null,
      });
      expect(odds.place[2]).toEqual({ oddsMin: 3.0, oddsMax: 4.0, ninki: null });
    },
  );

  it.each(nonNumericCases)(
    "予想オッズ(発売前)のオッズセルが「%s」(%s)の場合、該当馬はodds:nullになり、他馬・レース全体は影響を受けないこと",
    (oddsText) => {
      const yosoRow = (umaban: number, ninki: number, odds: string) => `
        <tr>
          <td class="Ninki">${ninki}</td>
          <td class="Waku1">${umaban}</td>
          <td class="Mark_User"></td>
          <td class="Horse_Name">テスト馬${umaban}</td>
          <td class="Odds">${odds}</td>
        </tr>`;
      const html = `
        <table class="RaceOdds_HorseList_Table Ninki">
          <tr class="col_label"><th>人気</th><th>馬番</th><th>印</th><th>馬名</th><th>予想オッズ</th></tr>
          ${yosoRow(1, 1, oddsText)}
          ${yosoRow(2, 2, "8.5")}
        </table>`;
      const odds = parseNarOdds(html);
      expect(odds.win[1]).toEqual({ odds: null, ninki: 1 });
      expect(odds.win[2]).toEqual({ odds: 8.5, ninki: 2 });
    },
  );

  it("実測フィクスチャ由来の混在ケース: 1頭だけ取消でも他11頭・複勝は正常に取得できること", () => {
    // フィクスチャ(12頭)の単勝2番目(馬番2)を「取消」に差し替えた合成HTML。
    const html = loadFixture("nar_odds_b1_202654071210.html").replace(
      '<td class="Odds"><span class="Odds ">10.4</span></td>',
      '<td class="Odds"><span class="Odds ">取消</span></td>',
    );
    const odds = parseNarOdds(html);
    expect(odds.win[2]).toEqual({ odds: null, ninki: null });
    // 他馬(馬番1・馬番3)は正常値のまま。
    expect(odds.win[1]).toEqual({ odds: 24.8, ninki: null });
    expect(odds.win[3]).toEqual({ odds: 5.1, ninki: null });
    // 複勝は単勝の異常と無関係に12頭とも正常。
    expect(Object.keys(odds.place)).toHaveLength(12);
  });
});
