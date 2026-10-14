/**
 * 騎手の年度別成績(db.netkeiba.com/jockey/result.html?id=…。Issue #226)のパーサー。
 *
 * 1行=1年。年ごとの 1着・2着・3着・着外の回数から、騎乗数(starts)と3着内の回数(placed)を求める。
 * 「通算」の行は年ではないので含めない。
 *
 * ## 取れるデータの範囲(2026-10-11 の実測。docs/current-spec.md 参照)
 * 競馬場別・距離別などの内訳(`jockey/data_summary/{id}/`)はプレミアム限定で、ログインなしでは値が伏せ字
 * (`**`)になる。無料で取れるのはこの**年度別の全体成績**だけ(芝・ダート別は出走と勝利のみで、複勝は取れない)。
 * したがって scorer に渡す騎手成績は「当該コース」ではなく**全体**の複勝率になる(`JockeyCourseStats` の JSDoc)。
 *
 * ## 列の解決
 * 列位置は固定せず、1段目のヘッダ文言(`JOCKEY_RESULTS_HEADER_LABELS`)から求める(colspan を足し込んで数える)。
 * 年の行の途中に壊れた値(数でない・セル不足)があれば、黙って捨てず {@link JockeyResultsParseError} で失敗させる
 * (捨てると騎乗数を過小に見積もったまま補正が掛かるため。呼び出し側はその騎手だけ警告にして補正なしにする)。
 *
 * ## 中央と地方
 * 同じ URL の形で、地方は `&syusai=20` を付けたページが地方の成績(`urls.ts` の `jockeyResultsUrl`)。
 * このパーサは中央・地方を区別しない(渡されたページの表を読むだけ)。
 */

import * as cheerio from "cheerio";
import {
  JOCKEY_RESULTS_HEADER_LABELS as LABEL,
  JOCKEY_RESULTS_SELECTORS as SEL,
} from "./selectors.js";

/** 騎手の1年分の成績。 */
export interface JockeyYearRecord {
  /** 年(西暦4桁)。 */
  readonly year: number;
  /** その年の騎乗数(1着+2着+3着+着外)。 */
  readonly starts: number;
  /** うち3着以内の回数(1着+2着+3着)。 */
  readonly placed: number;
}

/** 騎手の年度別成績のパースに失敗したことを表す例外。 */
export class JockeyResultsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JockeyResultsParseError";
  }
}

/** セルのテキストを整える(空白を詰める)。 */
function cellText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 回数のセル(「1,234」のような千位区切りを含む)を非負整数にする。数でなければ null。 */
function toCount(text: string): number | null {
  const t = cellText(text).replace(/,/g, "");
  return /^\d+$/.test(t) ? Number(t) : null;
}

/**
 * 騎手の年度別成績ページから、年ごとの騎乗数と3着内の回数を取り出す(新しい年が先)。
 * 年の行が1つも無い(通算の行だけ。例: 中央の成績が無い騎手)ときは空配列。
 * @throws JockeyResultsParseError 表が無い・必要な列が無い・年の行が壊れている場合。
 */
export function parseJockeyResults(html: string): JockeyYearRecord[] {
  const $ = cheerio.load(html);
  const table = $(SEL.table).first();
  if (table.length === 0) {
    throw new JockeyResultsParseError("年度別成績の表が見つかりません");
  }
  const rows = table.find("tr").toArray();
  const headerRow = rows[0];
  if (headerRow === undefined) {
    throw new JockeyResultsParseError("年度別成績の表に行がありません");
  }

  // 1段目のヘッダ文言 → 列位置(colspan を足し込む)。
  const columnOf = new Map<string, number>();
  let col = 0;
  $(headerRow)
    .children("th,td")
    .each((_, el) => {
      const label = cellText($(el).text());
      if (!columnOf.has(label)) {
        columnOf.set(label, col);
      }
      const span = Number($(el).attr("colspan") ?? "1");
      col += Number.isInteger(span) && span >= 1 ? span : 1;
    });

  const needed = [LABEL.year, LABEL.first, LABEL.second, LABEL.third, LABEL.unplaced] as const;
  for (const label of needed) {
    if (!columnOf.has(label)) {
      throw new JockeyResultsParseError(`ヘッダに「${label}」の列がありません`);
    }
  }
  const yearCol = columnOf.get(LABEL.year)!;
  const countCols = [LABEL.first, LABEL.second, LABEL.third, LABEL.unplaced].map((l) => columnOf.get(l)!);
  const maxCol = Math.max(yearCol, ...countCols);

  const records: JockeyYearRecord[] = [];
  for (const row of rows.slice(1)) {
    const cells = $(row)
      .children("th,td")
      .toArray()
      .map((el) => cellText($(el).text()));
    const yearText = cells[yearCol];
    // 2段目のヘッダ(出走・勝利)と「通算」の行は年ではないので読まない。
    if (yearText === undefined || !/^\d{4}$/.test(yearText)) {
      continue;
    }
    if (cells.length <= maxCol) {
      throw new JockeyResultsParseError(
        `${yearText}年の行のセル数(${cells.length})がヘッダの列(${maxCol + 1}以上)より少ない`,
      );
    }
    const counts = countCols.map((c) => toCount(cells[c]!));
    if (counts.some((n) => n === null)) {
      throw new JockeyResultsParseError(`${yearText}年の行に数でない回数があります`);
    }
    const [first, second, third, unplaced] = counts as [number, number, number, number];
    records.push({
      year: Number(yearText),
      starts: first + second + third + unplaced,
      placed: first + second + third,
    });
  }
  return records;
}
