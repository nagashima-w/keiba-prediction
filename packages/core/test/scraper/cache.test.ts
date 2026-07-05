import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CachedFetcher,
  ScrapeCache,
  type TextFetcher,
} from "../../src/scraper/cache.js";
import type { FetchTextOptions } from "../../src/scraper/http-client.js";

/**
 * テスト用の可変クロック。now() を進めることで TTL 判定やフェイク時刻を制御する。
 */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

/**
 * fetchText の呼び出しを記録するスタブ TextFetcher を生成する。
 * 呼び出しごとに連番付きの本文を返し、呼び出し回数・引数を検証できるようにする。
 */
function makeFetcherStub(bodyFor?: (url: string, n: number) => string): {
  fetcher: TextFetcher;
  calls: Array<{ url: string; options?: FetchTextOptions }>;
} {
  const calls: Array<{ url: string; options?: FetchTextOptions }> = [];
  const fetcher: TextFetcher = {
    fetchText: vi.fn(async (url: string, options?: FetchTextOptions) => {
      calls.push({ url, options });
      const n = calls.length;
      return bodyFor ? bodyFor(url, n) : `body#${n}`;
    }),
  };
  return { fetcher, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScrapeCache", () => {
  describe("基本操作(set / get)", () => {
    it("setした値をgetで取り出せ、取得日時(fetchedAt)も保存されること", () => {
      const clock = makeClock(1000);
      const cache = new ScrapeCache({ now: clock.now });

      cache.set("https://example.test/race/1", "<html>race1</html>");
      const entry = cache.get("https://example.test/race/1");

      expect(entry).toEqual({
        value: "<html>race1</html>",
        fetchedAt: 1000,
      });
      cache.close();
    });

    it("存在しないキーのgetはundefinedを返すこと(キャッシュミス)", () => {
      const cache = new ScrapeCache({ now: makeClock().now });
      expect(cache.get("https://example.test/none")).toBeUndefined();
      cache.close();
    });

    it("同一キーへのsetは値と取得日時を上書きすること", () => {
      const clock = makeClock(0);
      const cache = new ScrapeCache({ now: clock.now });

      cache.set("k", "old");
      clock.set(5000);
      cache.set("k", "new");

      expect(cache.get("k")).toEqual({ value: "new", fetchedAt: 5000 });
      cache.close();
    });
  });

  describe("TTL付き取得(maxAgeMs)", () => {
    it("maxAgeMs未指定時は経過時間に関わらずヒットすること(期限無視)", () => {
      const clock = makeClock(0);
      const cache = new ScrapeCache({ now: clock.now });
      cache.set("k", "v");
      clock.advance(10 ** 9); // 十分に長い時間を経過させる

      expect(cache.get("k")?.value).toBe("v");
      cache.close();
    });

    it("経過時間がmaxAgeMsちょうどのときはヒットとして返すこと(境界: 期限ちょうど)", () => {
      const clock = makeClock(0);
      const cache = new ScrapeCache({ now: clock.now });
      cache.set("k", "v");
      clock.advance(1000);

      expect(cache.get("k", { maxAgeMs: 1000 })?.value).toBe("v");
      cache.close();
    });

    it("経過時間がmaxAgeMsを1ms超えたときはミス(undefined)となること(境界: 期限切れ直後)", () => {
      const clock = makeClock(0);
      const cache = new ScrapeCache({ now: clock.now });
      cache.set("k", "v");
      clock.advance(1001);

      expect(cache.get("k", { maxAgeMs: 1000 })).toBeUndefined();
      cache.close();
    });

    it("maxAgeMs=0のときは同一時刻の取得のみヒットし、1ms経過でミスとなること(揮発性データのバイパス相当)", () => {
      const clock = makeClock(0);
      const cache = new ScrapeCache({ now: clock.now });
      cache.set("k", "v");

      expect(cache.get("k", { maxAgeMs: 0 })?.value).toBe("v");
      clock.advance(1);
      expect(cache.get("k", { maxAgeMs: 0 })).toBeUndefined();
      cache.close();
    });
  });

  describe("スキーマの独立性", () => {
    it("キャッシュ用テーブルscrape_cacheのみが作成され、分析履歴等のテーブルは作らないこと", () => {
      const cache = new ScrapeCache({ now: makeClock().now });
      const names = cache.rawDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort();

      expect(names).toEqual(["scrape_cache"]);
      cache.close();
    });
  });
});

describe("CachedFetcher(キャッシュ付きフェッチ)", () => {
  it("キャッシュミス時はfetchTextを1回発行し、結果を保存して返すこと", async () => {
    const cache = new ScrapeCache({ now: makeClock().now });
    const { fetcher, calls } = makeFetcherStub();
    const cf = new CachedFetcher({ fetcher, cache });

    const text = await cf.fetchText("https://example.test/a");

    expect(text).toBe("body#1");
    expect(calls).toHaveLength(1);
    expect(cache.get("https://example.test/a")?.value).toBe("body#1");
    cache.close();
  });

  it("TTL内の2回目取得はfetchTextを発行せず、キャッシュ値を返すこと(ヒット時はフェッチ不発行)", async () => {
    const clock = makeClock(0);
    const cache = new ScrapeCache({ now: clock.now });
    const { fetcher, calls } = makeFetcherStub();
    const cf = new CachedFetcher({ fetcher, cache });

    const first = await cf.fetchText("https://example.test/a", { maxAgeMs: 10_000 });
    clock.advance(5_000);
    const second = await cf.fetchText("https://example.test/a", { maxAgeMs: 10_000 });

    expect(first).toBe("body#1");
    expect(second).toBe("body#1");
    expect(calls).toHaveLength(1);
    cache.close();
  });

  it("TTL切れ後の取得は再度fetchTextを発行し、キャッシュを更新すること", async () => {
    const clock = makeClock(0);
    const cache = new ScrapeCache({ now: clock.now });
    const { fetcher, calls } = makeFetcherStub();
    const cf = new CachedFetcher({ fetcher, cache });

    await cf.fetchText("https://example.test/a", { maxAgeMs: 1_000 });
    clock.advance(1_001);
    const second = await cf.fetchText("https://example.test/a", { maxAgeMs: 1_000 });

    expect(second).toBe("body#2");
    expect(calls).toHaveLength(2);
    expect(cache.get("https://example.test/a")?.value).toBe("body#2");
    cache.close();
  });

  it("bypassCache指定時はキャッシュヒット可能でも必ずfetchTextを発行し、キャッシュを更新すること(オッズ直前再取得相当)", async () => {
    const clock = makeClock(0);
    const cache = new ScrapeCache({ now: clock.now });
    const { fetcher, calls } = makeFetcherStub();
    const cf = new CachedFetcher({ fetcher, cache });

    await cf.fetchText("https://example.test/odds", { maxAgeMs: 10_000 });
    // TTL内でもbypassCacheなら再取得する
    const refreshed = await cf.fetchText("https://example.test/odds", {
      maxAgeMs: 10_000,
      bypassCache: true,
    });

    expect(refreshed).toBe("body#2");
    expect(calls).toHaveLength(2);
    expect(cache.get("https://example.test/odds")?.value).toBe("body#2");
    cache.close();
  });

  it("fetchTextがrejectした場合は例外が呼び出し側に伝播し、キャッシュに不正な値が保存されないこと", async () => {
    const cache = new ScrapeCache({ now: makeClock().now });
    const fetchError = new Error("ネットワーク障害");
    const fetcher: TextFetcher = {
      fetchText: vi.fn(async () => {
        throw fetchError;
      }),
    };
    const cf = new CachedFetcher({ fetcher, cache });

    await expect(cf.fetchText("https://example.test/fail")).rejects.toThrow(
      "ネットワーク障害",
    );
    // 失敗時はキャッシュへ何も書き込まれていないこと(ミスのまま)
    expect(cache.get("https://example.test/fail")).toBeUndefined();
    cache.close();
  });

  it("bypassCacheでのフェッチが失敗しても、既存のキャッシュエントリが破壊されずに残ること", async () => {
    const clock = makeClock(0);
    const cache = new ScrapeCache({ now: clock.now });
    // 事前に正常なキャッシュを1件作る
    cache.set("https://example.test/odds", "古いが有効な本文");

    const fetcher: TextFetcher = {
      fetchText: vi.fn(async () => {
        throw new Error("再取得失敗");
      }),
    };
    const cf = new CachedFetcher({ fetcher, cache });

    await expect(
      cf.fetchText("https://example.test/odds", { bypassCache: true }),
    ).rejects.toThrow("再取得失敗");
    // 既存エントリは上書きされず、そのまま残っていること
    expect(cache.get("https://example.test/odds")).toEqual({
      value: "古いが有効な本文",
      fetchedAt: 0,
    });
    cache.close();
  });

  it("encoding等のフェッチオプションはTTL/バイパス制御用のキーを除いてfetcherへ渡されること", async () => {
    const cache = new ScrapeCache({ now: makeClock().now });
    const { fetcher, calls } = makeFetcherStub();
    const cf = new CachedFetcher({ fetcher, cache });

    await cf.fetchText("https://example.test/e", {
      encoding: "euc-jp",
      maxAgeMs: 5_000,
      bypassCache: false,
    });

    expect(calls[0]!.options).toEqual({ encoding: "euc-jp" });
    cache.close();
  });
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("ScrapeCacheとCachedFetcherがindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.ScrapeCache).toBe(ScrapeCache);
    expect(mod.CachedFetcher).toBe(CachedFetcher);
  });
});
