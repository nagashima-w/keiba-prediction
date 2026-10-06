/**
 * 取得結果のキャッシュ(`CacheStore`)の、Durable Object の SQLite ストレージ(`ctx.storage.sql`)による実装(Issue #177〈#164-b〉・#170)。
 *
 * exe の `ScrapeCache`(better-sqlite3)と**同じ契約**(`packages/core/test/fixtures/cache-store-contract.json`。core と cloud の両方のテストが読む):
 *  - 鮮度は**読み取り側**で判定する: 保存からの経過(`now - fetched_at`)が `maxAgeMs` を**超えたら**ミス(ちょうどはヒット)。
 *    `maxAgeMs` を省略すると、常にヒット。期限切れの行は(掃除するまで)消えない。
 *  - 同じキーへの `set` は、値と取得時刻を上書きする。
 *
 * クラウド版だけの規則:
 *  - **2 MiB(UTF-8 のバイト数)を超える本文は保存しない**(例外にもしない。呼び出し側の取得は成功のまま)。DO の SQLite は1行の大きさに上限が
 *    ある(約 2 MB。公式ドキュメントの値で、行の大きさの内訳〈キーなどの分〉までは確認していない)ので、それを超えて INSERT が失敗し、取得ごと
 *    失敗になるのを避ける。同じキーに古い本文があれば、それも消す(古い本文を新しいものとして返さない)。
 *  - 期限切れの掃除 {@link DoSqlCacheStore.purgeOlderThan}(呼び出し側が、掃除専用のアラームで呼ぶ。`race-day-core.ts` 参照)。
 *  - 保存(INSERT)が例外で失敗しても、**取得は失敗にしない**(`CachedFetcher` は `set` の例外をそのまま投げるので、ここで握る)。警告だけ出し、同じキーの古い本文は消す。
 *
 * 時計は注入する(テストで固定できる)。DO の SQLite の `exec` は同期なので、`get`・`set` も同期(`CachedFetcher` は await で受ける)。
 */
import type { CacheEntry, CacheStore, ScrapeCacheGetOptions } from "../../packages/core/src/scraper/cached-fetcher";
import type { SqlLike } from "./sql-like";

/** 保存する本文の上限(UTF-8 のバイト数)。AC-c5。 */
export const MAX_CACHE_VALUE_BYTES = 2 * 1024 * 1024;

const TABLE = "fetch_cache";

export interface DoSqlCacheStoreOptions {
  readonly sql: SqlLike;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  /** 保存に失敗したときの警告の出し先(省略時は黙る)。本文は渡さない。 */
  readonly onWarn?: (message: string) => void;
}

export class DoSqlCacheStore implements CacheStore {
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  constructor(options: DoSqlCacheStoreOptions) {
    this.sql = options.sql;
    this.now = options.now;
    this.onWarn = options.onWarn ?? (() => {});
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
    );
  }

  get(key: string, options: ScrapeCacheGetOptions = {}): CacheEntry | undefined {
    const rows = this.sql.exec(`SELECT value, fetched_at AS fetchedAt FROM ${TABLE} WHERE key = ?`, key).toArray() as {
      value: string;
      fetchedAt: number;
    }[];
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (options.maxAgeMs !== undefined && this.now() - row.fetchedAt > options.maxAgeMs) {
      return undefined;
    }
    return { value: row.value, fetchedAt: row.fetchedAt };
  }

  set(key: string, value: string): void {
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      // 保存しない。古い本文が残っていれば、それを新しい取得の結果として返さないよう消す。
      this.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
      return;
    }
    try {
      this.sql.exec(
        `INSERT INTO ${TABLE} (key, value, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
        key,
        value,
        this.now(),
      );
    } catch (error) {
      // 保存の失敗(DO の SQLite の1行の大きさの上限を超えた等。本番の上限は公式ドキュメントで確認できていない)で、取得そのものを失敗にしない
      // (CachedFetcher は set の例外をそのまま投げるので、ここで握る)。警告だけ出す(本文は出さない)。古い本文があれば、新しい結果として返さないよう消す。
      this.onWarn(`取得キャッシュへの保存に失敗しました(キー: ${key.slice(0, 120)}): ${error instanceof Error ? error.message : String(error)}`);
      try {
        this.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
      } catch {
        // 消せなくても、取得は失敗にしない。
      }
    }
  }

  /**
   * 保存からの経過が `retentionMs` を**超えた**行を消し、消した件数を返す(ちょうど・新しい行は残す)。
   * `retentionMs` が負・非有限(NaN・Infinity)なら、何も消さずに投げる(全消し・何もしないの取り違えを防ぐ)。
   * 保持の長さは、使う鮮度の最長(戦績の 24 時間)以上にすること(それより短いと、まだヒットしうる行を消す)。
   */
  purgeOlderThan(retentionMs: number): number {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) {
      throw new Error(`retentionMs は 0 以上の有限の数が必要です(渡された値: ${String(retentionMs)})`);
    }
    const cutoff = this.now() - retentionMs;
    const before = this.count();
    this.sql.exec(`DELETE FROM ${TABLE} WHERE fetched_at < ?`, cutoff);
    return before - this.count();
  }

  /** 保存されている行数。 */
  count(): number {
    const rows = this.sql.exec(`SELECT COUNT(*) AS n FROM ${TABLE}`).toArray() as { n: number }[];
    return rows[0]?.n ?? 0;
  }
}
