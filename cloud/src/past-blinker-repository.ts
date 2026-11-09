/**
 * 過去のレースのブリンカー着用(JRA の過去の結果の頁から取ったもの)の D1 への保存と、取り終えたレースの確認(Issue #698)。表は migration 0044 の `past_blinker_races`・`past_blinker_horses`。
 *
 * **約束**: 「`past_blinker_races` に行があるレースの馬で、`past_blinker_horses` に行が無い = 着けていなかった」。着けていない馬の行は書かない(書き込みの行数を減らすため)。
 * この約束を守るため、レースの行は、そのレースの馬の行と**同じ batch(1 つのトランザクション)**で書く。馬の表の INSERT を先に並べ、どちらかが失敗すれば両方とも残らない。
 * 既存の行は書き換えない(`ON CONFLICT DO NOTHING`)。書く行数(`meta.changes` の合計)を返す。呼び出し側(DO)が 1 日の上限に数える。
 * 読み出しは全走査をしない: 取り終えたかは、json_each に束縛した配列から `past_blinker_races` の主キーを引く。
 */
export interface PastBlinkerDb {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export const PAST_BLINKER_SOURCE = "jra_result";

/** ?1 = レースの ID の JSON 配列。取り終えたレースだけ(主キーの引き)。 */
export const FILTER_DONE_SQL = "SELECT value AS race_id FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM past_blinker_races r WHERE r.race_id = value)";

/** ?1 = `[{"r": レース, "h": 馬}]` の JSON、?2 = 取得した日(YYYYMMDD)。 */
export const INSERT_BLINKER_HORSES_SQL =
  "INSERT INTO past_blinker_horses (race_id, horse_id, source, fetched_on) " +
  `SELECT json_extract(value, '$.r'), json_extract(value, '$.h'), '${PAST_BLINKER_SOURCE}', ?2 FROM json_each(?1) WHERE true ON CONFLICT (race_id, horse_id) DO NOTHING`;

/** ?1 = `[{"r": レース, "n": 頭数, "b": 印の数}]` の JSON、?2 = 取得した日(YYYYMMDD)。 */
export const INSERT_RACES_SQL =
  "INSERT INTO past_blinker_races (race_id, fetched_on, head_count, blinker_count) " +
  "SELECT json_extract(value, '$.r'), ?2, json_extract(value, '$.n'), json_extract(value, '$.b') FROM json_each(?1) WHERE true ON CONFLICT (race_id) DO NOTHING";

export interface SavedPastRace {
  readonly raceId: string;
  readonly headCount: number;
  readonly blinkerHorseIds: readonly string[];
}

export interface PastBlinkerStoreLike {
  /** 渡したレースのうち、取り終えているもの(渡した順)。 */
  filterDone(raceIds: readonly string[]): Promise<string[]>;
  /** 書いた行数(2 つの表の `meta.changes` の合計)。 */
  saveRaces(races: readonly SavedPastRace[], today: string): Promise<number>;
}

export class D1PastBlinkerStore implements PastBlinkerStoreLike {
  constructor(private readonly deps: { readonly db: PastBlinkerDb }) {}

  async filterDone(raceIds: readonly string[]): Promise<string[]> {
    if (raceIds.length === 0) return [];
    const rows = await this.deps.db.prepare(FILTER_DONE_SQL).bind(JSON.stringify(raceIds)).all<{ race_id: string }>();
    const done = new Set(rows.results.map((r) => r.race_id));
    return raceIds.filter((id) => done.has(id));
  }

  async saveRaces(races: readonly SavedPastRace[], today: string): Promise<number> {
    if (races.length === 0) return 0;
    const { db } = this.deps;
    const horses = races.flatMap((r) => r.blinkerHorseIds.map((h) => ({ r: r.raceId, h })));
    const statements: D1PreparedStatement[] = [];
    if (horses.length > 0) statements.push(db.prepare(INSERT_BLINKER_HORSES_SQL).bind(JSON.stringify(horses), today));
    statements.push(db.prepare(INSERT_RACES_SQL).bind(JSON.stringify(races.map((r) => ({ r: r.raceId, n: r.headCount, b: r.blinkerHorseIds.length }))), today));
    const results = await db.batch(statements);
    return results.reduce((sum, res) => sum + (res.meta.changes ?? 0), 0);
  }
}
