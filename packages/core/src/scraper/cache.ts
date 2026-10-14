import Database from "better-sqlite3";
import type {
  CacheEntry,
  CacheStore,
  NowFn,
  ScrapeCacheGetOptions,
} from "./cached-fetcher.js";

// Issue #168(#163-a): CachedFetcher・TextFetcher・型は better-sqlite3 に依存しない cached-fetcher.ts へ切り出した。
// 既存の import 元(`./cache.js`・バレル)を壊さないよう、ここから再 export する。
export {
  CachedFetcher,
  type CacheEntry,
  type CachedFetcherOptions,
  type CachedFetchTextOptions,
  type CacheStore,
  type NowFn,
  type ScrapeCacheGetOptions,
  type TextFetcher,
} from "./cached-fetcher.js";

/**
 * キャッシュ用テーブル名。分析履歴・検証結果などの将来のテーブルとは独立させる。
 * 揮発性の異なるデータ(確定済み戦績 / 発走直前オッズ)を同一スキーマに載せ、
 * 鮮度は取得側(get)の maxAgeMs で判定する設計とする。
 */
const TABLE_NAME = "scrape_cache";

/** ScrapeCache の構築オプション。 */
export interface ScrapeCacheOptions {
  /**
   * SQLiteのファイルパス。省略時は ":memory:"(インメモリDB)。
   * `database` を渡した場合は無視される。
   */
  filename?: string;
  /** 既存の better-sqlite3 Database インスタンスを注入する(テストや共有時に使用)。 */
  database?: Database.Database;
  /** 現在時刻の取得関数。デフォルトは Date.now。 */
  now?: NowFn;
}

/**
 * スクレイピング結果のSQLiteキャッシュ層。
 *
 * 設計方針(鮮度=TTLの扱い):
 * - 書き込み時点では鮮度を固定せず、取得時刻(fetchedAt)だけを保存する。
 * - 鮮度判定は取得側(get / CachedFetcher)が maxAgeMs で行う「読み取り側TTL」方式。
 *   同一のキャッシュ本文を、確定済みデータには長い maxAgeMs、揮発性オッズには短い(または0の)
 *   maxAgeMs、という異なる鮮度要件で使い分けられるため柔軟性が高い。
 */
export class ScrapeCache implements CacheStore {
  private readonly db: Database.Database;
  private readonly now: NowFn;

  constructor(options: ScrapeCacheOptions = {}) {
    this.db = options.database ?? new Database(options.filename ?? ":memory:");
    this.now = options.now ?? Date.now;
    this.initSchema();
  }

  /** キャッシュ用テーブルを(存在しなければ)作成する。 */
  private initSchema(): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           fetched_at INTEGER NOT NULL
         )`,
      )
      .run();
  }

  /**
   * キーに対応する値を保存する。同一キーが既にあれば値と取得時刻を上書きする。
   * @param key URL等の文字列キー
   * @param value 保存する本文
   */
  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO ${TABLE_NAME} (key, value, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           fetched_at = excluded.fetched_at`,
      )
      .run(key, value, this.now());
  }

  /**
   * キーに対応するエントリを取得する。
   * maxAgeMs を指定し、保存からの経過時間がそれを超えている場合は
   * 期限切れとして undefined(ミス)を返す。
   * @param key URL等の文字列キー
   * @param options 鮮度(maxAgeMs)の指定
   */
  get(key: string, options: ScrapeCacheGetOptions = {}): CacheEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT value, fetched_at AS fetchedAt FROM ${TABLE_NAME} WHERE key = ?`,
      )
      .get(key) as { value: string; fetchedAt: number } | undefined;

    if (!row) {
      return undefined;
    }

    if (options.maxAgeMs !== undefined) {
      const age = this.now() - row.fetchedAt;
      if (age > options.maxAgeMs) {
        return undefined;
      }
    }

    return { value: row.value, fetchedAt: row.fetchedAt };
  }

  /** 内部の better-sqlite3 Database への参照(検証・拡張用)。 */
  get rawDatabase(): Database.Database {
    return this.db;
  }

  /** データベース接続を閉じる。 */
  close(): void {
    this.db.close();
  }
}
