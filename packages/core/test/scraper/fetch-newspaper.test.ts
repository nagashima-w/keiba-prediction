import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { gradeWinnerCacheKey } from "../../src/scraper/fetch-grade-winner.js";
import { fetchNewspaperConditions, newspaperCacheKey, type NewspaperFetcher } from "../../src/scraper/fetch-newspaper.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { NewspaperParseError } from "../../src/scraper/parse-newspaper.js";
import { newspaperApiUrl, newspaperOriginUrl, newspaperRefererUrl } from "../../src/scraper/urls.js";

/** Issue #421 段階 1-b: 新聞形式の API(AplNewsPaper)の取得アダプタ。実ネットワークは使わない。 */

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

function stub(response: string): { fetcher: NewspaperFetcher; calls: Array<{ url: string; options?: CachedFetchTextOptions }> } {
  const calls: Array<{ url: string; options?: CachedFetchTextOptions }> = [];
  return {
    fetcher: {
      fetchText: vi.fn(async (url: string, options?: CachedFetchTextOptions) => {
        calls.push({ url, options });
        return response;
      }),
    },
    calls,
  };
}

describe("urls: 新聞形式 API(中央は race・地方は nar のホスト。ページ名は中央・地方とも newspaper.html)", () => {
  it("中央", () => {
    const id = parseRaceId("202608040711");
    expect(newspaperApiUrl(id)).toBe("https://race.netkeiba.com/race_api/");
    expect(newspaperRefererUrl(id)).toBe("https://race.netkeiba.com/race/newspaper.html?race_id=202608040711");
    expect(newspaperOriginUrl(id)).toBe("https://race.netkeiba.com");
  });

  it("地方(ページ名は中央と同じ。grade-winner の past10 / past5 のような違いは無い)", () => {
    const id = parseRaceId("202655090311");
    expect(newspaperApiUrl(id)).toBe("https://nar.netkeiba.com/race_api/");
    expect(newspaperRefererUrl(id)).toBe("https://nar.netkeiba.com/race/newspaper.html?race_id=202655090311");
    expect(newspaperOriginUrl(id)).toBe("https://nar.netkeiba.com");
  });
});

describe("newspaperCacheKey", () => {
  it("race_id を含む一意なキーで、grade-winner のキーとは衝突しない", () => {
    const a = parseRaceId("202608040711");
    const b = parseRaceId("202608040712");
    expect(newspaperCacheKey(a)).toBe("race_api#AplNewsPaper#202608040711");
    expect(newspaperCacheKey(a)).not.toBe(newspaperCacheKey(b));
    expect(newspaperCacheKey(a)).not.toBe(gradeWinnerCacheKey(a));
  });
});

describe("fetchNewspaperConditions", () => {
  it("中央: 固定 URL・POST ボディ・4 つのヘッダ・cacheKey・指定した maxAgeMs で fetchText を 1 回呼び、表を返す", async () => {
    const { fetcher, calls } = stub(loadFixture("newspaper_api_202608040711.json"));
    const raceId = parseRaceId("202608040711");

    const table = await fetchNewspaperConditions(raceId, { fetcher, maxAgeMs: 123_000 });

    expect(Object.keys(table)).toHaveLength(88);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://race.netkeiba.com/race_api/");
    expect(call.options?.method).toBe("POST");
    expect(call.options?.body).toBe("input=UTF-8&output=json&class=AplNewsPaper&method=get&compress=1&race_id=202608040711");
    expect(call.options?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://race.netkeiba.com/race/newspaper.html?race_id=202608040711",
      Origin: "https://race.netkeiba.com",
    });
    expect(call.options?.cacheKey).toBe(newspaperCacheKey(raceId));
    expect(call.options?.maxAgeMs).toBe(123_000);
    expect(call.options?.encoding).toBe("utf-8");
  });

  it("地方: nar のホスト・同じボディの形(race_id だけ違う)・Referer は newspaper.html", async () => {
    const { fetcher, calls } = stub(loadFixture("newspaper_api_nar_202655090311.json"));
    const raceId = parseRaceId("202655090311");

    const table = await fetchNewspaperConditions(raceId, { fetcher });

    expect(Object.keys(table)).toHaveLength(270);
    const call = calls[0]!;
    expect(call.url).toBe("https://nar.netkeiba.com/race_api/");
    expect(call.options?.body).toBe("input=UTF-8&output=json&class=AplNewsPaper&method=get&compress=1&race_id=202655090311");
    expect(call.options?.headers).toMatchObject({
      Referer: "https://nar.netkeiba.com/race/newspaper.html?race_id=202655090311",
      Origin: "https://nar.netkeiba.com",
    });
    expect(call.options?.cacheKey).toBe("race_api#AplNewsPaper#202655090311");
    expect(call.options?.maxAgeMs).toBeUndefined();
  });

  it("⚠️データ混線の防止: race_id が違う 2 回の呼び出しは別の cacheKey になる", async () => {
    const { fetcher, calls } = stub(loadFixture("newspaper_api_202608040711.json"));
    await fetchNewspaperConditions(parseRaceId("202608040711"), { fetcher });
    await fetchNewspaperConditions(parseRaceId("202608040712"), { fetcher });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options?.cacheKey).not.toBe(calls[1]!.options?.cacheKey);
  });

  it("壊れた応答は NewspaperParseError(握りつぶさない)", async () => {
    const { fetcher } = stub("not a json");
    await expect(fetchNewspaperConditions(parseRaceId("202608040711"), { fetcher })).rejects.toThrow(NewspaperParseError);
  });
});
