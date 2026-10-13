/**
 * 馬場の API の取得の試み(`baba_fetches`)と、競馬場ごとの当日の値(`baba_conditions`)の D1 への保存(Issue #294〈#293-A〉。migration 0017)。
 *
 * ## 1 日 1 回の保証の実体: {@link D1BabaStore.claim}
 * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。**API に出る前に**、開催日を主キーとする行を `INSERT ... ON CONFLICT DO NOTHING` で書く。
 * `meta.changes` が 1 のとき(= この呼び出しが行を作った)だけ `claimed` を返し、0 なら `exists`(既に誰かが試みた)。DO の再起動・アラームの重複・DO のストレージの消失でも、2 回目は通らない。
 * 結果({@link D1BabaStore.finish})は、試みの行の更新と競馬場の行の INSERT を `batch` 1 回(原子的)で書く。**結果の保存に失敗しても、再試行はしない**(API は既に使った)。
 *
 * 書き込みは 1 日 数文(claim 1 + finish の batch が 1 + 競馬場の数)。呼び出しは `RaceDayCore` の取得ステップだけ。
 */
import type { BabaFinish, BabaStore } from "./race-day-baba";
import type { BabaVenueRecord } from "./baba-conditions";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type BabaDb = Pick<D1Database, "prepare" | "batch">;

const CLAIM_SQL = "INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES (?, ?) ON CONFLICT (kaisai_date) DO NOTHING";

const FINISH_SQL = "UPDATE baba_fetches SET finished_at = ?, result = ?, api_fetched_at = ?, venues_saved = ?, venues_dropped = ? WHERE kaisai_date = ?";

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

export class D1BabaStore implements BabaStore {
  private readonly db: BabaDb;

  constructor(options: { readonly db: BabaDb }) {
    this.db = options.db;
  }

  /** 試みを先に記録する。行を作れたら `claimed`(API に出てよい)、既にあれば `exists`(出ない)。失敗は投げる(まだ API に出ていないので、呼び出し側が再試行してよい)。 */
  async claim(kaisaiDate: string, attemptedAt: number): Promise<"claimed" | "exists"> {
    const result = await this.db.prepare(CLAIM_SQL).bind(kaisaiDate, attemptedAt).run();
    return (result.meta.changes ?? 0) > 0 ? "claimed" : "exists";
  }

  /** 結果の分類と、保存する競馬場の行を、batch 1 回(原子的)で書く。失敗は投げる(呼び出し側は警告にして、再試行しない)。 */
  async finish(kaisaiDate: string, finish: BabaFinish): Promise<void> {
    const statements = [
      this.db.prepare(FINISH_SQL).bind(finish.finishedAt, finish.result, finish.apiFetchedAt, finish.venues.length, finish.dropped, kaisaiDate),
      ...finish.venues.map((v) => this.db.prepare(CONDITION_SQL).bind(...conditionBinds(kaisaiDate, v, finish.finishedAt))),
    ];
    await this.db.batch(statements);
  }
}
