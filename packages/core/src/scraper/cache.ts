import Database from "better-sqlite3";
import type { FetchTextOptions } from "./http-client.js";

/**
 * キャッシュ用テーブル名。分析履歴・検証結果などの将来のテーブルとは独立させる。
 * 揮発性の異なるデータ(確定済み戦績 / 発走直前オッズ)を同一スキーマに載せ、
 * 鮮度は取得側(get)の maxAgeMs で判定する設計とする。
 */
const TABLE_NAME = "scrape_cache";

/** 時刻取得関数。テストでフェイク時刻を注入できるよう外部化する。 */
export type NowFn = () => number;

/** キャッシュから取り出したエントリ。 */
export interface CacheEntry {
  /** 保存されている本文(スクレイピング結果のHTML等)。 */
  readonly value: string;
  /** 取得(保存)された時刻(エポックミリ秒)。 */
  readonly fetchedAt: number;
}

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

/** get() の取得オプション。 */
export interface ScrapeCacheGetOptions {
  /**
   * 許容する鮮度(ミリ秒)。保存からの経過時間がこの値を超えるエントリはミス扱いとする。
   * 未指定なら期限を無視して常にヒットさせる(確定済みデータ向け)。
   * 0 を指定すると保存と同一ミリ秒の取得のみヒットするが、実クロックでは同一ms内の
   * 連続アクセスはヒットしうるため「確実な再取得」の手段にはならない。
   * 常に最新を取りたい場合は CachedFetcher の bypassCache を用いること。
   */
  maxAgeMs?: number;
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
export class ScrapeCache {
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

/**
 * テキストを取得できる最小限のフェッチャインターフェース。
 * HttpClient がこれを満たすため、CachedFetcher と合成できる。
 */
export interface TextFetcher {
  fetchText(url: string, options?: FetchTextOptions): Promise<string>;
}

/** CachedFetcher の構築オプション。 */
export interface CachedFetcherOptions {
  /** 実際にHTTP取得を行うフェッチャ(通常は HttpClient)。 */
  fetcher: TextFetcher;
  /** 取得結果を保存・参照するキャッシュ。 */
  cache: ScrapeCache;
}

/** CachedFetcher.fetchText の呼び出しオプション。 */
export interface CachedFetchTextOptions extends FetchTextOptions {
  /**
   * キャッシュを有効とみなす鮮度(ミリ秒)。ScrapeCache.get と同じ意味。
   * 未指定なら鮮度無制限でヒットを許可する。
   */
  maxAgeMs?: number;
  /**
   * true のとき、キャッシュヒット可能でも必ずフェッチを発行してキャッシュを更新する。
   * 発走直前のオッズ再取得など、常に最新が必要な場面で使う。
   */
  bypassCache?: boolean;
}

/**
 * ScrapeCache と TextFetcher を合成した「キャッシュ付きフェッチ」。
 *
 * - キャッシュヒット時はフェッチを発行しない。よってレート制限待ちも発生しない。
 * - ミス時(またはbypassCache時)はフェッチして結果を保存し、その値を返す。
 */
export class CachedFetcher {
  private readonly fetcher: TextFetcher;
  private readonly cache: ScrapeCache;

  constructor(options: CachedFetcherOptions) {
    this.fetcher = options.fetcher;
    this.cache = options.cache;
  }

  /**
   * URLをキャッシュ経由で取得する。
   * @param url 取得対象URL(キャッシュキーにもなる)
   * @param options 鮮度・バイパス指定、およびフェッチャへ渡すオプション(encoding等)
   */
  async fetchText(
    url: string,
    options: CachedFetchTextOptions = {},
  ): Promise<string> {
    const { maxAgeMs, bypassCache, ...fetchOptions } = options;

    if (!bypassCache) {
      const hit = this.cache.get(url, { maxAgeMs });
      if (hit) {
        return hit.value;
      }
    }

    const text = await this.fetcher.fetchText(url, fetchOptions);
    this.cache.set(url, text);
    return text;
  }
}
