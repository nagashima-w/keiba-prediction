/**
 * JRA の馬場のページの読み取り(Issue #478〈#477-B〉)。**純関数**: ネットワーク・D1・DO に触れない。
 * 外部の API(旧 `baba-fetch.ts`・`parseBabaResponse`)に代えて、JRA のページから同じ形の {@link BabaVenueRecord} を作る。
 *
 * ## 読むもの(どれも Shift_JIS を読んだ文字列。見本は `fixtures/jra_*_20261025.*`)
 *  - クッション値 `_data_cushion.html`({@link parseCushionHtml}): 場ごとに `<div id="rcX" title="場名">`、計測ごとに `<div class="unit">`(`time`・`cushion`)。**新しい順**。値の前後に空白が入ることがある。
 *  - 含水率 `_data_moist.html`({@link parseMoistHtml}): 同じ形で、`turf`・`dirt` の中の `span.mg`(ゴール前)・`span.m4c`(4 コーナー)の値と `data-condition`、注記の「当日雨量は X ミリメートル」。
 *    `data-condition` は JRA のページの JS の対応(`hard`=良・`wet`=稍重・`soft`=重)で語にし、それ以外は不明(null)。
 *  - 開催情報 `accessJ.html` の POST の JSON({@link parseAccessJson}): `kaisai_info[]` の `jyoname`・`kaisai_ymd`・`ba_s`(芝)・`ba_d`(ダート)。**芝・ダートの全体の状態(`turf.condition`・`dirt.condition`)はこれを使う**
 *    (旧 API の値は含水率の欄から決めた値で、公式と食い違うことがあった)。開催日(`kaisai_ymd`)が今日の場だけを採る。
 *  - コースの情報 `index.html`・`index2.html`・`index3.html`({@link parseCoursePage}): 見出し「馬場情報（○○競馬場）」で場を決め、使用コース・芝丈・芝の状態の文章と、場の切り替えタブ(開催している場の数)を読む。
 *
 * ## 当日の値だけを採る({@link assembleBabaVenues})
 * 計測の時刻の文字列(`10月25日（日曜）7時00分`)には年が無い。取得日(JST の今日)の前後 182 日以内に入る年を {Y-1, Y, Y+1} から選び(同じ月日は約 365 日おきなので候補は高々 1 つ)、**曜日で検算**して合わなければ読めない扱いにする。
 * クッション値と含水率は計測の時刻が違う(例: 含水率 5:30、クッション値 7:00)ので、**場ごと・日付で**突き合わせる(時刻では突き合わせない)。それぞれ、当日の計測のうち**ページの先頭に近いもの(= 新しいもの)**を採る。
 * どちらか片方でも当日の値があれば、その場を保存する(もう一方の項目は null)。両方とも当日でない場は捨てる(`not-today`。読めない時刻は `unparsed`、場名が JRA の 10 場に無ければ `invalid`)。
 * `measuredAt` はクッション値の時刻(あれば)、無ければ含水率の時刻。
 *
 * ## 秘匿・上限
 * 外部の文章は制御文字を除き、長さを切る(LLM に入るため)。`rawJson` は読み取った値の要約の JSON(HTML・本文は入れない)で、各ページの取得の結果は固定の語({@link BabaSourceStatus})だけを入れる。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { isRecord } from "../../packages/core/src/common/guards";
import { VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";
import {
  BABA_DROPPED_DETAIL_LIMIT,
  BABA_MEASURED_TEXT_LIMIT,
  BABA_RAW_JSON_LIMIT,
  type BabaDropReason,
  type BabaDroppedDetail,
  type BabaSurface,
  type BabaVenueRecord,
} from "./baba-conditions";
import type { JraFailure } from "./jra-http";

/** 各ページの取得・読み取りの結果(固定の語だけ。`rawJson` の `sources` に入る)。`skipped` = 取らなかった。 */
export type BabaSourceStatus = "ok" | "skipped" | "shape-mismatch" | JraFailure | `http-${number}`;

export interface BabaSources {
  readonly cushion: BabaSourceStatus;
  readonly moist: BabaSourceStatus;
  readonly access: BabaSourceStatus;
  /** コースの情報(index・index2・index3)。1 本でも失敗した場合は最初の失敗の語。 */
  readonly course: BabaSourceStatus;
}

/** 数値の範囲(両端を含む)。 */
const CUSHION_RANGE = [0, 20] as const;
const MOISTURE_RANGE = [0, 100] as const;
const RAINFALL_RANGE = [0, 500] as const;

/** 文字列の長さの上限。 */
const MAX_COURSE = 200;
const MAX_TURF_LENGTH = 200;
const MAX_TURF_TEXT = 500;
const MAX_VENUE_NAME = 20;
const MAX_VENUE_TEXT = 4;

/** 状態語の許可リスト(core の `BABA_CONDITION_WORDS` と同じ)。 */
const CONDITION_WORDS: ReadonlySet<string> = new Set(["良", "稍重", "重", "不良"]);
/** 含水率の `data-condition` → 状態語(JRA のページの JS の対応)。 */
const MOIST_CONDITION: Readonly<Record<string, string>> = { hard: "良", wet: "稍重", soft: "重" };

const DAY_MS = 86_400_000;
/** 年の補いで、取得日との距離がこの日数以内の年を選ぶ。 */
const YEAR_WINDOW_DAYS = 182;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 場名 → 場コード(`VENUE_BY_TRACK_CODE` の逆引き)。 */
const CODE_BY_VENUE_NAME: ReadonlyMap<string, string> = new Map([...VENUE_BY_TRACK_CODE].map(([code, name]) => [name, code]));

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 制御文字を除いて、長さを切る。 */
function sanitize(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

/** タグを除き、基本の文字参照を戻し、空白をまとめる(改行・`<br>` は空白)。 */
function plainText(fragment: string): string {
  return fragment
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 前後の空白を除いた十進数の文字列だけを数にする。読めなければ null。 */
function numberOf(text: string): number | null {
  const t = text.trim();
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

function inRange(value: number | null, range: readonly [number, number]): number | null {
  return value !== null && Number.isFinite(value) && value >= range[0] && value <= range[1] ? value : null;
}

const conditionWord = (value: unknown): string | null => (typeof value === "string" && CONDITION_WORDS.has(value) ? value : null);

// ---------------------------------------------------------------- 場ごとの区画

interface Section {
  readonly name: string;
  readonly body: string;
}

/** `<div id="rcX" title="場名">` ごとに区切る。場の見出しが 1 つも無ければ空。 */
function sectionsOf(html: string): Section[] {
  const heads = [...html.matchAll(/<div\s+id="rc[A-Za-z0-9]*"\s+title="([^"]*)"\s*>/g)];
  return heads.map((m, i) => ({ name: plainText(m[1] ?? ""), body: html.slice(m.index + m[0].length, heads[i + 1]?.index ?? html.length) }));
}

/** 区画を計測(`<div class="unit">`)ごとに分ける。 */
function unitsOf(body: string): string[] {
  return body.split(/<div\s+class="unit"\s*>/).slice(1);
}

function timeOf(unit: string): string | null {
  const m = /<div\s+class="time"\s*>([^<]*)<\/div>/.exec(unit);
  return m === null ? null : plainText(m[1] ?? "");
}

// ---------------------------------------------------------------- クッション値

export interface CushionUnit {
  /** 計測の時刻の文字列(例: `10月25日（日曜）7時00分`)。 */
  readonly time: string;
  readonly cushion: number | null;
}

export interface CushionVenueData {
  readonly name: string;
  /** 新しい順。 */
  readonly units: readonly CushionUnit[];
}

/**
 * クッション値のページを読む。場の見出しが 1 つも無い、または全場で計測が 1 件も読めなければ null(形が想定と違う。Issue #490-1: `time` の class が変わると、
 * 全場の計測が読めずに「今日ではない」と取り違えるため)。値が数でない計測は、その値だけ null。
 */
export function parseCushionHtml(html: string): CushionVenueData[] | null {
  const sections = sectionsOf(html);
  if (sections.length === 0) {
    return null;
  }
  const venues = sections.map((s) => ({
    name: s.name,
    units: unitsOf(s.body).flatMap((u): CushionUnit[] => {
      const time = timeOf(u);
      if (time === null) {
        return [];
      }
      const value = /<div\s+class="cushion"\s*>([^<]*)<\/div>/.exec(u);
      return [{ time, cushion: value === null ? null : numberOf(value[1] ?? "") }];
    }),
  }));
  return venues.some((v) => v.units.length > 0) ? venues : null;
}

// ---------------------------------------------------------------- 含水率

export interface MoistFace {
  readonly goal: number | null;
  readonly goalCondition: string | null;
  readonly corner4: number | null;
  readonly corner4Condition: string | null;
}

export interface MoistUnit {
  readonly time: string;
  readonly turf: MoistFace;
  readonly dirt: MoistFace;
  /** 注記の「測定時刻までの当日雨量は X ミリメートル」の X。注記が「特になし」など雨量の無い文なら null。 */
  readonly rainfallMm: number | null;
}

export interface MoistVenueData {
  readonly name: string;
  /** 新しい順。 */
  readonly units: readonly MoistUnit[];
}

function faceOf(unit: string, cls: "turf" | "dirt"): MoistFace {
  const block = new RegExp(`<div\\s+class="${cls}"\\s*>([\\s\\S]*?)</div>`).exec(unit)?.[1] ?? "";
  let goal: { value: number | null; condition: string | null } = { value: null, condition: null };
  let corner4: { value: number | null; condition: string | null } = { value: null, condition: null };
  for (const m of block.matchAll(/<span\s+class="(mg|m4c)"([^>]*)>([^<]*)<\/span>/g)) {
    const attr = /data-condition="([^"]*)"/.exec(m[2] ?? "");
    const condition = attr === null ? null : (MOIST_CONDITION[attr[1] ?? ""] ?? null);
    const entry = { value: numberOf(m[3] ?? ""), condition };
    if (m[1] === "mg") {
      goal = entry;
    } else {
      corner4 = entry;
    }
  }
  return { goal: goal.value, goalCondition: goal.condition, corner4: corner4.value, corner4Condition: corner4.condition };
}

/**
 * 含水率のページを読む。場の見出しが 1 つも無い、全場で計測が 1 件も読めない、または計測はあるのに全場・全計測で 4 つの値(芝・ダートのゴール前/4 角)が 1 つも読めなければ
 * null(形が想定と違う。Issue #490-1: `span.mg` などの class が変わると、含水率が全部 null のまま「読めた」ことになるため)。
 */
export function parseMoistHtml(html: string): MoistVenueData[] | null {
  const sections = sectionsOf(html);
  if (sections.length === 0) {
    return null;
  }
  const venues = sections.map((s) => ({
    name: s.name,
    units: unitsOf(s.body).flatMap((u): MoistUnit[] => {
      const time = timeOf(u);
      if (time === null) {
        return [];
      }
      const rain = /<li>[^<]*当日雨量は\s*(\d+(?:\.\d+)?)\s*ミリ/.exec(u);
      return [{ time, turf: faceOf(u, "turf"), dirt: faceOf(u, "dirt"), rainfallMm: rain === null ? null : Number(rain[1]) }];
    }),
  }));
  const units = venues.flatMap((v) => v.units);
  const anyValue = units.some((u) => [u.turf.goal, u.turf.corner4, u.dirt.goal, u.dirt.corner4].some((x) => x !== null));
  return anyValue ? venues : null;
}

// ---------------------------------------------------------------- 開催情報(POST の JSON)

export interface AccessVenue {
  readonly name: string;
  /** 開催日(YYYYMMDD)。文字列でなければ空文字。 */
  readonly kaisaiYmd: string;
  /** 芝の馬場状態(`ba_s`)。許可リスト外・空は null。 */
  readonly turfCondition: string | null;
  /** ダートの馬場状態(`ba_d`)。 */
  readonly dirtCondition: string | null;
}

/** 開催情報の JSON を読む。JSON でない・`kaisai_info` が配列でないときは null。開催の無い日(空の配列)は空の配列。`jyoname` が文字列でない件は捨てる。 */
export function parseAccessJson(text: string): AccessVenue[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json["kaisai_info"])) {
    return null;
  }
  const out: AccessVenue[] = [];
  for (const item of json["kaisai_info"] as unknown[]) {
    if (!isRecord(item) || typeof item["jyoname"] !== "string" || item["jyoname"] === "") {
      continue;
    }
    out.push({
      name: item["jyoname"],
      kaisaiYmd: typeof item["kaisai_ymd"] === "string" ? item["kaisai_ymd"] : "",
      turfCondition: conditionWord(item["ba_s"]),
      dirtCondition: conditionWord(item["ba_d"]),
    });
  }
  return out;
}

// ---------------------------------------------------------------- コースの情報

export interface CoursePage {
  /** 見出し「馬場情報（○○競馬場）」の場名。 */
  readonly venueName: string;
  /** 場の切り替えタブの場名(`index.html`・`index2.html`・… の順。開催している場の数)。タブが無ければ空。 */
  readonly tabs: readonly string[];
  readonly usedCourse: string | null;
  /** 「芝丈(cm) 芝野芝10から12・洋芝10から14 障害野芝10から12」の形。表が無ければ null。 */
  readonly turfLength: string | null;
  readonly turfConditionText: string | null;
}

function turfLengthOf(html: string): string | null {
  const table = /<div\s+class="turf_length"\s*>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (table === undefined) {
    return null;
  }
  const body = /<tbody>([\s\S]*)$/.exec(table)?.[1] ?? table;
  const rows: string[] = [];
  // `</tr>` の欠けた行が実物にある(index.html の障害の行)ので、`<tr>` で区切って読む。
  for (const chunk of body.split(/<tr\b[^>]*>/).slice(1)) {
    const label = /<th\s+scope="row"\s*>([\s\S]*?)<\/th>/.exec(chunk);
    if (label === null) {
      continue;
    }
    const cells = [...chunk.matchAll(/<td\s*>([\s\S]*?)<\/td>/g)].map((m) => plainText(m[1] ?? ""));
    const parts = [cells[0] === undefined ? null : `野芝${cells[0]}`, cells[1] === undefined ? null : `洋芝${cells[1]}`].filter(
      (p, i): p is string => p !== null && cells[i] !== "" && cells[i] !== "なし",
    );
    if (parts.length > 0) {
      rows.push(`${plainText(label[1] ?? "")}${parts.join("・")}`);
    }
  }
  return rows.length === 0 ? null : `芝丈(cm) ${rows.join(" ")}`;
}

function fieldOf(html: string, heading: string): string | null {
  const m = new RegExp(`<h3>${heading}</h3>\\s*</div>\\s*<div\\s+class="content"\\s*>\\s*<p>([\\s\\S]*?)</p>`).exec(html);
  if (m === null) {
    return null;
  }
  const text = plainText(m[1] ?? "");
  return text === "" ? null : text;
}

/** コースの情報のページを読む。見出しから場名が読めなければ null。欄の無い項目は null(ほかは読む)。 */
export function parseCoursePage(html: string): CoursePage | null {
  const title = /<title>\s*馬場情報（([^）<]*?)競馬場）/.exec(html);
  if (title === null) {
    return null;
  }
  const nav = /<div\s+class="nav tab"\s*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ?? "";
  const tabs = [...nav.matchAll(/<a\s+href="index\d*\.html"\s*>([^<]*?)競馬場<\/a>/g)].map((m) => plainText(m[1] ?? ""));
  return {
    venueName: plainText(title[1] ?? ""),
    tabs,
    usedCourse: fieldOf(html, "使用コース"),
    turfLength: turfLengthOf(html),
    turfConditionText: fieldOf(html, "芝の状態"),
  };
}

// ---------------------------------------------------------------- 日付

/** JST の暦日(YYYYMMDD)。 */
function jstDateOf(epochMs: number): string {
  const d = new Date(epochMs + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

interface Today {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly date: string;
}

/**
 * 計測の時刻の文字列(`10月12日（月曜）7時00分`)を、取得日(JST の今日)を基準に、年を補い・曜日を検算して読む。
 * 読めない・実在しない日・曜日が合わない・時刻が範囲外なら null。
 */
function readMeasuredAt(text: string, today: Today): { date: string; iso: string } | null {
  const m = /^(\d{1,2})月(\d{1,2})日[（(]([日月火水木金土])曜[）)](\d{1,2})時(\d{1,2})分$/.exec(text);
  if (m === null) {
    return null;
  }
  const [month, day, weekday, hour, minute] = [Number(m[1]), Number(m[2]), m[3]!, Number(m[4]), Number(m[5])];
  if (hour > 23 || minute > 59) {
    return null;
  }
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year - 1, today.year, today.year + 1]) {
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

// ---------------------------------------------------------------- 組み立て

export interface AssembleInput {
  /** 取得の時刻(UTC のエポックミリ秒)。JST の暦日を「今日」とする。 */
  readonly nowMs: number;
  readonly cushion: readonly CushionVenueData[] | null;
  readonly moist: readonly MoistVenueData[] | null;
  readonly access: readonly AccessVenue[] | null;
  readonly courses: readonly CoursePage[];
  /** 各ページの取得の結果(`rawJson` に残す)。 */
  readonly sources: BabaSources;
}

export interface AssembleResult {
  readonly venues: readonly BabaVenueRecord[];
  /** 捨てた場の件数(当日でない・読めない・場名が不明)。 */
  readonly dropped: number;
  /** 捨てた場の理由と計測の時刻の文字列(場の並び順。{@link BABA_DROPPED_DETAIL_LIMIT} 件まで)。 */
  readonly droppedDetails: readonly BabaDroppedDetail[];
  /** クッション値・含水率のページに載っていた場の場コード(クッション値の並び → 含水率にだけある場。重複なし。場名が JRA の 10 場に無いものは入らない)。 */
  readonly listedVenueCodes: readonly string[];
}

interface Pick<T> {
  readonly unit: T | null;
  readonly iso: string | null;
  /** 当日の計測が無いとき、先頭の計測の時刻の文字列(診断用)。 */
  readonly firstText: string | null;
  /** 読めない時刻の計測があったときの、その時刻の文字列。 */
  readonly unreadableText: string | null;
}

/** 計測の列(新しい順)から、当日の計測のうち先頭に近いものを選ぶ。 */
function pickToday<T extends { readonly time: string }>(units: readonly T[], today: Today): Pick<T> {
  let unreadableText: string | null = null;
  for (const unit of units) {
    const read = readMeasuredAt(unit.time, today);
    if (read === null) {
      unreadableText ??= unit.time;
      continue;
    }
    if (read.date === today.date) {
      return { unit, iso: read.iso, firstText: units[0]?.time ?? null, unreadableText };
    }
  }
  return { unit: null, iso: null, firstText: units[0]?.time ?? null, unreadableText };
}

const EMPTY_SURFACE_SOURCE = { goal: null, goalCondition: null, corner4: null, corner4Condition: null } as const satisfies MoistFace;

function surfaceOf(condition: string | null, face: MoistFace): BabaSurface {
  return {
    condition,
    goalCondition: face.goalCondition,
    corner4Condition: face.corner4Condition,
    goalMoisture: inRange(face.goal, MOISTURE_RANGE),
    corner4Moisture: inRange(face.corner4, MOISTURE_RANGE),
  };
}

function dropDetail(venueCode: string | null, reason: BabaDropReason, measured: string | null): BabaDroppedDetail {
  return {
    venue: venueCode === null ? null : sanitize(venueCode, MAX_VENUE_TEXT),
    reason,
    measured: measured === null ? null : sanitize(measured, BABA_MEASURED_TEXT_LIMIT),
  };
}

/**
 * 読み取った各ページから、当日の場ごとの保存する値を組み立てる。場の並びは、クッション値のページの並び → 含水率のページにだけある場。
 * 当日の計測が無い場・場名が JRA の 10 場に無い場は、件数と診断に回す(保存しない)。
 */
export function assembleBabaVenues(input: AssembleInput): AssembleResult {
  const dateText = jstDateOf(input.nowMs);
  const today: Today = { year: Number(dateText.slice(0, 4)), month: Number(dateText.slice(4, 6)), day: Number(dateText.slice(6, 8)), date: dateText };
  const cushionByName = new Map((input.cushion ?? []).map((v) => [v.name, v]));
  const moistByName = new Map((input.moist ?? []).map((v) => [v.name, v]));
  const names = [...new Set([...(input.cushion ?? []).map((v) => v.name), ...(input.moist ?? []).map((v) => v.name)])];

  const venues: BabaVenueRecord[] = [];
  const listedVenueCodes = names.flatMap((n) => CODE_BY_VENUE_NAME.get(n) ?? []);
  const droppedDetails: BabaDroppedDetail[] = [];
  let dropped = 0;
  const drop = (detail: BabaDroppedDetail): void => {
    dropped += 1;
    if (droppedDetails.length < BABA_DROPPED_DETAIL_LIMIT) {
      droppedDetails.push(detail);
    }
  };

  for (const name of names) {
    const code = CODE_BY_VENUE_NAME.get(name) ?? null;
    const cushionPick = pickToday(cushionByName.get(name)?.units ?? [], today);
    const moistPick = pickToday(moistByName.get(name)?.units ?? [], today);
    const measuredText = cushionPick.firstText ?? moistPick.firstText;
    if (code === null) {
      drop(dropDetail(null, "invalid", measuredText));
      continue;
    }
    if (cushionPick.unit === null && moistPick.unit === null) {
      const unreadable = cushionPick.unreadableText ?? moistPick.unreadableText;
      drop(unreadable !== null ? dropDetail(code, "unparsed", unreadable) : dropDetail(code, "not-today", measuredText));
      continue;
    }

    const measuredAt = (cushionPick.unit !== null ? cushionPick.iso : moistPick.iso) as string;
    const cushion = cushionPick.unit === null ? null : inRange(cushionPick.unit.cushion, CUSHION_RANGE);
    const moist = moistPick.unit;
    const access = (input.access ?? []).find((a) => a.name === name && a.kaisaiYmd === today.date) ?? null;
    const course = input.courses.find((c) => c.venueName === name) ?? null;
    const turf = surfaceOf(access?.turfCondition ?? null, moist?.turf ?? EMPTY_SURFACE_SOURCE);
    const dirt = surfaceOf(access?.dirtCondition ?? null, moist?.dirt ?? EMPTY_SURFACE_SOURCE);
    const rainfallMm = moist === null ? null : inRange(moist.rainfallMm, RAINFALL_RANGE);
    const raw = JSON.stringify({
      venueCode: code,
      venueName: name,
      measuredAt,
      cushion: cushionPick.unit === null ? null : { time: cushionPick.unit.time, value: cushion },
      moist: moist === null ? null : { time: moist.time, turf: { goal: turf.goalMoisture, corner4: turf.corner4Moisture }, dirt: { goal: dirt.goalMoisture, corner4: dirt.corner4Moisture }, rainfallMm },
      sources: input.sources,
    });
    venues.push({
      venueCode: code,
      venueName: sanitize(name, MAX_VENUE_NAME),
      measuredAt,
      cushion,
      turf,
      dirt,
      rainfallMm,
      usedCourse: course?.usedCourse == null ? null : sanitize(course.usedCourse, MAX_COURSE),
      turfLength: course?.turfLength == null ? null : sanitize(course.turfLength, MAX_TURF_LENGTH),
      turfConditionText: course?.turfConditionText == null ? null : sanitize(course.turfConditionText, MAX_TURF_TEXT),
      rawJson: raw.length <= BABA_RAW_JSON_LIMIT ? raw : null,
    });
  }
  return { venues, dropped, droppedDetails, listedVenueCodes };
}
