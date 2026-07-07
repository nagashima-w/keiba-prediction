/**
 * 全戦績(ajax_horse_results)のパーサー。
 *
 * APIレスポンスは `{status:"OK", data:"<HTMLフラグメント>"}`。status を検証してから
 * data 内の戦績テーブル(db_h_race_results、1行=1走・33セル)をパースする。
 * 列構成は docs/phase1-scraping-plan.md「戦績HTMLフラグメントの列構成」を参照。
 *
 * 空セル・欠損(海外・地方の変則行など)は個別 null 許容とする。ただし行のセル数が
 * ヘッダ列数と一致しない「行全体が壊れている」場合は silent に捨てず失敗させる(方針踏襲)。
 *
 * 着順は「中止」「除外」等の非数値があり得るため、数値順位か種別かを判別可能な型で返す
 * (スコアリングでの除外判定に使う)。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { parseRaceId, type RaceId } from "./ids.js";
import { HORSE_RESULTS_SELECTORS as SEL, PATTERNS } from "./selectors.js";
import type {
  BodyWeight,
  CourseType,
  FinishPosition,
  HorseRaceResult,
  RaceVenue,
  VenueKind,
} from "./types.js";

/** 戦績テーブルの列インデックス(33列構成)。 */
const COL = {
  date: 0,
  venue: 1,
  weather: 2,
  raceNumber: 3,
  raceName: 4,
  entryCount: 6,
  wakuban: 7,
  umaban: 8,
  odds: 9,
  ninki: 10,
  finish: 11,
  jockey: 12,
  kinryo: 13,
  distance: 14,
  trackCondition: 16,
  time: 18,
  margin: 19,
  passing: 25,
  pace: 26,
  last3f: 27,
  bodyWeight: 28,
  winner: 31,
} as const;

/** 全戦績のパース失敗(構造不一致・壊れた行等)を表す例外。 */
export class HorseResultsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HorseResultsParseError";
  }
}

/** APIレスポンスのJSON構造(必要部分のみ)。 */
interface ResultsResponse {
  status?: unknown;
  data?: unknown;
}

/** 空文字・"&nbsp;"・"-" のみのセルを null に、それ以外はトリム文字列を返す。 */
function textOrNull(raw: string): string | null {
  const t = raw.replace(/ /g, " ").trim();
  if (t === "" || t === "-") {
    return null;
  }
  return t;
}

/** 数値セルを number | null にする(非数値・空は null)。 */
function numberOrNull(raw: string): number | null {
  const t = textOrNull(raw);
  if (t === null) {
    return null;
  }
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** 着順セルを判別可能な型に変換する。 */
function toFinishPosition(raw: string): FinishPosition | null {
  const t = textOrNull(raw);
  if (t === null) {
    return null;
  }
  if (/^[0-9]+$/.test(t)) {
    return { kind: "順位", value: Number(t) };
  }
  // 降着表記(例: 5(降))は確定順位を保持し、降着フラグを立てる。
  const demoted = PATTERNS.demotedFinish.exec(t);
  if (demoted) {
    return { kind: "順位", value: Number(demoted[1]!), demoted: true };
  }
  return { kind: "非数値", text: t };
}

/** 開催セル(例: 2福島2)を回次・会場・日目に分解する。 */
function toVenue(raw: string): RaceVenue | null {
  const t = textOrNull(raw);
  if (t === null) {
    return null;
  }
  const m = PATTERNS.venueRound.exec(t);
  if (!m) {
    // 分解できない表記(海外開催名など)は raw のみ保持する。
    return { round: null, name: t, day: null, raw: t };
  }
  return {
    round: Number(m[1]!),
    name: m[2]!,
    day: Number(m[3]!),
    raw: t,
  };
}

/** コース種別文字をドメイン型に対応付ける。未知は null。 */
function toCourseType(raw: string): CourseType | null {
  return raw === "芝" || raw === "ダ" || raw === "障" ? raw : null;
}

/** 距離セル(例: ダ1700)をコース種別と距離に分解する。 */
function toCourseAndDistance(raw: string): {
  courseType: CourseType | null;
  distance: number | null;
} {
  const t = textOrNull(raw);
  if (t === null) {
    return { courseType: null, distance: null };
  }
  const m = PATTERNS.courseAndDistanceCompact.exec(t);
  if (!m) {
    return { courseType: null, distance: null };
  }
  return { courseType: toCourseType(m[1]!), distance: Number(m[2]!) };
}

/** 通過順位セル(例: 5-4-8-6)を数値配列にする。空は空配列。 */
function toPassing(raw: string): number[] {
  const t = textOrNull(raw);
  if (t === null) {
    return [];
  }
  return t
    .split(PATTERNS.passingSeparator)
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

/** 馬体重セル(例: 496(+2))を分解する。未計量等は null。 */
function toBodyWeight(raw: string): BodyWeight | null {
  const normalized = raw.replace(/\s+/g, "");
  const m = PATTERNS.weight.exec(normalized);
  if (!m) {
    return null;
  }
  return { weight: Number(m[1]!), diff: Number(m[2]!) };
}

/** レース名セルの分類結果(区分・検証済みID・生ID)。 */
interface RaceClassification {
  /** 中央として妥当な12桁ID(場コード01〜10)のみ入る。それ以外は null。 */
  readonly raceId: RaceId | null;
  /** 取得できた生の12桁数値ID(海外の英字混じり・リンク欠損は null)。 */
  readonly raceIdRaw: string | null;
  /** 開催区分。 */
  readonly venueKind: VenueKind;
}

/**
 * レース名セルのリンクIDから開催区分とレースIDを判定する。
 *
 * 判定基準(リンクIDのみに基づく。会場名テキストとは独立):
 * - 12桁数値ID かつ 場コード(5〜6桁目)が 01〜10 → 中央(RaceId 型を入れる)
 * - 12桁数値ID かつ 場コードが範囲外(船橋43・大井44・門別30 等) → 地方(生IDのみ保持)
 * - 12桁数値IDとして取得できない(英字混じり `2026J0010109`・リンク欠損) → 海外
 *
 * 設計判断: リンク欠損行は場コードを判定できないため海外に区分する(基準の「IDなし=海外」に従う)。
 * 中央走はレース名リンクが必ず付くため実害は小さいが、リンク欠損中央走が将来現れた場合は
 * 海外へ誤分類され得る点をトレードオフとして受容する。行そのものは常に保持する。
 */
function classifyRace($cell: ReturnType<CheerioAPI>): RaceClassification {
  const href = $cell.find("a").first().attr("href") ?? "";
  const raw = PATTERNS.raceIdSegmentFromRacePath.exec(href)?.[1];
  // 12桁の半角数字でなければ(英字混じり・リンク欠損)海外扱い。
  if (raw === undefined || !/^[0-9]{12}$/.test(raw)) {
    return { raceId: null, raceIdRaw: null, venueKind: "海外" };
  }
  const trackCode = Number(raw.slice(4, 6));
  if (trackCode >= 1 && trackCode <= 10) {
    // 場コードは中央範囲でも、レース番号(下2桁)が01〜12外だと parseRaceId は失敗する。
    // その場合でも行は捨てず、raceId のみ null にフォールバックして生値(raceIdRaw)を保持する。
    try {
      return { raceId: parseRaceId(raw), raceIdRaw: raw, venueKind: "中央" };
    } catch {
      return { raceId: null, raceIdRaw: raw, venueKind: "中央" };
    }
  }
  return { raceId: null, raceIdRaw: raw, venueKind: "地方" };
}

/**
 * 全戦績のAPI JSON文字列をパースする。
 *
 * @param json ajax_horse_results のJSON文字列
 * @returns 1走ずつの戦績配列(HTML上の並び=新しい順)
 */
export function parseHorseResults(json: string): HorseRaceResult[] {
  let parsed: ResultsResponse;
  try {
    parsed = JSON.parse(json) as ResultsResponse;
  } catch {
    throw new HorseResultsParseError("JSONとして解釈できませんでした");
  }

  if (parsed.status !== "OK") {
    throw new HorseResultsParseError(
      `status が "OK" ではありません(status: ${JSON.stringify(parsed.status)})`,
    );
  }
  if (typeof parsed.data !== "string") {
    throw new HorseResultsParseError("data がHTMLフラグメント文字列ではありません");
  }

  const $ = cheerio.load(parsed.data);
  const $table = $(SEL.table).first();
  if ($table.length === 0) {
    throw new HorseResultsParseError(
      "戦績テーブル(db_h_race_results)が見つかりませんでした",
    );
  }

  // ヘッダ列数を基準にする(行のセル数がこれと一致しない=壊れた行)。
  const columnCount = $table.find(SEL.row).first().find(SEL.headerCell).length;
  if (columnCount === 0) {
    throw new HorseResultsParseError("戦績テーブルのヘッダ列を認識できませんでした");
  }

  const results: HorseRaceResult[] = [];
  $table.find(SEL.row).each((_, row) => {
    const $cells = $(row).find(SEL.dataCell);
    if ($cells.length === 0) {
      return; // ヘッダ行(td を持たない)はスキップ。
    }
    if ($cells.length !== columnCount) {
      // 行全体が壊れている(想定列数と不一致)。silentに捨てず失敗させる。
      throw new HorseResultsParseError(
        `戦績の行のセル数(${$cells.length})がヘッダ列数(${columnCount})と一致しません`,
      );
    }
    results.push(parseRow($, $cells));
  });

  return results;
}

/** 1データ行(td群)から1走分を抽出する。 */
function parseRow(
  $: CheerioAPI,
  $cells: ReturnType<CheerioAPI>,
): HorseRaceResult {
  const text = (index: number): string => $cells.eq(index).text();
  const { courseType, distance } = toCourseAndDistance(text(COL.distance));

  const $jockey = $cells.eq(COL.jockey);
  const jockeyId =
    PATTERNS.jockeyIdFromHref.exec($jockey.find("a").first().attr("href") ?? "")?.[1] ??
    null;

  const classification = classifyRace($cells.eq(COL.raceName));

  return {
    date: textOrNull(text(COL.date)),
    venue: toVenue(text(COL.venue)),
    weather: textOrNull(text(COL.weather)),
    raceNumber: numberOrNull(text(COL.raceNumber)),
    raceName: textOrNull(text(COL.raceName)),
    raceId: classification.raceId,
    raceIdRaw: classification.raceIdRaw,
    venueKind: classification.venueKind,
    entryCount: numberOrNull(text(COL.entryCount)),
    wakuban: numberOrNull(text(COL.wakuban)),
    umaban: numberOrNull(text(COL.umaban)),
    odds: numberOrNull(text(COL.odds)),
    ninki: numberOrNull(text(COL.ninki)),
    finishPosition: toFinishPosition(text(COL.finish)),
    jockeyName: textOrNull($jockey.text()),
    jockeyId,
    kinryo: numberOrNull(text(COL.kinryo)),
    courseType,
    distance,
    trackCondition: textOrNull(text(COL.trackCondition)),
    time: textOrNull(text(COL.time)),
    margin: numberOrNull(text(COL.margin)),
    passing: toPassing(text(COL.passing)),
    pace: textOrNull(text(COL.pace)),
    last3f: numberOrNull(text(COL.last3f)),
    bodyWeight: toBodyWeight(text(COL.bodyWeight)),
    winnerName: textOrNull($cells.eq(COL.winner).text()),
  };
}
