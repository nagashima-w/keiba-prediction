/**
 * 出馬表(shutuba.html)のパーサー。
 *
 * ページ上部のレース情報と、各出走馬の枠・馬番・馬名・horse_id・性齢・斤量・
 * 騎手(jockey_id)・厩舎所在地・調教師(trainer_id)・馬体重(増減)を抽出する。
 * セレクタ・正規表現は selectors.ts に集約し、本ファイルはその解釈のみを行う。
 *
 * 出走頭数は最大18頭(上限であり、少頭数のレースも普通にある)。
 * 頭数は固定値と仮定せず、実データ行の数だけ動的にパースする。
 * 枠番(1〜8)・馬番(1〜18)の範囲外は構造変更や誤パースの兆候として
 * ShutubaParseError で失敗させる(データの取りこぼしを silent に隠さない方針)。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { parseHorseId } from "./ids.js";
import { PATTERNS, SHUTUBA_SELECTORS as SEL } from "./selectors.js";
import type {
  BodyWeight,
  CourseType,
  Shutuba,
  ShutubaHorse,
  ShutubaRaceInfo,
} from "./types.js";

/** 枠番の上限(1〜8)。 */
const MAX_WAKUBAN = 8;
/** 馬番の上限(1〜18)。 */
const MAX_UMABAN = 18;

/** 出馬表のパース失敗(構造不一致・範囲外データ等)を表す例外。 */
export class ShutubaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShutubaParseError";
  }
}

/** コース種別文字をドメイン型に対応付ける。 */
function toCourseType(raw: string): CourseType {
  switch (raw) {
    case "芝":
    case "ダ":
    case "障":
      return raw;
    default:
      throw new ShutubaParseError(`未知のコース種別です: ${raw}`);
  }
}

/**
 * 芝コース区分(柵)を抽出する。芝以外(ダート・障害)は概念が無いため undefined。
 * 芝でも「芝XXXXm」直後の括弧が無い・括弧内に柵letterが無い場合は判別不能として null。
 */
function parseFence(courseType: CourseType, data01: string): string | null | undefined {
  if (courseType !== "芝") {
    return undefined;
  }
  const parenContent = PATTERNS.turfFenceParen.exec(data01)?.[1];
  if (parenContent === undefined) {
    return null;
  }
  return PATTERNS.fenceLetterToken.exec(parenContent)?.[1] ?? null;
}

/** レース情報(ページ上部)を抽出する。 */
function parseRaceInfo($: CheerioAPI): ShutubaRaceInfo {
  const raceName = $(SEL.raceName).first().text().trim();
  const data01 = $(SEL.raceData01).first().text();

  const cdMatch = PATTERNS.courseAndDistance.exec(data01);
  if (!cdMatch) {
    throw new ShutubaParseError(
      "レース情報からコース種別・距離を抽出できませんでした",
    );
  }
  const courseType = toCourseType(cdMatch[1]!);
  const distance = Number(cdMatch[2]!);

  const startTime = PATTERNS.startTime.exec(data01)?.[1];
  const weather = PATTERNS.weather.exec(data01)?.[1];
  const trackCondition = PATTERNS.trackCondition.exec(data01)?.[1];
  const fence = parseFence(courseType, data01);

  return {
    raceName,
    courseType,
    distance,
    ...(startTime !== undefined ? { startTime } : {}),
    ...(weather !== undefined ? { weather } : {}),
    ...(trackCondition !== undefined ? { trackCondition } : {}),
    ...(fence !== undefined ? { fence } : {}),
  };
}

/** 馬体重表記(例: 464(-8))を分解する。未発表相当は null を返す。 */
function parseBodyWeight(raw: string): BodyWeight | null {
  const normalized = raw.replace(/\s+/g, "");
  const m = PATTERNS.weight.exec(normalized);
  if (!m) {
    // 「計不」「--」等の未発表表記は null(体重情報なし)として扱う。
    return null;
  }
  return { weight: Number(m[1]!), diff: Number(m[2]!) };
}

/**
 * 厩舎所在地ラベルを整形する。
 *
 * 中央は美浦/栗東が代表値だが、地方(NAR)では所属会場名(高知・浦和など)が入るため、
 * 値を丸めず取得した文字列をそのまま保持する(HorseProfile.stableLocation と同じ方針。
 * 詳細: docs/nar-scraping-plan.md)。ラベル自体が空(構造異常)の場合のみ失敗させる。
 */
function toStableLocation(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ShutubaParseError("厩舎所在地ラベルが空です");
  }
  return trimmed;
}

/** cheerio の選択結果(1要素をラップした Cheerio オブジェクト)の型。 */
type CheerioSelection = ReturnType<CheerioAPI>;

/** 1行(tr.HorseList)をラップした Cheerio から1頭分のデータを抽出する。 */
function parseHorseRow($r: CheerioSelection): ShutubaHorse {
  const wakubanText = $r.find(SEL.waku).first().text().trim();
  const umabanText = $r.find(SEL.umaban).first().text().trim();
  const wakuban = Number(wakubanText);
  const umaban = Number(umabanText);
  if (!Number.isInteger(wakuban) || wakuban < 1 || wakuban > MAX_WAKUBAN) {
    throw new ShutubaParseError(
      `枠番は1〜${MAX_WAKUBAN}の範囲である必要があります(抽出値: "${wakubanText}")`,
    );
  }
  if (!Number.isInteger(umaban) || umaban < 1 || umaban > MAX_UMABAN) {
    throw new ShutubaParseError(
      `馬番は1〜${MAX_UMABAN}の範囲である必要があります(抽出値: "${umabanText}")`,
    );
  }

  // 馬名+horse_id。
  const $horse = $r.find(SEL.horseLink).first();
  const name = ($horse.attr("title") ?? $horse.text()).trim();
  const horseHref = $horse.attr("href") ?? "";
  const horseIdRaw = PATTERNS.horseIdFromHref.exec(horseHref)?.[1];
  if (horseIdRaw === undefined) {
    throw new ShutubaParseError(
      `馬IDを抽出できませんでした(href: "${horseHref}")`,
    );
  }
  const horseId = parseHorseId(horseIdRaw);

  // 性齢(例: 牝3)。中央/地方でclassが異なる(Barei有無)ため、
  // horseInfoセルの直後のtdを性齢セルとして位置ベースで取る(中央・地方で共通)。
  const $barei = $r.find(SEL.horseInfo).first().next("td");
  const bareiText = $barei.text().trim();
  const saMatch = PATTERNS.sexAndAge.exec(bareiText);
  if (!saMatch) {
    throw new ShutubaParseError(
      `性齢を分解できませんでした(抽出値: "${bareiText}")`,
    );
  }
  const sex = saMatch[1]!;
  const age = Number(saMatch[2]!);

  // 斤量: 性齢セルの直後のtd(位置依存)。
  const kinryo = Number($barei.next(SEL.kinryoCell).text().trim());

  // 騎手。リンク(jockey_id)が無い行(騎手未定など)では jockeyId は null。
  const $jockey = $r.find(SEL.jockeyLink).first();
  const jockeyName = ($jockey.attr("title") ?? $jockey.text()).trim();
  const jockeyId =
    PATTERNS.jockeyIdFromHref.exec($jockey.attr("href") ?? "")?.[1] ?? null;

  // 厩舎(所在地ラベル + 調教師)。調教師リンクが無い行では trainerId は null。
  const stableLocation = toStableLocation(
    $r.find(SEL.trainerLabel).first().text().trim(),
  );
  const $trainer = $r.find(SEL.trainerLink).first();
  const trainerName = ($trainer.attr("title") ?? $trainer.text()).trim();
  const trainerId =
    PATTERNS.trainerIdFromHref.exec($trainer.attr("href") ?? "")?.[1] ?? null;

  // 馬体重(増減)。未発表は null。
  const bodyWeight = parseBodyWeight($r.find(SEL.weight).first().text());

  return {
    wakuban,
    umaban,
    name,
    horseId,
    sex,
    age,
    kinryo,
    jockeyName,
    jockeyId,
    stableLocation,
    trainerName,
    trainerId,
    bodyWeight,
  };
}

/**
 * 出馬表HTMLをパースして、レース情報と出走馬の配列を返す。
 *
 * 実データ行は `td.HorseInfo` を含む `tr.HorseList` のみ(先頭の読み込みプレースホルダ行は除く)。
 * 頭数は行数から動的に決まる。枠番・馬番が範囲外の場合は ShutubaParseError を投げる。
 *
 * @param html shutuba.html のHTML文字列(デコード済みUTF-8)
 * @returns レース情報+出走馬
 */
export function parseShutuba(html: string): Shutuba {
  const $ = cheerio.load(html);
  const race = parseRaceInfo($);

  const horses: ShutubaHorse[] = [];
  $(SEL.horseRow).each((_, row) => {
    const $r = $(row);
    // 読み込み用ダミー行(HorseInfoを持たない)は実データ行ではない。
    if ($r.find(SEL.horseInfo).length === 0) {
      return;
    }
    horses.push(parseHorseRow($r));
  });

  // 出走馬が1頭も取れないのは構造変更・誤パースの兆候。silentに空配列で隠さず失敗させる。
  if (horses.length === 0) {
    throw new ShutubaParseError(
      "出走馬(td.HorseInfoを持つtr.HorseList)を1件も抽出できませんでした",
    );
  }

  // 馬番昇順に整列する(HTML上の並びに依存せず、常に馬番順で返す)。
  horses.sort((a, b) => a.umaban - b.umaban);

  return { race, horses };
}
