import type { FetchTextOptions } from "./http-client.js";

/**
 * キャッシュ付きフェッチ(`CachedFetcher`)と、その保存先の抽象(`CacheStore`)。
 *
 * Issue #168(#163-a)で `cache.ts` から切り出した。**このファイルは better-sqlite3 に依存しない**
 * (クラウド版〈cloud/。Cloudflare Workers〉が core を相対 import で取り込むため、ネイティブ依存を持ち込めない。
 * `test/ev/native-free-modules.test.ts` が機械的に固定している)。SQLite 実装の `ScrapeCache` は `cache.ts` に残る。
 * 既存の import 元を壊さないよう、`cache.ts` がここの公開物を再 export している。
 */

/** 時刻取得関数。テストでフェイク時刻を注入できるよう外部化する。 */
export type NowFn = () => number;

/** キャッシュから取り出したエントリ。 */
export interface CacheEntry {
  /** 保存されている本文(スクレイピング結果のHTML等)。 */
  readonly value: string;
  /** 取得(保存)された時刻(エポックミリ秒)。 */
  readonly fetchedAt: number;
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
 * 取得結果の保存先(キャッシュストア)の最小インターフェース(Issue #168・#163-a)。
 *
 * `get`・`set` の戻り値は**値でも Promise でもよい**(`CachedFetcher` が `await` で受ける)。これにより、
 * exe の同期実装(`ScrapeCache`。better-sqlite3)をそのまま使いながら、クラウド版(Cloudflare の Durable Object の
 * ストレージ等。#170)は非同期の実装を差し込める。鮮度判定(`maxAgeMs`)は実装(ストア)の責務で、
 * 「保存からの経過が `maxAgeMs` を**超えたら**ミス」(`ScrapeCache.get` と同じ規則)に揃えること。
 */
export interface CacheStore {
  /** キーに対応するエントリ。無い・期限切れ(`options.maxAgeMs` 超過)なら undefined。 */
  get(
    key: string,
    options?: ScrapeCacheGetOptions,
  ): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  /** キーに値を保存する(同一キーは値と取得時刻を上書き)。 */
  set(key: string, value: string): void | Promise<void>;
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
  /** 取得結果を保存・参照するキャッシュ(同期・非同期どちらのストアでもよい)。 */
  cache: CacheStore;
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
  /**
   * キャッシュキーを明示指定する(タスク機能B。省略時は url をキーとして使う従来どおりの挙動)。
   *
   * ⚠️ 重要: race.netkeiba.com/race_api/ のような「URLが固定でrace_id等がPOSTボディに入る」API
   * では、URLだけをキーにすると全レースで同一キーになり、最初に取得したレースのデータが
   * 以降すべてのレースに誤って返る事故になる(boss着手前ゲート指摘)。POSTボディに識別子が
   * 入るエンドポイントを呼ぶ側は、必ずこのオプションで一意なキー(例:
   * `race_api#AplGradeWinner#{race_id}`)を指定すること。
   */
  cacheKey?: string;
}

/**
 * CacheStore と TextFetcher を合成した「キャッシュ付きフェッチ」。
 *
 * - キャッシュヒット時はフェッチを発行しない。よってレート制限待ちも発生しない。
 * - ミス時(またはbypassCache時)はフェッチして結果を保存し、その値を返す。
 */
export class CachedFetcher {
  private readonly fetcher: TextFetcher;
  private readonly cache: CacheStore;

  constructor(options: CachedFetcherOptions) {
    this.fetcher = options.fetcher;
    this.cache = options.cache;
  }

  /**
   * URLをキャッシュ経由で取得する。
   * @param url 取得対象URL(キャッシュキーにもなる。cacheKey指定時はそちらを優先する)
   * @param options 鮮度・バイパス指定、キャッシュキー指定、およびフェッチャへ渡すオプション(encoding等)
   */
  async fetchText(
    url: string,
    options: CachedFetchTextOptions = {},
  ): Promise<string> {
    const { maxAgeMs, bypassCache, cacheKey, ...fetchOptions } = options;
    const key = cacheKey ?? url;

    if (!bypassCache) {
      const hit = await this.cache.get(key, { maxAgeMs });
      if (hit) {
        return hit.value;
      }
    }

    const text = await this.fetcher.fetchText(url, fetchOptions);
    await this.cache.set(key, text);
    return text;
  }
}
