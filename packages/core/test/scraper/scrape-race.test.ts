import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId, parseKaisaiDate } from "../../src/scraper/ids.js";
import {
  DEFAULT_OIKIRI_TTL_MS,
  DEFAULT_ODDS_TTL_MS,
  DEFAULT_RACE_LIST_TTL_MS,
  DEFAULT_RESULTS_TTL_MS,
  DEFAULT_SHUTUBA_TTL_MS,
  listRaces,
  scrapeRace,
  type RaceFetcher,
} from "../../src/scraper/scrape-race.js";

/** フィクスチャを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** テストで使うレース(ラジオNIKKEI賞・福島芝1800・16頭)。 */
const RACE_ID = parseRaceId("202603020211");
/** 出馬表の先頭馬(戦績フィクスチャも存在する)。 */
const FIRST_HORSE_ID = "2023103386";

/**
 * 馬ID → 戦績フィクスチャの割り当て。
 * 戦績件数を馬ごとに変える(4/23/15/3走)ことで、
 * 「馬↔戦績の取り違え(クロスワイヤリング)」や「空配列リグレッション」を件数レベルで検知する。
 * キーは shutuba_202603020211 の実在馬(馬番1〜4)。値は戦績件数の異なる実フィクスチャ。
 */
const RESULTS_BY_HORSE: Record<string, { fixture: string; count: number }> = {
  "2023103386": { fixture: "horse_results_2023103386.json", count: 4 }, // 馬番1
  "2023105684": { fixture: "horse_results_2021105857.json", count: 23 }, // 馬番2
  "2023104885": { fixture: "horse_results_2021105727.json", count: 15 }, // 馬番3
  "2023101569": { fixture: "horse_results_2024104976.json", count: 3 }, // 馬番4
};

/** URL種別ごとに対応するフィクスチャ。 */
const FIXTURES = {
  shutuba: loadFixture("shutuba_202603020211.html"),
  oikiri: loadFixture("oikiri_202603020211.html"),
  odds: loadFixture("odds_202603020211.json"),
  raceList: loadFixture("race_list_sub_20260628.html"),
  /** 割り当ての無い馬(馬番5以降)に返すフォールバック戦績。件数は検証しない。 */
  resultsFallback: loadFixture("horse_results_2021105857.json"),
};

/** ajax_horse_results のURLから馬IDを取り出す。 */
function horseIdFromUrl(url: string): string {
  const m = /[?&]id=([^&]+)/.exec(url);
  if (!m) throw new Error(`馬IDを抽出できません: ${url}`);
  return m[1]!;
}

/**
 * URLからフィクスチャ本文を返す既定ハンドラ。
 * 戦績は馬IDごとに異なる内容(件数)を返し、馬↔戦績の対応を検証可能にする。
 */
function defaultHandler(url: string): string {
  if (url.includes("shutuba.html")) return FIXTURES.shutuba;
  if (url.includes("ajax_horse_results")) {
    const horseId = horseIdFromUrl(url);
    const assigned = RESULTS_BY_HORSE[horseId];
    return assigned ? loadFixture(assigned.fixture) : FIXTURES.resultsFallback;
  }
  if (url.includes("oikiri.html")) return FIXTURES.oikiri;
  if (url.includes("api_get_jra_odds")) return FIXTURES.odds;
  if (url.includes("race_list_sub")) return FIXTURES.raceList;
  throw new Error(`未知のURL: ${url}`);
}

/**
 * 呼び出しを記録するフェイクフェッチャ。
 * handler は同期関数で、投げれば取得失敗を模擬できる。
 */
class RecordingFetcher implements RaceFetcher {
  readonly calls: Array<{ url: string; options?: CachedFetchTextOptions }> = [];
  constructor(private readonly handler: (url: string) => string) {}
  async fetchText(
    url: string,
    options?: CachedFetchTextOptions,
  ): Promise<string> {
    this.calls.push({ url, options });
    return this.handler(url);
  }
  /** URLに部分一致する最初の呼び出しを返す。 */
  callFor(fragment: string): { url: string; options?: CachedFetchTextOptions } {
    const call = this.calls.find((c) => c.url.includes(fragment));
    if (!call) throw new Error(`${fragment} を含む呼び出しがありません`);
    return call;
  }
}

/** 固定時刻を返す now(メタ情報の検証用)。 */
const FIXED_NOW = () => new Date("2026-06-28T06:00:00.000Z");

describe("scrapeRace(レース完全データの統合取得)", () => {
  it("出馬表・戦績・調教・オッズを取得して1つのRaceDataにまとめること", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.raceId).toBe(RACE_ID);
    expect(data.race.raceName).toBe("ラジオNIKKEI賞");
    expect(data.race.courseType).toBe("芝");
    expect(data.race.distance).toBe(1800);

    // 出走馬(16頭)。各馬に出馬表情報+戦績+調教評価がぶら下がる。
    expect(data.horses).toHaveLength(16);
    expect(data.horses[0]!.shutuba.horseId).toBe(FIRST_HORSE_ID);
    expect(data.horses.every((h) => Array.isArray(h.results))).toBe(true);
    // 調教評価は全16頭が馬IDで突合できる(フィクスチャ実測)。
    expect(data.horses.every((h) => h.oikiri !== null)).toBe(true);

    // 馬↔戦績が正しく対応していること。件数の異なる4頭を突合し、
    // 取り違え(クロスワイヤリング)や空配列リグレッションを検知する。
    for (const [horseId, { count }] of Object.entries(RESULTS_BY_HORSE)) {
      const horse = data.horses.find((h) => h.shutuba.horseId === horseId);
      expect(horse, `馬ID ${horseId} が出走表にいること`).toBeDefined();
      expect(horse!.results, `馬ID ${horseId} の戦績件数`).toHaveLength(count);
    }
    // 先頭馬(馬番1)は4走、馬番2は23走と、確かに異なる件数が入る。
    expect(data.horses[0]!.results).toHaveLength(4);
    expect(data.horses[1]!.results).toHaveLength(23);

    // オッズ(単勝・複勝とも16頭分、確定時刻付き)。
    expect(Object.keys(data.odds.win)).toHaveLength(16);
    expect(Object.keys(data.odds.place)).toHaveLength(16);
    expect(data.odds.officialDatetime).toBe("2026-06-28 15:52:30");
    // EV計算が依存する実値(単勝オッズ・複勝下限)を突合する。
    expect(data.odds.win[1]).toEqual({ odds: 9, ninki: 5 });
    expect(data.odds.place[1]).toEqual({ oddsMin: 3.1, oddsMax: 4.1, ninki: 5 });
    expect(data.odds.win[5]!.odds).toBe(5.6);
    expect(data.odds.place[5]!.oddsMin).toBe(1.9);

    // 警告なし・取得時刻は注入したnow。
    expect(data.meta.warnings).toEqual([]);
    expect(data.meta.fetchedAt).toBe("2026-06-28T06:00:00.000Z");
    // オッズ取得時刻もメタに入る(固定nowなので着手時刻と一致)。
    expect(data.meta.oddsFetchedAt).toBe("2026-06-28T06:00:00.000Z");
  });

  it("meta.fetchedAt は着手時刻、oddsFetchedAt はオッズ取得直後の時刻を表すこと", async () => {
    // 呼び出しごとに1秒進む時計。着手時とオッズ取得時でズレることを検証する。
    let tick = 0;
    const advancingNow = () => new Date(Date.UTC(2026, 5, 28, 6, 0, tick++));
    const fetcher = new RecordingFetcher(defaultHandler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: advancingNow });

    // 着手が先、オッズ取得はその後(直列取得で時間が経過する)。
    expect(data.meta.fetchedAt).toBe("2026-06-28T06:00:00.000Z");
    expect(
      new Date(data.meta.oddsFetchedAt).getTime(),
    ).toBeGreaterThan(new Date(data.meta.fetchedAt).getTime());
  });

  it("各データ取得にカテゴリ既定のTTL(maxAgeMs)を渡すこと", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW });

    expect(fetcher.callFor("shutuba.html").options?.maxAgeMs).toBe(
      DEFAULT_SHUTUBA_TTL_MS,
    );
    expect(fetcher.callFor("ajax_horse_results").options?.maxAgeMs).toBe(
      DEFAULT_RESULTS_TTL_MS,
    );
    expect(fetcher.callFor("oikiri.html").options?.maxAgeMs).toBe(
      DEFAULT_OIKIRI_TTL_MS,
    );
    expect(fetcher.callFor("api_get_jra_odds").options?.maxAgeMs).toBe(
      DEFAULT_ODDS_TTL_MS,
    );
  });

  it("deps.ttl でTTLを上書きできること", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    await scrapeRace(RACE_ID, {
      fetcher,
      now: FIXED_NOW,
      ttl: { oddsMs: 5, shutubaMs: 123 },
    });
    expect(fetcher.callFor("api_get_jra_odds").options?.maxAgeMs).toBe(5);
    expect(fetcher.callFor("shutuba.html").options?.maxAgeMs).toBe(123);
    // 未指定カテゴリは既定値のまま。
    expect(fetcher.callFor("oikiri.html").options?.maxAgeMs).toBe(
      DEFAULT_OIKIRI_TTL_MS,
    );
  });

  it("bypassOddsCache 指定時はオッズのみ bypassCache=true で取得すること", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    await scrapeRace(
      RACE_ID,
      { fetcher, now: FIXED_NOW },
      { bypassOddsCache: true },
    );
    expect(fetcher.callFor("api_get_jra_odds").options?.bypassCache).toBe(true);
    // 出馬表・戦績・調教はキャッシュを使う(bypassしない)。
    expect(fetcher.callFor("shutuba.html").options?.bypassCache).toBeFalsy();
    expect(fetcher.callFor("ajax_horse_results").options?.bypassCache).toBeFalsy();
  });

  it("調教(optional)が失敗してもレース全体は成功し、oikiriはnull+警告になること", async () => {
    const fetcher = new RecordingFetcher((url) => {
      if (url.includes("oikiri.html")) throw new Error("調教ページ取得失敗");
      return defaultHandler(url);
    });
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(16);
    expect(data.horses.every((h) => h.oikiri === null)).toBe(true);
    // 戦績・オッズは正常。
    expect(data.horses.every((h) => h.results !== null)).toBe(true);
    expect(Object.keys(data.odds.win)).toHaveLength(16);
    // 調教の警告が1件記録される。
    const warns = data.meta.warnings.filter((w) => w.kind === "調教");
    expect(warns).toHaveLength(1);
  });

  it("戦績が1頭だけ失敗しても他馬は取得でき、その馬はresults:null+警告になること", async () => {
    const fetcher = new RecordingFetcher((url) => {
      if (url.includes("ajax_horse_results") && url.includes(FIRST_HORSE_ID)) {
        throw new Error("戦績API取得失敗");
      }
      return defaultHandler(url);
    });
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW });

    const failed = data.horses.find(
      (h) => h.shutuba.horseId === FIRST_HORSE_ID,
    )!;
    expect(failed.results).toBeNull();
    // 他馬は取得できている。
    const others = data.horses.filter(
      (h) => h.shutuba.horseId !== FIRST_HORSE_ID,
    );
    expect(others.every((h) => h.results !== null)).toBe(true);
    // 該当馬IDを持つ戦績警告が1件。
    const warns = data.meta.warnings.filter((w) => w.kind === "戦績");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.horseId).toBe(FIRST_HORSE_ID);
  });

  it("必須データ(出馬表)の取得失敗はthrowすること", async () => {
    const fetcher = new RecordingFetcher((url) => {
      if (url.includes("shutuba.html")) throw new Error("出馬表取得失敗");
      return defaultHandler(url);
    });
    await expect(scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW })).rejects.toThrow(
      /出馬表取得失敗/,
    );
  });

  it("必須データ(オッズ)の取得失敗はthrowすること", async () => {
    const fetcher = new RecordingFetcher((url) => {
      if (url.includes("api_get_jra_odds")) throw new Error("オッズ取得失敗");
      return defaultHandler(url);
    });
    await expect(scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW })).rejects.toThrow(
      /オッズ取得失敗/,
    );
  });
});

describe("listRaces(開催日→レース一覧)", () => {
  it("開催日からレース一覧を取得すること", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    const entries = await listRaces(parseKaisaiDate("20260628"), { fetcher });
    // フィクスチャは3場36レース。
    expect(entries).toHaveLength(36);
    expect(fetcher.callFor("race_list_sub").options?.maxAgeMs).toBe(
      DEFAULT_RACE_LIST_TTL_MS,
    );
  });
});
