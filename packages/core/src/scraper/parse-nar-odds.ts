/**
 * 地方(NAR)オッズページ(odds/index.html?type=b1)のパーサー。
 *
 * 中央(race.netkeiba.com)はJSON API(api_get_jra_odds)から単勝・複勝を取得するが、
 * 地方は同等のJSON APIが存在しない(実測404)。代わりに静的HTML上の
 * #odds_tan_block(単勝)・#odds_fuku_block(複勝)テーブルを解釈し、
 * 既存 OddsSnapshot 互換の構造を返す。
 *
 * 発売状態の正規化:
 * - 発売後: #odds_tan_block/#odds_fuku_block が静的に入る。NARページ単体では
 *   「発売中」か「確定」かを判別できないため(確定判定には result.html の払戻有無が必要)、
 *   中央の "middle"(発売中の暫定オッズ)相当として扱う。
 * - 発売前: 上記2ブロックが存在せず、代わりに netkeibaのAIによる「予想オッズ」テーブル
 *   (単勝のみ、class に Ninki が付く)が表示される。複勝が存在しないため、
 *   中央の "yoso"(前売り前の予想オッズ)相当として正規化する。
 *
 * 単勝・複勝の各行とも「馬番」列は先頭から2列目(列インデックス1)に固定で現れるため、
 * 1列目の意味(枠/人気)が発売前後で異なっても位置ベースで共通に取り出せる。
 * オッズ確定時刻はページに情報が無いため officialDatetime は常に null。
 *
 * 詳細: docs/nar-scraping-plan.md「オッズの取得方式」。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { NAR_ODDS_SELECTORS as SEL, PATTERNS } from "./selectors.js";
import type { OddsSnapshot, PlaceOdds, WinOdds } from "./types.js";

/** 馬番の上限(1〜18)。 */
const MAX_UMABAN = 18;

/** 地方オッズのパース失敗(構造不一致・範囲外馬番等)を表す例外。 */
export class NarOddsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarOddsParseError";
  }
}

/** cheerio の選択結果(1要素をラップした Cheerio オブジェクト)の型。 */
type CheerioSelection = ReturnType<CheerioAPI>;

/** テーブル内のデータ行(th を含まずtdを持つ行)を返す。ヘッダ行(th)を除外する。 */
function dataRows($: CheerioAPI, $table: CheerioSelection): CheerioSelection[] {
  const rows: CheerioSelection[] = [];
  $table.find(SEL.row).each((_, row) => {
    const $row = $(row);
    if ($row.find("th").length === 0 && $row.find("td").length > 0) {
      rows.push($row);
    }
  });
  return rows;
}

/** 行から馬番を取り出す(先頭から2列目=列インデックス1に固定)。 */
function umabanOf($row: CheerioSelection): number {
  const text = $row.find("td").eq(1).text().trim();
  const umaban = Number(text);
  if (!/^[0-9]+$/.test(text) || umaban < 1 || umaban > MAX_UMABAN) {
    throw new NarOddsParseError(
      `馬番は1〜${MAX_UMABAN}の範囲である必要があります(抽出値: "${text}")`,
    );
  }
  return umaban;
}

/**
 * 発売後(#odds_tan_block)の1行から単勝オッズを取り出す。
 * オッズ列は最終列(span.Oddsに包まれるが .text() で透過的に取れる)。人気列は無いため null。
 */
function parseTanRow($row: CheerioSelection): { umaban: number; win: WinOdds } {
  const umaban = umabanOf($row);
  const oddsText = $row.find("td").last().text().trim();
  const m = PATTERNS.narWinOdds.exec(oddsText);
  if (!m) {
    throw new NarOddsParseError(
      `単勝オッズを数値として解釈できませんでした(馬番${umaban}, 値: "${oddsText}")`,
    );
  }
  return { umaban, win: { odds: Number(oddsText), ninki: null } };
}

/**
 * 発売後(#odds_fuku_block)の1行から複勝オッズ(下限-上限)を取り出す。人気列は無いため null。
 */
function parseFukuRow(
  $row: CheerioSelection,
): { umaban: number; place: PlaceOdds } {
  const umaban = umabanOf($row);
  const oddsText = $row.find("td").last().text().trim();
  const m = PATTERNS.narPlaceOddsRange.exec(oddsText);
  if (!m) {
    throw new NarOddsParseError(
      `複勝オッズ(下限-上限)を解釈できませんでした(馬番${umaban}, 値: "${oddsText}")`,
    );
  }
  return {
    umaban,
    place: { oddsMin: Number(m[1]!), oddsMax: Number(m[2]!), ninki: null },
  };
}

/**
 * 発売前(予想オッズ)の1行から単勝相当オッズを取り出す。
 * 列構成: 人気(列0) / 馬番(列1) / 印(列2) / 馬名(列3) / 予想オッズ(列4=最終列)。
 */
function parseYosoRow($row: CheerioSelection): { umaban: number; win: WinOdds } {
  const umaban = umabanOf($row);
  const ninkiText = $row.find("td").eq(0).text().trim();
  const ninki = /^[0-9]+$/.test(ninkiText) ? Number(ninkiText) : null;
  const oddsText = $row.find("td").last().text().trim();
  const m = PATTERNS.narWinOdds.exec(oddsText);
  if (!m) {
    throw new NarOddsParseError(
      `予想オッズを数値として解釈できませんでした(馬番${umaban}, 値: "${oddsText}")`,
    );
  }
  return { umaban, win: { odds: Number(oddsText), ninki } };
}

/**
 * 地方オッズページのHTMLをパースする。
 *
 * @param html odds/index.html?type=b1 のHTML文字列(デコード済みUTF-8)
 * @returns 単勝・複勝オッズのスナップショット(OddsSnapshot互換)
 */
export function parseNarOdds(html: string): OddsSnapshot {
  const $ = cheerio.load(html);

  const $tanBlock = $(SEL.tanBlock).first();
  if ($tanBlock.length > 0) {
    // 発売後: #odds_tan_block(単勝)+#odds_fuku_block(複勝、あれば)。
    const win: Record<number, WinOdds> = {};
    for (const $row of dataRows($, $tanBlock)) {
      const { umaban, win: w } = parseTanRow($row);
      win[umaban] = w;
    }
    if (Object.keys(win).length === 0) {
      throw new NarOddsParseError(
        "単勝ブロック(#odds_tan_block)から1件もオッズを抽出できませんでした",
      );
    }

    const place: Record<number, PlaceOdds> = {};
    const $fukuBlock = $(SEL.fukuBlock).first();
    if ($fukuBlock.length > 0) {
      for (const $row of dataRows($, $fukuBlock)) {
        const { umaban, place: p } = parseFukuRow($row);
        place[umaban] = p;
      }
    }

    return { officialDatetime: null, oddsStatus: "middle", win, place };
  }

  // 発売前: 予想オッズテーブル(単勝相当のみ、複勝なし)。
  const $yosoTable = $(SEL.yosoTable).first();
  if ($yosoTable.length === 0) {
    throw new NarOddsParseError(
      "単勝ブロック(#odds_tan_block)も予想オッズテーブルも見つかりませんでした",
    );
  }
  const win: Record<number, WinOdds> = {};
  for (const $row of dataRows($, $yosoTable)) {
    const { umaban, win: w } = parseYosoRow($row);
    win[umaban] = w;
  }
  if (Object.keys(win).length === 0) {
    throw new NarOddsParseError(
      "予想オッズテーブルから1件もオッズを抽出できませんでした",
    );
  }

  return { officialDatetime: null, oddsStatus: "yoso", win, place: {} };
}
