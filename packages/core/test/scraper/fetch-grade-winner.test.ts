import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import {
  fetchGradeWinnerEntries,
  gradeWinnerCacheKey,
  type GradeWinnerFetcher,
} from "../../src/scraper/fetch-grade-winner.js";
import { parseRaceId } from "../../src/scraper/ids.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 呼び出しを記録するスタブフェッチャ。 */
function makeFetcherStub(response: string): {
  fetcher: GradeWinnerFetcher;
  calls: Array<{ url: string; options?: CachedFetchTextOptions }>;
} {
  const calls: Array<{ url: string; options?: CachedFetchTextOptions }> = [];
  const fetcher: GradeWinnerFetcher = {
    fetchText: vi.fn(async (url: string, options?: CachedFetchTextOptions) => {
      calls.push({ url, options });
      return response;
    }),
  };
  return { fetcher, calls };
}

describe("fetchGradeWinnerEntries(中央)", () => {
  it("中央のrace_idで正常系(status:OK)フィクスチャを取得すると、過去10回分の配列を返すこと", async () => {
    const { fetcher } = makeFetcherStub(
      loadFixture("grade_winner_202603020211.json"),
    );
    const raceId = parseRaceId("202603020211");

    const entries = await fetchGradeWinnerEntries(raceId, { fetcher });

    expect(entries).toHaveLength(10);
  });

  it("非重賞(status:NG)フィクスチャのときはnullを返し、例外を投げないこと(静かにスキップ。非重賞であることの証跡であり、地方だからNGという意味ではない)", async () => {
    const { fetcher } = makeFetcherStub(
      loadFixture("grade_winner_ng_202602010607.json"),
    );
    const raceId = parseRaceId("202602010607");

    await expect(fetchGradeWinnerEntries(raceId, { fetcher })).resolves.toBeNull();
  });

  it("固定URL(race.netkeiba.com)・正しいPOSTボディ・必要なヘッダ(Referer=past10.html)・一意なcacheKeyでfetchTextを呼ぶこと", async () => {
    const { fetcher, calls } = makeFetcherStub(
      loadFixture("grade_winner_202603020211.json"),
    );
    const raceId = parseRaceId("202603020211");

    await fetchGradeWinnerEntries(raceId, { fetcher });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://race.netkeiba.com/race_api/");
    expect(call.options?.method).toBe("POST");
    expect(call.options?.body).toBe(
      "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202603020211",
    );
    expect(call.options?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211",
      Origin: "https://race.netkeiba.com",
    });
    expect(call.options?.cacheKey).toBe(gradeWinnerCacheKey(raceId));
    // 過去回は確定データのためmaxAgeMsは指定しない(無期限キャッシュ)。
    expect(call.options?.maxAgeMs).toBeUndefined();
  });

  it("⚠️最重要回帰: 異なるrace_idの2回呼び出しが別のcacheKeyになること(URL固定APIでのデータ混線防止)", async () => {
    const { fetcher, calls } = makeFetcherStub(
      loadFixture("grade_winner_202603020211.json"),
    );
    const raceIdA = parseRaceId("202603020211");
    const raceIdB = parseRaceId("202503020211");

    await fetchGradeWinnerEntries(raceIdA, { fetcher });
    await fetchGradeWinnerEntries(raceIdB, { fetcher });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.options?.cacheKey).not.toBe(calls[1]!.options?.cacheKey);
    expect(calls[0]!.options?.cacheKey).toBe(gradeWinnerCacheKey(raceIdA));
    expect(calls[1]!.options?.cacheKey).toBe(gradeWinnerCacheKey(raceIdB));
  });
});

describe("fetchGradeWinnerEntries(地方=NAR。2026-07-28実測訂正: nar.netkeiba.comの同一APIで取得できる)", () => {
  it("地方のrace_idで正常系(status:OK)フィクスチャを取得すると、過去10回分の配列を返すこと(帝王賞・大井)", async () => {
    const { fetcher } = makeFetcherStub(
      loadFixture("grade_winner_nar_202644070111.json"),
    );
    const raceId = parseRaceId("202644070111"); // 場コード44 → 大井。

    const entries = await fetchGradeWinnerEntries(raceId, { fetcher });

    expect(entries).toHaveLength(10);
  });

  it("固定URL(nar.netkeiba.com)・正しいPOSTボディ・必要なヘッダ(Referer=past5.html)・一意なcacheKeyでfetchTextを呼ぶこと(ホストのみ中央と異なる)", async () => {
    const { fetcher, calls } = makeFetcherStub(
      loadFixture("grade_winner_nar_202644070111.json"),
    );
    const raceId = parseRaceId("202644070111");

    await fetchGradeWinnerEntries(raceId, { fetcher });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://nar.netkeiba.com/race_api/");
    expect(call.options?.method).toBe("POST");
    // ボディの組み立て方(パラメータ名)は中央と完全に同一。
    expect(call.options?.body).toBe(
      "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202644070111",
    );
    expect(call.options?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      // 地方はReferer/Originがnar.netkeiba.comになる(ページ名もpast5.htmlで中央と異なる)。
      Referer: "https://nar.netkeiba.com/race/past5.html?race_id=202644070111",
      Origin: "https://nar.netkeiba.com",
    });
    expect(call.options?.cacheKey).toBe(gradeWinnerCacheKey(raceId));
  });

  it("中央と地方で同じrace_api/パスでもcacheKeyが異なること(ホストが違ってもrace_id基準で一意)", async () => {
    const centralId = parseRaceId("202603020211");
    const narId = parseRaceId("202644070111");
    expect(gradeWinnerCacheKey(centralId)).not.toBe(gradeWinnerCacheKey(narId));
  });
});
