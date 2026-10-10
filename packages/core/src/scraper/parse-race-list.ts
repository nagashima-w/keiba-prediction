/**
 * レース一覧サブHTML(race_list_sub)のパーサー。
 *
 * 開催日ページのフラグメントHTMLから、当日の各レースの要約を抽出する。
 * セレクタ・正規表現は selectors.ts に集約し、本ファイルはその解釈のみを行う。
 */

import * as cheerio from "cheerio";
import { centralGradeFromClassNames } from "./grade-label.js";
import { InvalidIdError, parseRaceId, venueKindOfRaceId } from "./ids.js";
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
 * 一覧のデータ枠のテキストから、発走時刻を `HH:MM`(ゼロ詰め)で取り出す。無い・範囲外(0〜23 時・0〜59 分の外)は undefined。
 * 範囲外を落とすのは、cloud の `startTimeEpochMs` が `00:00〜23:59` 以外で投げるため(壊れた表記で定時の予約を落とさない)。
 */
function toStartTime(dataText: string): string | undefined {
  const match = PATTERNS.raceListStartTime.exec(dataText);
  if (match === null) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
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
      // 場コードが対象外(帯広ばんえい等)の項目は一覧から除外する(silentにスキップ)。
      // 一覧パースは「構造として完全な項目のみ列挙する」既存方針(距離不明行等も同様にスキップ)
      // に沿った振る舞いであり、個別の理由を区別する必要はない。
      let raceId;
      try {
        raceId = parseRaceId(raceIdMatch[1]!);
      } catch (error) {
        if (error instanceof InvalidIdError) {
          return;
        }
        throw error;
      }

      // コース種別・距離: データ枠のテキストから抽出(障害はclassが付かないため)。
      const dataText = $item.find(SEL.raceData).text();
      const cdMatch = PATTERNS.courseAndDistance.exec(dataText);
      if (!cdMatch) {
        return; // 距離情報の無い項目(集計行など)はスキップ。
      }
      const courseType = toCourseType(cdMatch[1]!);
      const distance = Number(cdMatch[2]!);

      // 頭数。中央は span.RaceList_Itemnumber でラップされるが、地方(NAR)はラップの無い
      // プレーンテキストで入るため、共通のデータ枠テキスト(dataText)から正規表現で取り出す
      // (どちらの構造でも dataText に頭数の文言が含まれる)。
      const entryCount = Number(PATTERNS.entryCount.exec(dataText)?.[1] ?? "0");

      // レース番号(例: 11R)。
      const raceNumber = Number(
        PATTERNS.raceNumber.exec($item.find(SEL.raceNumber).text())?.[1] ?? "0",
      );

      // 発走時刻(Issue #202)。中央・地方とも、データ枠のテキストに含まれる `H:MM`/`HH:MM`。空の行(発走後に取得した中央の一覧)・範囲外の値は undefined(キーを持たない)。
      const startTime = toStartTime(dataText);

      // レース名(切り詰められている場合あり)。
      const name = $item.find(SEL.itemTitle).text().trim();

      // グレードラベル。地方(テキスト方式)は生テキストのまま: 存在しない/複数存在する場合は先頭のspanを採用し、
      // 内テキストが空なら undefined にする(空文字を拾わない)。
      // 中央は画像アイコン方式で内テキストが空のため、レース名の横のアイコンのクラス番号から読む(Issue #250。
      // 実測した重賞の番号だけがラベルになる=grade-label.ts)。番号の表は中央専用なので、地方の行には当てない。
      const textGrade = $item.find(SEL.grade).first().text().trim() || undefined;
      const grade =
        textGrade ??
        (venueKindOfRaceId(raceId) === "central"
          ? centralGradeFromClassNames($item.find(SEL.gradeIcon).map((___, el) => $(el).attr("class") ?? "").get())
          : undefined);

      entries.push({
        raceId,
        name,
        courseType,
        distance,
        entryCount,
        venue,
        raceNumber,
        ...(startTime !== undefined ? { startTime } : {}),
        grade,
      });
    });
  });

  return entries;
}
