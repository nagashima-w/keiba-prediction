/**
 * 調教(oikiri.html)のパーサー。
 *
 * 無料範囲で取得できる各馬の評価テキスト(td.Training_Critic 例「動き良化」)と
 * 評価ランク(class が Rank_〜 のセル 例「B」)を抽出する。
 * 調教タイム・ラップはプレミアム領域のため今回スコープ外(types.ts の OikiriEntry に余地を残す)。
 * セレクタは selectors.ts に集約し、本ファイルはその解釈のみを行う。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { parseHorseId } from "./ids.js";
import { OIKIRI_SELECTORS as SEL, PATTERNS } from "./selectors.js";
import type { OikiriEntry, OikiriResult, OikiriSkippedRow } from "./types.js";

/** 馬番の上限(1〜18)。 */
const MAX_UMABAN = 18;

/**
 * 調教のパース失敗を表す例外。
 * 個々の異常行(馬番範囲外・馬IDリンク欠損)はスキップ扱いとし、本例外は投げない。
 * 本例外は調教テーブル自体が無い等の構造異常(誤取得・サイト構造変更)にのみ用いる。
 */
export class OikiriParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OikiriParseError";
  }
}

/** cheerio の選択結果(1要素をラップした Cheerio オブジェクト)の型。 */
type CheerioSelection = ReturnType<CheerioAPI>;

/**
 * 1行(tr.HorseList)から1頭分の調教データを抽出する。
 * 異常な行は例外ではなく理由文字列を返し、呼び出し側でスキップさせる。
 *
 * @returns 正常時は OikiriEntry、異常時はスキップ理由の文字列
 */
function parseRow($r: CheerioSelection): OikiriEntry | string {
  const umabanText = $r.find(SEL.umaban).first().text().trim();
  const umaban = Number(umabanText);
  if (!Number.isInteger(umaban) || umaban < 1 || umaban > MAX_UMABAN) {
    return `馬番が1〜${MAX_UMABAN}の範囲外です(抽出値: "${umabanText}")`;
  }

  const $horse = $r.find(SEL.horseLink).first();
  const horseName = $horse.text().trim();
  const horseHref = $horse.attr("href") ?? "";
  const horseIdRaw = PATTERNS.horseIdFromHref.exec(horseHref)?.[1];
  if (horseIdRaw === undefined) {
    return `馬IDを抽出できませんでした(href: "${horseHref}")`;
  }
  const horseId = parseHorseId(horseIdRaw);

  // 評価テキスト・ランクは空の馬があり得るため null 許容。
  const critic = $r.find(SEL.critic).first().text().trim() || null;
  const rankCell = $r.find(SEL.rank).first();
  const rank = rankCell.length > 0 ? rankCell.text().trim() || null : null;

  return { umaban, horseId, horseName, critic, rank };
}

/**
 * 調教HTMLをパースして、各馬の調教評価とスキップ情報を返す。
 *
 * 調教は optional データのため、1行の異常(馬番範囲外・馬IDリンク欠損)で全頭分を
 * 破棄せず、その行のみスキップして正常行を返す。スキップは silent にせず件数・理由を記録する。
 * 調教テーブル自体が無い/調教行が1件も無い構造異常のみ OikiriParseError で失敗させる。
 *
 * @param html oikiri.html のHTML文字列(デコード済みUTF-8)
 * @returns 各馬の調教評価(HTML上の並び順)とスキップ情報
 */
export function parseOikiri(html: string): OikiriResult {
  const $ = cheerio.load(html);
  const $table = $(SEL.table).first();
  // 調教テーブルが無いのは構造変更・誤取得の兆候。silentに空配列で隠さず失敗させる。
  if ($table.length === 0) {
    throw new OikiriParseError("OikiriTable が見つかりませんでした");
  }

  const entries: OikiriEntry[] = [];
  const skipped: OikiriSkippedRow[] = [];
  $table.find(SEL.row).each((rowIndex, row) => {
    const parsed = parseRow($(row));
    if (typeof parsed === "string") {
      skipped.push({ rowIndex, reason: parsed });
      return;
    }
    entries.push(parsed);
  });

  // 調教行(tr.HorseList)自体が1件も無いのは構造異常。正常行もスキップ行も無い場合に失敗させる。
  if (entries.length === 0 && skipped.length === 0) {
    throw new OikiriParseError(
      "調教行(tr.HorseList)を1件も抽出できませんでした",
    );
  }

  return { entries, skippedRowCount: skipped.length, skipped };
}
