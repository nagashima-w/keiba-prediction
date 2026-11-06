/**
 * 騎手・調教師の「市場の予測との差」の指標の D1 への読み書き(Issue #642。migration 0039。式は `market-edge-calc.ts`、毎晩の段取りは `market-edge-core.ts`)。
 *
 * ## 表
 *  - `race_market_rows`: 中央の過去の結果 1 レースにつき 1 行(開催日・馬ごとの [騎手 ID, 名前, 調教師 ID, 名前, q, y] の JSON)。**取り込みのときに 1 回だけ書く**(R2 を毎晩読み直さない)。
 *  - `market_edge`: 騎手・調教師ごとの指標(毎晩、集計の結果で置き換える)。`market_edge_meta`: 直近の計算の記録(1 行)。
 *  - `race_archive.market_version`: 目録の取り込みの済み印。NULL = 未処理、{@link MARKET_ROWS_DONE} = 取り込み済み、{@link MARKET_ROWS_SKIPPED} = 窓より古いので読まずに印だけ付けた。
 *    未処理だけを部分索引 `idx_race_archive_market_pending` から読む(目録の全走査にならない)。目録の中身が変わる保存は NULL に戻す(`race-archive-repository.ts` の UPSERT)。
 *
 * ## 書き込みの見積もり(ローカルの workerd の `meta.rows_written` で固定。market-edge-repository.integration.test.ts)
 *  - 取り込み: 1 レースにつき、市場の行が本体 + 日付の索引で 2 行、取り込み印が目録の本体 1 行(部分索引から外れる分は `rows_written` に出なかった)。つまり 3 行。窓より古いレースは印だけで 1 行。
 *    ★索引の分は、DELETE でも出なかった(`pruneBefore` は 1 行の削除で 1)。Cloudflare の課金上の数え方が実測より多い可能性があるので、上限の見積もりには余裕を見る(取り込み 1 レースを最大 4 行として扱う)。
 *  - 毎晩の置き換え: 人数 + 記録 1 行 + 窓から外れた人の削除。
 *
 * D1 の 1 回の呼び出しで使える文は 50 まで(`docs/db-sql-rules.md`)。ここの batch は最大でも 取り込み 2〜3 文・置き換え 5 文。
 * ★`UPDATE`・`DELETE` を書くのはコードの経路で、migration には書かない(`docs/db-sql-rules.md` の決まり 3)。
 */
import type { MarketCoef, MarketEdge, MarketHorse, MarketRow } from "./market-edge-calc";
import { decodeMarketHorses, encodeMarketHorses } from "./market-edge-calc";

/** D1 のうち使う部分。 */
export type MarketEdgeDb = Pick<D1Database, "prepare" | "batch">;

/** `race_archive.market_version` の値。 */
export const MARKET_ROWS_DONE = 1;
export const MARKET_ROWS_SKIPPED = -1;

/** 1 文に入れる市場の行の数の上限。束縛数 = 3 × 行数 が D1 の上限 100 に収まる大きさ。 */
export const MARKET_ROWS_CHUNK = 33;

/**
 * 未処理(`market_version IS NULL`)の中央のレースを、主キー順のカーソルで読む。migration 0039 の部分索引 `idx_race_archive_market_pending` から引く。
 * ★この WHERE の `market_version IS NULL AND kind = 'central'` は、索引の WHERE と同じ形でなければならない(違うと SQLite は部分索引を使わず、全行を読む)。
 */
export const SELECT_MARKET_PENDING_PAGE_SQL = "SELECT race_id AS raceId, race_date AS raceDate FROM race_archive WHERE market_version IS NULL AND kind = 'central' AND race_id > ? ORDER BY race_id LIMIT ?";

/** 取り込み印を付ける(印が NULL のものだけ)。値は 1(取り込み済み)か -1(窓より古い)。束縛は (印, race_id の JSON 配列)。 */
export const MARK_MARKET_VERSION_SQL = "UPDATE race_archive SET market_version = ? WHERE race_id IN (SELECT value FROM json_each(?)) AND market_version IS NULL";

/** 市場の行を n 行ぶん書く(同じレースは置き換える)。 */
export function saveMarketRowsSql(n: number): string {
  return `INSERT INTO race_market_rows (race_id, race_date, horses_json) VALUES ${Array.from({ length: n }, () => "(?, ?, ?)").join(", ")} ON CONFLICT(race_id) DO UPDATE SET race_date = excluded.race_date, horses_json = excluded.horses_json`;
}

/**
 * 集計が読む市場の行。(開催日, race_id) のカーソルの後ろから、日付の索引(`idx_race_market_rows_date`。末尾に主キーが入る)の範囲で読む。
 * 束縛は (カーソルの開催日, カーソルの race_id, limit)。最初は (窓の開始日, "")。
 */
export const SELECT_MARKET_WINDOW_PAGE_SQL =
  "SELECT race_id AS raceId, race_date AS raceDate, horses_json AS horsesJson FROM race_market_rows WHERE (race_date, race_id) > (?, ?) ORDER BY race_date, race_id LIMIT ?";

/** 窓より前の市場の行を消す(日付の索引の範囲)。 */
export const PRUNE_MARKET_ROWS_SQL = "DELETE FROM race_market_rows WHERE race_date < ?";

/**
 * 指標を置き換える(入れる)。束縛は (person_kind, computed_on, 人の JSON 配列〈{id, name, n, edge, hitRate, predMean}〉)。
 * `WHERE true` は、`INSERT … SELECT … ON CONFLICT` の構文のあいまいさを避けるため。
 */
export const UPSERT_MARKET_EDGES_SQL = `INSERT INTO market_edge (person_kind, person_id, name, n, edge, hit_rate, pred_mean, computed_on)
SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.n'), json_extract(value, '$.edge'), json_extract(value, '$.hitRate'), json_extract(value, '$.predMean'), ?
FROM json_each(?) WHERE true
ON CONFLICT(person_kind, person_id) DO UPDATE SET name = excluded.name, n = excluded.n, edge = excluded.edge, hit_rate = excluded.hit_rate, pred_mean = excluded.pred_mean, computed_on = excluded.computed_on`;

/** 今回の置き換えに入らなかった人(窓から外れた人)を消す。person_kind の主キーの範囲。束縛は (person_kind, computed_on)。 */
export const DELETE_STALE_MARKET_EDGES_SQL = "DELETE FROM market_edge WHERE person_kind = ? AND computed_on <> ?";

/** 計算の記録(1 行。id = 1 に固定)。 */
export const UPSERT_MARKET_EDGE_META_SQL = `INSERT INTO market_edge_meta (id, computed_on, window_from, window_to, coef_json, converged, fit_iterations, races, horses)
VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET computed_on = excluded.computed_on, window_from = excluded.window_from, window_to = excluded.window_to, coef_json = excluded.coef_json, converged = excluded.converged, fit_iterations = excluded.fit_iterations, races = excluded.races, horses = excluded.horses`;

export const SELECT_MARKET_EDGES_SQL =
  "SELECT person_id AS id, name, n, edge, hit_rate AS hitRate, pred_mean AS predMean, computed_on AS computedOn FROM market_edge WHERE person_kind = ? ORDER BY person_id";

export const SELECT_MARKET_EDGE_META_SQL =
  "SELECT computed_on AS computedOn, window_from AS windowFrom, window_to AS windowTo, coef_json AS coefJson, converged, fit_iterations AS iterations, races, horses FROM market_edge_meta WHERE id = 1";

export interface MarketPendingEntry {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly raceDate: string;
}

export interface MarketWindowCursor {
  readonly raceDate: string;
  readonly raceId: string;
}

export interface MarketRowsPage {
  readonly rows: MarketRow[];
  /** 読めなかった(horses_json が壊れている)行の数。 */
  readonly broken: number;
  /** 続きのカーソル。ページが満杯でなければ(末尾に達した)null。 */
  readonly next: MarketWindowCursor | null;
}

/** 保存する指標の 1 回分。 */
export interface MarketEdgeSnapshot {
  readonly computedOn: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly coef: MarketCoef;
  readonly converged: boolean;
  readonly iterations: number;
  readonly races: number;
  readonly horses: number;
  readonly jockeys: readonly MarketEdge[];
  readonly trainers: readonly MarketEdge[];
}

export interface StoredMarketEdge extends MarketEdge {
  /** 計算した日(JST の YYYY-MM-DD) */
  readonly computedOn: string;
}

export interface MarketEdgeMeta {
  readonly computedOn: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly coef: MarketCoef;
  readonly converged: boolean;
  readonly iterations: number;
  readonly races: number;
  readonly horses: number;
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

export class D1MarketEdgeStore {
  constructor(private readonly db: MarketEdgeDb) {}

  /** 未処理の中央のレースを race_id の順に、`afterRaceId`(空文字なら先頭)の後ろから `limit` 件。 */
  async listPendingPage(afterRaceId: string, limit: number): Promise<MarketPendingEntry[]> {
    const { results } = await this.db.prepare(SELECT_MARKET_PENDING_PAGE_SQL).bind(afterRaceId, limit).all<MarketPendingEntry>();
    return results;
  }

  /** 窓より古いレースに、読まずに印 {@link MARKET_ROWS_SKIPPED} だけ付ける。 */
  async markSkipped(raceIds: readonly string[]): Promise<{ rowsWritten: number }> {
    if (raceIds.length === 0) return { rowsWritten: 0 };
    const res = await this.db.prepare(MARK_MARKET_VERSION_SQL).bind(MARKET_ROWS_SKIPPED, JSON.stringify(raceIds)).run();
    return { rowsWritten: rowsWrittenOf([res]) };
  }

  /**
   * 市場の行を書き、`doneRaceIds`(行を書いたレースと、使えなくて行を作らなかったレース)に取り込み印 {@link MARKET_ROWS_DONE} を付ける。**1 回の batch**(片方だけ書かれない)。
   * 行は {@link MARKET_ROWS_CHUNK} 行ずつ 1 文にする。失敗は投げる。
   */
  async saveRows(rows: readonly MarketRow[], doneRaceIds: readonly string[]): Promise<{ rowsWritten: number; dbSizeBytes: number | null }> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += MARKET_ROWS_CHUNK) {
      const chunk = rows.slice(i, i + MARKET_ROWS_CHUNK);
      statements.push(this.db.prepare(saveMarketRowsSql(chunk.length)).bind(...chunk.flatMap((r) => [r.raceId, r.raceDate, encodeMarketHorses(r.horses)])));
    }
    if (doneRaceIds.length > 0) statements.push(this.db.prepare(MARK_MARKET_VERSION_SQL).bind(MARKET_ROWS_DONE, JSON.stringify(doneRaceIds)));
    if (statements.length === 0) return { rowsWritten: 0, dbSizeBytes: null };
    const results = await this.db.batch(statements);
    return { rowsWritten: rowsWrittenOf(results), dbSizeBytes: sizeOf(results[results.length - 1]?.meta as { size_after?: unknown } | undefined) };
  }

  /** 集計が読む市場の行を、(開催日, race_id) の順に、カーソルの後ろから `limit` 行。 */
  async readWindowRowsPage(after: MarketWindowCursor, limit: number): Promise<MarketRowsPage> {
    const { results } = await this.db.prepare(SELECT_MARKET_WINDOW_PAGE_SQL).bind(after.raceDate, after.raceId, limit).all<{ raceId: string; raceDate: string; horsesJson: string }>();
    const rows: MarketRow[] = [];
    let broken = 0;
    for (const r of results) {
      const horses = decodeMarketHorses(r.horsesJson);
      if (horses === null) {
        broken += 1;
        continue;
      }
      rows.push({ raceId: r.raceId, raceDate: r.raceDate, horses: horses as readonly MarketHorse[] });
    }
    const last = results[results.length - 1];
    return { rows, broken, next: results.length >= limit && last !== undefined ? { raceDate: last.raceDate, raceId: last.raceId } : null };
  }

  /** 窓より前(`cutoff` より前の開催日)の市場の行を消す。 */
  async pruneBefore(cutoff: string): Promise<{ rowsWritten: number }> {
    const res = await this.db.prepare(PRUNE_MARKET_ROWS_SQL).bind(cutoff).run();
    return { rowsWritten: rowsWrittenOf([res]) };
  }

  /** 指標と記録を置き換える。**1 回の batch**(5 文)。窓から外れた人は消える。 */
  async replaceEdges(snapshot: MarketEdgeSnapshot): Promise<{ rowsWritten: number }> {
    const json = (list: readonly MarketEdge[]): string => JSON.stringify(list.map((e) => ({ id: e.id, name: e.name, n: e.n, edge: e.edge, hitRate: e.hitRate, predMean: e.predMean })));
    const results = await this.db.batch([
      this.db.prepare(UPSERT_MARKET_EDGES_SQL).bind("jockey", snapshot.computedOn, json(snapshot.jockeys)),
      this.db.prepare(UPSERT_MARKET_EDGES_SQL).bind("trainer", snapshot.computedOn, json(snapshot.trainers)),
      this.db.prepare(DELETE_STALE_MARKET_EDGES_SQL).bind("jockey", snapshot.computedOn),
      this.db.prepare(DELETE_STALE_MARKET_EDGES_SQL).bind("trainer", snapshot.computedOn),
      this.db
        .prepare(UPSERT_MARKET_EDGE_META_SQL)
        .bind(snapshot.computedOn, snapshot.windowFrom, snapshot.windowTo, JSON.stringify(snapshot.coef), snapshot.converged ? 1 : 0, snapshot.iterations, snapshot.races, snapshot.horses),
    ]);
    return { rowsWritten: rowsWrittenOf(results) };
  }

  /** 指標を ID の昇順で全件(騎手か調教師)。画面(#643・#644)の読み出し口。 */
  async readEdges(kind: "jockey" | "trainer"): Promise<StoredMarketEdge[]> {
    const { results } = await this.db.prepare(SELECT_MARKET_EDGES_SQL).bind(kind).all<StoredMarketEdge>();
    return results;
  }

  /** 直近の計算の記録。無ければ null。 */
  async readMeta(): Promise<MarketEdgeMeta | null> {
    const row = await this.db
      .prepare(SELECT_MARKET_EDGE_META_SQL)
      .first<{ computedOn: string; windowFrom: string; windowTo: string; coefJson: string; converged: number; iterations: number; races: number; horses: number }>();
    if (row === null) return null;
    const coef = JSON.parse(row.coefJson) as MarketCoef;
    return { computedOn: row.computedOn, windowFrom: row.windowFrom, windowTo: row.windowTo, coef, converged: row.converged === 1, iterations: row.iterations, races: row.races, horses: row.horses };
  }
}
