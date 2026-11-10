/**
 * 過去のレースの追い切りの評価(ランクと評語)の保存(Issue #731。migration 0045 の `race_oikiri`。探索の材料)。
 *
 * - レースで 1 行(WITHOUT ROWID・副索引なし。1 行の書き込みが 1 行)。`horses_json` は馬ごとの `[馬番, 馬 ID, ランク, 評語]` の配列(ページの並び)。元の HTML は保存しない。
 * - 書くのは {@link D1RaceOikiriStore.saveRaceOikiri} だけ。順序: 入力を検査(D1 に触れる前) → D1 の大きさを読む(`SELECT 1` の `meta.size_after`) → UPSERT。
 *   D1 の大きさが上限(既定 400,000,000 バイト。過去の結果の保存〈race-archive-repository.ts〉と同じ)を超えていれば `skipped`(`db-size`)、大きさが数として取れなければ `skipped`(`db-size-unknown`。安全側)で、何も書かない。
 * - 冪等: UPSERT の WHERE が「中身が変わるとき」だけ真になる。同じ中身の再保存は `changes` 0・`rows_written` 0 で、`fetched_at` も据え置く(戻り値は `unchanged`)。
 *   比較の対象は race_date・horses_json・skipped_rows・parser_version(`fetched_at` は入れない。入れると毎回更新になる)。
 */

import type { OikiriEntry } from "../../packages/core/src/scraper/types.js";
import { OIKIRI_PARSER_VERSION } from "../../packages/core/src/scraper/parse-oikiri.js";
import { assertRaceId } from "./race-archive-format";
import { DB_SIZE_LIMIT_BYTES } from "./race-archive-repository";

/** D1 のうち、ストアが使う部分だけ。 */
export type RaceOikiriDb = Pick<D1Database, "prepare">;

const SELECT_SIZE_SQL = "SELECT 1";
/** 冪等な UPSERT。WHERE が偽なら行は変わらない(`changes` 0)。 */
const UPSERT_SQL = `INSERT INTO race_oikiri (race_id, race_date, horses_json, skipped_rows, parser_version, fetched_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(race_id) DO UPDATE SET
  race_date = excluded.race_date,
  horses_json = excluded.horses_json,
  skipped_rows = excluded.skipped_rows,
  parser_version = excluded.parser_version,
  fetched_at = excluded.fetched_at
WHERE race_oikiri.race_date IS NOT excluded.race_date
  OR race_oikiri.horses_json IS NOT excluded.horses_json
  OR race_oikiri.skipped_rows IS NOT excluded.skipped_rows
  OR race_oikiri.parser_version IS NOT excluded.parser_version`;
const SELECT_ONE_SQL = "SELECT race_id AS raceId, race_date AS raceDate, horses_json AS horsesJson, skipped_rows AS skippedRows, parser_version AS parserVersion, fetched_at AS fetchedAt FROM race_oikiri WHERE race_id = ?";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RaceOikiriInput {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly raceDate: string;
  /** パーサが読めた馬(ページの並び)。1 頭以上。 */
  readonly entries: readonly OikiriEntry[];
  /** 読めずに捨てた行数(0 以上の整数)。 */
  readonly skippedRows: number;
}

export type SaveRaceOikiriResult =
  | { readonly status: "saved" | "unchanged"; readonly dbSizeBytes: number | null }
  | { readonly status: "skipped"; readonly reason: "db-size" | "db-size-unknown"; readonly dbSizeBytes: number | null };

export interface RaceOikiriRow {
  readonly raceId: string;
  readonly raceDate: string;
  readonly horses: ReadonlyArray<{ readonly umaban: number; readonly horseId: string; readonly rank: string | null; readonly critic: string | null }>;
  readonly skippedRows: number;
  readonly parserVersion: number;
  readonly fetchedAt: string;
}

export interface D1RaceOikiriStoreOptions {
  readonly db: RaceOikiriDb;
  readonly now?: () => Date;
  readonly maxDbBytes?: number;
}

function sizeOf(meta: { readonly size_after?: unknown } | undefined): number | null {
  const size = meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

/** 行の `horses_json` の形: `[馬番, 馬 ID, ランク, 評語]` の配列。 */
export function encodeOikiriHorses(entries: readonly OikiriEntry[]): string {
  return JSON.stringify(entries.map((e) => [e.umaban, e.horseId, e.rank, e.critic]));
}

function validateInput(input: RaceOikiriInput): void {
  assertRaceId(input.raceId);
  if (typeof input.raceDate !== "string" || !DATE_RE.test(input.raceDate)) {
    throw new RangeError(`raceDate は YYYY-MM-DD でなければなりません: ${JSON.stringify(input.raceDate)}`);
  }
  if (input.entries.length === 0) {
    throw new RangeError("entries は 1 頭以上でなければなりません");
  }
  if (!Number.isInteger(input.skippedRows) || input.skippedRows < 0) {
    throw new RangeError(`skippedRows は 0 以上の整数でなければなりません: ${JSON.stringify(input.skippedRows)}`);
  }
}

export class D1RaceOikiriStore {
  private readonly db: RaceOikiriDb;
  private readonly now: () => Date;
  private readonly maxDbBytes: number;

  constructor(options: D1RaceOikiriStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.maxDbBytes = options.maxDbBytes ?? DB_SIZE_LIMIT_BYTES;
  }

  /** 1 レース分を保存する。手順・戻り値はファイル先頭の説明。失敗(D1 の例外)はそのまま投げる(呼び出し側が数えて、やり直す)。 */
  async saveRaceOikiri(input: RaceOikiriInput): Promise<SaveRaceOikiriResult> {
    validateInput(input);
    const horsesJson = encodeOikiriHorses(input.entries);
    const sizeBefore = sizeOf((await this.db.prepare(SELECT_SIZE_SQL).run()).meta);
    if (sizeBefore === null) {
      return { status: "skipped", reason: "db-size-unknown", dbSizeBytes: null };
    }
    if (sizeBefore > this.maxDbBytes) {
      return { status: "skipped", reason: "db-size", dbSizeBytes: sizeBefore };
    }
    const result = await this.db
      .prepare(UPSERT_SQL)
      .bind(input.raceId, input.raceDate, horsesJson, input.skippedRows, OIKIRI_PARSER_VERSION, this.now().toISOString())
      .run();
    return { status: result.meta.changes > 0 ? "saved" : "unchanged", dbSizeBytes: sizeOf(result.meta) ?? sizeBefore };
  }

  /** 1 レース分を読む。無ければ null。 */
  async getRaceOikiri(raceId: string): Promise<RaceOikiriRow | null> {
    assertRaceId(raceId);
    const row = await this.db.prepare(SELECT_ONE_SQL).bind(raceId).first<{ raceId: string; raceDate: string; horsesJson: string; skippedRows: number; parserVersion: number; fetchedAt: string }>();
    if (row === null) {
      return null;
    }
    const horses = (JSON.parse(row.horsesJson) as Array<[number, string, string | null, string | null]>).map(([umaban, horseId, rank, critic]) => ({ umaban, horseId, rank, critic }));
    return { raceId: row.raceId, raceDate: row.raceDate, horses, skippedRows: row.skippedRows, parserVersion: row.parserVersion, fetchedAt: row.fetchedAt };
  }
}
