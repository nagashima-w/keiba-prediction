/**
 * 騎手・調教師の年ごとの集計の D1 への読み書き(Issue #729 段階 A。migration 0048)。
 * 表: `race_person_rows`(レースで 1 行)・`person_year`(人 × 年で 1 行)と、目録の取り込み印 `race_archive.person_version`。
 * 構造は `market-edge-repository.ts`(#642)を写した。毎晩の段取りは `market-edge-core.ts`、集計は `person-stats-aggregate.ts`、定義は `person-stats-calc.ts`。
 *
 * D1 の決まり(`docs/db-sql-rules.md`): 全走査なし(未処理の列挙は部分索引、集計の読みは日付の索引の範囲、人の置き換えは主キー)・値の並びは `json_each` で束縛・1 回の呼び出しの文は 50 以内。
 */
import {
  PERSON_ROWS_VERSION,
  decodePersonHorses,
  encodePersonHorses,
  type PersonRow,
  type PersonYearRow,
} from "./person-stats-calc";

/** D1 のうち使う部分。 */
export type PersonStatsDb = Pick<D1Database, "prepare" | "batch">;

/** `race_archive.person_version` の「取り込み済み」の値(= {@link PERSON_ROWS_VERSION})。 */
export const PERSON_ROWS_DONE = PERSON_ROWS_VERSION;

/** 1 文に入れる人の行の数の上限。束縛数 = 6 × 行数 が D1 の上限 100 に収まる大きさ。 */
export const PERSON_ROWS_CHUNK = 16;

/** 1 文で置き換える人 × 年の数(束縛は JSON 1 つ + 日付 1 つ。JSON の大きさに合わせて決めた)。 */
export const PERSON_YEAR_CHUNK = 300;

/** 1 回の batch に入れる文の上限(D1 の 1 回の呼び出しは 50 文まで。余裕を見る)。 */
const BATCH_MAX = 40;

/**
 * 未処理(`person_version IS NULL`)の中央・2021-01-01 以降のレースを、主キー順のカーソルで読む。migration 0048 の部分索引 `idx_race_archive_person_pending` から引く。
 * ★この WHERE の `person_version IS NULL AND kind = 'central' AND race_date >= '2021-01-01'` は、索引の WHERE と同じ形(日付のリテラルも同じ)でなければならない(違うと SQLite は部分索引を使わず、全行を読む)。
 */
export const SELECT_PERSON_PENDING_PAGE_SQL =
  "SELECT race_id AS raceId, race_date AS raceDate FROM race_archive WHERE person_version IS NULL AND kind = 'central' AND race_date >= '2021-01-01' AND race_id > ? ORDER BY race_id LIMIT ?";

/** 取り込み印を付ける(印が NULL のものだけ)。束縛は (印, race_id の JSON 配列)。 */
export const MARK_PERSON_VERSION_SQL = "UPDATE race_archive SET person_version = ? WHERE race_id IN (SELECT value FROM json_each(?)) AND person_version IS NULL";

/** 人の行を n 行ぶん書く(同じレースは置き換える)。 */
export function savePersonRowsSql(n: number): string {
  return `INSERT INTO race_person_rows (race_id, race_date, venue_code, course_type, distance, horses_json) VALUES ${Array.from({ length: n }, () => "(?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT(race_id) DO UPDATE SET race_date = excluded.race_date, venue_code = excluded.venue_code, course_type = excluded.course_type, distance = excluded.distance, horses_json = excluded.horses_json`;
}

/**
 * 集計が読む人の行。(開催日, race_id) のカーソルの後ろから、日付の索引(`idx_race_person_rows_date`。末尾に主キーが入る)の範囲で、`race_date < ?`(年の翌年の 1 月 1 日)まで読む。
 * 束縛は (カーソルの開催日, カーソルの race_id, 範囲の終わり〈含まない〉, limit)。最初は (年の 1 月 1 日, "", 翌年の 1 月 1 日, limit)。
 */
export const SELECT_PERSON_ROWS_PAGE_SQL =
  "SELECT race_id AS raceId, race_date AS raceDate, venue_code AS venueCode, course_type AS courseType, distance, horses_json AS horsesJson FROM race_person_rows WHERE (race_date, race_id) > (?, ?) AND race_date < ? ORDER BY race_date, race_id LIMIT ?";

/**
 * 人 × 年の集計を置き換える(入れる)。束縛は (computed_on, 行の JSON 配列〈{k, id, y, s, p}〉)。
 * **値が同じなら書き換えない**(`WHERE` が偽なら DO UPDATE は何も書かない。`computed_on` は値を最後に変えた日になる)。
 * `WHERE true` は、`INSERT … SELECT … ON CONFLICT` の構文のあいまいさを避けるため。
 */
export const UPSERT_PERSON_YEAR_SQL = `INSERT INTO person_year (person_kind, person_id, year, starts, placed, computed_on)
SELECT json_extract(value, '$.k'), json_extract(value, '$.id'), json_extract(value, '$.y'), json_extract(value, '$.s'), json_extract(value, '$.p'), ?
FROM json_each(?) WHERE true
ON CONFLICT(person_kind, person_id, year) DO UPDATE SET starts = excluded.starts, placed = excluded.placed, computed_on = excluded.computed_on
WHERE person_year.starts IS NOT excluded.starts OR person_year.placed IS NOT excluded.placed`;

export interface PersonPendingEntry {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly raceDate: string;
}

export interface PersonRowsCursor {
  readonly raceDate: string;
  readonly raceId: string;
}

export interface PersonRowsPage {
  readonly rows: PersonRow[];
  /** 読めなかった(horses_json が壊れている)行の数。 */
  readonly broken: number;
  /** 続きのカーソル。ページが満杯でなければ(末尾に達した)null。 */
  readonly next: PersonRowsCursor | null;
}

function rowsWrittenOf(results: ReadonlyArray<{ meta?: { rows_written?: unknown } }>): number {
  let total = 0;
  for (const r of results) {
    const n = r.meta?.rows_written;
    if (typeof n === "number" && Number.isFinite(n)) total += n;
  }
  return total;
}

function sizeOf(meta: { size_after?: unknown } | undefined): number | null {
  const size = meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

export class D1PersonStatsStore {
  constructor(private readonly db: PersonStatsDb) {}

  /** 未処理の中央・2021-01-01 以降のレースを race_id の順に、`afterRaceId`(空文字なら先頭)の後ろから `limit` 件。 */
  async listPendingPage(afterRaceId: string, limit: number): Promise<PersonPendingEntry[]> {
    const { results } = await this.db.prepare(SELECT_PERSON_PENDING_PAGE_SQL).bind(afterRaceId, limit).all<PersonPendingEntry>();
    return results;
  }

  /**
   * 人の行を書き、`doneRaceIds`(行を書いたレースと、数える馬がなくて行を作らなかったレース)に取り込み印 {@link PERSON_ROWS_DONE} を付ける。**1 回の batch**(片方だけ書かれない)。
   * 行は {@link PERSON_ROWS_CHUNK} 行ずつ 1 文にする。失敗は投げる。
   */
  async saveRows(rows: readonly PersonRow[], doneRaceIds: readonly string[]): Promise<{ rowsWritten: number; dbSizeBytes: number | null }> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += PERSON_ROWS_CHUNK) {
      const chunk = rows.slice(i, i + PERSON_ROWS_CHUNK);
      statements.push(
        this.db.prepare(savePersonRowsSql(chunk.length)).bind(...chunk.flatMap((r) => [r.raceId, r.raceDate, r.venueCode, r.courseType, r.distance, encodePersonHorses(r.horses)])),
      );
    }
    if (doneRaceIds.length > 0) statements.push(this.db.prepare(MARK_PERSON_VERSION_SQL).bind(PERSON_ROWS_DONE, JSON.stringify(doneRaceIds)));
    if (statements.length === 0) return { rowsWritten: 0, dbSizeBytes: null };
    const results = await this.db.batch(statements);
    return { rowsWritten: rowsWrittenOf(results), dbSizeBytes: sizeOf(results[results.length - 1]?.meta as { size_after?: unknown } | undefined) };
  }

  /** 集計が読む人の行を、(開催日, race_id) の順に、カーソルの後ろから `limit` 行。`toExclusive`(含まない)の開催日の前まで。 */
  async readRowsPage(after: PersonRowsCursor, toExclusive: string, limit: number): Promise<PersonRowsPage> {
    const { results } = await this.db
      .prepare(SELECT_PERSON_ROWS_PAGE_SQL)
      .bind(after.raceDate, after.raceId, toExclusive, limit)
      .all<{ raceId: string; raceDate: string; venueCode: string; courseType: PersonRow["courseType"]; distance: number | null; horsesJson: string }>();
    const rows: PersonRow[] = [];
    let broken = 0;
    for (const r of results) {
      const horses = decodePersonHorses(r.horsesJson);
      if (horses === null) {
        broken += 1;
        continue;
      }
      rows.push({ raceId: r.raceId, raceDate: r.raceDate, venueCode: r.venueCode, courseType: r.courseType, distance: r.distance, horses });
    }
    const last = results[results.length - 1];
    return { rows, broken, next: results.length >= limit && last !== undefined ? { raceDate: last.raceDate, raceId: last.raceId } : null };
  }

  /** 人 × 年の集計を置き換える(値が変わった行だけ書く)。**1 回の batch**(文は {@link PERSON_YEAR_CHUNK} 人ずつ。多ければ batch を分ける)。 */
  async replaceYears(years: readonly PersonYearRow[], computedOn: string): Promise<{ rowsWritten: number }> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < years.length; i += PERSON_YEAR_CHUNK) {
      const chunk = years.slice(i, i + PERSON_YEAR_CHUNK);
      statements.push(this.db.prepare(UPSERT_PERSON_YEAR_SQL).bind(computedOn, JSON.stringify(chunk.map((y) => ({ k: y.personKind, id: y.personId, y: y.year, s: y.starts, p: y.placed })))));
    }
    let rowsWritten = 0;
    for (let i = 0; i < statements.length; i += BATCH_MAX) {
      rowsWritten += rowsWrittenOf(await this.db.batch(statements.slice(i, i + BATCH_MAX)));
    }
    return { rowsWritten };
  }
}
