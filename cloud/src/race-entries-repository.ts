/**
 * 出馬表の D1 への保存(Issue #799。migration 0050 の表 `race_entry_races`・`race_entry_horses`)。
 *
 * 1 レースの保存は D1 への問い合わせ 3 文(Workers Free の 1 呼び出し 50 の内側。`batch` は使わず、文の数で数える):
 *  1. レースの行の UPSERT。
 *  2. 馬の行の UPSERT(`INSERT … SELECT … FROM json_each(?)` で、馬の配列を JSON 1 個に束縛する。1 行ずつ束縛すると 1 文 100 変数の上限に近づく)。
 *  3. 出馬表から消えた馬の行の DELETE(そのレースの、馬番が今回の一覧に無い行。主キー先頭の範囲)。
 * **同じ値の再保存は行を書かない**: UPSERT の `DO UPDATE ... WHERE` が、値の列が既存の行と違うときだけ更新する(`saved_at` は比べない)。
 * NULL を含む列は `IS NOT` で比べる(`!=` だと NULL が絡む遷移を取りこぼす)。値が違えば最後の値で上書きする。
 * 失敗は投げる。**呼び出し側(RaceDay の計算ステップ)が握って警告にする**(分析は止めない)。
 */

import type { RaceEntriesRecord, RaceEntriesStore } from "./race-entries";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type RaceEntriesDb = Pick<D1Database, "prepare">;

export const UPSERT_ENTRY_RACE_SQL =
  "INSERT INTO race_entry_races (race_id, kaisai_date, venue_code, course_type, distance, race_class, grade, start_time, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (race_id) DO UPDATE SET kaisai_date = excluded.kaisai_date, venue_code = excluded.venue_code, course_type = excluded.course_type, distance = excluded.distance, " +
  "race_class = excluded.race_class, grade = excluded.grade, start_time = excluded.start_time, saved_at = excluded.saved_at " +
  "WHERE race_entry_races.kaisai_date IS NOT excluded.kaisai_date OR race_entry_races.venue_code IS NOT excluded.venue_code OR race_entry_races.course_type IS NOT excluded.course_type " +
  "OR race_entry_races.distance IS NOT excluded.distance OR race_entry_races.race_class IS NOT excluded.race_class OR race_entry_races.grade IS NOT excluded.grade " +
  "OR race_entry_races.start_time IS NOT excluded.start_time";

/** `?1` = 馬の配列(JSON。要素は [馬番, 枠, 馬 ID, 騎手 ID, 調教師 ID, 斤量, 性, 齢, scratch])、`?2` = レース ID、`?3` = 書く時刻。 */
export const UPSERT_ENTRY_HORSES_SQL =
  "INSERT INTO race_entry_horses (race_id, umaban, waku, horse_id, jockey_id, trainer_id, kinryo, sex, age, scratch, saved_at) " +
  "SELECT ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), " +
  "json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), ?3 FROM json_each(?1) WHERE true " +
  "ON CONFLICT (race_id, umaban) DO UPDATE SET waku = excluded.waku, horse_id = excluded.horse_id, jockey_id = excluded.jockey_id, trainer_id = excluded.trainer_id, " +
  "kinryo = excluded.kinryo, sex = excluded.sex, age = excluded.age, scratch = excluded.scratch, saved_at = excluded.saved_at " +
  "WHERE race_entry_horses.waku IS NOT excluded.waku OR race_entry_horses.horse_id IS NOT excluded.horse_id OR race_entry_horses.jockey_id IS NOT excluded.jockey_id " +
  "OR race_entry_horses.trainer_id IS NOT excluded.trainer_id OR race_entry_horses.kinryo IS NOT excluded.kinryo OR race_entry_horses.sex IS NOT excluded.sex " +
  "OR race_entry_horses.age IS NOT excluded.age OR race_entry_horses.scratch IS NOT excluded.scratch";

/** `?1` = レース ID、`?2` = 今回の馬番の配列(JSON)。 */
export const DELETE_GONE_ENTRY_HORSES_SQL =
  "DELETE FROM race_entry_horses WHERE race_id = ?1 AND umaban NOT IN (SELECT value FROM json_each(?2))";

export class D1RaceEntriesStore implements RaceEntriesStore {
  private readonly db: RaceEntriesDb;

  constructor(options: { readonly db: RaceEntriesDb }) {
    this.db = options.db;
  }

  async save(record: RaceEntriesRecord): Promise<void> {
    const r = record.race;
    await this.db
      .prepare(UPSERT_ENTRY_RACE_SQL)
      .bind(r.raceId, r.kaisaiDate, r.venueCode, r.courseType, r.distance, r.raceClass, r.grade, r.startTime, r.savedAt)
      .run();
    const rows = record.horses.map((h) => [h.umaban, h.waku, h.horseId, h.jockeyId, h.trainerId, h.kinryo, h.sex, h.age, h.scratch]);
    await this.db.prepare(UPSERT_ENTRY_HORSES_SQL).bind(JSON.stringify(rows), r.raceId, r.savedAt).run();
    await this.db.prepare(DELETE_GONE_ENTRY_HORSES_SQL).bind(r.raceId, JSON.stringify(record.horses.map((h) => h.umaban))).run();
  }
}
