/**
 * 馬場の取得の試み(`baba_fetches`)と、競馬場ごとの当日の値(`baba_conditions`)の D1 への保存(Issue #294〈#293-A〉。migration 0017)。
 *
 * ## 1 日 1 回の保証の実体: {@link D1BabaStore.claim}
 * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。**JRA に出る前に**、開催日を主キーとする行を `INSERT ... ON CONFLICT DO NOTHING` で書く。
 * `meta.changes` が 1 のとき(= この呼び出しが行を作った)だけ `claimed` を返し、0 なら `exists`(既に誰かが試みた)。DO の再起動・アラームの重複・DO のストレージの消失でも、2 回目は通らない。
 * 結果({@link D1BabaStore.finish})は、試みの行の更新と競馬場の行の INSERT を `batch` 1 回(原子的)で書く。**結果の保存に失敗しても、再試行はしない**(JRA への取得は既に使った)。
 *
 * ## 読み出し: {@link D1BabaStore.load}(Issue #295)
 * 発走前の分析が、そのレースの開催日 × 場コードの 1 行(主キー)を読む。**SELECT 1 文**。列(クッション値・芝とダートの状態と含水率・使用コース・芝の状態の文章)だけを読み(芝丈・降水量・元の JSON は読まない)、
 * core の `normalizeDayBaba` を通す(D1 に直接入れた値でも、許可リスト外の状態語・見出しの偽造・範囲外の数値がそのまま LLM に入らない)。行が無い・読めない値は null。失敗(表が無い・D1 の失敗)は投げる(呼び出し側が握って値なしで続ける)。
 *
 * ## 診断の読み出し: {@link D1BabaStore.loadFetches}(Issue #360)
 * 管理者の `GET /api/baba-fetch` が、取得の試み(`baba_fetches`)を新しい順に読み、保存した競馬場(`baba_conditions`)を日ごとに付ける。**SELECT 2 文**(読み取りだけ)。
 * `dropped_json`(捨てた競馬場の理由と計測日時の文字列。migration 0021)は、書くときに {@link D1BabaStore.finish} が JSON にし、読むときは理由の語の許可リストと長さで整えて返す(壊れた値は null)。
 *
 * 書き込みは 1 日 数文(claim 1 + finish の batch が 1 + 競馬場の数)。呼び出しは `RaceDayCore` の取得ステップだけ。
 */
import type { BabaFinish, BabaReader, BabaStore } from "./race-day-baba";
import { normalizeDayBaba, type DayBaba } from "../../packages/core/src/analyzer/day-baba";
import { BABA_DROPPED_DETAIL_LIMIT, BABA_MEASURED_TEXT_LIMIT, type BabaDropReason, type BabaDroppedDetail, type BabaVenueRecord } from "./baba-conditions";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type BabaDb = Pick<D1Database, "prepare" | "batch">;

const CLAIM_SQL = "INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES (?, ?) ON CONFLICT (kaisai_date) DO NOTHING";

const FINISH_SQL = "UPDATE baba_fetches SET finished_at = ?, result = ?, api_fetched_at = ?, venues_saved = ?, venues_dropped = ?, dropped_json = ? WHERE kaisai_date = ?";

const CONDITION_SQL =
  "INSERT INTO baba_conditions (kaisai_date, venue_code, venue_name, measured_at, cushion, " +
  "turf_condition, turf_goal_condition, turf_corner4_condition, turf_goal_moisture, turf_corner4_moisture, " +
  "dirt_condition, dirt_goal_condition, dirt_corner4_condition, dirt_goal_moisture, dirt_corner4_moisture, " +
  "rainfall_mm, used_course, turf_length, turf_state_text, raw_json, saved_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kaisai_date, venue_code) DO NOTHING";

function conditionBinds(kaisaiDate: string, v: BabaVenueRecord, savedAt: number): unknown[] {
  return [
    kaisaiDate,
    v.venueCode,
    v.venueName,
    v.measuredAt,
    v.cushion,
    v.turf.condition,
    v.turf.goalCondition,
    v.turf.corner4Condition,
    v.turf.goalMoisture,
    v.turf.corner4Moisture,
    v.dirt.condition,
    v.dirt.goalCondition,
    v.dirt.corner4Condition,
    v.dirt.goalMoisture,
    v.dirt.corner4Moisture,
    v.rainfallMm,
    v.usedCourse,
    v.turfLength,
    v.turfConditionText,
    v.rawJson,
    savedAt,
  ];
}

const LOAD_SQL =
  "SELECT measured_at, cushion, turf_condition, turf_goal_condition, turf_corner4_condition, turf_goal_moisture, turf_corner4_moisture, " +
  "dirt_condition, dirt_goal_condition, dirt_corner4_condition, dirt_goal_moisture, dirt_corner4_moisture, used_course, turf_state_text " +
  "FROM baba_conditions WHERE kaisai_date = ? AND venue_code = ?";

/** 診断の読み出し(`loadFetches`)の既定の件数(開催日 14 日ぶん)と上限。 */
export const FETCH_LIST_LIMIT_DEFAULT = 14;

/** 取得の試み 1 日ぶんの記録(管理者の診断用の読み出し。`GET /api/baba-fetch`)。URL・応答の本文・元の JSON は持たない。 */
export interface BabaFetchRecord {
  readonly kaisaiDate: string;
  readonly attemptedAt: number;
  readonly finishedAt: number | null;
  readonly result: string | null;
  readonly apiFetchedAt: string | null;
  readonly venuesSaved: number | null;
  readonly venuesDropped: number | null;
  /** 捨てた競馬場の診断。null = この列が無かった旧版の記録・壊れた記録。 */
  readonly dropped: readonly BabaDroppedDetail[] | null;
  /** その日 `baba_conditions` に保存されている競馬場。 */
  readonly saved: readonly { readonly venueCode: string; readonly venueName: string; readonly measuredAt: string }[];
}

const FETCH_LIST_SQL =
  "SELECT kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped, dropped_json FROM baba_fetches ORDER BY kaisai_date DESC LIMIT ?";
const FETCH_ONE_SQL =
  "SELECT kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped, dropped_json FROM baba_fetches WHERE kaisai_date = ?";
const SAVED_SQL = "SELECT kaisai_date, venue_code, venue_name, measured_at FROM baba_conditions WHERE kaisai_date >= ? AND kaisai_date <= ? ORDER BY kaisai_date DESC, venue_code";

const DROP_REASONS: ReadonlySet<string> = new Set<BabaDropReason>(["not-today", "unparsed", "invalid", "duplicate"]);

/** `dropped_json` を読む。壊れている・配列でないときは null、要素は理由の語が許可リストのものだけ(文字列は長さを切る。D1 に直接入れた値でも想定外の形を返さない)。 */
function readDroppedJson(text: unknown): BabaDroppedDetail[] | null {
  if (typeof text !== "string") {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) {
    return null;
  }
  const out: BabaDroppedDetail[] = [];
  for (const item of json.slice(0, BABA_DROPPED_DETAIL_LIMIT)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const { venue, reason, measured } = item as Record<string, unknown>;
    if (typeof reason !== "string" || !DROP_REASONS.has(reason)) {
      continue;
    }
    out.push({
      venue: typeof venue === "string" ? venue.slice(0, 4) : null,
      reason: reason as BabaDropReason,
      measured: typeof measured === "string" ? measured.slice(0, BABA_MEASURED_TEXT_LIMIT) : null,
    });
  }
  return out;
}

const numberOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
const stringOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class D1BabaStore implements BabaStore, BabaReader {
  private readonly db: BabaDb;

  constructor(options: { readonly db: BabaDb }) {
    this.db = options.db;
  }

  /** 試みを先に記録する。行を作れたら `claimed`(JRA に出てよい)、既にあれば `exists`(出ない)。失敗は投げる(まだ JRA に出ていないので、呼び出し側が再試行してよい)。 */
  async claim(kaisaiDate: string, attemptedAt: number): Promise<"claimed" | "exists"> {
    const result = await this.db.prepare(CLAIM_SQL).bind(kaisaiDate, attemptedAt).run();
    return (result.meta.changes ?? 0) > 0 ? "claimed" : "exists";
  }

  /** 結果の分類と、保存する競馬場の行を、batch 1 回(原子的)で書く。失敗は投げる(呼び出し側は警告にして、再試行しない)。 */
  async finish(kaisaiDate: string, finish: BabaFinish): Promise<void> {
    const statements = [
      this.db.prepare(FINISH_SQL).bind(finish.finishedAt, finish.result, finish.apiFetchedAt, finish.venues.length, finish.dropped, JSON.stringify(finish.droppedDetails), kaisaiDate),
      ...finish.venues.map((v) => this.db.prepare(CONDITION_SQL).bind(...conditionBinds(kaisaiDate, v, finish.finishedAt))),
    ];
    await this.db.batch(statements);
  }

  /**
   * 取得の試みの記録を、開催日の新しい順に返す(Issue #360。管理者の診断用)。`kaisaiDate` を指定するとその日の 1 行だけ。保存した競馬場(`baba_conditions`)も日ごとに付ける。
   * SELECT 2 文(読み取りだけ)。失敗は投げる(呼び出し側が固定の種類名の 503 にする)。
   */
  async loadFetches(options: { readonly kaisaiDate?: string; readonly limit: number }): Promise<BabaFetchRecord[]> {
    const fetchRows =
      options.kaisaiDate === undefined
        ? (await this.db.prepare(FETCH_LIST_SQL).bind(options.limit).all<Record<string, unknown>>()).results
        : (await this.db.prepare(FETCH_ONE_SQL).bind(options.kaisaiDate).all<Record<string, unknown>>()).results;
    if (fetchRows.length === 0) {
      return [];
    }
    const dates = fetchRows.map((r) => String(r["kaisai_date"])).sort();
    const savedRows = (await this.db.prepare(SAVED_SQL).bind(dates[0], dates[dates.length - 1]).all<Record<string, unknown>>()).results;
    return fetchRows.map((r) => {
      const date = String(r["kaisai_date"]);
      return {
        kaisaiDate: date,
        attemptedAt: Number(r["attempted_at"]),
        finishedAt: numberOrNull(r["finished_at"]),
        result: stringOrNull(r["result"]),
        apiFetchedAt: stringOrNull(r["api_fetched_at"]),
        venuesSaved: numberOrNull(r["venues_saved"]),
        venuesDropped: numberOrNull(r["venues_dropped"]),
        dropped: readDroppedJson(r["dropped_json"]),
        saved: savedRows
          .filter((s) => s["kaisai_date"] === date)
          .map((s) => ({ venueCode: String(s["venue_code"]), venueName: String(s["venue_name"]), measuredAt: String(s["measured_at"]) })),
      };
    });
  }

  /** 開催日(YYYYMMDD)× JRA の場コード(01〜10)の当日の馬場の値を読む。行が無い・読めない値は null。失敗は投げる。 */
  async load(kaisaiDate: string, venueCode: string): Promise<DayBaba | null> {
    const row = await this.db.prepare(LOAD_SQL).bind(kaisaiDate, venueCode).first<Record<string, unknown>>();
    if (row === null) {
      return null;
    }
    return normalizeDayBaba({
      measuredAt: row["measured_at"],
      cushion: row["cushion"],
      turf: {
        condition: row["turf_condition"],
        goalCondition: row["turf_goal_condition"],
        corner4Condition: row["turf_corner4_condition"],
        goalMoisture: row["turf_goal_moisture"],
        corner4Moisture: row["turf_corner4_moisture"],
      },
      dirt: {
        condition: row["dirt_condition"],
        goalCondition: row["dirt_goal_condition"],
        corner4Condition: row["dirt_corner4_condition"],
        goalMoisture: row["dirt_goal_moisture"],
        corner4Moisture: row["dirt_corner4_moisture"],
      },
      usedCourse: row["used_course"],
      turfStateText: row["turf_state_text"],
    });
  }
}
