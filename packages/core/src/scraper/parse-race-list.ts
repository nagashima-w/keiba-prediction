/**
 * レース一覧サブHTML(race_list_sub)のパーサー。
 *
 * 開催日ページのフラグメントHTMLから、当日の各レースの要約を抽出する。
 * セレクタ・正規表現は selectors.ts に集約し、本ファイルはその解釈のみを行う。
 */

import * as cheerio from "cheerio";
import { parseRaceId } from "./ids.js";
import { PATTERNS, RACE_LIST_SELECTORS as SEL } from "./selectors.js";
import type { CourseType, RaceListEntry } from "./types.js";

/** コース種別文字をドメイン型に対応付ける。 */
function toCourseType(raw: string): CourseType {
  switch (raw) {
    case "芝":
    case "ダ":
    case "障":
      return raw;
    default:
      // 正規表現側で3種のみ捕捉するため、ここには到達しない想定。
      throw new Error(`未知のコース種別です: ${raw}`);
  }
}

/**
 * レース一覧サブHTMLをパースして、当日の各レース要約の配列を返す。
 *
 * - 会場ごとの `dl` グループを走査し、その見出しから会場名を取り出す
 * - 各 `li` からレースID・レース名・コース種別・距離・頭数・レース番号を抽出する
 * - 対象要素が存在しないHTML(空・無関係)では空配列を返す
 *
 * @param html race_list_sub のHTML文字列(デコード済みUTF-8)
 * @returns レース要約の配列(HTML上の並び順)
 */
export function parseRaceList(html: string): RaceListEntry[] {
  const $ = cheerio.load(html);
  const entries: RaceListEntry[] = [];

  $(SEL.group).each((_, group) => {
    const $group = $(group);

    // 会場名は見出しから <small>(回次・日次)を除いた本文とする。
    const $title = $group.find(SEL.groupTitle).clone();
    $title.find(SEL.titleAnnotation).remove();
    const venue = $title.text().trim() || undefined;

    $group.find(SEL.item).each((__, item) => {
      const $item = $(item);

      // レースID: race_id を含むリンクの href から抽出。
      const href = $item.find(SEL.itemLink).first().attr("href") ?? "";
      const raceIdMatch = PATTERNS.raceIdFromHref.exec(href);
      if (!raceIdMatch) {
        return; // レースリンクの無い項目はスキップ。
      }
      const raceId = parseRaceId(raceIdMatch[1]!);

      // コース種別・距離: データ枠のテキストから抽出(障害はclassが付かないため)。
      const dataText = $item.find(SEL.raceData).text();
      const cdMatch = PATTERNS.courseAndDistance.exec(dataText);
      if (!cdMatch) {
        return; // 距離情報の無い項目(集計行など)はスキップ。
      }
      const courseType = toCourseType(cdMatch[1]!);
      const distance = Number(cdMatch[2]!);

      // 頭数。
      const entryCountText = $item.find(SEL.entryCount).text();
      const entryCount = Number(
        PATTERNS.entryCount.exec(entryCountText)?.[1] ?? "0",
      );

      // レース番号(例: 11R)。
      const raceNumber = Number(
        PATTERNS.raceNumber.exec($item.find(SEL.raceNumber).text())?.[1] ?? "0",
      );

      // レース名(切り詰められている場合あり)。
      const name = $item.find(SEL.itemTitle).text().trim();

      entries.push({
        raceId,
        name,
        courseType,
        distance,
        entryCount,
        venue,
        raceNumber,
      });
    });
  });

  return entries;
}
