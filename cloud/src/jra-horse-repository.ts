/**
 * JRA の馬ごとの頁から取った属性(父・母・母の父・生産者)の D1 への保存と、取る馬の読み出し(Issue #697)。
 * 書くのは `horse_profiles` だけ(馬主〈`horse_owner_history`〉は書かない。ユーザーの決定)。出どころは `source = 'jra_horse'`。
 *
 * **既存の行は上書きしない**(`ON CONFLICT DO NOTHING`)。出馬表から入った行(`source = 'jra'`。レース時点の値)を、馬の頁の値で消さないため。
 * 逆に、ここで入れた行を後から出馬表の保存(`jra-entries-repository.ts` の UPSERT)が上書きするのはよい(レース時点の値が優先)。
 * 読み出しは、全走査をしない: 対象の馬は `horse_runs` の主キー(horse_id, race_key)の範囲読み、いるかの確認は json_each に束縛した配列で `horse_profiles` の主キーを引く。
 */
import type { HorseProfile } from "./jra-horse-parse";

export type JraHorseDb = Pick<D1Database, "prepare">;

export const JRA_HORSE_SOURCE = "jra_horse";

/** ?1 = カーソル(この ID より大きい馬)、?2 = 件数の上限。主キーの先頭 horse_id の範囲読み(GROUP BY は主キーの順をそのまま使う)。 */
export const LIST_HORSE_IDS_SQL = "SELECT horse_id FROM horse_runs WHERE horse_id > ?1 GROUP BY horse_id ORDER BY horse_id LIMIT ?2";

/** ?1 = 馬の ID の JSON 配列。`horse_profiles` にいない馬だけ(主キーの引き)。 */
export const FILTER_MISSING_SQL = "SELECT value AS horse_id FROM json_each(?1) WHERE NOT EXISTS (SELECT 1 FROM horse_profiles p WHERE p.horse_id = value)";

/** ?1 = 馬の JSON の配列、?2 = 取得した日(YYYYMMDD)。既にいる馬は書かない。 */
export const INSERT_HORSE_PROFILES_SQL =
  "INSERT INTO horse_profiles (horse_id, name, sire, dam, dam_sire, breeder, source, first_seen_on, updated_on) " +
  `SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.sire'), json_extract(value, '$.dam'), json_extract(value, '$.ds'), json_extract(value, '$.breeder'), '${JRA_HORSE_SOURCE}', ?2, ?2 ` +
  "FROM json_each(?1) WHERE true ON CONFLICT (horse_id) DO NOTHING";

export interface SavedHorseProfile extends HorseProfile {
  readonly horseId: string;
}

export interface JraHorseStoreLike {
  listHorseIdsAfter(cursor: string, limit: number): Promise<string[]>;
  filterMissing(horseIds: readonly string[]): Promise<string[]>;
  /** 書いた行数(`meta.changes`)。 */
  insertProfiles(profiles: readonly SavedHorseProfile[], today: string): Promise<number>;
}

export class D1JraHorseStore implements JraHorseStoreLike {
  constructor(private readonly deps: { readonly db: JraHorseDb }) {}

  async listHorseIdsAfter(cursor: string, limit: number): Promise<string[]> {
    const rows = await this.deps.db.prepare(LIST_HORSE_IDS_SQL).bind(cursor, limit).all<{ horse_id: string }>();
    return rows.results.map((r) => r.horse_id);
  }

  async filterMissing(horseIds: readonly string[]): Promise<string[]> {
    if (horseIds.length === 0) return [];
    const rows = await this.deps.db.prepare(FILTER_MISSING_SQL).bind(JSON.stringify(horseIds)).all<{ horse_id: string }>();
    const missing = new Set(rows.results.map((r) => r.horse_id));
    return horseIds.filter((id) => missing.has(id));
  }

  async insertProfiles(profiles: readonly SavedHorseProfile[], today: string): Promise<number> {
    if (profiles.length === 0) return 0;
    const json = JSON.stringify(profiles.map((p) => ({ id: p.horseId, name: p.name, sire: p.sire, dam: p.dam, ds: p.damSire, breeder: p.breeder })));
    const result = await this.deps.db.prepare(INSERT_HORSE_PROFILES_SQL).bind(json, today).run();
    return result.meta.changes ?? 0;
  }
}
