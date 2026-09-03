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
import { toNinki } from "./ninki.js";
import { toOddsNumber } from "./odds-number.js";
import { NAR_ODDS_SELECTORS as SEL } from "./selectors.js";
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
 * オッズセルが非数値(取消等)の場合は odds:null で温存する(構造異常ではない)。
 * オッズ文字列の数値化は共有ヘルパ `scraper/odds-number.ts` の `toOddsNumber` に委譲する
 * (中央・ワイド・3連複と契約を統一。Issue #73)。
 */
function parseTanRow($row: CheerioSelection): { umaban: number; win: WinOdds } {
  const umaban = umabanOf($row);
  const oddsText = $row.find("td").last().text().trim();
  return { umaban, win: { odds: toOddsNumber(oddsText), ninki: null } };
}

/**
 * 「下限 - 上限」形式のレンジテキストを分割し、各半分を独立に数値化する(per-half契約。Issue #73)。
 *
 * **per-half(壊れた側のみnull)**: 片側が非数値(取消等)でも、読める側の数値は捨てない。
 * `parse-nar-combo-odds.ts::parseRangeText`(地方ワイド)と契約を統一した(Issue #73。
 * 旧実装は「片方が壊れたら両方null」〈all-or-nothing〉であり、EV計算が使う複勝下限
 * (`parse-odds.ts` JSDoc参照)を、無関係な上限側の破損を理由に読める下限ごと捨てていた
 * 欠陥だった。#31の原則により、判定不能を判定結果に混ぜない側〈per-half〉を採用する)。
 *
 * 分割セパレータは ASCII ハイフン(前後の空白を許容して分割する)。現行フィクスチャ
 * (`nar_odds_b1_202654071210.html` の `#odds_fuku_block`)で観測されたのは
 * `'6.8 - 8.5'` 形式(ASCIIハイフン+前後空白1つ)であり、全角ハイフン等の発生は
 * 未観測(どちらの向きにも断定しない)。
 *
 * **`parse-nar-combo-odds.ts::parseRangeText` との構造的重複について(code-reviewer指摘)**:
 * 両関数とも「ハイフンで構造分割→`parts.length!==2`等のガード→各半分を`toOddsNumber`」という
 * 同一の構造を持つ(数値パターン自体は`scraper/odds-number.ts`に集約済みのためAC2の文言には
 * 違反しない)。本Issue(#73)のスコープでは統合しない判断とした。理由: 対象ドキュメントが別
 * (単複ページ`#odds_fuku_block`とワイド組合せページの`td.Odds`セル)で、レンジ以外の周辺処理
 * (人気列の有無・馬番の抽出方式)も異なり、単純な関数抽出では済まない可能性がある。共通化する
 * 場合は影響範囲の精査が別途必要なため、将来 `splitOddsRange` のような共有ヘルパへ統合する
 * 価値があるかどうかは、着手時に改めて判断すること。
 */
function parsePlaceOddsRange(text: string): { oddsMin: number | null; oddsMax: number | null } {
  const parts = text.split(/\s*-\s*/);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return { oddsMin: null, oddsMax: null };
  }
  return { oddsMin: toOddsNumber(parts[0]!), oddsMax: toOddsNumber(parts[1]!) };
}

/**
 * 発売後(#odds_fuku_block)の1行から複勝オッズ(下限-上限)を取り出す。人気列は無いため null。
 * レンジとして分割できない(ハイフンが無い・2個以上・片側が空)場合は oddsMin/oddsMax とも
 * null で温存する(構造異常ではない)。分割できた場合の各半分の数値化は per-half 契約
 * (`parsePlaceOddsRange` 参照。Issue #73)。
 *
 * per-half化(AC5')の非破壊性の実測: 実フィクスチャ(`nar_odds_b1_202654071210.html`)の
 * `#odds_fuku_block`複勝レンジセル12行中、片側だけ数値化できない行は0件(再現:
 * `python3 -c "import re; html=open('fixtures/nar_odds_b1_202654071210.html',encoding='utf-8').read(); seg=html[html.find('odds_fuku_block'):html.find('odds_fuku_block')+6000]; print(len(re.findall(r'<span class=\"Odds ?\">([^<]*)</span>', seg)))"`
 * → 12件)。per-half化はこのフィクスチャの出力に影響しない。
 */
function parseFukuRow(
  $row: CheerioSelection,
): { umaban: number; place: PlaceOdds } {
  const umaban = umabanOf($row);
  const oddsText = $row.find("td").last().text().trim();
  const { oddsMin, oddsMax } = parsePlaceOddsRange(oddsText);
  return { umaban, place: { oddsMin, oddsMax, ninki: null } };
}

/**
 * 発売前(予想オッズ)の1行から単勝相当オッズを取り出す。
 * 列構成: 人気(列0) / 馬番(列1) / 印(列2) / 馬名(列3) / 予想オッズ(列4=最終列)。
 * オッズセルが非数値(取消等)の場合は odds:null で温存する(構造異常ではない。
 * オッズの数値化は共有ヘルパ `scraper/odds-number.ts` の `toOddsNumber` に委譲する。Issue #73)。
 * 人気列は共有ヘルパ `scraper/ninki.ts` の `toNinki` で数値化する(Issue #34。
 * 単勝・複勝〈parse-odds.ts〉/ワイド・3連複〈parse-combo-odds.ts〉と契約を統一。
 * "0"は欠損表現としてnullになる)。
 */
function parseYosoRow($row: CheerioSelection): { umaban: number; win: WinOdds } {
  const umaban = umabanOf($row);
  const ninkiText = $row.find("td").eq(0).text().trim();
  const ninki = toNinki(ninkiText);
  const oddsText = $row.find("td").last().text().trim();
  return { umaban, win: { odds: toOddsNumber(oddsText), ninki } };
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
