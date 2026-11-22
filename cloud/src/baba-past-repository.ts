/**
 * 過去の馬場の公表値(JRA の過去の PDF から取ったもの)の D1 への保存と、取り終えた PDF の確認(Issue #769)。表は migration 0049 の `baba_past`・`baba_past_pdfs`。
 * 読み書きはこのファイルだけ。**D1 に書くのは本番の Worker の DO(`JraBabaPastBackfillDO`)だけ**。
 *
 * ## 保存 {@link D1BabaPastStore.savePdf}: R2 → D1 の順(`race-archive-repository.ts` と同じ流儀)
 * 1. PDF のバイト列があれば、R2 に控えを置く(`baba-past/{PDF の名前}`)。**パーサを直したときに JRA へ取り直さないため**。
 *    今月の R2 の Class A(PUT)が柵(`r2-fence.ts`。無料枠の 10%)に達していれば置かない。put が失敗(例外・上限時間)しても、**D1 は書く**(`r2_key` は NULL)。
 * 2. D1 を 1 つの batch(1 つのトランザクション)で書く: ① `r2_ops` の Class A を +1(置いたときだけ。失敗した put は数えない) ② `baba_past` の行(`json_each` に束縛。主キーの UPSERT) ③ `baba_past_pdfs` の記録の UPSERT。
 *    **行と記録を同じ batch で書く**ので、「記録がある = 行が書かれている」が崩れない(どちらかが失敗すれば両方とも残らない)。
 * 同じ PDF をもう一度保存すると、行・記録は同じ主キーに上書きされる(読み直しで値を直せる)。R2 のキーは、今回置かなかった(NULL)ときは前のキーを残す(R2 に控えがあることを忘れない)。書いた行数(`meta.changes` の合計)を返す。呼び出し側(DO)が 1 日の上限に数える。
 *
 * ## 読み出し
 * 全走査をしない: 取り終えたかは、`json_each` に束縛した配列から `baba_past_pdfs` の主キーを引く。管理者の一覧は、年ごとの主キーの範囲読み(`source_pdf` の先頭が年)。
 */
import { monthKey, isWriteAllowed, type R2Usage } from "./r2-fence";
import { withPutTimeout } from "./bucket-timeout";
import type { AnalysisBucket } from "./analysis-repository";
import type { BabaPastRow } from "./jra-baba-past-pdf";

export interface BabaPastDb {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

/** R2 のうち使う部分(get と put だけ)。 */
export type BabaPastBucket = AnalysisBucket;

/** R2 のキーの前置き。PDF の名前(`2021pdf/tokyo01.pdf`)をそのまま続ける。 */
export const BABA_PAST_R2_PREFIX = "baba-past/";
/** R2 の put の上限時間(ミリ秒)。 */
const R2_PUT_TIMEOUT_MS = 10_000;

/** ?1 = PDF の名前の JSON 配列。取り終えた PDF だけ(主キーの引き)。 */
export const FILTER_DONE_SQL = "SELECT value AS source_pdf FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM baba_past_pdfs p WHERE p.source_pdf = value)";

/** ?1 = `[{"d": 日付, "w": 曜日, "c": クッション値, "tg": …}]` の JSON、?2 = 場コード、?3 = PDF の名前、?4 = 保存した時刻(ミリ秒)。同じ主キーは上書きする。 */
export const INSERT_PAST_ROWS_SQL =
  "INSERT INTO baba_past (kaisai_date, venue_code, weekday, cushion, turf_goal_moisture, turf_corner4_moisture, dirt_goal_moisture, dirt_corner4_moisture, source_pdf, fetched_at) " +
  "SELECT json_extract(value, '$.d'), ?2, json_extract(value, '$.w'), json_extract(value, '$.c'), json_extract(value, '$.tg'), json_extract(value, '$.t4'), json_extract(value, '$.dg'), json_extract(value, '$.d4'), ?3, ?4 " +
  "FROM json_each(?1) WHERE true " +
  "ON CONFLICT (kaisai_date, venue_code) DO UPDATE SET weekday = excluded.weekday, cushion = excluded.cushion, turf_goal_moisture = excluded.turf_goal_moisture, " +
  "turf_corner4_moisture = excluded.turf_corner4_moisture, dirt_goal_moisture = excluded.dirt_goal_moisture, dirt_corner4_moisture = excluded.dirt_corner4_moisture, " +
  "source_pdf = excluded.source_pdf, fetched_at = excluded.fetched_at";

/** ?1 = PDF の名前、?2 = 年、?3 = 場コード、?4 = 開催回、?5 = 結果の分類、?6 = 書いた行数、?7 = R2 のキー(無ければ NULL)、?8 = 時刻(ミリ秒)。 */
export const UPSERT_PDF_SQL =
  "INSERT INTO baba_past_pdfs (source_pdf, year, venue_code, kai, result, rows_saved, r2_key, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
  "ON CONFLICT (source_pdf) DO UPDATE SET year = excluded.year, venue_code = excluded.venue_code, kai = excluded.kai, result = excluded.result, rows_saved = excluded.rows_saved, " +
  "r2_key = COALESCE(excluded.r2_key, baba_past_pdfs.r2_key), fetched_at = excluded.fetched_at";

/** ?1 = 範囲の下端(`2021pdf/`)、?2 = 上端(`2021pdf0`。`/` の次の文字)。主キーの範囲読み。 */
export const LIST_PDFS_BY_YEAR_SQL = "SELECT source_pdf, result, rows_saved, r2_key FROM baba_past_pdfs WHERE source_pdf >= ?1 AND source_pdf < ?2 ORDER BY source_pdf";

const SELECT_R2_USAGE_SQL = "SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?";
const COUNT_WRITE_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 1, 0) ON CONFLICT(ym) DO UPDATE SET class_a = class_a + 1";

export interface BabaPastSaveInput {
  /** PDF の名前(`archive/` からの相対。例 `2021pdf/tokyo01.pdf`)。 */
  readonly path: string;
  readonly year: number;
  readonly venueCode: string;
  readonly kai: number;
  /** 結果の分類(`ok`・読めなかった理由・取得の失敗の理由)。 */
  readonly result: string;
  /** 書く行(`result` が `ok` のときだけ。それ以外は空)。 */
  readonly rows: readonly BabaPastRow[];
  /** R2 に控える PDF のバイト列。取れなかったときは null。 */
  readonly pdf: Uint8Array | null;
  /** 記録の時刻(エポックミリ秒)。R2 の月の区切り(UTC)にも使う。 */
  readonly nowMs: number;
}

export interface BabaPastSaved {
  /** 書いた行数(batch の `meta.changes` の合計)。 */
  readonly written: number;
  /** R2 に置いたときのキー。置かなかった(柵・失敗・PDF なし)ときは null。 */
  readonly r2Key: string | null;
}

export interface BabaPastStoreLike {
  /** 渡した PDF のうち、取り終えているもの(渡した順)。 */
  filterDone(paths: readonly string[]): Promise<string[]>;
  savePdf(input: BabaPastSaveInput): Promise<BabaPastSaved>;
  /** 年ごとの記録(主キーの範囲読み)。読み直し・取り直しの対象を探す(Issue #789)。 */
  listPdfsByYear(year: number): Promise<BabaPastPdfRecord[]>;
  /** R2 の控えの PDF を読む。無ければ null(読み直しで、JRA へは行かない)。 */
  getPdf(path: string): Promise<Uint8Array | null>;
}

export interface BabaPastPdfRecord {
  readonly sourcePdf: string;
  readonly result: string;
  readonly rowsSaved: number;
  /** R2 の控えのキー(控えを置いていなければ null)。 */
  readonly r2Key: string | null;
}

/** 年ごとの記録の一覧(管理者の読み取り口。読み取りだけ。バケットは要らない)。主キーの範囲読み。 */
export async function listBabaPastPdfsByYear(db: Pick<BabaPastDb, "prepare">, year: number): Promise<BabaPastPdfRecord[]> {
  const rows = await db.prepare(LIST_PDFS_BY_YEAR_SQL).bind(`${year}pdf/`, `${year}pdf0`).all<{ source_pdf: string; result: string; rows_saved: number; r2_key: string | null }>();
  return rows.results.map((r) => ({ sourcePdf: r.source_pdf, result: r.result, rowsSaved: r.rows_saved, r2Key: r.r2_key }));
}

export class D1BabaPastStore implements BabaPastStoreLike {
  constructor(private readonly deps: { readonly db: BabaPastDb; readonly bucket: BabaPastBucket }) {}

  async filterDone(paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const rows = await this.deps.db.prepare(FILTER_DONE_SQL).bind(JSON.stringify(paths)).all<{ source_pdf: string }>();
    const done = new Set(rows.results.map((r) => r.source_pdf));
    return paths.filter((p) => done.has(p));
  }

  listPdfsByYear(year: number): Promise<BabaPastPdfRecord[]> {
    return listBabaPastPdfsByYear(this.deps.db, year);
  }

  async getPdf(path: string): Promise<Uint8Array | null> {
    const object = await this.deps.bucket.get(`${BABA_PAST_R2_PREFIX}${path}`);
    return object === null ? null : new Uint8Array(await object.arrayBuffer());
  }

  async savePdf(input: BabaPastSaveInput): Promise<BabaPastSaved> {
    const { db, bucket } = this.deps;
    const ym = monthKey(new Date(input.nowMs));
    let r2Key: string | null = null;
    if (input.pdf !== null) {
      const usage = await db.prepare(SELECT_R2_USAGE_SQL).bind(ym).first<R2Usage>();
      if (isWriteAllowed(usage ?? { classA: 0, classB: 0 })) {
        const key = `${BABA_PAST_R2_PREFIX}${input.path}`;
        try {
          await withPutTimeout(bucket, R2_PUT_TIMEOUT_MS).put(key, input.pdf, { httpMetadata: { contentType: "application/pdf" } });
          r2Key = key;
        } catch {
          r2Key = null; // 置けなくても D1 は書く(失敗した put は数えない)
        }
      }
    }
    const statements: D1PreparedStatement[] = [];
    if (r2Key !== null) statements.push(db.prepare(COUNT_WRITE_SQL).bind(ym));
    if (input.rows.length > 0) {
      const json = JSON.stringify(
        input.rows.map((r) => ({ d: r.kaisaiDate, w: r.weekday, c: r.cushion, tg: r.turfGoalMoisture, t4: r.turfCorner4Moisture, dg: r.dirtGoalMoisture, d4: r.dirtCorner4Moisture })),
      );
      statements.push(db.prepare(INSERT_PAST_ROWS_SQL).bind(json, input.venueCode, input.path, input.nowMs));
    }
    statements.push(db.prepare(UPSERT_PDF_SQL).bind(input.path, input.year, input.venueCode, input.kai, input.result, input.rows.length, r2Key, input.nowMs));
    const results = await db.batch(statements);
    return { written: results.reduce((sum, res) => sum + (res.meta.changes ?? 0), 0), r2Key };
  }
}
