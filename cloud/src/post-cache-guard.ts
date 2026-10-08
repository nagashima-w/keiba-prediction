/**
 * POST を `cacheKey` なしでキャッシュ付きフェッチャに通さないためのガード(Issue #181 段階2)。
 *
 * `CachedFetcher` は `cacheKey ?? url` をキャッシュのキーにする。重賞の過去10年傾向の API(`/race_api/`)は URL が固定で、race_id は POST の本文に入るので、
 * `cacheKey` を付け忘れると全レースが同じキーになり、**最初に取得したレースの傾向が、以降のすべての重賞に返る**(`cached-fetcher.ts` の JSDoc が警告している事故)。
 * 実際の呼び出し(core の `fetchGradeWinnerEntries`)は常に `gradeWinnerCacheKey` を付けるが、将来の呼び出しが踏まないよう、
 * `CachedFetcher` の**外側**(`CachedFetcher` は `cacheKey` を内側の取得器へ渡さないので、内側では見えない)で、`cacheKey` の無い POST を取得・キャッシュの前に投げる。
 */
import type { CachedFetchTextOptions } from "../../packages/core/src/scraper/cached-fetcher";

export class PostWithoutCacheKeyError extends Error {
  constructor(url: string) {
    super(`POST には cacheKey が必要です(URL が固定の API では、全レースが同じキャッシュのキーになります): ${url.slice(0, 120)}`);
    this.name = "PostWithoutCacheKeyError";
  }
}

/** `CachedFetcher` が構造的に満たす、ここで包む取得器の形。 */
export interface CacheKeyedFetcher {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** `cacheKey` の無い POST を拒否する取得器にする(GET は素通し)。 */
export function requireCacheKeyForPost(inner: CacheKeyedFetcher): CacheKeyedFetcher {
  return {
    fetchText: (url, options) => {
      if (options?.method?.toUpperCase() === "POST" && options.cacheKey === undefined) {
        return Promise.reject(new PostWithoutCacheKeyError(url));
      }
      return inner.fetchText(url, options);
    },
  };
}
