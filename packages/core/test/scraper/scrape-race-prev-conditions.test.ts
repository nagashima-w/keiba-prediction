import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { newspaperCacheKey } from "../../src/scraper/fetch-newspaper.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { DEFAULT_NEWSPAPER_TTL_MS, scrapeRace, type RaceFetcher } from "../../src/scraper/scrape-race.js";

/**
 * Issue #421 段階 1-b: `scrapeRace` の `options.includePrevConditions`(前走の条件。新聞形式 API を 1 本)。
 * 既定 OFF=従来と同じ呼び出し列。ON でも失敗は警告にして、分析に必要なデータは従来どおり返す。
 */

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

type Call = { url: string; options?: CachedFetchTextOptions };

class RecordingFetcher implements RaceFetcher {
  readonly calls: Call[] = [];
  constructor(private readonly handler: (url: string, options?: CachedFetchTextOptions) => string) {}
  async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
    this.calls.push({ url, options });
    return this.handler(url, options);
  }
  get posts(): Call[] {
    return this.calls.filter((c) => c.options?.method === "POST");
  }
  get jockeyCalls(): Call[] {
    return this.calls.filter((c) => c.url.includes("/jockey/result.html"));
  }
}

const FIXED_NOW = () => new Date("2026-06-28T06:00:00.000Z");
const CENTRAL_ID = parseRaceId("202603020211");
const NEWSPAPER_FIXTURE = loadFixture("newspaper_api_202608040711.json");

function centralHandler(newspaper: (options?: CachedFetchTextOptions) => string = () => NEWSPAPER_FIXTURE) {
  return (url: string, options?: CachedFetchTextOptions): string => {
    if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
    if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
    if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
    if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
    if (url.includes("/jockey/result.html")) return loadFixture(url.includes("id=01170") ? "jockey_results_01170.html" : "jockey_results_01220.html");
    if (url.endsWith("/race_api/") && options?.method === "POST") return newspaper(options);
    throw new Error(`未知のURL: ${url}`);
  };
}

describe("scrapeRace + includePrevConditions", () => {
  it("既定(未指定・false): POST を 1 本も出さず、結果に prevRaceConditions のキー自体が無い。発行 URL 列は従来どおり(19 本)", async () => {
    const a = new RecordingFetcher(centralHandler());
    const b = new RecordingFetcher(centralHandler());
    const dataA = await scrapeRace(CENTRAL_ID, { fetcher: a, now: FIXED_NOW });
    const dataB = await scrapeRace(CENTRAL_ID, { fetcher: b, now: FIXED_NOW }, { includePrevConditions: false });
    expect(a.posts).toHaveLength(0);
    expect(b.posts).toHaveLength(0);
    expect("prevRaceConditions" in dataA).toBe(false);
    expect("prevRaceConditions" in dataB).toBe(false);
    expect(a.calls).toHaveLength(19);
    expect(b.calls.map((c) => c.url)).toEqual(a.calls.map((c) => c.url));
  });

  it("ON: POST がちょうど 1 本。固定 URL・AplNewsPaper のボディ・cacheKey・既定の TTL(6 時間)で、表が RaceData に載る", async () => {
    const fetcher = new RecordingFetcher(centralHandler());
    const data = await scrapeRace(CENTRAL_ID, { fetcher, now: FIXED_NOW }, { includePrevConditions: true });
    expect(fetcher.posts).toHaveLength(1);
    const post = fetcher.posts[0]!;
    expect(post.url).toBe("https://race.netkeiba.com/race_api/");
    expect(post.options?.body).toBe("input=UTF-8&output=json&class=AplNewsPaper&method=get&compress=1&race_id=202603020211");
    expect(post.options?.cacheKey).toBe(newspaperCacheKey(CENTRAL_ID));
    expect(DEFAULT_NEWSPAPER_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(post.options?.maxAgeMs).toBe(DEFAULT_NEWSPAPER_TTL_MS);
    expect(Object.keys(data.prevRaceConditions ?? {})).toHaveLength(88);
    expect(data.meta.warnings).toEqual([]);
    expect(fetcher.calls).toHaveLength(20); // 従来の 19 本 + 1 本
  });

  it("TTL は deps.ttl.newspaperMs で上書きできる(計算ステップが実質無期限を渡す口)", async () => {
    const fetcher = new RecordingFetcher(centralHandler());
    await scrapeRace(CENTRAL_ID, { fetcher, now: FIXED_NOW, ttl: { newspaperMs: 777 } }, { includePrevConditions: true });
    expect(fetcher.posts[0]!.options?.maxAgeMs).toBe(777);
  });

  it("騎手・調教師の取得の上限(jockeyRequestLimit)の外: ON でも騎手の取得数は OFF と同じ(新聞形式の 1 本が上限を食わない)", async () => {
    // 基準: OFF で全騎手(16 人)を取ったときの fetcher 呼び出しの合計 T。上限 = T なら、最後の騎手は呼び出し T-1 本目から始まって取れる。
    // 新聞形式の POST が上限の数え込みに入るなら、最後の騎手は T 本目で上限に当たり、取れなくなる。
    const base = new RecordingFetcher(centralHandler());
    const baseData = await scrapeRace(CENTRAL_ID, { fetcher: base, now: FIXED_NOW }, { includeJockeyStats: true, jockeyRequestLimit: 1000 });
    const total = base.calls.length;
    expect(base.jockeyCalls.length).toBeGreaterThanOrEqual(10); // 前提: 多数の騎手を取っている(退化していない)
    expect(Object.keys(baseData.jockeyStats ?? {})).toHaveLength(base.jockeyCalls.length);

    const withPrev = new RecordingFetcher(centralHandler());
    const data = await scrapeRace(CENTRAL_ID, { fetcher: withPrev, now: FIXED_NOW }, { includeJockeyStats: true, includePrevConditions: true, jockeyRequestLimit: total });
    expect(withPrev.posts).toHaveLength(1);
    expect(withPrev.jockeyCalls).toHaveLength(base.jockeyCalls.length);
    expect(Object.keys(data.jockeyStats ?? {})).toEqual(Object.keys(baseData.jockeyStats ?? {}));
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toEqual([]);
  });

  it("地方: nar のホストへ POST し、表が載る(地方の条件の文言は空)", async () => {
    const handler = (url: string, options?: CachedFetchTextOptions): string => {
      if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021104387.json");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      if (url.endsWith("/race_api/") && options?.method === "POST") return loadFixture("newspaper_api_nar_202655090311.json");
      throw new Error(`未知のURL(NAR): ${url}`);
    };
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(parseRaceId("202654071210"), { fetcher, now: FIXED_NOW }, { includePrevConditions: true });
    expect(fetcher.posts).toHaveLength(1);
    expect(fetcher.posts[0]!.url).toBe("https://nar.netkeiba.com/race_api/");
    expect(fetcher.posts[0]!.options?.body).toContain("race_id=202654071210");
    expect(Object.keys(data.prevRaceConditions ?? {})).toHaveLength(270);
  });

  describe("失敗は警告(kind=前走条件)で、他のデータは従来どおり返る", () => {
    it("通信の失敗: 警告 1 件・prevRaceConditions のキーは無い・brokenCacheKey は付かない(キャッシュに何も入っていない)", async () => {
      const fetcher = new RecordingFetcher(
        centralHandler(() => {
          throw new Error("ネットワークが切れた");
        }),
      );
      const data = await scrapeRace(CENTRAL_ID, { fetcher, now: FIXED_NOW }, { includePrevConditions: true });
      expect(data.horses).toHaveLength(16);
      expect("prevRaceConditions" in data).toBe(false);
      const warnings = data.meta.warnings.filter((w) => w.kind === "前走条件");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain("ネットワークが切れた");
      expect("brokenCacheKey" in warnings[0]!).toBe(false);
      expect(data.meta.warnings).toHaveLength(1);
    });

    it.each([
      ["JSON でない応答", "<html>壊れた</html>"],
      ["status が NG(実測の応答)", loadFixture("newspaper_api_ng_202605050811.json")],
      ["zlib として読めない", JSON.stringify({ status: "OK", reason: null, data: { k: Buffer.from("zlibではない").toString("base64") } })],
      ["展開後が配列でない", JSON.stringify({ status: "OK", reason: null, data: { k: deflateSync(Buffer.from('{"a":1}')).toString("base64") } })],
    ])("読めない応答(%s): 警告に brokenCacheKey(消すべきキャッシュのキー)が付く", async (_name, body) => {
      const fetcher = new RecordingFetcher(centralHandler(() => body));
      const data = await scrapeRace(CENTRAL_ID, { fetcher, now: FIXED_NOW }, { includePrevConditions: true });
      expect(data.horses).toHaveLength(16);
      expect("prevRaceConditions" in data).toBe(false);
      const warnings = data.meta.warnings.filter((w) => w.kind === "前走条件");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.brokenCacheKey).toBe("race_api#AplNewsPaper#202603020211");
    });
  });
});
