/**
 * レース結果(result.html)のパーサー。
 *
 * 取得対象:
 * - 全着順(#All_Result_Table): 各馬の着順・馬番・馬名。
 * - 確定払戻(払戻テーブル): 複勝と単勝の払戻(100円あたりの円)。
 *
 * 設計上の注意:
 * - 文書全体には結果本体以外にも tr.HorseList を持つテーブルが複数存在する
 *   (プレミアムのラップサマリー等。フィクスチャでは全体13行のうち結果本体は10行)。
 *   そのため結果行は #All_Result_Table 配下にスコープして取り、余分な行を silent に
 *   取り込まない。結果本体テーブルが無い場合は構造異常として失敗させる。
 * - 枠と馬番はどちらも td.Num だが、枠セルは class に Waku{n} を持つ。枠セルを除外して
 *   馬番セルを選ぶ(枠番と馬番の取り違え防止。フィクスチャに枠≠馬番の行がある)。
 * - 着順は「中止」「除外」等の非数値があり得るため、全戦績と同じ FinishPosition 流儀で返す。
 * - 払戻テーブルは発走後に確定するため、未確定レースでは欠ける。欠損時は payout類を空配列に
 *   して耐性を持たせる(未確定レースを渡しても着順部分は取れる)。ただし払戻が存在する場合に
 *   「的中馬番数」と「払戻件数」が食い違う構造異常は silent に隠さず失敗させる。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { PATTERNS, RACE_RESULT_SELECTORS as SEL } from "./selectors.js";
import type { FinishPosition, RacePayoutEntry, RaceResult } from "./types.js";

/** レース結果のパース失敗(結果テーブル欠損・払戻の件数不整合等)を表す例外。 */
export class RaceResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceResultParseError";
  }
}

/** 空白・"&nbsp;" を除いてトリムした文字列を返す。 */
function normalizeText(raw: string): string {
  return raw.replace(/ /g, " ").trim();
}

/**
 * 着順表示を判別可能な型に変換する(全戦績 parse-horse-results の toFinishPosition と同流儀)。
 * 空文字は null、数値は順位、降着(例: 5(降))は順位+demoted、それ以外は非数値。
 */
function toFinishPosition(raw: string): FinishPosition | null {
  const t = normalizeText(raw);
  if (t === "") {
    return null;
  }
  if (/^[0-9]+$/.test(t)) {
    return { kind: "順位", value: Number(t) };
  }
  const demoted = PATTERNS.demotedFinish.exec(t);
  if (demoted) {
    return { kind: "順位", value: Number(demoted[1]!), demoted: true };
  }
  return { kind: "非数値", text: t };
}

/**
 * 結果行から馬番を取り出す。枠・馬番はどちらも td.Num だが、枠セルは class に Waku{n} を
 * 持つため、それを除外した td.Num を馬番として採用する。
 *
 * 想定形は「td.Num が2セル・うち1つが枠(Waku)、残り1つが馬番」。枠クラスが落ちる等で
 * この前提が崩れると枠番を馬番として silent 採用しかねないため、逸脱時は loud に失敗させる
 * (方針: 行を捨てない/構造異常を隠さない)。
 */
function umabanOf($: CheerioAPI, $row: ReturnType<CheerioAPI>): number {
  const numCells = $row.find(SEL.numCell).toArray();
  const umabanCells = numCells.filter(
    (cell) => !PATTERNS.wakuClass.test($(cell).attr("class") ?? ""),
  );
  const wakuCount = numCells.length - umabanCells.length;
  if (numCells.length !== 2 || wakuCount !== 1 || umabanCells.length !== 1) {
    throw new RaceResultParseError(
      `結果行の馬番セル構成が想定外です(td.Num=${numCells.length}, Waku=${wakuCount})`,
    );
  }
  const t = normalizeText($(umabanCells[0]!).text());
  if (!/^[0-9]+$/.test(t)) {
    throw new RaceResultParseError(
      `馬番を数値として解釈できませんでした(値: "${t}")`,
    );
  }
  return Number(t);
}

/** 払戻金額文字列(例: "1,060円")を数値化する。数字が無ければ null。 */
function toPayoutNumber(raw: string): number | null {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits === "" ? null : Number(digits);
}

/**
 * 払戻行(td.Result の的中馬番 × td.Payout の払戻)を RacePayoutEntry[] に変換する。
 * 行が存在しない場合は空配列。馬番数と払戻件数が食い違う場合は構造異常として失敗させる。
 */
function parsePayoutRow(
  $: CheerioAPI,
  rowSelector: string,
  label: string,
): RacePayoutEntry[] {
  const $row = $(rowSelector).first();
  if ($row.length === 0) {
    return [];
  }

  // 的中馬番: td.Result 内の空でない span テキスト(空 span は区切り用)。
  const umabans = $row
    .find(`${SEL.payoutResult} span`)
    .toArray()
    .map((el) => normalizeText($(el).text()))
    .filter((t) => t !== "")
    .map((t) => Number(t));

  // 払戻: td.Payout 内を <br> で分割し、各点を数値化。
  const payoutHtml = $row.find(SEL.payoutAmount).first().html() ?? "";
  const payouts = payoutHtml
    .split(/<br\s*\/?>/i)
    .map((chunk) => toPayoutNumber(cheerio.load(chunk).text()))
    .filter((n): n is number => n !== null);

  if (umabans.length !== payouts.length) {
    throw new RaceResultParseError(
      `${label}の的中馬番数(${umabans.length})と払戻件数(${payouts.length})が一致しません`,
    );
  }

  return umabans.map((umaban, i) => ({ umaban, payout: payouts[i]! }));
}

/**
 * レース結果ページのHTMLをパースする。
 *
 * @param html result.html の静的HTML(UTF-8)
 * @returns 各馬の着順と、複勝・単勝の確定払戻
 */
export function parseRaceResult(html: string): RaceResult {
  const $ = cheerio.load(html);

  const $table = $(SEL.resultTable).first();
  if ($table.length === 0) {
    throw new RaceResultParseError(
      "結果テーブル(#All_Result_Table)が見つかりませんでした",
    );
  }

  const horses: RaceResult["horses"] = [];
  $table.find(SEL.resultRow).each((_, row) => {
    const $row = $(row);
    // 馬番が想定形で取れない結果行は構造異常として umabanOf が例外を投げる(silentに捨てない)。
    const umaban = umabanOf($, $row);
    const $name = $row.find(SEL.horseNameLink).first();
    const horseName = normalizeText($name.attr("title") ?? $name.text());
    horses.push({
      umaban,
      finishPosition: toFinishPosition($row.find(SEL.finishRank).first().text()),
      horseName,
    });
  });

  return {
    horses,
    placePayouts: parsePayoutRow($, SEL.placeRow, "複勝"),
    winPayouts: parsePayoutRow($, SEL.winRow, "単勝"),
  };
}
