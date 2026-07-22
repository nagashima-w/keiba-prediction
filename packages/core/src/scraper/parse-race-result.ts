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
 *   馬番セルを選ぶ(枠番と馬番の取り違え防止。フィクスチャに枠≠馬番の行がある)。枠番自体は
 *   除外された側(Waku{n} を持つ側)のセル値を読む(umaban と同じ構造チェックを共有する)。
 * - 後3F・コーナー通過順は、タイム・着差など他の列と class(class="Time" 等)を共有し
 *   class だけでは区別できないため、ヘッダ行(thead)のテキストから列インデックスを解決し、
 *   データ行側は同じ位置の td を位置ベースで読む。
 *   地方(NAR)の一部レースはコーナー通過順の列自体が無いため、その場合は列インデックスが
 *   解決できず passing は空配列にフォールバックする(silent に誤セルを拾わず、位置依存にも
 *   退化しない)。ヘッダ列が解決できてもセルの値自体が空・非数値の場合も同様に
 *   null/空配列にフォールバックする(いずれも非throw)。
 *   さらに、取消・除外等で行の途中の td が1個欠けると後続列が1つずつ前へズレ、列インデックスは
 *   合っていても実際には隣の列(オッズ・厩舎等)の値を拾ってしまう危険がある。これを防ぐため、
 *   後3F・コーナー通過順を読む前に「その行の td 数がヘッダ th 数と一致するか」を確認し、
 *   一致しない行はズレた値を"もっともらしい値"として拾わずフィールドを null/空配列にする。
 *   parse-horse-results はセル数不一致を構造異常として throw するが、結果ページは取消・除外
 *   などで行ごとにセル構成が変わり得るため、ここでは throw せず対象フィールドのみフォールバック
 *   させる(行自体・umaban/finishPosition/wakuban は破棄しない)。
 * - 着順は「中止」「除外」等の非数値があり得るため、全戦績と同じ FinishPosition 流儀で返す。
 * - 払戻テーブルは発走後に確定するため、未確定レースでは欠ける。欠損時は payout類を空配列に
 *   して耐性を持たせる(未確定レースを渡しても着順部分は取れる)。ただし払戻が存在する場合に
 *   「的中馬番数」と「払戻件数」が食い違う構造異常は silent に隠さず失敗させる。
 * - #All_Result_Table 自体が存在する状態で結果行(tbody 配下の tr)が0件の場合は、発走前・
 *   確定前でまだ結果行が出ていない可能性があるため、構造異常(RaceResultParseError)とは
 *   区別して RaceResultNotConfirmedError を投げる。#All_Result_Table 自体が無い場合は
 *   従来どおり RaceResultParseError(構造異常)。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import {
  PATTERNS,
  RACE_RESULT_HEADER_LABELS,
  RACE_RESULT_SELECTORS as SEL,
} from "./selectors.js";
import type { FinishPosition, RacePayoutEntry, RaceResult } from "./types.js";

/** レース結果のパース失敗(結果テーブル欠損・払戻の件数不整合等)を表す例外。 */
export class RaceResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceResultParseError";
  }
}

/**
 * 未確定レース(発走前・確定前)を表す例外。
 *
 * netkeiba の result.html は発走前・結果確定前のレースでも200で返り、
 * #All_Result_Table 自体は存在するが結果行(tbody 配下の tr)が0件になる。
 * これは構造変更・誤パースを示す RaceResultParseError とは原因が異なる
 * (パーサー・サイト構造は正常で、単に「まだ結果が無い」だけ)ため、
 * 呼び出し側が区別して扱えるよう別クラスとして投げる。
 */
export class RaceResultNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceResultNotConfirmedError";
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
 * 結果行から枠・馬番のセルを取り出す。枠・馬番はどちらも td.Num だが、枠セルは class に
 * Waku{n} を持つため、それを除外した td.Num を馬番セル、含む方を枠セルとして分ける。
 *
 * 想定形は「td.Num が2セル・うち1つが枠(Waku)、残り1つが馬番」。枠クラスが落ちる等で
 * この前提が崩れると枠番を馬番として silent 採用しかねないため、逸脱時は loud に失敗させる
 * (方針: 行を捨てない/構造異常を隠さない)。この構造チェック自体は umaban・wakuban で共有する
 * (umaban の抽出に必須の前提であり、いずれかだけ緩めると取り違えリスクが残るため)。
 */
function resolveNumCells(
  $: CheerioAPI,
  $row: ReturnType<CheerioAPI>,
): { umabanCell: ReturnType<CheerioAPI>; wakuCell: ReturnType<CheerioAPI> } {
  const numCells = $row.find(SEL.numCell).toArray();
  const umabanCells = numCells.filter(
    (cell) => !PATTERNS.wakuClass.test($(cell).attr("class") ?? ""),
  );
  const wakuCells = numCells.filter((cell) =>
    PATTERNS.wakuClass.test($(cell).attr("class") ?? ""),
  );
  if (numCells.length !== 2 || wakuCells.length !== 1 || umabanCells.length !== 1) {
    throw new RaceResultParseError(
      `結果行の馬番セル構成が想定外です(td.Num=${numCells.length}, Waku=${wakuCells.length})`,
    );
  }
  return { umabanCell: $(umabanCells[0]!), wakuCell: $(wakuCells[0]!) };
}

/** 馬番セルを数値化する。数字として解釈できない場合は構造異常として失敗させる(方針踏襲)。 */
function umabanOf($cell: ReturnType<CheerioAPI>): number {
  const t = normalizeText($cell.text());
  if (!/^[0-9]+$/.test(t)) {
    throw new RaceResultParseError(
      `馬番を数値として解釈できませんでした(値: "${t}")`,
    );
  }
  return Number(t);
}

/**
 * 枠セルを数値化する。umaban とは異なり、セルのテキストが空・非数値でも構造異常として
 * throw はせず null にフォールバックする(枠は補助情報のため。仕様の非throwフォールバック方針)。
 */
function wakubanOf($cell: ReturnType<CheerioAPI>): number | null {
  const t = normalizeText($cell.text());
  return /^[0-9]+$/.test(t) ? Number(t) : null;
}

/** 数値セルを number | null にする(空・非数値は null。parse-horse-results の numberOrNull と同流儀)。 */
function numberOrNull(raw: string): number | null {
  const t = normalizeText(raw);
  if (t === "" || t === "-") {
    return null;
  }
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/**
 * 通過順位セル(例: 2-2-4-2)を数値配列にする。空・非数値は空配列。
 * parse-horse-results の toPassing と同流儀(区切り文字は PATTERNS.passingSeparator を共用)。
 */
function toPassing(raw: string): number[] {
  const t = normalizeText(raw);
  if (t === "" || t === "-") {
    return [];
  }
  return t
    .split(PATTERNS.passingSeparator)
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

/**
 * 結果テーブルのヘッダ行(thead)のテキスト一覧を取得する。ヘッダ行が無い場合は空配列
 * (このときは呼び出し側で列インデックスが解決できず、対象フィールドが非throwフォールバックする)。
 */
function headerTexts($: CheerioAPI, $table: ReturnType<CheerioAPI>): string[] {
  return $table
    .find(SEL.headerRow)
    .first()
    .find(SEL.headerCell)
    .toArray()
    .map((th) => normalizeText($(th).text()));
}

/** ヘッダテキスト一覧からラベルに一致する列インデックスを解決する。見つからなければ null。 */
function columnIndexOf(headers: string[], label: string): number | null {
  const idx = headers.indexOf(label);
  return idx === -1 ? null : idx;
}

/**
 * 列インデックスで読むフィールド(後3F・コーナー通過順)向けのガード。
 * 行の td 数がヘッダ th 数と一致する場合のみ true を返す。
 *
 * 取消・除外等で行途中の td が1個でも欠けると後続列が前へズレ、列インデックス自体は
 * 合っていても実際には隣の列の値を拾ってしまう(silent なデータ破損)。この不一致を
 * 検知した行では、呼び出し側が対象フィールドを読み取らず null/空配列にフォールバックする
 * (parse-horse-results と異なり throw はしない。行自体は破棄しないため)。
 */
function columnsAligned(
  $cells: ReturnType<CheerioAPI>,
  expectedColumnCount: number,
): boolean {
  return expectedColumnCount > 0 && $cells.length === expectedColumnCount;
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

  // 後3F・コーナー通過順の列インデックスをヘッダテキストから解決する(1テーブルにつき1回)。
  // ヘッダ行が無い、または該当ラベルが見つからない場合は null(非throwフォールバック)。
  const headers = headerTexts($, $table);
  const expectedColumnCount = headers.length;
  const last3fIndex = columnIndexOf(headers, RACE_RESULT_HEADER_LABELS.last3f);
  const passingIndex = columnIndexOf(headers, RACE_RESULT_HEADER_LABELS.passing);

  const horses: RaceResult["horses"] = [];
  $table.find(SEL.resultRow).each((_, row) => {
    const $row = $(row);
    // 馬番・枠が想定形で取れない結果行は構造異常として resolveNumCells が例外を投げる
    // (silentに捨てない)。
    const { umabanCell, wakuCell } = resolveNumCells($, $row);
    const umaban = umabanOf(umabanCell);
    const wakuban = wakubanOf(wakuCell);
    const $name = $row.find(SEL.horseNameLink).first();
    const horseName = normalizeText($name.attr("title") ?? $name.text());

    // 位置ベースのデータセル(後3F・コーナー通過順)。列インデックスが解決できない場合に加え、
    // この行の td 数がヘッダ th 数と一致しない場合(取消・除外等で中間セルが欠けて後続列が
    // ズレている可能性がある)も、ズレた別列の値を silent に拾わず null・空配列にする。
    const $cells = $row.find(SEL.dataCell);
    const aligned = columnsAligned($cells, expectedColumnCount);
    const last3f =
      last3fIndex === null || !aligned
        ? null
        : numberOrNull($cells.eq(last3fIndex).text());
    const passing =
      passingIndex === null || !aligned
        ? []
        : toPassing($cells.eq(passingIndex).text());

    horses.push({
      umaban,
      finishPosition: toFinishPosition($row.find(SEL.finishRank).first().text()),
      horseName,
      wakuban,
      passing,
      last3f,
    });
  });

  // 結果テーブルはあるのに結果行が1件も取れない場合、原因は主に2通りある:
  // (a) 発走前・確定前で netkeiba がまだ結果行を出していない(#All_Result_Table はあるが
  //     tbody が空。200で返り、構造自体は正常)。
  // (b) サイト構造の変更・誤パース(本来は行があるはずなのに取れていない)。
  // (a) を (b) と同じ「構造異常」として扱うと、取込前に検証できない未確定レースを
  // 押しただけでUIが赤エラーになってしまう。(b) と区別できる決定的な判定はできないため、
  // 「行0件」はまず (a) とみなし、呼び出し側が区別して扱えるよう別例外を投げる
  // (silentに空配列で隠しはしない。parseShutubaの出走馬0頭チェックと同じ方針で失敗はさせる)。
  if (horses.length === 0) {
    throw new RaceResultNotConfirmedError(
      "結果テーブル(#All_Result_Table)はありますが結果行がありません(発走前・確定前の可能性があります)",
    );
  }

  return {
    horses,
    placePayouts: parsePayoutRow($, SEL.placeRow, "複勝"),
    winPayouts: parsePayoutRow($, SEL.winRow, "単勝"),
  };
}
