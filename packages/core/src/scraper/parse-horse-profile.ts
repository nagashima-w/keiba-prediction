/**
 * 馬プロフィール(db.netkeiba.com/horse/{id}/)のパーサー。
 *
 * ページ見出しの馬名と `db_prof_table`(生年月日・調教師・通算成績など)を抽出する。
 * セレクタ・正規表現は selectors.ts に集約し、本ファイルはその解釈のみを行う。
 *
 * 馬IDはページ本文の各リンク(近親馬など他馬IDも混在する)から拾うと取り違えるため、
 * 呼び出し側が db/horse/{id}/ の取得に使った検証済みIDをそのまま受け取る。
 *
 * 厩舎所在地は美浦/栗東が代表値だが、地方・海外所属では他の表記があり得るため、
 * 既知値に丸めず取得文字列をそのまま保持する(取得不可時のみ null)。
 *
 * 注: comment(陣営コメント)パーサーは実装しない。本文はプレミアム限定で無料では
 * 取得できないため(docs/phase1-scraping-plan.md「厩舎コメント」)。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { HorseId } from "./ids.js";
import { HORSE_PROFILE_SELECTORS as SEL, PATTERNS } from "./selectors.js";
import type { HorseProfile } from "./types.js";

/** 馬プロフィールのパース失敗(構造不一致等)を表す例外。 */
export class HorseProfileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HorseProfileParseError";
  }
}

/**
 * db_prof_table の各行を見出し(th)→データ(td)のマップにする。
 * 同名見出しは最初の1件を採用する。
 */
function readProfileRows($: CheerioAPI): Map<string, ReturnType<CheerioAPI>> {
  const rows = new Map<string, ReturnType<CheerioAPI>>();
  $(SEL.profTable)
    .first()
    .find("tr")
    .each((_, tr) => {
      const $tr = $(tr);
      const label = $tr.find(SEL.rowHeader).first().text().trim();
      if (label && !rows.has(label)) {
        rows.set(label, $tr.find(SEL.rowData).first());
      }
    });
  return rows;
}

/**
 * 馬プロフィールHTMLをパースする。
 *
 * @param html db/horse/{id}/ のHTML文字列(EUC-JPデコード済みUTF-8)
 * @param horseId 取得に用いた検証済み馬ID
 * @returns 馬プロフィール
 */
export function parseHorseProfile(
  html: string,
  horseId: HorseId,
): HorseProfile {
  const $ = cheerio.load(html);

  const name = $(SEL.name).first().text().trim();
  const $table = $(SEL.profTable).first();
  // 見出しもプロフィール表も無いのは構造変更・誤取得の兆候。silentに空で返さず失敗させる。
  if (name === "" && $table.length === 0) {
    throw new HorseProfileParseError(
      "馬名見出しも db_prof_table も見つかりませんでした",
    );
  }

  const rows = readProfileRows($);

  const birthDate = rows.get("生年月日")?.text().trim() || null;

  // 調教師セル: <a href="/trainer/{id}/">名前</a> (所在地)。
  const $trainerCell = rows.get("調教師");
  let trainerName: string | null = null;
  let trainerId: string | null = null;
  let stableLocation: string | null = null;
  if ($trainerCell) {
    const $link = $trainerCell.find(SEL.trainerLink).first();
    if ($link.length > 0) {
      trainerName = ($link.attr("title") ?? $link.text()).trim() || null;
      trainerId =
        PATTERNS.trainerIdFromProfileHref.exec($link.attr("href") ?? "")?.[1] ??
        null;
    }
    // 所在地は括弧内(例: (美浦) / (仏))。丸めず取得文字列を保持する。
    stableLocation =
      PATTERNS.parenContent.exec($trainerCell.text())?.[1]?.trim() || null;
  }

  const totalResults = rows.get("通算成績")?.text().replace(/\s+/g, " ").trim() || null;

  return {
    horseId,
    name,
    birthDate,
    trainerName,
    trainerId,
    stableLocation,
    totalResults,
  };
}
