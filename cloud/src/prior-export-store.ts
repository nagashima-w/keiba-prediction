/**
 * 統計モデルの見直し用の書き出し(Issue #266)の D1・R2 の読み書き。**呼び出し元に依存しない**(コンストラクタは `{ db, bucket, now }` だけ。書き出しの DO〈`PriorExportDO`〉が使う)。
 *
 * ## 読み
 *  - 候補(`readCandidates`): `analyses` のうち**結果のあるレース**の分析を、選別に必要な列だけ(大きな列・追加指示は読まない)。1 文。
 *  - 馬・結果・面(`readRaceData`): 1 回の batch(3 文)。いずれも `IN (SELECT value FROM json_each(?))` で、主キーの索引を引く(EXPLAIN で全件走査にならないことを確認済み)ので、
 *    読む行数は束縛した ID の行だけ。D1 が返す `meta.rows_read` を合計して返す。
 *  - 詳細(`fetchDetails`): R2 の `get` だけ(LIST・HEAD は使わない)。同時実行は {@link GET_CONCURRENCY}。取得を試みた回数を返す(Class B に数える)。
 *    `detail_key` が NULL の行は取得しない(none)。R2 に無い・壊れている・別のレースのものも none(失敗ではない)。get の例外だけ failed(再試行する)。
 *    形式 v2(Issue #341)の出馬表の列は、**同じ get で読んだ詳細の `raceSnapshot`** から取り出す(`toSnapshotColumns`)。取得の回数も D1 の文も増えない。
 *
 * ## 書き
 *  - `r2_ops` の Class B の加算(`countReads`)と、Class A の加算 + R2 の put(`putFile`)。put の前に Class A を数える(`analysis-repository.ts` の流儀: 先に数えて、put の失敗は過少でなく過大に倒す)。
 *  - R2 に書くのはこのクラスの `putFile` の 1 箇所だけ(固定キーを原子的に上書き)。
 */

import { decodeDetail } from "./analysis-detail";
import { monthKey, type R2Usage } from "./r2-fence";
import { toSnapshotColumns, type CandidateRow } from "./prior-export-format";
import type { DetailOutcome, DetailRequest, PriorExportStorePort, RaceDataBatch } from "./prior-export-core";

export type PriorExportDb = Pick<D1Database, "prepare" | "batch">;
/** R2 のうち使う部分: 詳細の読み出し(get)と、完成したファイルの書き込み(put)だけ。 */
export type PriorExportBucket = Pick<R2Bucket, "get" | "put">;

/** R2 の get の同時実行数。 */
const GET_CONCURRENCY = 6;

const CANDIDATES_SQL = `SELECT a.id AS id, a.race_id AS raceId, a.analyzed_at AS analyzedAt, a.kaisai_date AS kaisaiDate, a.prompt_version AS promptVersion,
       a.detail_key AS detailKey, a.ev_estimated AS evEstimated, a.prompt_lookahead_guarded AS promptLookaheadGuarded,
       a.history_cutoff_date AS historyCutoffDate, a.start_time AS startTime
  FROM analyses a
 WHERE EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
 ORDER BY a.id`;

const HORSES_SQL = `SELECT analysis_id AS analysisId, umaban, prior, adjusted_prob AS adjustedProb, place_odds_min AS placeOddsMin
  FROM analysis_horses WHERE analysis_id IN (SELECT value FROM json_each(?)) ORDER BY analysis_id, umaban`;
const RESULTS_SQL = `SELECT race_id AS raceId, umaban, finish_position AS finishPosition, win_odds AS winOdds, ninki
  FROM race_results WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, umaban`;
const META_SQL = `SELECT race_id AS raceId, course_type AS courseType FROM race_result_meta WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id`;

const SELECT_R2_USAGE_SQL = "SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?";
const COUNT_READS_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 0, ?) ON CONFLICT(ym) DO UPDATE SET class_b = class_b + ?";
const COUNT_WRITE_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 1, 0) ON CONFLICT(ym) DO UPDATE SET class_a = class_a + 1";

export interface D1PriorExportStoreOptions {
  readonly db: PriorExportDb;
  readonly bucket: PriorExportBucket;
  /** 時計(R2 の月の区切りに使う)。既定は現在時刻。テストで注入する。 */
  readonly now?: () => Date;
}

export class D1PriorExportStore implements PriorExportStorePort {
  private readonly db: PriorExportDb;
  private readonly bucket: PriorExportBucket;
  private readonly now: () => Date;

  constructor(options: D1PriorExportStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
  }

  async readUsage(): Promise<R2Usage> {
    const row = await this.db.prepare(SELECT_R2_USAGE_SQL).bind(monthKey(this.now())).first<R2Usage>();
    return row ?? { classA: 0, classB: 0 };
  }

  async readCandidates(): Promise<{ readonly rows: CandidateRow[]; readonly rowsRead: number }> {
    const res = await this.db.prepare(CANDIDATES_SQL).all<CandidateRow>();
    return { rows: res.results, rowsRead: res.meta.rows_read ?? 0 };
  }

  async readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<RaceDataBatch> {
    const ids = JSON.stringify(analysisIds);
    const races = JSON.stringify(raceIds);
    const [horses, results, meta] = await this.db.batch<Record<string, never>>([
      this.db.prepare(HORSES_SQL).bind(ids),
      this.db.prepare(RESULTS_SQL).bind(races),
      this.db.prepare(META_SQL).bind(races),
    ]);
    const rowsRead = [horses, results, meta].reduce((n, r) => n + (r?.meta.rows_read ?? 0), 0);
    return {
      horses: (horses?.results ?? []) as unknown as RaceDataBatch["horses"],
      results: (results?.results ?? []) as unknown as RaceDataBatch["results"],
      courseTypes: (meta?.results ?? []) as unknown as RaceDataBatch["courseTypes"],
      rowsRead,
    };
  }

  async fetchDetails(items: readonly DetailRequest[]): Promise<{ readonly outcomes: DetailOutcome[]; readonly gets: number }> {
    const outcomes: DetailOutcome[] = new Array<DetailOutcome>(items.length);
    let gets = 0;
    const one = async (index: number): Promise<void> => {
      const item = items[index]!;
      if (item.detailKey === null) {
        outcomes[index] = { kind: "none" };
        return;
      }
      gets += 1;
      let bytes: Uint8Array | null;
      try {
        const object = await this.bucket.get(item.detailKey);
        bytes = object === null ? null : new Uint8Array(await object.arrayBuffer());
      } catch {
        outcomes[index] = { kind: "failed" };
        return;
      }
      const payload = bytes === null ? null : decodeDetail(bytes);
      outcomes[index] =
        payload === null || payload.raceId !== item.raceId
          ? { kind: "none" }
          : { kind: "ok", contributions: payload.contributions, snapshot: toSnapshotColumns(payload.raceSnapshot) };
    };
    for (let start = 0; start < items.length; start += GET_CONCURRENCY) {
      await Promise.all(Array.from({ length: Math.min(GET_CONCURRENCY, items.length - start) }, (_, k) => one(start + k)));
    }
    return { outcomes, gets };
  }

  async countReads(gets: number): Promise<void> {
    if (gets <= 0) {
      return;
    }
    await this.db.prepare(COUNT_READS_SQL).bind(monthKey(this.now()), gets, gets).run();
  }

  async putFile(key: string, bytes: Uint8Array, info: { readonly generatedAt: string; readonly rows: number; readonly races: number }): Promise<void> {
    await this.db.prepare(COUNT_WRITE_SQL).bind(monthKey(this.now())).run();
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { generatedAt: info.generatedAt, rows: String(info.rows), races: String(info.races) },
    });
  }
}
