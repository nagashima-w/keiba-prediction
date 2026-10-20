/**
 * 外部の馬場の API(JRA の競馬場の最新の馬場状態を返す JSON)の応答の解析(Issue #294〈#293-A〉)。**純関数**: ネットワーク・D1・DO に触れない。
 *
 * ## 応答の形(見本: `fixtures/baba_latest_20261012.json`。2026-10-12 17:05 JST にユーザーが手元で取得したもの)
 * `{ fetchedAt, text, venues[] }`。`venues[]` の 1 件は `venueCode`・`venueName`・`measuredAt`・`cushion`・`turf`・`dirt`・`rainfallMm`・`usedCourse`・`turfLength`・`turfCondition`・`summary`。
 * `text` と各競馬場の `summary` は他の項目と重複するので使わない。
 *
 * ## 当日の競馬場だけを選ぶ
 * **開催していない競馬場の古い値も入る**(見本には、2026-10-12 の東京・京都と並んで、札幌の 9/6 の値が入っていた)。計測日が今日(JST)の競馬場だけを残す。
 * `measuredAt`(例: `10月12日（月曜）7時00分`)には**年が無い**。年は、取得日(JST の今日)の前後 182 日以内に入る年を {Y-1, Y, Y+1} から選ぶ
 * (同じ月日は約 365 日おきなので、候補は高々 1 つ。年またぎの古い値も当日と取り違えない)。さらに**曜日で検算**し、合わなければ捨てる(1 年前の同じ月日を当日と取り違えない)。
 * 年は **JST の年**で補う(UTC の年だと、`2026-12-31T15:30Z` = JST の元日 0:30 を誤る)。
 *
 * ## 捨てる・保存しない
 * - 全体の形が想定と違う(JSON でない・`fetchedAt` が無い・`venues` が配列でない)→ 何も保存しない(`not-json`・`shape-mismatch`)。
 * - `fetchedAt` の JST の日付が今日でない(API 側の古いキャッシュ)→ 何も保存しない(`stale`)。
 * - 競馬場 1 件の不正(場コードが JRA の 01〜10 でない・型が違う・数値が範囲外・計測日時が読めない・計測日が当日でない・場コードの重複)→ その 1 件だけ捨てて件数に数える。
 *   捨てた理由は {@link BabaDropReason} の 4 つに分け、場コードと計測日時の文字列(例: `10月17日（土曜）7時00分`)を {@link BabaDroppedDetail} として残す(Issue #360。診断用。競馬場の値や元の JSON は入れない)。
 *   数値の範囲(クッション値 0〜20・含水率 0〜100・降水量 0〜500)は私の目安: 見本の値は クッション値 7.8〜10.7・含水率 1.7〜13.2。外部の API の誤値が、後続(#295)で LLM に渡るのを避けるための歯止め。
 * - 見本に無い形(`turf`・`dirt` が null、降水量などの欠落)は NULL として許容する。
 * - 文字列は制御文字を除き、長さを切る(外部の API の応答の文章が、後続で LLM に入るため)。元の JSON は {@link BABA_RAW_JSON_LIMIT} 以内なら `rawJson` に残す。
 *
 * ## 失敗の分類({@link BabaResultClass})
 * 保存してよい固定の語だけ。例外の文面・URL・応答の本文は、保存もログもしない。
 */

/** 取得の結果の分類(`baba_fetches.result`)。固定の語だけ。 */
export type BabaResultClass =
  | "ok"
  | "no-today-venues"
  | "not-json"
  | "shape-mismatch"
  | "stale"
  | "timeout"
  | "network"
  | "too-large"
  | "redirect"
  | "other"
  | "claim-failed"
  | `http-${number}`;

/**
 * 取得の失敗(分類つき)。メッセージは固定の語だけで、元の例外(URL を含みうる)は持たない(`cause` なし)。
 * 取得口({@link import("./baba-fetch").createBabaFetcher})が投げ、`BabaStage` が分類だけを読む。
 */
export class BabaFetchError extends Error {
  readonly result: BabaResultClass;

  constructor(result: BabaResultClass) {
    super(`馬場の API の取得に失敗しました(分類: ${result})`);
    this.name = "BabaFetchError";
    this.result = result;
  }
}

import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { isRecord } from "../../packages/core/src/common/guards";

/** `RaceDayCore` に渡す取得口: 2xx の本文を返す。失敗は {@link BabaFetchError} を投げる。URL はこの関数の外に出ない(作るのは `baba-fetch.ts`)。 */
export type BabaFetcher = () => Promise<string>;

/** 元の JSON(競馬場 1 件ぶん)を `rawJson` に残す上限(文字数)。超えるときは null(JSON の途中で切らない)。 */
export const BABA_RAW_JSON_LIMIT = 4096;

/** 数値の範囲(両端を含む)。 */
const CUSHION_RANGE = [0, 20] as const;
const MOISTURE_RANGE = [0, 100] as const;
const RAINFALL_RANGE = [0, 500] as const;

/** 文字列の長さの上限。 */
const MAX_CONDITION = 20;
const MAX_COURSE = 200;
const MAX_TURF_LENGTH = 200;
const MAX_TURF_TEXT = 500;
const MAX_VENUE_NAME = 20;

const DAY_MS = 86_400_000;
/** 年の補いで、取得日との距離がこの日数以内の年を選ぶ。 */
const YEAR_WINDOW_DAYS = 182;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 1 面(芝・ダート)の状態と含水率。 */
export interface BabaSurface {
  readonly condition: string | null;
  readonly goalCondition: string | null;
  readonly corner4Condition: string | null;
  readonly goalMoisture: number | null;
  readonly corner4Moisture: number | null;
}

/** 当日の競馬場 1 件ぶんの値(保存する形)。 */
export interface BabaVenueRecord {
  /** JRA の場コード(01〜10。netkeiba のレース ID の場コードと同じ)。 */
  readonly venueCode: string;
  readonly venueName: string;
  /** 計測日時(`YYYY-MM-DDTHH:MM+09:00`)。 */
  readonly measuredAt: string;
  readonly cushion: number | null;
  readonly turf: BabaSurface;
  readonly dirt: BabaSurface;
  readonly rainfallMm: number | null;
  readonly usedCourse: string | null;
  readonly turfLength: string | null;
  /** 芝の状態の文章(応答の `turfCondition`。良・稍重などの状態ではない)。 */
  readonly turfConditionText: string | null;
  /** 元の JSON(競馬場 1 件ぶん)。{@link BABA_RAW_JSON_LIMIT} を超えるときは null。 */
  readonly rawJson: string | null;
}

/**
 * 競馬場を捨てた理由(診断用。Issue #360)。
 *  - `not-today`: 計測日時を読めて、日付が今日でない(API に当日の値がまだ載っていない・開催していない競馬場の古い値)。
 *  - `unparsed`: `measuredAt` が文字列だが、読めない(書式の不一致・実在しない日・時刻の範囲外・曜日の検算の失敗)。書式の変更などの不具合の兆候。
 *  - `invalid`: 形が不正(場コードが JRA の 01〜10 でない・型が違う・数値が範囲外・`measuredAt` が文字列でない・競馬場がオブジェクトでない)。
 *  - `duplicate`: 場コードの重複(2 件目以降)。
 */
export type BabaDropReason = "not-today" | "unparsed" | "invalid" | "duplicate";

/** 捨てた競馬場 1 件の診断(`baba_fetches.dropped_json` の要素)。競馬場の値や元の JSON は含めない。 */
export interface BabaDroppedDetail {
  /** 場コード(応答が文字列で持っていたもの。制御文字を除いて 4 字まで)。読めなければ null。 */
  readonly venue: string | null;
  readonly reason: BabaDropReason;
  /** 応答の `measuredAt` の文字列(例: `10月17日（土曜）7時00分`)。制御文字を除いて {@link BABA_MEASURED_TEXT_LIMIT} 字まで。文字列でなければ null。 */
  readonly measured: string | null;
}

/** 捨てた競馬場の詳細を残す件数の上限(件数そのものは `dropped` に残る)。 */
export const BABA_DROPPED_DETAIL_LIMIT = 20;
/** 詳細に残す計測日時の文字列の長さの上限。 */
export const BABA_MEASURED_TEXT_LIMIT = 40;
const MAX_VENUE_TEXT = 4;

export interface BabaParseResult {
  readonly result: "ok" | "no-today-venues" | "not-json" | "shape-mismatch" | "stale";
  /** 当日の競馬場だけ(`result` が `ok` のときだけ 1 件以上)。 */
  readonly venues: readonly BabaVenueRecord[];
  /** 捨てた競馬場の件数(当日でない・読めない・不正・重複)。 */
  readonly dropped: number;
  /** 捨てた競馬場の理由と計測日時の文字列(応答の並び順。{@link BABA_DROPPED_DETAIL_LIMIT} 件まで)。全体の失敗のときは空。 */
  readonly droppedDetails: readonly BabaDroppedDetail[];
  /** 応答の `fetchedAt`(形が読めたときだけ。読めなければ null)。 */
  readonly apiFetchedAt: string | null;
}

const fail = (result: "not-json" | "shape-mismatch" | "stale", apiFetchedAt: string | null = null): BabaParseResult => ({ result, venues: [], dropped: 0, droppedDetails: [], apiFetchedAt });

/** 不正な競馬場を表す印(型が違う・範囲外)。 */
const INVALID = Symbol("invalid");
type Maybe<T> = T | typeof INVALID;

/** undefined・null → null。範囲内の有限の数 → その数。それ以外 → INVALID。 */
function numberOrNull(value: unknown, range: readonly [number, number]): Maybe<number | null> {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < range[0] || value > range[1]) {
    return INVALID;
  }
  return value;
}

/** 制御文字を除いて、長さを切る。 */
function sanitize(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

/** undefined・null → null。文字列 → 整形した文字列。それ以外 → INVALID。 */
function stringOrNull(value: unknown, max: number): Maybe<string | null> {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? sanitize(value, max) : INVALID;
}

function surfaceOf(value: unknown): Maybe<BabaSurface> {
  if (value === undefined || value === null) {
    return { condition: null, goalCondition: null, corner4Condition: null, goalMoisture: null, corner4Moisture: null };
  }
  if (!isRecord(value)) {
    return INVALID;
  }
  const condition = stringOrNull(value["condition"], MAX_CONDITION);
  const goalCondition = stringOrNull(value["goalCondition"], MAX_CONDITION);
  const corner4Condition = stringOrNull(value["corner4Condition"], MAX_CONDITION);
  const goalMoisture = numberOrNull(value["goal"], MOISTURE_RANGE);
  const corner4Moisture = numberOrNull(value["corner4"], MOISTURE_RANGE);
  if (condition === INVALID || goalCondition === INVALID || corner4Condition === INVALID || goalMoisture === INVALID || corner4Moisture === INVALID) {
    return INVALID;
  }
  return { condition, goalCondition, corner4Condition, goalMoisture, corner4Moisture };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** JST の暦日(YYYYMMDD)。 */
function jstDateOf(epochMs: number): string {
  const d = new Date(epochMs + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/**
 * `measuredAt`(`10月12日（月曜）7時00分`)を、取得日(JST の今日)を基準に、年を補い・曜日を検算して読む。
 * 読めない・実在しない日・曜日が合わない・時刻が範囲外なら null。
 */
function readMeasuredAt(text: string, todayYear: number, todayMonth: number, todayDay: number): { date: string; iso: string } | null {
  const m = /^(\d{1,2})月(\d{1,2})日[（(]([日月火水木金土])曜[）)](\d{1,2})時(\d{1,2})分$/.exec(text);
  if (m === null) {
    return null;
  }
  const [month, day, weekday, hour, minute] = [Number(m[1]), Number(m[2]), m[3]!, Number(m[4]), Number(m[5])];
  if (hour > 23 || minute > 59) {
    return null;
  }
  const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);
  for (const year of [todayYear - 1, todayYear, todayYear + 1]) {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
      continue; // 実在しない日(平年の 2/29 など)
    }
    if (Math.abs(candidate.getTime() - todayUtc) > YEAR_WINDOW_DAYS * DAY_MS) {
      continue;
    }
    if (WEEKDAYS[candidate.getUTCDay()] !== weekday) {
      return null; // 曜日の検算に失敗
    }
    return { date: `${year}${pad2(month)}${pad2(day)}`, iso: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}+09:00` };
  }
  return null;
}

/** 捨てた競馬場の診断(場コードと計測日時の文字列。読めなければ null)。 */
function describeDropped(value: unknown, reason: BabaDropReason): BabaDroppedDetail {
  if (!isRecord(value)) {
    return { venue: null, reason, measured: null };
  }
  const code = value["venueCode"];
  const measured = value["measuredAt"];
  return {
    venue: typeof code === "string" ? sanitize(code, MAX_VENUE_TEXT) : null,
    reason,
    measured: typeof measured === "string" ? sanitize(measured, BABA_MEASURED_TEXT_LIMIT) : null,
  };
}

/**
 * 競馬場 1 件を読む。形の不正(型・範囲・場コード・計測日時が文字列でない)なら "invalid"、計測日時が読めなければ "unparsed"、読めて当日でなければ "not-today"。
 */
function readVenue(value: unknown, today: { year: number; month: number; day: number; date: string }): BabaVenueRecord | Exclude<BabaDropReason, "duplicate"> {
  if (!isRecord(value)) {
    return "invalid";
  }
  const code = value["venueCode"];
  if (typeof code !== "string" || !/^(0[1-9]|10)$/.test(code)) {
    return "invalid";
  }
  const name = value["venueName"];
  if (typeof name !== "string") {
    return "invalid";
  }
  const measuredText = value["measuredAt"];
  if (typeof measuredText !== "string") {
    return "invalid";
  }
  const cushion = numberOrNull(value["cushion"], CUSHION_RANGE);
  const rainfallMm = numberOrNull(value["rainfallMm"], RAINFALL_RANGE);
  const turf = surfaceOf(value["turf"]);
  const dirt = surfaceOf(value["dirt"]);
  const usedCourse = stringOrNull(value["usedCourse"], MAX_COURSE);
  const turfLength = stringOrNull(value["turfLength"], MAX_TURF_LENGTH);
  const turfConditionText = stringOrNull(value["turfCondition"], MAX_TURF_TEXT);
  if (cushion === INVALID || rainfallMm === INVALID || turf === INVALID || dirt === INVALID || usedCourse === INVALID || turfLength === INVALID || turfConditionText === INVALID) {
    return "invalid";
  }
  const measured = readMeasuredAt(measuredText, today.year, today.month, today.day);
  if (measured === null) {
    return "unparsed";
  }
  if (measured.date !== today.date) {
    return "not-today";
  }
  const raw = JSON.stringify(value);
  return {
    venueCode: code,
    venueName: sanitize(name, MAX_VENUE_NAME),
    measuredAt: measured.iso,
    cushion,
    turf,
    dirt,
    rainfallMm,
    usedCourse,
    turfLength,
    turfConditionText,
    rawJson: raw.length <= BABA_RAW_JSON_LIMIT ? raw : null,
  };
}

/**
 * 応答の本文を解析する。`nowMs`(UTC のエポックミリ秒)の JST の暦日を「今日」とし、計測日が今日の競馬場だけを返す。
 */
export function parseBabaResponse(text: string, nowMs: number): BabaParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("not-json");
  }
  if (!isRecord(json) || typeof json["fetchedAt"] !== "string" || !Array.isArray(json["venues"])) {
    return fail("shape-mismatch");
  }
  const fetchedAt = json["fetchedAt"];
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) {
    return fail("shape-mismatch");
  }
  const todayDate = jstDateOf(nowMs);
  if (jstDateOf(fetchedMs) !== todayDate) {
    return fail("stale", fetchedAt);
  }
  const today = { year: Number(todayDate.slice(0, 4)), month: Number(todayDate.slice(4, 6)), day: Number(todayDate.slice(6, 8)), date: todayDate };
  const venues: BabaVenueRecord[] = [];
  const droppedDetails: BabaDroppedDetail[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of json["venues"] as unknown[]) {
    const read = readVenue(entry, today);
    const reason: BabaDropReason | null = typeof read === "string" ? read : seen.has(read.venueCode) ? "duplicate" : null;
    if (reason !== null) {
      dropped += 1;
      if (droppedDetails.length < BABA_DROPPED_DETAIL_LIMIT) {
        droppedDetails.push(describeDropped(entry, reason));
      }
      continue;
    }
    seen.add((read as BabaVenueRecord).venueCode);
    venues.push(read as BabaVenueRecord);
  }
  return { result: venues.length > 0 ? "ok" : "no-today-venues", venues, dropped, droppedDetails, apiFetchedAt: fetchedAt };
}
