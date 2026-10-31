/**
 * 馬場の取得の試み(`baba_fetch_attempts`〈枠ごと。migration 0026〉と、その日の要約の `baba_fetches`〈日ごと。migration 0017・0021〉)と、競馬場ごとの当日の値(`baba_conditions`)の D1 への保存
 * (Issue #294〈#293-A〉で作り、Issue #480〈#477-D〉で「1 日 1 回」を「1 枠 1 回」に広げた)。
 *
 * ## 1 枠 1 回の保証の実体: {@link D1BabaStore.claim}
 * 利用の条件は「JRA の開催日に、利用者全体で 1 枠 1 回」(枠は 09:00 から 10 分おき、12:00 まで)。**JRA に出る前に**、(開催日, 枠) を主キーとする行を `INSERT ... ON CONFLICT DO NOTHING` で書く。
 * `meta.changes` が 1 のとき(= この呼び出しが行を作った)だけ `claimed` を返し、0 なら `exists`(その枠は既に誰かが試みた)。DO の再起動・アラームの重複・DO のストレージの消失でも、同じ枠の 2 回目は通らない。
 * その日に「そろった」回(`complete = 1`)が既にあれば、枠の行を作らずに `done` を返す(DO のストレージが消えても、そろった日に取り直さない)。
 * claim の batch は、その日の要約 `baba_fetches` の行も(なければ)作る(最初の試みの時刻を残す)。
 * 結果({@link D1BabaStore.finish})は、競馬場の行の書き込み・枠の行の更新・日の要約の更新を `batch` 1 回(原子的)で書く。**結果の保存に失敗しても、同じ枠では再試行しない**(JRA への取得は既に使った)。
 *
 * ## 既に入っている行の補完({@link CONDITION_SQL})
 * 競馬場の行は、クッション値と含水率のどちらかだけでも先に保存する。後の回で欠けが埋まるとき**だけ**、`ON CONFLICT DO UPDATE ... WHERE` で更新する:
 *  - 値の列は `COALESCE(既存, 新)`: **既に入っている値は消さない・上書きしない**(公式の馬場状態などが後の回で変わっていても、入っている値は触らない)。NULL だった列だけが埋まる。
 *  - 更新するのは、(既存のクッション値が NULL で新しい読みにある)または(既存の含水率が 4 つとも NULL で新しい読みに 1 つでもある)ときだけ。完全な行・埋めるものが無い読みでは、何も書かない。
 *  - 計測日時は、クッション値を埋めたときだけ新しい読みのものにする(計測日時はクッション値の時刻、無ければ含水率の時刻と定めているため)。元の JSON と保存時刻は、更新した読みのものにする。
 * 枠の `venues_saved` は、この回の `saved_at` で書かれた(新しく入った・埋めた)行の数。
 *
 * ## 読み出し: {@link D1BabaStore.load}(Issue #295)
 * 発走前の分析が、そのレースの開催日 × 場コードの 1 行(主キー)を読む。**SELECT 1 文**。列(クッション値・芝とダートの状態と含水率・使用コース・芝の状態の文章)だけを読み(芝丈・降水量・元の JSON は読まない)、
 * core の `normalizeDayBaba` を通す(D1 に直接入れた値でも、許可リスト外の状態語・見出しの偽造・範囲外の数値がそのまま LLM に入らない)。行が無い・読めない値は null。失敗(表が無い・D1 の失敗)は投げる(呼び出し側が握って値なしで続ける)。
 *
 * ## 診断の読み出し: {@link D1BabaStore.loadFetches}(Issue #360)
 * 管理者の `GET /api/baba-fetch` が、取得の試みの日ごとの要約(`baba_fetches`)を新しい順に読み、保存した競馬場(`baba_conditions`)と枠ごとの試み(`baba_fetch_attempts`。Issue #480)を日ごとに付ける。**SELECT 3 文**(読み取りだけ)。
 * `dropped_json`(捨てた競馬場の理由と計測日時の文字列。migration 0021)は、書くときに {@link D1BabaStore.finish} が JSON にし、読むときは理由の語の許可リストと長さで整えて返す(壊れた値は null)。
 *
 * 書き込みは 1 枠 数文(claim の batch が 1 + finish の batch が 1〈競馬場の数 + 3 文〉)。呼び出しは `RaceDayCore` の取得ステップだけ。
 */
import type { BabaFinish, BabaReader, BabaStore } from "./race-day-baba";
import { normalizeDayBaba, type DayBaba } from "../../packages/core/src/analyzer/day-baba";
import { BABA_DROPPED_DETAIL_LIMIT, BABA_MEASURED_TEXT_LIMIT, type BabaDropReason, type BabaDroppedDetail, type BabaVenueRecord } from "./baba-conditions";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type BabaDb = Pick<D1Database, "prepare" | "batch">;

const DONE_SQL = "SELECT 1 AS done FROM baba_fetch_attempts WHERE kaisai_date = ? AND complete = 1 LIMIT 1";

const CLAIM_SQL = "INSERT INTO baba_fetch_attempts (kaisai_date, slot, attempted_at) VALUES (?, ?, ?) ON CONFLICT (kaisai_date, slot) DO NOTHING";

/** その日の要約の行(最初の試みで作る。2 回目以降は何もしない)。 */
const CLAIM_DAY_SQL = "INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES (?, ?) ON CONFLICT (kaisai_date) DO NOTHING";

/** 枠の行の更新。`venues_saved` はこの回の `saved_at` で書かれた行の数(競馬場の書き込みの後の文で実行する)。 */
const FINISH_ATTEMPT_SQL =
  "UPDATE baba_fetch_attempts SET finished_at = ?, result = ?, api_fetched_at = ?, " +
  "venues_saved = (SELECT COUNT(*) FROM baba_conditions WHERE kaisai_date = ? AND saved_at = ?), venues_dropped = ?, dropped_json = ?, complete = ? " +
  "WHERE kaisai_date = ? AND slot = ?";

/** 保持の条件: 既に ok の日の要約を、後の回の失敗で上書きしない。 */
const KEEP_OK = "(result = 'ok' AND ? <> 'ok')";

/** その日の要約の更新: 最新の回の結果。ただし ok の要約は、後の回の失敗で上書きしない。`venues_saved` は日の合計。 */
const FINISH_DAY_SQL =
  `UPDATE baba_fetches SET finished_at = CASE WHEN ${KEEP_OK} THEN finished_at ELSE ? END, ` +
  `api_fetched_at = CASE WHEN ${KEEP_OK} THEN api_fetched_at ELSE ? END, ` +
  `venues_dropped = CASE WHEN ${KEEP_OK} THEN venues_dropped ELSE ? END, ` +
  `dropped_json = CASE WHEN ${KEEP_OK} THEN dropped_json ELSE ? END, ` +
  "venues_saved = (SELECT COUNT(*) FROM baba_conditions WHERE kaisai_date = ?), " +
  `result = CASE WHEN ${KEEP_OK} THEN result ELSE ? END ` +
  "WHERE kaisai_date = ?";

const VALUE_COLUMNS = [
  "cushion",
  "turf_condition",
  "turf_goal_condition",
  "turf_corner4_condition",
  "turf_goal_moisture",
  "turf_corner4_moisture",
  "dirt_condition",
  "dirt_goal_condition",
  "dirt_corner4_condition",
  "dirt_goal_moisture",
  "dirt_corner4_moisture",
  "rainfall_mm",
  "used_course",
  "turf_length",
  "turf_state_text",
] as const;

const MOISTURE_COLUMNS = ["turf_goal_moisture", "turf_corner4_moisture", "dirt_goal_moisture", "dirt_corner4_moisture"] as const;
const allNull = (prefix: string): string => MOISTURE_COLUMNS.map((c) => `${prefix}${c} IS NULL`).join(" AND ");
const anyPresent = (prefix: string): string => MOISTURE_COLUMNS.map((c) => `${prefix}${c} IS NOT NULL`).join(" OR ");

/**
 * 競馬場の行の保存(補完の upsert)。新しい行は INSERT。既にある行は、欠けを埋めるときだけ更新する(冒頭の「既に入っている行の補完」):
 * 既存のクッション値が NULL で新しい読みにある、または、既存の含水率が 4 つとも NULL で新しい読みに 1 つでもある。
 * `raw_json` は更新した読みのもので、行の列(古い読みと新しい読みの混在)とは一致しない。読み手は無い(診断用)。
 */
const CONDITION_SQL =
  "INSERT INTO baba_conditions (kaisai_date, venue_code, venue_name, measured_at, cushion, " +
  "turf_condition, turf_goal_condition, turf_corner4_condition, turf_goal_moisture, turf_corner4_moisture, " +
  "dirt_condition, dirt_goal_condition, dirt_corner4_condition, dirt_goal_moisture, dirt_corner4_moisture, " +
  "rainfall_mm, used_course, turf_length, turf_state_text, raw_json, saved_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kaisai_date, venue_code) DO UPDATE SET " +
  "measured_at = CASE WHEN baba_conditions.cushion IS NULL AND excluded.cushion IS NOT NULL THEN excluded.measured_at ELSE baba_conditions.measured_at END, " +
  VALUE_COLUMNS.map((c) => `${c} = COALESCE(baba_conditions.${c}, excluded.${c})`).join(", ") +
  ", raw_json = excluded.raw_json, saved_at = excluded.saved_at " +
  `WHERE (baba_conditions.cushion IS NULL AND excluded.cushion IS NOT NULL) OR ((${allNull("baba_conditions.")}) AND (${anyPresent("excluded.")}))`;

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
  /** 枠ごとの試み(`baba_fetch_attempts`。枠の順。Issue #480)。旧版〈1 日 1 回〉の日・枠の記録を持たない日は空。 */
  readonly attempts: readonly BabaAttemptRecord[];
}

/** 取得の枠 1 回ぶんの記録(管理者の診断用の読み出し)。URL・応答の本文・元の JSON は持たない。 */
export interface BabaAttemptRecord {
  /** 枠の番号(0 = 最初の枠)。 */
  readonly slot: number;
  readonly attemptedAt: number;
  readonly finishedAt: number | null;
  readonly result: string | null;
  readonly apiFetchedAt: string | null;
  /** この回で新しく入った・欠けを埋めた競馬場の数。 */
  readonly venuesSaved: number | null;
  readonly venuesDropped: number | null;
  readonly dropped: readonly BabaDroppedDetail[] | null;
  /** この回で、その日の全部の場がそろったか。null = 結果を記録できなかった。 */
  readonly complete: boolean | null;
}

const FETCH_LIST_SQL =
  "SELECT kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped, dropped_json FROM baba_fetches ORDER BY kaisai_date DESC LIMIT ?";
const FETCH_ONE_SQL =
  "SELECT kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped, dropped_json FROM baba_fetches WHERE kaisai_date = ?";
const ATTEMPTS_SQL =
  "SELECT kaisai_date, slot, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped, dropped_json, complete FROM baba_fetch_attempts WHERE kaisai_date >= ? AND kaisai_date <= ? ORDER BY kaisai_date DESC, slot";
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

  /**
   * 枠の試みを先に記録する。行を作れたら `claimed`(JRA に出てよい)、その枠が既にあれば `exists`(出ない)、その日に「そろった」回が既にあれば `done`(出ない)。
   * 失敗は投げる(まだ JRA に出ていないので、呼び出し側が再試行してよい)。
   */
  async claim(kaisaiDate: string, slot: number, attemptedAt: number): Promise<"claimed" | "exists" | "done"> {
    const done = await this.db.prepare(DONE_SQL).bind(kaisaiDate).first<Record<string, unknown>>();
    if (done !== null) {
      return "done";
    }
    const results = await this.db.batch([this.db.prepare(CLAIM_SQL).bind(kaisaiDate, slot, attemptedAt), this.db.prepare(CLAIM_DAY_SQL).bind(kaisaiDate, attemptedAt)]);
    return (results[0]?.meta.changes ?? 0) > 0 ? "claimed" : "exists";
  }

  /**
   * 競馬場の行(補完の upsert)・枠の行の更新・その日の要約の更新を、batch 1 回(原子的)で書く。
   * 競馬場の行を先に書く(枠の `venues_saved` は、この回の `saved_at` で書かれた行を数える)。失敗は投げる(呼び出し側は警告にして、同じ枠では再試行しない)。
   */
  async finish(kaisaiDate: string, finish: BabaFinish): Promise<void> {
    const droppedJson = JSON.stringify(finish.droppedDetails);
    const statements = [
      ...finish.venues.map((v) => this.db.prepare(CONDITION_SQL).bind(...conditionBinds(kaisaiDate, v, finish.finishedAt))),
      this.db
        .prepare(FINISH_ATTEMPT_SQL)
        .bind(finish.finishedAt, finish.result, finish.apiFetchedAt, kaisaiDate, finish.finishedAt, finish.dropped, droppedJson, finish.complete ? 1 : 0, kaisaiDate, finish.slot),
      this.db
        .prepare(FINISH_DAY_SQL)
        .bind(finish.result, finish.finishedAt, finish.result, finish.apiFetchedAt, finish.result, finish.dropped, finish.result, droppedJson, kaisaiDate, finish.result, finish.result, kaisaiDate),
    ];
    await this.db.batch(statements);
  }

  /**
   * 取得の試みの記録(日ごとの要約)を、開催日の新しい順に返す(Issue #360。管理者の診断用)。`kaisaiDate` を指定するとその日の 1 行だけ。保存した競馬場(`baba_conditions`)と枠ごとの試み(Issue #480)も日ごとに付ける。
   * SELECT 3 文(読み取りだけ)。失敗は投げる(呼び出し側が固定の種類名の 503 にする)。
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
    const attemptRows = (await this.db.prepare(ATTEMPTS_SQL).bind(dates[0], dates[dates.length - 1]).all<Record<string, unknown>>()).results;
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
        attempts: attemptRows
          .filter((a) => a["kaisai_date"] === date)
          .map((a) => ({
            slot: Number(a["slot"]),
            attemptedAt: Number(a["attempted_at"]),
            finishedAt: numberOrNull(a["finished_at"]),
            result: stringOrNull(a["result"]),
            apiFetchedAt: stringOrNull(a["api_fetched_at"]),
            venuesSaved: numberOrNull(a["venues_saved"]),
            venuesDropped: numberOrNull(a["venues_dropped"]),
            dropped: readDroppedJson(a["dropped_json"]),
            complete: typeof a["complete"] === "number" ? a["complete"] === 1 : null,
          })),
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
