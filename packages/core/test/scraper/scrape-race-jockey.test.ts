import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseJockeyResults } from "../../src/scraper/parse-jockey-results.js";
import {
  DEFAULT_JOCKEY_TTL_MS,
  scrapeRace,
  type RaceFetcher,
} from "../../src/scraper/scrape-race.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #226: 騎手の年度別成績の取得(`options.includeJockeyStats`。opt-in。既定OFF)。
 *
 * 保存済みの実フィクスチャだけを使い、実ネットワークには出ない。
 */

class RecordingFetcher implements RaceFetcher {
  readonly calls: Array<{ url: string; options?: CachedFetchTextOptions }> = [];
  constructor(private readonly handler: (url: string) => string) {}
  async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
    this.calls.push({ url, options });
    return this.handler(url);
  }
  get urls(): string[] {
    return this.calls.map((c) => c.url);
  }
  /** 騎手ページの呼び出しだけ。 */
  get jockeyCalls(): Array<{ url: string; options?: CachedFetchTextOptions }> {
    return this.calls.filter((c) => c.url.includes("/jockey/result.html"));
  }
}

const FIXED_NOW = () => new Date("2026-06-28T06:00:00.000Z");

// ───────────── 中央(202603020211。16頭・騎手16人) ─────────────

const CENTRAL_RACE_ID = parseRaceId("202603020211");
const CENTRAL_SHUTUBA = loadFixture("shutuba_202603020211.html");
const JOCKEY_PAGE_01170 = loadFixture("jockey_results_01170.html");
const JOCKEY_PAGE_OTHER = loadFixture("jockey_results_01220.html");

/** 出馬表の16人の騎手ID(フィクスチャの実値。出馬表の順ではなく昇順)。 */
const CENTRAL_JOCKEY_IDS = [
  "01043", "01075", "01077", "01092", "01122", "01126", "01127", "01150",
  "01160", "01161", "01170", "01208", "01213", "05212", "05386", "05675",
];

function centralHandler(shutuba: string = CENTRAL_SHUTUBA, jockeyHandler?: (url: string) => string) {
  return (url: string): string => {
    if (url.includes("shutuba.html")) return shutuba;
    if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
    if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
    if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
    if (url.includes("/jockey/result.html")) {
      if (jockeyHandler) return jockeyHandler(url);
      return url.includes("id=01170") ? JOCKEY_PAGE_01170 : JOCKEY_PAGE_OTHER;
    }
    throw new Error(`未知のURL: ${url}`);
  };
}

describe("scrapeRace + includeJockeyStats(中央)", () => {
  it("前提: 出馬表の騎手は16人(重複なし)で、期待するID列と一致する", async () => {
    const fetcher = new RecordingFetcher(centralHandler());
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });
    const ids = data.horses.map((h) => h.shutuba.jockeyId).sort();
    expect(ids).toEqual(CENTRAL_JOCKEY_IDS);
  });

  it("既定(オプション未指定・false): 騎手のURLを1本も取得せず、結果に jockeyStats のキー自体が無い", async () => {
    const off = new RecordingFetcher(centralHandler());
    const explicitOff = new RecordingFetcher(centralHandler());
    const a = await scrapeRace(CENTRAL_RACE_ID, { fetcher: off, now: FIXED_NOW });
    const b = await scrapeRace(CENTRAL_RACE_ID, { fetcher: explicitOff, now: FIXED_NOW }, { includeJockeyStats: false });
    expect(off.jockeyCalls).toHaveLength(0);
    expect(explicitOff.jockeyCalls).toHaveLength(0);
    expect("jockeyStats" in a).toBe(false);
    expect("jockeyStats" in b).toBe(false);
    // 発行URL列は従来どおり(出馬表1+戦績16+調教1+オッズ1=19本)。
    expect(off.urls).toHaveLength(19);
    expect(explicitOff.urls).toEqual(off.urls);
  });

  it("true: 騎手ごとに1本、計16本を取得する(URLは中央の result.html?id=…)", async () => {
    const fetcher = new RecordingFetcher(centralHandler());
    await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(16);
    expect(fetcher.jockeyCalls.map((c) => c.url).sort()).toEqual(
      CENTRAL_JOCKEY_IDS.map((id) => `https://db.netkeiba.com/jockey/result.html?id=${id}`).sort(),
    );
    // 既存の19本はそのまま、騎手は**その後ろ**に足される(既存の発行順を変えない)。
    expect(fetcher.urls).toHaveLength(19 + 16);
    expect(fetcher.urls.slice(0, 19).some((u) => u.includes("/jockey/"))).toBe(false);
  });

  it("true: 結果の jockeyStats に、騎手IDをキーに年ごとの成績が入る(パーサの出力と同じ)", async () => {
    const fetcher = new RecordingFetcher(centralHandler());
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    const stats = data.jockeyStats!;
    expect(Object.keys(stats).sort()).toEqual(CENTRAL_JOCKEY_IDS);
    expect(stats["01170"]).toEqual(parseJockeyResults(JOCKEY_PAGE_01170));
    expect(stats["01170"]![0]).toEqual({ year: 2026, starts: 608, placed: 226 });
    expect(stats["01043"]).toEqual(parseJockeyResults(JOCKEY_PAGE_OTHER));
    expect(stats["01043"]).not.toEqual(stats["01170"]); // 騎手の取り違えを検出できる前提
    // JSON を往復しても値が消えない(Map ではなく素のオブジェクト)。
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });

  it("キャッシュの許容鮮度は7日(既定。週に1回の更新。旧: 24時間)で、ttl.jockeyMs で上書きできる", async () => {
    expect(DEFAULT_JOCKEY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const dflt = new RecordingFetcher(centralHandler());
    await scrapeRace(CENTRAL_RACE_ID, { fetcher: dflt, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(dflt.jockeyCalls.every((c) => c.options?.maxAgeMs === DEFAULT_JOCKEY_TTL_MS)).toBe(true);
    const custom = new RecordingFetcher(centralHandler());
    await scrapeRace(CENTRAL_RACE_ID, { fetcher: custom, now: FIXED_NOW, ttl: { jockeyMs: 1234 } }, { includeJockeyStats: true });
    expect(custom.jockeyCalls).toHaveLength(16);
    expect(custom.jockeyCalls.every((c) => c.options?.maxAgeMs === 1234)).toBe(true);
  });

  it("同じ騎手が複数の馬に乗るときは、騎手IDで一意にして1回だけ取得する(15本)", async () => {
    // 騎手 01126 のリンクを 01170 に書き換える → 01170 が2頭に乗る。
    const shared = CENTRAL_SHUTUBA.replaceAll("jockey/result/recent/01126", "jockey/result/recent/01170");
    expect(shared).not.toBe(CENTRAL_SHUTUBA); // 書き換えが効いている前提
    const fetcher = new RecordingFetcher(centralHandler(shared));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(data.horses.filter((h) => h.shutuba.jockeyId === "01170")).toHaveLength(2);
    expect(fetcher.jockeyCalls).toHaveLength(15);
    expect(fetcher.jockeyCalls.filter((c) => c.url.includes("id=01170"))).toHaveLength(1);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(15);
  });

  it("騎手IDが無い馬(騎手未定・リンク欠損)は取得せず、警告も出さない", async () => {
    const noLink = CENTRAL_SHUTUBA.replaceAll("jockey/result/recent/01126", "jockey/other/x");
    const fetcher = new RecordingFetcher(centralHandler(noLink));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(data.horses.filter((h) => h.shutuba.jockeyId === null)).toHaveLength(1);
    expect(fetcher.jockeyCalls).toHaveLength(15);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toEqual([]);
  });

  it("1人の取得に失敗しても投げず、その騎手の分だけ警告(種別=騎手)にして、ほかの騎手は取得できる", async () => {
    const fetcher = new RecordingFetcher(
      centralHandler(CENTRAL_SHUTUBA, (url) => {
        if (url.includes("id=01126")) throw new Error("HTTP 500");
        return JOCKEY_PAGE_OTHER;
      }),
    );
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(Object.keys(data.jockeyStats!)).toHaveLength(15);
    expect(data.jockeyStats!["01126"]).toBeUndefined();
    const warns = data.meta.warnings.filter((w) => w.kind === "騎手");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("01126");
    expect(warns[0]!.message).toContain("HTTP 500");
    expect(warns[0]!.jockeyId).toBe("01126");
    // 失敗した騎手を含め、16人ぶんを試みた。
    expect(fetcher.jockeyCalls).toHaveLength(16);
  });

  it("ページが壊れていて読めない騎手も、警告にして補正なし側に倒す(レース全体は落とさない)", async () => {
    const fetcher = new RecordingFetcher(
      centralHandler(CENTRAL_SHUTUBA, (url) => (url.includes("id=01126") ? "<html>not a table</html>" : JOCKEY_PAGE_OTHER)),
    );
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(data.jockeyStats!["01126"]).toBeUndefined();
    expect(data.meta.warnings.filter((w) => w.kind === "騎手").map((w) => w.jockeyId)).toEqual(["01126"]);
  });

  it("全員の取得に失敗しても投げず、jockeyStats は空のオブジェクト(キーは有る=取得を試みた)", async () => {
    const fetcher = new RecordingFetcher(
      centralHandler(CENTRAL_SHUTUBA, () => {
        throw new Error("blocked");
      }),
    );
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    expect(data.jockeyStats).toEqual({});
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toHaveLength(16);
  });
});

// ───────────── 地方(202654071210。12頭・騎手12人) ─────────────

const NAR_RACE_ID = parseRaceId("202654071210");
const NAR_JOCKEY_PAGE = loadFixture("nar_jockey_results_05496.html");

function narHandler(url: string): string {
  if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
  if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
  if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
  if (url.includes("/jockey/result.html")) return NAR_JOCKEY_PAGE;
  throw new Error(`未知のURL(NAR): ${url}`);
}

describe("scrapeRace + includeJockeyStats(地方)", () => {
  it("地方のレースは、地方の成績のページ(&syusai=20)を騎手ごとに1本取得する", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(NAR_RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true });
    const ids = [...new Set(data.horses.map((h) => h.shutuba.jockeyId))];
    expect(ids).toHaveLength(12);
    expect(fetcher.jockeyCalls).toHaveLength(12);
    expect(fetcher.jockeyCalls.every((c) => c.url.endsWith("&syusai=20"))).toBe(true);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(12);
    expect(data.jockeyStats![ids[0]!]).toEqual(parseJockeyResults(NAR_JOCKEY_PAGE));
  });

  it("既定(OFF)では地方でも騎手のURLを取得しない", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(NAR_RACE_ID, { fetcher, now: FIXED_NOW });
    expect(fetcher.jockeyCalls).toHaveLength(0);
    expect("jockeyStats" in data).toBe(false);
  });
});
