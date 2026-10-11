import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CachedFetcher,
  ScrapeCache,
  type TextFetcher,
} from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import {
  DEFAULT_OIKIRI_TTL_MS,
  DEFAULT_RESULTS_TTL_MS,
  DEFAULT_SHUTUBA_TTL_MS,
  scrapeRace,
} from "../../src/scraper/scrape-race.js";

/**
 * Issue #155: 出馬表のキャッシュ TTL を10分にし、取消・馬体重・騎手の乗り替わりの更新を
 * 最長6時間取りこぼさないようにする。
 *
 * 「10分以内ならキャッシュ・10分を超えたら取り直し」は、`scrapeRace` の `now`(メタ情報用で
 * 鮮度判定に関与しない)ではなく、`ScrapeCache` に注入する時計と `CachedFetcher` の `maxAgeMs`
 * の組み合わせで決まる。そのため **本番と同じ配線**(`{ fetcher: CachedFetcher }` のみ。`ttl` は
 * 渡さず既定値を使う。`pipeline-deps.ts` と同じ)で、可変クロックを進めて境界の両側を固定する。
 */

const TEN_MINUTES_MS = 10 * 60 * 1000;
const RACE_ID = parseRaceId("202603020211");

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const FIXTURES = {
  shutuba: loadFixture("shutuba_202603020211.html"),
  oikiri: loadFixture("oikiri_202603020211.html"),
  odds: loadFixture("odds_202603020211.json"),
  results: loadFixture("horse_results_2021105857.json"),
};

/** URL種別ごとの実フェッチ回数を数える TextFetcher と、可変クロック付きの本番相当配線を作る。 */
function setup(): {
  fetcher: CachedFetcher;
  advance: (ms: number) => void;
  count: (fragment: string) => number;
} {
  const urls: string[] = [];
  const inner: TextFetcher = {
    async fetchText(url: string): Promise<string> {
      urls.push(url);
      if (url.includes("shutuba.html")) return FIXTURES.shutuba;
      if (url.includes("ajax_horse_results")) return FIXTURES.results;
      if (url.includes("oikiri.html")) return FIXTURES.oikiri;
      if (url.includes("api_get_jra_odds")) return FIXTURES.odds;
      throw new Error(`未知のURL: ${url}`);
    },
  };
  let current = 1_000_000;
  const cache = new ScrapeCache({ now: () => current });
  return {
    fetcher: new CachedFetcher({ fetcher: inner, cache }),
    advance: (ms) => {
      current += ms;
    },
    count: (fragment) => urls.filter((u) => u.includes(fragment)).length,
  };
}

describe("出馬表キャッシュ TTL(Issue #155)", () => {
  it("既定値は10分であること(定数同士の比較ではなくリテラルで固定する)", () => {
    expect(DEFAULT_SHUTUBA_TTL_MS).toBe(600_000);
    expect(DEFAULT_SHUTUBA_TTL_MS).toBe(TEN_MINUTES_MS);
  });

  it("戦績の既定TTLは24時間のまま(出馬表だけを短縮した)。調教は Issue #191 で戦績と同じ24時間に延ばした(リテラルで固定する)", () => {
    expect(DEFAULT_RESULTS_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_OIKIRI_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_OIKIRI_TTL_MS).toBe(86_400_000);
  });

  it("10分ちょうど経過後の再取得は出馬表をキャッシュから返し、フェッチを増やさないこと(境界: ヒット)", async () => {
    const { fetcher, advance, count } = setup();
    await scrapeRace(RACE_ID, { fetcher });
    // 前提を無条件に固定する: 1回目で出馬表・調教・戦績が実際に取得されている。
    expect(count("shutuba.html")).toBe(1);
    expect(count("oikiri.html")).toBe(1);
    expect(count("ajax_horse_results")).toBeGreaterThan(0);

    advance(TEN_MINUTES_MS);
    await scrapeRace(RACE_ID, { fetcher });
    expect(count("shutuba.html")).toBe(1);
  });

  it("10分+1ms 経過後の再取得は出馬表だけを取り直し、戦績・調教は増えないこと(境界: ミス)", async () => {
    const { fetcher, advance, count } = setup();
    await scrapeRace(RACE_ID, { fetcher });
    const resultsAfterFirst = count("ajax_horse_results");
    // 前提: 戦績が1件以上取得されている(増えないことの検証が自明に成立しないように)。
    expect(resultsAfterFirst).toBeGreaterThan(0);
    expect(count("shutuba.html")).toBe(1);
    expect(count("oikiri.html")).toBe(1);

    advance(TEN_MINUTES_MS + 1);
    await scrapeRace(RACE_ID, { fetcher });

    expect(count("shutuba.html")).toBe(2);
    expect(count("ajax_horse_results")).toBe(resultsAfterFirst);
    expect(count("oikiri.html")).toBe(1);
  });

  // Issue #191: 調教(追い切り)のキャッシュ許容鮮度を、旧 6 時間から戦績と同じ 24 時間に延ばした(調教は当日の朝に取れていれば、その後に更新されない)。
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  it("調教: 旧TTL(6時間)を1ms 超えても、キャッシュから返し取り直さない(旧版ならここで取り直す)", async () => {
    const { fetcher, advance, count } = setup();
    await scrapeRace(RACE_ID, { fetcher });
    expect(count("oikiri.html")).toBe(1); // 前提: 1回目で調教を取得している

    advance(SIX_HOURS_MS + 1);
    await scrapeRace(RACE_ID, { fetcher });

    expect(count("shutuba.html")).toBe(2); // 前提: 時間が実際に進んでいる(出馬表の10分は過ぎて取り直す)
    expect(count("oikiri.html")).toBe(1);
  });

  it("調教: 24時間ちょうどはヒット(境界)、24時間+1ms はミス(取り直す)", async () => {
    const hit = setup();
    await scrapeRace(RACE_ID, { fetcher: hit.fetcher });
    expect(hit.count("oikiri.html")).toBe(1);
    hit.advance(TWENTY_FOUR_HOURS_MS);
    await scrapeRace(RACE_ID, { fetcher: hit.fetcher });
    expect(hit.count("oikiri.html")).toBe(1);

    const miss = setup();
    await scrapeRace(RACE_ID, { fetcher: miss.fetcher });
    expect(miss.count("oikiri.html")).toBe(1);
    miss.advance(TWENTY_FOUR_HOURS_MS + 1);
    await scrapeRace(RACE_ID, { fetcher: miss.fetcher });
    expect(miss.count("oikiri.html")).toBe(2);
  });
});
