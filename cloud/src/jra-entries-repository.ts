/**
 * JRA の出馬表の取得の記録(`jra_entry_fetches`)と、馬の血統・生産者(`horse_profiles`)・馬主の履歴(`horse_owner_history`)・レースごとの出走時の情報(`race_horse_entries`)の
 * D1 への保存(Issue #639。migration 0038)。**保存するだけ**: 分析・プロンプト・画面には使わない(読み出しの SQL は持たない)。
 *
 * ## 試みの先行記録: {@link D1JraEntriesStore.claim}
 * JRA に出る**前に** (開催日, 場, 試行番号) の行を `INSERT ... ON CONFLICT DO NOTHING` で書く。`meta.changes` が 1 のとき(= この呼び出しが行を作った)だけ `claimed`、0 なら `exists`
 * (その試みは既に行った。DO の再起動・アラームの重複・DO のストレージの消失でも、同じ試みの 2 回目は通らない)。その場に `complete = 1` の回があれば `done`(取り直さない)。
 * 場コード `00` は、開催の選択・レースの選択をたどる回(場ごとの CNAME を集める)。
 *
 * ## 保存: {@link D1JraEntriesStore.saveRaces}
 * 書き込みの文は、行数によらず**表ごとに 1 文**(`json_each` で束縛した配列を `INSERT ... SELECT`。`docs/db-sql-rules.md` の 5)。1 文の束縛値は 100KB を超えないよう、
 * {@link ENTRY_CHUNK_HORSES} 頭ごとに分け、全部を 1 回の `batch`(原子的)で書く(216 頭でも文は 18 本)。D1 の 1 回の呼び出しの文は 50 まで。
 * 値が変わらないときは**書かない**(`ON CONFLICT DO UPDATE ... WHERE` が偽なら行を書かない)ので、同じ馬を毎回取っても書き込みの行数は増えない。
 *  - `horse_profiles`: 血統・生産者は上書き。ただし**読めなかった項目(NULL)で既に入っている値を消さない**(COALESCE)。古い日付の取得(過去の分の後追い)は、新しい値を上書きしない。
 *  - `horse_owner_history`: (馬, 馬主) ごとに 1 行。同じ馬主なら `last_seen_on` だけ進める。馬主が空なら作らない。
 *  - `race_horse_entries`: (レース, 馬) ごとに 1 行。ブリンカー無しの行も入れる。値が変わったときだけ更新する。
 * 書き込みの見積もり(1 開催日の最大): 36 レース × 約 16 頭 = 約 580 行 × 3 表 = 約 1,750 行(D1 の 1 日 10 万行の 2% 弱)。
 */
import type { JraEntryHorse } from "./jra-entries-parse";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type JraEntriesDb = Pick<D1Database, "prepare" | "batch">;

/** 1 文に束縛する馬の数の上限。1 頭の JSON は、7 項目すべてが 64 字の日本語(3 バイト)の最悪で約 1.3KB(実測: 60 頭で 77KB だった)。40 頭なら最悪でも約 52KB で、100KB に収まる。 */
export const ENTRY_CHUNK_HORSES = 40;

/** この Issue の出どころ。 */
export const JRA_SOURCE = "jra";

export const JRA_ENTRY_DONE_SQL = "SELECT 1 AS done FROM jra_entry_fetches WHERE kaisai_date = ? AND venue_code = ? AND complete = 1 LIMIT 1";

export const JRA_ENTRY_CLAIM_SQL = "INSERT INTO jra_entry_fetches (kaisai_date, venue_code, attempt, attempted_at) VALUES (?, ?, ?, ?) ON CONFLICT (kaisai_date, venue_code, attempt) DO NOTHING";

export const JRA_ENTRY_FINISH_SQL =
  "UPDATE jra_entry_fetches SET finished_at = ?, result = ?, races_total = ?, races_saved = ?, horses_skipped = ?, requests = ?, elapsed_ms = ?, complete = ? " +
  "WHERE kaisai_date = ? AND venue_code = ? AND attempt = ?";

/** 新しい(または同じ)日付の取得か。古い日付の取得(過去の分の後追い)は、新しい値を上書きしない。 */
const NEWER = "excluded.updated_on >= horse_profiles.updated_on";

/** 馬ごと。?1 = 馬の JSON の配列、?2 = 開催日、?3 = 出どころ。 */
export const UPSERT_PROFILES_SQL =
  "INSERT INTO horse_profiles (horse_id, name, sire, dam, dam_sire, breeder, source, first_seen_on, updated_on) " +
  "SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.sire'), json_extract(value, '$.dam'), json_extract(value, '$.ds'), json_extract(value, '$.breeder'), ?3, ?2, ?2 " +
  "FROM json_each(?1) WHERE true " +
  "ON CONFLICT (horse_id) DO UPDATE SET " +
  `name = CASE WHEN ${NEWER} THEN excluded.name ELSE horse_profiles.name END, ` +
  `sire = CASE WHEN ${NEWER} THEN COALESCE(excluded.sire, horse_profiles.sire) ELSE horse_profiles.sire END, ` +
  `dam = CASE WHEN ${NEWER} THEN COALESCE(excluded.dam, horse_profiles.dam) ELSE horse_profiles.dam END, ` +
  `dam_sire = CASE WHEN ${NEWER} THEN COALESCE(excluded.dam_sire, horse_profiles.dam_sire) ELSE horse_profiles.dam_sire END, ` +
  `breeder = CASE WHEN ${NEWER} THEN COALESCE(excluded.breeder, horse_profiles.breeder) ELSE horse_profiles.breeder END, ` +
  `source = CASE WHEN ${NEWER} THEN excluded.source ELSE horse_profiles.source END, ` +
  "first_seen_on = MIN(horse_profiles.first_seen_on, excluded.first_seen_on), " +
  "updated_on = MAX(horse_profiles.updated_on, excluded.updated_on) " +
  "WHERE excluded.first_seen_on < horse_profiles.first_seen_on " +
  `OR (${NEWER} AND (horse_profiles.name IS NOT excluded.name ` +
  "OR (excluded.sire IS NOT NULL AND horse_profiles.sire IS NOT excluded.sire) " +
  "OR (excluded.dam IS NOT NULL AND horse_profiles.dam IS NOT excluded.dam) " +
  "OR (excluded.dam_sire IS NOT NULL AND horse_profiles.dam_sire IS NOT excluded.dam_sire) " +
  "OR (excluded.breeder IS NOT NULL AND horse_profiles.breeder IS NOT excluded.breeder)))";

/** 馬主の履歴。馬主が空(NULL)の馬は作らない。 */
export const UPSERT_OWNERS_SQL =
  "INSERT INTO horse_owner_history (horse_id, owner, source, first_seen_on, last_seen_on) " +
  "SELECT json_extract(value, '$.id'), json_extract(value, '$.owner'), ?3, ?2, ?2 FROM json_each(?1) WHERE json_extract(value, '$.owner') IS NOT NULL " +
  "ON CONFLICT (horse_id, owner) DO UPDATE SET " +
  "first_seen_on = MIN(horse_owner_history.first_seen_on, excluded.first_seen_on), " +
  "last_seen_on = MAX(horse_owner_history.last_seen_on, excluded.last_seen_on) " +
  "WHERE excluded.last_seen_on > horse_owner_history.last_seen_on OR excluded.first_seen_on < horse_owner_history.first_seen_on";

/** レースごとの出走時の情報。 */
export const UPSERT_ENTRIES_SQL =
  "INSERT INTO race_horse_entries (race_id, horse_id, source, umaban, blinker, reduction_kg, foreign_mark, updated_on) " +
  "SELECT json_extract(value, '$.race'), json_extract(value, '$.id'), ?3, json_extract(value, '$.um'), json_extract(value, '$.bl'), json_extract(value, '$.rd'), json_extract(value, '$.fm'), ?2 " +
  "FROM json_each(?1) WHERE true " +
  "ON CONFLICT (race_id, horse_id) DO UPDATE SET source = excluded.source, umaban = excluded.umaban, blinker = excluded.blinker, reduction_kg = excluded.reduction_kg, foreign_mark = excluded.foreign_mark, updated_on = excluded.updated_on " +
  "WHERE excluded.updated_on >= race_horse_entries.updated_on AND " +
  "(race_horse_entries.umaban IS NOT excluded.umaban OR race_horse_entries.blinker <> excluded.blinker OR race_horse_entries.reduction_kg <> excluded.reduction_kg OR race_horse_entries.foreign_mark <> excluded.foreign_mark)";

/** 1 レースぶんの馬。 */
export interface SavedRace {
  /** netkeiba の race_id(12 桁)。 */
  readonly raceId: string;
  readonly horses: readonly JraEntryHorse[];
}

/** 試みの結果(`jra_entry_fetches` の列)。 */
export interface JraEntriesFinish {
  readonly finishedAt: number;
  readonly result: string;
  readonly racesTotal: number;
  readonly racesSaved: number;
  readonly horsesSkipped: number;
  readonly requests: number;
  readonly elapsedMs: number;
  readonly complete: boolean;
}

export interface JraEntriesStoreLike {
  claim(kaisaiDate: string, venueCode: string, attempt: number, attemptedAt: number): Promise<"claimed" | "exists" | "done">;
  saveRaces(kaisaiDate: string, races: readonly SavedRace[]): Promise<{ readonly rowsWritten: number }>;
  finish(kaisaiDate: string, venueCode: string, attempt: number, finish: JraEntriesFinish): Promise<void>;
}

export interface D1JraEntriesStoreDeps {
  readonly db: JraEntriesDb;
}

const orNull = (text: string): string | null => (text === "" ? null : text);

export class D1JraEntriesStore implements JraEntriesStoreLike {
  constructor(private readonly deps: D1JraEntriesStoreDeps) {}

  async claim(kaisaiDate: string, venueCode: string, attempt: number, attemptedAt: number): Promise<"claimed" | "exists" | "done"> {
    const { db } = this.deps;
    const done = await db.prepare(JRA_ENTRY_DONE_SQL).bind(kaisaiDate, venueCode).first<{ done: number }>();
    if (done !== null) {
      return "done";
    }
    const result = await db.prepare(JRA_ENTRY_CLAIM_SQL).bind(kaisaiDate, venueCode, attempt, attemptedAt).run();
    return result.meta.changes === 1 ? "claimed" : "exists";
  }

  async saveRaces(kaisaiDate: string, races: readonly SavedRace[]): Promise<{ readonly rowsWritten: number }> {
    const rows = races.flatMap((race) =>
      race.horses.map((h) => ({
        race: race.raceId,
        id: h.horseId,
        name: h.name,
        sire: orNull(h.sire),
        dam: orNull(h.dam),
        ds: orNull(h.damSire),
        breeder: orNull(h.breeder),
        owner: orNull(h.owner),
        um: h.umaban,
        bl: h.blinker ? 1 : 0,
        rd: h.reductionKg,
        fm: h.foreignMark ? 1 : 0,
      })),
    );
    if (rows.length === 0) {
      return { rowsWritten: 0 };
    }
    const { db } = this.deps;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += ENTRY_CHUNK_HORSES) {
      const json = JSON.stringify(rows.slice(i, i + ENTRY_CHUNK_HORSES));
      for (const sql of [UPSERT_PROFILES_SQL, UPSERT_OWNERS_SQL, UPSERT_ENTRIES_SQL]) {
        statements.push(db.prepare(sql).bind(json, kaisaiDate, JRA_SOURCE));
      }
    }
    const results = await db.batch(statements);
    return { rowsWritten: results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0) };
  }

  async finish(kaisaiDate: string, venueCode: string, attempt: number, f: JraEntriesFinish): Promise<void> {
    await this.deps.db
      .prepare(JRA_ENTRY_FINISH_SQL)
      .bind(f.finishedAt, f.result, f.racesTotal, f.racesSaved, f.horsesSkipped, f.requests, f.elapsedMs, f.complete ? 1 : 0, kaisaiDate, venueCode, attempt)
      .run();
  }
}
