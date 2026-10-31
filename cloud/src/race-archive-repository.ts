/**
 * 過去の結果ページの保存と読み出し(Issue #551〈#549-A2〉。親は #549)。**本体は R2、D1 には目録だけ**を置く。
 * 呼び出し元は #549-A3(Cloudflare での取得)と、#549-B(horse_runs への変換)。この Issue の時点では、本番の Worker はこの部品を呼ばない。
 *
 * - R2: `race-results/{race_id}.json.gz`(1 レース 1 オブジェクト。中身と符号化は `race-archive-format.ts`)
 * - D1: `race_archive`(migration 0031。1 レース 1 行・WITHOUT ROWID・副索引なし)
 * R2 には `get` と `put` しか使わない(LIST・HEAD・delete は型で使えない)。
 *
 * ## 保存 {@link D1RaceArchiveStore.saveRaceArchive}: R2 → D1 の順
 * 1. 入力を検査して符号化する(**R2 にも D1 にも触れる前**。JSON にできない値・形の違う値はここで例外になり、何も書かれない)
 * 2. D1 の読み取りの batch(2 文)で、今月の `r2_ops` と `SELECT 1`(`meta.size_after` を得るため。`rows_read` は増えない)を読む
 *    - D1 の大きさが上限(既定 400,000,000 バイト)を超えていれば `skipped`(`db-size`)。`size_after` が数として取れなければ `skipped`(`db-size-unknown`。安全側)
 *    - R2 の Class A(PUT)が柵(無料枠の 10%。`r2-fence.ts`)に達していれば `skipped`(`r2-fence`)
 *    - どちらも R2 には書かず、D1 も書かない。両方に当たるときは大きさを先に返す(D1 は本番の保存と同居しているので、守る順を先にする)
 * 3. R2 に put(**1 回だけ。再試行は呼び出し側**。失敗は例外で、D1 は何も書かれていない)
 * 4. D1 の書き込みの batch(2 文): ① `r2_ops` の Class A を +1 ② 目録の UPSERT。**同じ batch なので、計数と目録は一緒に成功するか一緒に落ちる**
 *
 * ### 冪等と、失敗からのやり直し
 * - 同じレースを何度保存しても、目録は 1 行・R2 のオブジェクトは 1 つ(同じキーを上書き)
 * - 目録の UPSERT は、`kind`・`race_date`・`parser_version`・`r2_key`・`raw_bytes` のどれかが変わるときだけ更新する(`fetched_at` も新しくする)。
 *   **すべて同じなら D1 の行は変わらず**(`changes` 0・`rows_written` 0)、戻り値は `unchanged`。ハッシュ列は持たない。
 *   `raw_bytes` は gzip 前の JSON のバイト数で、取得時刻の文字列の長さは固定なので、同じ中身なら変わらない(圧縮後の長さは同じとは限らない)
 * - R2 の put のあとで D1 が失敗すると、R2 にだけ置かれる。もう一度保存すれば目録が書かれる(R2 は上書き)
 *
 * ### Class A の数え方(★過少に倒れうる)
 * 計数は put の**後**、目録と同じ batch で行う(`analysis-repository.ts` は逆で、D1 を先に書き、計数を put の前にして過大に倒している)。
 * このため、**put は成功したが D1 の batch が失敗した保存は、Class A に数えられない**(1 回の失敗につき 1 の過少)。
 * 柵は無料枠の 10% で、実際の使用量(5 年分の取得で約 2 万回。ふだんは月 300 回前後)は柵の 100,000 回に対し十分に小さいので、許容する。
 * put が失敗したときも数えない(R2 に届いたかが分からず、課金されるかも未確認)。
 *
 * ## 読み出し {@link D1RaceArchiveStore.readRaceArchive}
 * 今月の Class B(GET)が柵に達していれば、R2 を引かず `skipped`(`r2-fence`)。そうでなければ get を 1 回行い、**要求を出したら Class B を +1**
 * (best-effort。計数が失敗しても読み出しは成功させる)。オブジェクトが無い・壊れている・別のレースのもの・読み取りの版が食い違うものは `missing`。
 * **get そのものの失敗は例外**にする(`missing` と区別する。段階 B が、取れなかったレースを「無い」として進めないため)。
 *
 * ## 目録の 1 行の取得 {@link D1RaceArchiveStore.getCatalogEntry}
 * D1 だけ(R2 には触れない)。列挙(読み取りの版ごと・日付の範囲など)は #549-B2 が必要になったときに足す。
 *
 * ## 限界
 * `meta.size_after` はローカルの workerd の D1 では、ページ単位の「データベースの大きさ(バイト)」として返ることを確認した。本番の D1 での意味は未確認
 * (取れなければ `db-size-unknown` で保存しない)。本番の R2・D1 での挙動は、本番の最初の保存で確かめる。
 */

import type { RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { assertRaceId, decodeRaceArchive, encodeRaceArchive, raceArchiveKeyOf, type RaceArchivePayload } from "./race-archive-format";
import { isReadAllowed, isWriteAllowed, monthKey, type R2Usage } from "./r2-fence";

/** D1 のうち、ストアが使う部分だけ(テストで記録つきの転送を渡せる)。 */
export type RaceArchiveDb = Pick<D1Database, "prepare" | "batch">;
/** R2 のうち、ストアが使う部分だけ。**get と put だけ**(LIST・HEAD・delete は型で使えない)。 */
export type RaceArchiveBucket = Pick<R2Bucket, "get" | "put">;

/**
 * D1 の大きさの上限(バイト。10 進)。これを**超えたら**保存しない(ちょうどなら保存する)。
 * D1 の無料枠の上限は 1 DB 500MB で、本番の保存(分析など)を巻き込まないよう、余裕を持たせて 400MB に置く(#549 のユーザーの決定)。
 */
export const DB_SIZE_LIMIT_BYTES = 400_000_000;

export type SkipReason = "r2-fence" | "db-size" | "db-size-unknown";

export type SaveRaceArchiveResult =
  | {
      readonly status: "saved" | "unchanged";
      /** R2 のキー。 */
      readonly key: string;
      /** 保存のあとの D1 の大きさ(`meta.size_after`)。 */
      readonly dbSizeBytes: number;
    }
  | {
      readonly status: "skipped";
      readonly reason: SkipReason;
      /** 保存の前に読んだ D1 の大きさ。`db-size-unknown`(取れなかった)のときだけ null。 */
      readonly dbSizeBytes: number | null;
    };

export type ReadRaceArchiveResult =
  | { readonly status: "found"; readonly archive: RaceArchivePayload }
  | { readonly status: "missing" }
  | { readonly status: "skipped"; readonly reason: "r2-fence" };

/** 目録の 1 行。 */
export interface RaceArchiveCatalogEntry {
  readonly raceId: string;
  readonly kind: "central" | "nar";
  /** YYYY-MM-DD */
  readonly raceDate: string;
  readonly parserVersion: number;
  readonly r2Key: string;
  /** gzip 前の JSON の UTF-8 バイト数。 */
  readonly rawBytes: number;
  /** 取得した時刻(ISO 形式の UTC)。 */
  readonly fetchedAt: string;
}

export interface D1RaceArchiveStoreOptions {
  readonly db: RaceArchiveDb;
  readonly bucket: RaceArchiveBucket;
  /** 時計(取得時刻と、R2 の操作回数の月の区切り〈UTC の yyyymm〉に使う)。既定は現在時刻。テストで注入する。 */
  readonly now?: () => Date;
  /** D1 の大きさの上限(バイト)。既定は {@link DB_SIZE_LIMIT_BYTES}。 */
  readonly maxDbBytes?: number;
}

/** 今月の R2 の操作回数(柵の判定のための読み取り)。 */
const SELECT_R2_USAGE_SQL = "SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?";
/** 大きさを得るための読み取り(`meta.size_after`)。読み取りの batch に、上の SELECT と一緒に入れる。 */
const SELECT_SIZE_SQL = "SELECT 1";
/** Class A(書き込み)の +1。月の行が無ければ作る(他の保存の SQL と同じ形)。 */
const COUNT_WRITE_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 1, 0) ON CONFLICT(ym) DO UPDATE SET class_a = class_a + 1";
/** Class B(読み出し)の +1。 */
const COUNT_READ_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 0, 1) ON CONFLICT(ym) DO UPDATE SET class_b = class_b + 1";

/**
 * 目録の UPSERT。**比較の対象に `fetched_at` を入れない**(入れると毎回更新になり、同じ中身の再保存で D1 の書き込みが増える)。
 * 更新するときは `fetched_at` も新しくする。WHERE が偽なら、行は変わらず `changes` 0・`rows_written` 0(ローカルの workerd の D1 で実測)。
 */
const UPSERT_CATALOG_SQL = `INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(race_id) DO UPDATE SET
  kind = excluded.kind,
  race_date = excluded.race_date,
  parser_version = excluded.parser_version,
  r2_key = excluded.r2_key,
  raw_bytes = excluded.raw_bytes,
  fetched_at = excluded.fetched_at
WHERE race_archive.kind IS NOT excluded.kind
  OR race_archive.race_date IS NOT excluded.race_date
  OR race_archive.parser_version IS NOT excluded.parser_version
  OR race_archive.r2_key IS NOT excluded.r2_key
  OR race_archive.raw_bytes IS NOT excluded.raw_bytes`;

const SELECT_CATALOG_SQL = "SELECT race_id AS raceId, kind, race_date AS raceDate, parser_version AS parserVersion, r2_key AS r2Key, raw_bytes AS rawBytes, fetched_at AS fetchedAt FROM race_archive WHERE race_id = ?";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `meta.size_after` を、使える大きさ(0 以上の有限の数)なら返す。それ以外は null。 */
function sizeOf(meta: { readonly size_after?: unknown } | undefined): number | null {
  const size = meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

/** 保存する前の検査。R2・D1 に触れる前に呼ぶ。 */
function validateRecord(record: RaceRecord): void {
  assertRaceId(record.raceId);
  if (record.kind !== "central" && record.kind !== "nar") {
    throw new RangeError(`kind は central か nar でなければなりません: ${JSON.stringify(record.kind)}`);
  }
  if (typeof record.date !== "string" || !DATE_RE.test(record.date)) {
    throw new RangeError(`date は YYYY-MM-DD でなければなりません: ${JSON.stringify(record.date)}`);
  }
  if (!Number.isInteger(record.parserVersion)) {
    throw new RangeError(`parserVersion は整数でなければなりません: ${JSON.stringify(record.parserVersion)}`);
  }
}

export class D1RaceArchiveStore {
  private readonly db: RaceArchiveDb;
  private readonly bucket: RaceArchiveBucket;
  private readonly now: () => Date;
  private readonly maxDbBytes: number;

  constructor(options: D1RaceArchiveStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
    this.maxDbBytes = options.maxDbBytes ?? DB_SIZE_LIMIT_BYTES;
  }

  /** 1 レース分(読み取り結果と元の HTML)を R2 → D1 の順で保存する。手順・戻り値・失敗の扱いはファイル先頭の説明。 */
  async saveRaceArchive(input: { readonly record: RaceRecord; readonly html: string }): Promise<SaveRaceArchiveResult> {
    const { record, html } = input;
    validateRecord(record);
    const now = this.now();
    const fetchedAt = now.toISOString();
    const encoded = encodeRaceArchive({ record, html, fetchedAt });
    const key = raceArchiveKeyOf(record.raceId);
    const ym = monthKey(now);

    // 柵と大きさを、1 回の batch で読む(書き込みの行は増えない)。
    const [usageResult, sizeResult] = await this.db.batch<unknown>([this.db.prepare(SELECT_R2_USAGE_SQL).bind(ym), this.db.prepare(SELECT_SIZE_SQL)]);
    const usage = (usageResult?.results[0] as R2Usage | undefined) ?? { classA: 0, classB: 0 };
    const sizeBefore = sizeOf(sizeResult?.meta);
    if (sizeBefore === null) {
      return { status: "skipped", reason: "db-size-unknown", dbSizeBytes: null };
    }
    if (sizeBefore > this.maxDbBytes) {
      return { status: "skipped", reason: "db-size", dbSizeBytes: sizeBefore };
    }
    if (!isWriteAllowed(usage)) {
      return { status: "skipped", reason: "r2-fence", dbSizeBytes: sizeBefore };
    }

    // R2 が先。失敗したら例外(D1 は何も書かれていない)。再試行は呼び出し側。
    await this.bucket.put(key, encoded.body, { httpMetadata: { contentType: "application/gzip" } });

    // D1 が後。計数と目録を同じ batch で書く(一緒に成功するか、一緒に落ちる)。
    const results = await this.db.batch([
      this.db.prepare(COUNT_WRITE_SQL).bind(ym),
      this.db.prepare(UPSERT_CATALOG_SQL).bind(record.raceId, record.kind, record.date, record.parserVersion, key, encoded.rawBytes, fetchedAt),
    ]);
    const upsert = results[1];
    if (upsert === undefined) {
      throw new Error("目録の UPSERT の結果を取得できませんでした");
    }
    return { status: upsert.meta.changes > 0 ? "saved" : "unchanged", key, dbSizeBytes: sizeOf(upsert.meta) ?? sizeBefore };
  }

  /** 1 レース分を R2 から読む。手順・戻り値はファイル先頭の説明。 */
  async readRaceArchive(raceId: string): Promise<ReadRaceArchiveResult> {
    const key = raceArchiveKeyOf(raceId);
    const ym = monthKey(this.now());
    const usage = (await this.db.prepare(SELECT_R2_USAGE_SQL).bind(ym).first<R2Usage>()) ?? { classA: 0, classB: 0 };
    if (!isReadAllowed(usage)) {
      return { status: "skipped", reason: "r2-fence" };
    }
    let bytes: Uint8Array | null = null;
    try {
      const object = await this.bucket.get(key);
      bytes = object === null ? null : new Uint8Array(await object.arrayBuffer());
    } finally {
      // 要求を出した試行は、get が失敗しても数える。計数の失敗は読み出しを妨げない。
      await this.countRead(ym);
    }
    if (bytes === null) {
      return { status: "missing" };
    }
    const archive = decodeRaceArchive(bytes);
    // 別のレースの保存物が置かれたキー(取り違え)・読み取りの版が record と食い違うものは、decode の側で null になる。
    if (archive === null || archive.record.raceId !== raceId) {
      return { status: "missing" };
    }
    return { status: "found", archive };
  }

  /** 目録の 1 行(D1 だけ。R2 には触れない)。無ければ null。 */
  async getCatalogEntry(raceId: string): Promise<RaceArchiveCatalogEntry | null> {
    assertRaceId(raceId);
    return this.db.prepare(SELECT_CATALOG_SQL).bind(raceId).first<RaceArchiveCatalogEntry>();
  }

  private async countRead(ym: number): Promise<void> {
    try {
      await this.db.prepare(COUNT_READ_SQL).bind(ym).run();
    } catch {
      // best-effort: 計数に失敗しても、読み出しの結果は返す。
    }
  }
}
