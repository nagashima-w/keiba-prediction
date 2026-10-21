import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";
import { scrapeRace, type RaceFetcher } from "../../src/scraper/scrape-race.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #421 段階 1: `scrapeRace` が出馬表のレースの条件(`weightType`・`filliesOnly`)を `RaceData.race` に載せること。
 * 中央は読み、**地方は(出馬表に牝・種別の span があっても)キーを付けない**(ユーザー決定: 地方は読まない)。
 */

class StubFetcher implements RaceFetcher {
  constructor(private readonly handler: (url: string) => string) {}
  async fetchText(url: string, _options?: CachedFetchTextOptions): Promise<string> {
    return this.handler(url);
  }
}

const FIXED_NOW = () => new Date("2026-06-28T01:00:00.000Z");

function centralHandler(shutuba: string): (url: string) => string {
  return (url) => {
    if (url.includes("shutuba.html")) return shutuba;
    if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
    if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
    if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
    throw new Error(`未知のURL: ${url}`);
  };
}

describe("scrapeRace: レースの条件(Issue #421 段階 1)", () => {
  it("中央(ハンデ戦・牝馬限定でない): weightType=ハンデ・filliesOnly=false が race に載る", async () => {
    const data = await scrapeRace(parseRaceId("202603020211"), { fetcher: new StubFetcher(centralHandler(loadFixture("shutuba_202603020211.html"))), now: FIXED_NOW });
    expect(data.race.weightType).toBe("ハンデ");
    expect(data.race.filliesOnly).toBe(false);
  });

  it("中央(馬齢・牝馬限定): weightType=馬齢・filliesOnly=true が race に載る", async () => {
    const handler = centralHandler(loadFixture("shutuba_202606040901.html"));
    const data = await scrapeRace(parseRaceId("202606040901"), {
      fetcher: new StubFetcher((url) => (url.includes("api_get_jra_odds") ? oddsFor16() : handler(url))),
      now: FIXED_NOW,
    });
    expect(data.race.weightType).toBe("馬齢");
    expect(data.race.filliesOnly).toBe(true);
  });

  it("地方: 出馬表の RaceData02 に牝と種別の span があっても、weightType・filliesOnly はキー自体を持たない", async () => {
    const original = loadFixture("nar_shutuba_202654071210.html");
    const withSpans = original.replace("<span>12頭</span>", "<span>牝</span>\n<span>ハンデ</span>\n<span>12頭</span>");
    // 前提(対照): 合成の span が実際に入っていて、読む指定をすればパーサは読む(キー無しの主張が空振りしない)。
    expect(withSpans).not.toBe(original);
    const control = parseShutuba(withSpans, { readRaceConditions: true }).race;
    expect(control.filliesOnly).toBe(true);
    expect(control.weightType).toBe("ハンデ");

    const handler = (url: string): string => {
      if (url.includes("shutuba.html")) return withSpans;
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021104387.json");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      throw new Error(`未知のURL(NAR): ${url}`);
    };
    const data = await scrapeRace(parseRaceId("202654071210"), { fetcher: new StubFetcher(handler), now: FIXED_NOW });
    expect(data.race.raceName).toBeDefined(); // 取得自体は成功している
    expect("weightType" in data.race).toBe(false);
    expect("filliesOnly" in data.race).toBe(false);
  });
});

/** 16頭ぶんの合成オッズ(取消馬6番は null・9999)。`shutuba_202606040901` 用。 */
function oddsFor16(): string {
  const win: Record<string, [string, string, string]> = {};
  const place: Record<string, [string, string, string]> = {};
  for (let n = 1; n <= 16; n++) {
    const key = String(n).padStart(2, "0");
    win[key] = n === 6 ? ["---.-", "0.0", "9999"] : [`${5 + n}.0`, "0.0", String(n)];
    place[key] = n === 6 ? ["---.-", "---.-", "9999"] : ["2.0", "3.0", String(n)];
  }
  return JSON.stringify({ status: "result", data: { official_datetime: "2026-06-28 09:50:00", odds: { "1": win, "2": place } } });
}
