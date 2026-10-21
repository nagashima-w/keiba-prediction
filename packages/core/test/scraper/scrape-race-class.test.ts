import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { scrapeRace, type RaceFetcher } from "../../src/scraper/scrape-race.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #426: `scrapeRace` が出馬表のレースのクラス(`raceClass`)を `RaceData.race` に載せること。
 * 負担重量の種別・牝馬限定(Issue #421。地方は読まない)と違って、**中央も地方も読む**(中央は正準ラベル、地方は区分の生のトークン)。
 */

class StubFetcher implements RaceFetcher {
  constructor(private readonly handler: (url: string) => string) {}
  async fetchText(url: string, _options?: CachedFetchTextOptions): Promise<string> {
    return this.handler(url);
  }
}

const FIXED_NOW = () => new Date("2026-06-28T01:00:00.000Z");

describe("scrapeRace: レースのクラス(Issue #426)", () => {
  it("中央(ラジオNIKKEI賞): raceClass=オープン が race に載る", async () => {
    const handler = (url: string): string => {
      if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
      if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
      if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
      throw new Error(`未知のURL: ${url}`);
    };
    const data = await scrapeRace(parseRaceId("202603020211"), { fetcher: new StubFetcher(handler), now: FIXED_NOW });
    expect(data.race.raceClass).toBe("オープン");
  });

  it("地方(高知 C1): raceClass=C1 が race に載る(種別・牝馬限定は地方では読まないまま)", async () => {
    const handler = (url: string): string => {
      if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021104387.json");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      throw new Error(`未知のURL(NAR): ${url}`);
    };
    const data = await scrapeRace(parseRaceId("202654071210"), { fetcher: new StubFetcher(handler), now: FIXED_NOW });
    expect(data.race.raceClass).toBe("C1");
    expect("weightType" in data.race).toBe(false);
    expect("filliesOnly" in data.race).toBe(false);
  });
});
