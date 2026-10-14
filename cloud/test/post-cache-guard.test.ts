import { describe, expect, it } from "vitest";
import { CachedFetcher, type CacheStore } from "../../packages/core/src/scraper/cached-fetcher";
import { PostWithoutCacheKeyError, requireCacheKeyForPost } from "../src/post-cache-guard";

/**
 * Issue #181 段階2(Q2): POST を `cacheKey` なしでキャッシュ付きフェッチャに通さないためのガード。
 * `CachedFetcher` は `cacheKey ?? url` をキーにするので、URL が固定の POST(`/race_api/`)を `cacheKey` なしで通すと、全レースが同じキーになり、
 * 最初に取得したレースの傾向が以降の全重賞に返る。実際の呼び出し(`fetchGradeWinnerEntries`)は常に `cacheKey` を付けるので、これは将来の呼び出しへの保険。
 */

function memoryCache(): CacheStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => (map.has(key) ? { value: map.get(key)!, fetchedAt: 0 } : undefined),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

function setup() {
  const cache = memoryCache();
  const calls: { url: string; method: string | undefined }[] = [];
  const cached = new CachedFetcher({
    cache,
    fetcher: {
      fetchText: async (url, options) => {
        calls.push({ url, method: options?.method });
        return `body-${calls.length}`;
      },
    },
  });
  return { cache, calls, guarded: requireCacheKeyForPost(cached) };
}

describe("requireCacheKeyForPost", () => {
  it("cacheKey なしの POST は、取得もキャッシュの読み書きもせずに投げる(URL をキーにした全レース共通の保存を作らない)", async () => {
    const { cache, calls, guarded } = setup();
    await expect(guarded.fetchText("https://race.netkeiba.com/race_api/", { method: "POST", body: "a=b" })).rejects.toBeInstanceOf(PostWithoutCacheKeyError);
    expect(calls).toHaveLength(0);
    expect(cache.map.size).toBe(0);
  });

  it("cacheKey つきの POST は通し、そのキーで保存する。同じキーの2回目はキャッシュに当たって取得しない", async () => {
    const { cache, calls, guarded } = setup();
    const options = { method: "POST", body: "a=b", cacheKey: "race_api#AplGradeWinner#202603020211" } as const;
    expect(await guarded.fetchText("https://race.netkeiba.com/race_api/", options)).toBe("body-1");
    expect(await guarded.fetchText("https://race.netkeiba.com/race_api/", options)).toBe("body-1");
    expect(calls).toEqual([{ url: "https://race.netkeiba.com/race_api/", method: "POST" }]);
    expect([...cache.map.keys()]).toEqual(["race_api#AplGradeWinner#202603020211"]);
  });

  it("別の cacheKey は別の保存になる(レースごとに取得する)", async () => {
    const { calls, guarded } = setup();
    await guarded.fetchText("https://race.netkeiba.com/race_api/", { method: "POST", body: "a", cacheKey: "k#1" });
    await guarded.fetchText("https://race.netkeiba.com/race_api/", { method: "POST", body: "a", cacheKey: "k#2" });
    expect(calls).toHaveLength(2);
  });

  it("GET は cacheKey なしでも通す(従来どおり URL がキー)。method の指定が無いものも GET", async () => {
    const { cache, calls, guarded } = setup();
    await guarded.fetchText("https://race.netkeiba.com/x");
    await guarded.fetchText("https://race.netkeiba.com/y", { method: "GET" });
    expect(calls).toHaveLength(2);
    expect([...cache.map.keys()]).toEqual(["https://race.netkeiba.com/x", "https://race.netkeiba.com/y"]);
  });

  it("メソッドの大文字小文字を区別しない(post も POST と同じに扱う)", async () => {
    const { calls, guarded } = setup();
    await expect(guarded.fetchText("https://race.netkeiba.com/race_api/", { method: "post", body: "a" })).rejects.toBeInstanceOf(PostWithoutCacheKeyError);
    expect(calls).toHaveLength(0);
  });
});
