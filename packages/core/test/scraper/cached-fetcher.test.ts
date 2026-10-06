import { describe, expect, it } from "vitest";

import { CachedFetcher as CachedFetcherViaCacheModule, ScrapeCache } from "../../src/scraper/cache.js";
import {
  CachedFetcher,
  type CacheEntry,
  type CacheStore,
  type ScrapeCacheGetOptions,
  type TextFetcher,
} from "../../src/scraper/cached-fetcher.js";

/**
 * Issue #168(#163-a)AC-a4: CachedFetcher を、同期・非同期どちらの CacheStore にも同じ表で通す。
 *
 * 背景: CachedFetcher は better-sqlite3 に依存しない `cached-fetcher.ts` へ切り出され、保存先は `CacheStore`
 * (同期でも非同期でもよい)になった。クラウド版(#170)は非同期のストア(Durable Object のストレージ)を差し込む。
 * したがって CachedFetcher は、ストアの戻り値が Promise でも値でも同じ結果になる必要がある。
 *
 * 3種のストアで同じ表を走らせる:
 *  - sync: 同期の Map(ScrapeCache と同じ判定規則: 経過が maxAgeMs を**超えたら**ミス)
 *  - async: 非同期の Map(get・set とも少し遅れて完了する。await が抜けると結果が変わる)
 *  - ScrapeCache: exe の本番の実装(better-sqlite3)
 *
 * 殺す変異の例:
 *  - get の await を落とす → async ストアで Promise が常に「ヒット」扱いになり、hit.value が undefined になる
 *  - set の await を落とす → async ストアで、fetchText が返った直後にはまだ保存されていない
 *  - 保存キーに cacheKey でなく url を使う / maxAgeMs を get に渡さない / bypassCache を無視する
 */

interface Harness {
  readonly store: CacheStore;
  /** 時刻を進める(ミリ秒)。 */
  readonly advance: (ms: number) => void;
  /** 保存されているエントリを読む(同期・非同期どちらのストアでも await で読める)。 */
  readonly peek: (key: string) => Promise<CacheEntry | undefined>;
}

/** Map ベースのストアの共通部分。判定規則は ScrapeCache.get と同じ(age > maxAgeMs でミス)。 */
function createMapStore(
  nowRef: { value: number },
  delayed: boolean,
): { store: CacheStore; map: Map<string, CacheEntry> } {
  const map = new Map<string, CacheEntry>();
  const lookup = (key: string, options?: ScrapeCacheGetOptions): CacheEntry | undefined => {
    const entry = map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (options?.maxAgeMs !== undefined && nowRef.value - entry.fetchedAt > options.maxAgeMs) {
      return undefined;
    }
    return entry;
  };
  const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
  const store: CacheStore = delayed
    ? {
        get: async (key, options) => {
          await wait();
          return lookup(key, options);
        },
        set: async (key, value) => {
          await wait();
          map.set(key, { value, fetchedAt: nowRef.value });
        },
      }
    : {
        get: (key, options) => lookup(key, options),
        set: (key, value) => {
          map.set(key, { value, fetchedAt: nowRef.value });
        },
      };
  return { store, map };
}

const HARNESSES: ReadonlyArray<readonly [string, () => Harness]> = [
  [
    "同期ストア(Map)",
    () => {
      const nowRef = { value: 1_000_000 };
      const { store } = createMapStore(nowRef, false);
      return {
        store,
        advance: (ms) => {
          nowRef.value += ms;
        },
        peek: async (key) => store.get(key),
      };
    },
  ],
  [
    "非同期ストア(Map。get・set が遅れて完了する)",
    () => {
      const nowRef = { value: 1_000_000 };
      const { store } = createMapStore(nowRef, true);
      return {
        store,
        advance: (ms) => {
          nowRef.value += ms;
        },
        peek: async (key) => store.get(key),
      };
    },
  ],
  [
    "ScrapeCache(exe の better-sqlite3)",
    () => {
      const nowRef = { value: 1_000_000 };
      const cache = new ScrapeCache({ now: () => nowRef.value });
      return {
        store: cache,
        advance: (ms) => {
          nowRef.value += ms;
        },
        peek: async (key) => cache.get(key),
      };
    },
  ],
];

/** 呼び出しを記録する偽のフェッチャ。n回目の呼び出しは `body-n` を返す。 */
function createFakeFetcher(): {
  fetcher: TextFetcher;
  calls: Array<{ url: string; options: unknown }>;
  failNext: () => void;
} {
  const calls: Array<{ url: string; options: unknown }> = [];
  let fail = false;
  return {
    calls,
    failNext: () => {
      fail = true;
    },
    fetcher: {
      fetchText: async (url, options) => {
        calls.push({ url, options });
        if (fail) {
          fail = false;
          throw new Error("取得失敗");
        }
        return `body-${calls.length}`;
      },
    },
  };
}

const URL_A = "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211";

describe.each(HARNESSES)("CachedFetcher × %s", (_label, makeHarness) => {
  it("ミス: フェッチを1回発行して値を返し、保存時刻つきで保存する", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });

    const value = await cached.fetchText(URL_A);

    expect(value).toBe("body-1");
    expect(calls).toHaveLength(1);
    expect(await h.peek(URL_A)).toEqual({ value: "body-1", fetchedAt: 1_000_000 });
  });

  it("ヒット(経過が maxAgeMs 以内): フェッチを発行せず、保存済みの値を返す", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });
    await cached.fetchText(URL_A);

    h.advance(60_000);
    const value = await cached.fetchText(URL_A, { maxAgeMs: 600_000 });

    expect(value).toBe("body-1");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["経過 = maxAgeMs はヒット(超えていない)", 600_000, 1],
    ["経過 = maxAgeMs + 1 はミス(超えた)", 600_001, 2],
  ])("境界: %s", async (_name, elapsed, expectedFetches) => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });
    await cached.fetchText(URL_A);

    h.advance(elapsed);
    await cached.fetchText(URL_A, { maxAgeMs: 600_000 });

    expect(calls).toHaveLength(expectedFetches);
  });

  it("maxAgeMs 未指定: どれだけ古くてもヒットする(確定済みデータ向け)", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });
    await cached.fetchText(URL_A);

    h.advance(10 * 365 * 24 * 3600 * 1000);
    const value = await cached.fetchText(URL_A);

    expect(value).toBe("body-1");
    expect(calls).toHaveLength(1);
  });

  it("bypassCache: ヒット可能でもフェッチを発行し、保存を新しい値で更新する", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });
    await cached.fetchText(URL_A);

    h.advance(1_000);
    const value = await cached.fetchText(URL_A, { maxAgeMs: 600_000, bypassCache: true });

    expect(value).toBe("body-2");
    expect(calls).toHaveLength(2);
    expect(await h.peek(URL_A)).toEqual({ value: "body-2", fetchedAt: 1_001_000 });
  });

  it("cacheKey: url でなく cacheKey をキーに保存・参照する(同じ url でも cacheKey が違えば別エントリ)", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });
    const apiUrl = "https://race.netkeiba.com/race_api/AplGradeWinner";

    const first = await cached.fetchText(apiUrl, { cacheKey: "race_api#AplGradeWinner#R1" });
    const second = await cached.fetchText(apiUrl, { cacheKey: "race_api#AplGradeWinner#R2" });
    const firstAgain = await cached.fetchText(apiUrl, { cacheKey: "race_api#AplGradeWinner#R1" });

    expect(first).toBe("body-1");
    expect(second).toBe("body-2");
    expect(firstAgain).toBe("body-1");
    expect(calls).toHaveLength(2);
    expect(await h.peek(apiUrl)).toBeUndefined();
    expect((await h.peek("race_api#AplGradeWinner#R1"))?.value).toBe("body-1");
    expect((await h.peek("race_api#AplGradeWinner#R2"))?.value).toBe("body-2");
  });

  it("フェッチが失敗したら例外が伝わり、何も保存しない(次回は再取得する)", async () => {
    const h = makeHarness();
    const { fetcher, calls, failNext } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });

    failNext();
    await expect(cached.fetchText(URL_A)).rejects.toThrow("取得失敗");
    expect(await h.peek(URL_A)).toBeUndefined();

    const value = await cached.fetchText(URL_A);
    expect(value).toBe("body-2");
    expect(calls).toHaveLength(2);
  });

  it("フェッチャへ渡すのは maxAgeMs・bypassCache・cacheKey を除いたオプションだけ(encoding は渡る)", async () => {
    const h = makeHarness();
    const { fetcher, calls } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });

    await cached.fetchText(URL_A, {
      maxAgeMs: 1,
      bypassCache: true,
      cacheKey: "k",
      encoding: "euc-jp",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ encoding: "euc-jp" });
  });

  it("fetchText が返った時点で、保存は完了している(set の完了を待つ)", async () => {
    const h = makeHarness();
    const { fetcher } = createFakeFetcher();
    const cached = new CachedFetcher({ fetcher, cache: h.store });

    await cached.fetchText(URL_A);

    // 待たずに直接読む。async ストアで set の await が抜けていると、ここで未保存のまま(undefined)になる。
    const entry = await h.store.get(URL_A);
    expect(entry?.value).toBe("body-1");
  });
});

describe("ストアの前提(空振り防止: 非同期ストアは本当に Promise を返し、同期ストアは返さない)", () => {
  it("非同期ストアの get・set は Promise、同期ストアと ScrapeCache の get は Promise ではない", () => {
    const [, makeSync] = HARNESSES[0]!;
    const [, makeAsync] = HARNESSES[1]!;
    const [, makeSqlite] = HARNESSES[2]!;
    expect(makeAsync().store.get("k")).toBeInstanceOf(Promise);
    expect(makeAsync().store.set("k", "v")).toBeInstanceOf(Promise);
    expect(makeSync().store.get("k")).not.toBeInstanceOf(Promise);
    expect(makeSqlite().store.get("k")).not.toBeInstanceOf(Promise);
  });
});

describe("cache.ts からの再 export(既存の import 元を壊さない)", () => {
  it("cache.ts の CachedFetcher は cached-fetcher.ts のものと同一のクラス", () => {
    expect(CachedFetcherViaCacheModule).toBe(CachedFetcher);
  });
});
