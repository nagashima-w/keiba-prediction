import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import type { RaceIdVenueKind } from "../../src/scraper/ids.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import type { JockeyResultsStore, StoredJockeyResults } from "../../src/scraper/jockey-results-store.js";
import { parseJockeyResults, type JockeyYearRecord } from "../../src/scraper/parse-jockey-results.js";
import {
  DEFAULT_JOCKEY_REQUEST_LIMIT,
  DEFAULT_JOCKEY_TTL_MS,
  scrapeRace,
  type RaceFetcher,
} from "../../src/scraper/scrape-race.js";

/**
 * Issue #226(週 1 回の更新): 騎手の年ごとの成績を、日をまたいで共有する保存先(`JockeyResultsStore`。クラウド版は D1)から先に読む。
 * 取得日時から TTL(既定 7 日)以内なら netkeiba に出ず、超えた・無いときだけ取得して保存する。保存先の失敗は取得にフォールバックする。
 * 1 回の `scrapeRace` の fetcher 呼び出しの合計に上限(既定 40)を設け、届いたら残りの騎手は取らずに警告にする。
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

class RecordingFetcher implements RaceFetcher {
  readonly calls: Array<{ url: string; options?: CachedFetchTextOptions }> = [];
  constructor(private readonly handler: (url: string) => string) {}
  async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
    this.calls.push({ url, options });
    return this.handler(url);
  }
  get jockeyCalls(): string[] {
    return this.calls.filter((c) => c.url.includes("/jockey/result.html")).map((c) => c.url);
  }
}

/** 取得日時つきでメモリに持つ偽の保存先。呼び出しを記録し、失敗も模擬できる。 */
class MemoryStore implements JockeyResultsStore {
  readonly entries = new Map<string, StoredJockeyResults>();
  readonly loads: Array<{ ids: readonly string[]; kind: RaceIdVenueKind }> = [];
  readonly saves: Array<{ kind: RaceIdVenueKind; entries: readonly { jockeyId: string; years: readonly JockeyYearRecord[]; fetchedAtMs: number }[] }> = [];
  failLoad = false;
  failSave = false;
  put(kind: RaceIdVenueKind, jockeyId: string, years: readonly JockeyYearRecord[], fetchedAtMs: number): void {
    this.entries.set(`${kind}:${jockeyId}`, { fetchedAtMs, years });
  }
  async loadMany(ids: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredJockeyResults>> {
    this.loads.push({ ids, kind });
    if (this.failLoad) throw new Error("D1 を読めません");
    const out = new Map<string, StoredJockeyResults>();
    for (const id of ids) {
      const hit = this.entries.get(`${kind}:${id}`);
      if (hit !== undefined) out.set(id, hit);
    }
    return out;
  }
  async saveMany(
    kind: RaceIdVenueKind,
    entries: readonly { jockeyId: string; years: readonly JockeyYearRecord[]; fetchedAtMs: number }[],
  ): Promise<void> {
    this.saves.push({ kind, entries });
    if (this.failSave) throw new Error("D1 に書けません");
    for (const e of entries) this.put(kind, e.jockeyId, e.years, e.fetchedAtMs);
  }
}

const NOW_MS = Date.parse("2026-06-28T06:00:00.000Z");
const FIXED_NOW = () => new Date(NOW_MS);
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const RACE_ID = parseRaceId("202603020211");
const SHUTUBA = loadFixture("shutuba_202603020211.html");
const PAGE_01170 = loadFixture("jockey_results_01170.html");
const PAGE_OTHER = loadFixture("jockey_results_01220.html");
const YEARS_01170 = parseJockeyResults(PAGE_01170);
const YEARS_OTHER = parseJockeyResults(PAGE_OTHER);

const JOCKEY_IDS = [
  "01043", "01075", "01077", "01092", "01122", "01126", "01127", "01150",
  "01160", "01161", "01170", "01208", "01213", "05212", "05386", "05675",
];

function handler(url: string): string {
  if (url.includes("shutuba.html")) return SHUTUBA;
  if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
  if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
  if (url.includes("type=5")) return loadFixture("odds_wide_202603020211.json");
  if (url.includes("type=7")) return loadFixture("odds_trio_202603020211.json");
  if (url.includes("type=4")) return loadFixture("odds_quinella_202603020211.json");
  if (url.includes("type=6")) return loadFixture("odds_exacta_202603020211.json");
  if (url.includes("type=8")) return loadFixture("odds_trifecta_202603020211.json");
  if (url.includes("type=3")) return loadFixture("odds_wakuren_202603020211.json");
  if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
  if (url.includes("/jockey/result.html")) return url.includes("id=01170") ? PAGE_01170 : PAGE_OTHER;
  throw new Error(`未知のURL: ${url}`);
}

const yearsOf = (id: string): readonly JockeyYearRecord[] => (id === "01170" ? YEARS_01170 : YEARS_OTHER);
const fillStore = (store: MemoryStore, fetchedAtMs: number, ids: readonly string[] = JOCKEY_IDS): void => {
  for (const id of ids) store.put("central", id, yearsOf(id), fetchedAtMs);
};

describe("保存先から読む(週 1 回の更新)", () => {
  it("既定の許容鮮度は 7 日", () => {
    expect(DEFAULT_JOCKEY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("保存先が空: 16 人を netkeiba から取得し、まとめて 1 回で保存する(取得日時は取得の時刻)。読みも 1 回(騎手 ID をまとめて)", async () => {
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(16);
    expect(store.loads).toHaveLength(1);
    expect([...store.loads[0]!.ids].sort()).toEqual(JOCKEY_IDS);
    expect(store.loads[0]!.kind).toBe("central");
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.kind).toBe("central");
    expect(store.saves[0]!.entries).toHaveLength(16);
    expect(store.saves[0]!.entries.every((e) => e.fetchedAtMs === NOW_MS)).toBe(true);
    const saved01170 = store.saves[0]!.entries.find((e) => e.jockeyId === "01170")!;
    expect(saved01170.years).toEqual(YEARS_01170);
    expect(data.jockeyStats!["01170"]).toEqual(YEARS_01170);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
  });

  it("全員が 7 日以内に保存済み: netkeiba の騎手のURLは 0 本で、保存先の値を使い、書き込みもしない", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - (WEEK - DAY)); // 6 日前
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(19); // 既存の 19 本(出馬表 1・戦績 16・調教 1・オッズ 1)だけ
    expect(store.saves).toHaveLength(0);
    expect(data.jockeyStats!["01170"]).toEqual(YEARS_01170);
    expect(data.jockeyStats!["01043"]).toEqual(YEARS_OTHER);
    expect(data.jockeyStats!["01170"]).not.toEqual(data.jockeyStats!["01043"]); // 騎手の取り違えを検出できる前提
  });

  it("境界: ちょうど 7 日前は新しい(取得しない)・7 日と 1 ミリ秒前は古い(取り直して保存し直す)", async () => {
    const exactly = new MemoryStore();
    fillStore(exactly, NOW_MS - WEEK);
    const f1 = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher: f1, now: FIXED_NOW, jockeyStore: exactly }, { includeJockeyStats: true });
    expect(f1.jockeyCalls).toHaveLength(0);

    const over = new MemoryStore();
    fillStore(over, NOW_MS - WEEK - 1);
    const f2 = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher: f2, now: FIXED_NOW, jockeyStore: over }, { includeJockeyStats: true });
    expect(f2.jockeyCalls).toHaveLength(16);
    expect(over.saves).toHaveLength(1);
    expect(over.saves[0]!.entries.every((e) => e.fetchedAtMs === NOW_MS)).toBe(true);
    expect(over.entries.get("central:01170")!.fetchedAtMs).toBe(NOW_MS); // 保存先が新しい取得日時に更新された
  });

  it("新しい人と古い人が混ざる: 古い人・無い人だけを取得し、その人だけを保存する", async () => {
    const store = new MemoryStore();
    const fresh = JOCKEY_IDS.slice(0, 10);
    const stale = JOCKEY_IDS.slice(10, 13); // 8 日前
    fillStore(store, NOW_MS - DAY, fresh);
    fillStore(store, NOW_MS - 8 * DAY, stale);
    // 残り 3 人(JOCKEY_IDS[13..15])は保存先に無い。
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(fetcher.jockeyCalls.map((u) => /id=(\w+)/.exec(u)![1]).sort()).toEqual(JOCKEY_IDS.slice(10).sort());
    expect(store.saves[0]!.entries.map((e) => e.jockeyId).sort()).toEqual(JOCKEY_IDS.slice(10).sort());
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
  });

  it("許容鮮度を実質無期限にすると(計算ステップ用)、1 年前の保存でも使う", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - 365 * DAY);
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(
      RACE_ID,
      { fetcher, now: FIXED_NOW, jockeyStore: store, ttl: { jockeyMs: Number.MAX_SAFE_INTEGER } },
      { includeJockeyStats: true },
    );
    expect(fetcher.jockeyCalls).toHaveLength(0);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
  });

  it("地方のレースは kind=nar で読み書きし、取得のURLは &syusai=20", async () => {
    const narHandler = (url: string): string => {
      if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      if (url.includes("/jockey/result.html")) return loadFixture("nar_jockey_results_05496.html");
      throw new Error(`未知のURL: ${url}`);
    };
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(narHandler);
    await scrapeRace(parseRaceId("202654071210"), { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(store.loads[0]!.kind).toBe("nar");
    expect(store.saves[0]!.kind).toBe("nar");
    expect(fetcher.jockeyCalls.length).toBeGreaterThan(0);
    expect(fetcher.jockeyCalls.every((u) => u.endsWith("&syusai=20"))).toBe(true);
  });

  it("includeJockeyStats が false なら、保存先にも触れない(読みも書きもしない)", async () => {
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store });
    expect(store.loads).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect("jockeyStats" in data).toBe(false);
  });
});

describe("保存先の失敗は取得にフォールバックする(分析は止めない)", () => {
  it("読み出しに失敗: 投げず、16 人を netkeiba から取得して使い、警告(種別=騎手)を 1 件残す。取得できたぶんは保存を試みる", async () => {
    const store = new MemoryStore();
    store.failLoad = true;
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(16);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
    const warns = data.meta.warnings.filter((w) => w.kind === "騎手");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("読めなかった");
    expect(warns[0]!.message).toContain("D1 を読めません");
    expect(store.saves).toHaveLength(1);
  });

  it("書き込みに失敗: 投げず、取得した成績はそのまま使い、警告(種別=騎手)を 1 件残す", async () => {
    const store = new MemoryStore();
    store.failSave = true;
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
    const warns = data.meta.warnings.filter((w) => w.kind === "騎手");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("保存できなかった");
    expect(warns[0]!.message).toContain("D1 に書けません");
  });

  it("読み書きの両方が失敗しても、netkeiba の取得で分析に必要な成績は揃う(警告は 2 件)", async () => {
    const store = new MemoryStore();
    store.failLoad = true;
    store.failSave = true;
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true });
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toHaveLength(2);
  });
});

describe("1 回の取得の fetcher 呼び出しの上限(サブリクエストの保険)", () => {
  it("既定の上限は 40", () => {
    expect(DEFAULT_JOCKEY_REQUEST_LIMIT).toBe(40);
  });

  it("上限に届いたら残りの騎手は取らず、警告を 1 件(取らなかった人数入り)残して補正なしで続行する。上限の分は取得する", async () => {
    // 騎手以外の呼び出しは 19 本(出馬表 1・戦績 16・調教 1・オッズ 1)。上限 30 なら騎手は 11 人まで。
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true, jockeyRequestLimit: 30 });
    expect(fetcher.calls).toHaveLength(30);
    expect(fetcher.jockeyCalls).toHaveLength(11);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(11);
    const warns = data.meta.warnings.filter((w) => w.kind === "騎手");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("5 人");
    expect(warns[0]!.message).toContain("30");
    expect(warns[0]!.message).toContain("補正なし");
    expect(warns[0]!.jockeyId).toBeUndefined();
  });

  it("取らなかったのは出馬表の後ろの騎手(前から順に取る)", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true, jockeyRequestLimit: 30 });
    const orderedIds = data.horses.map((h) => h.shutuba.jockeyId!);
    expect(Object.keys(data.jockeyStats!).sort()).toEqual(orderedIds.slice(0, 11).sort());
  });

  it("保存先から読んだ騎手は呼び出しに数えない: 8 人が保存済みなら、残り 8 人は上限 30 でも全員取得できる(警告なし)", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - DAY, JOCKEY_IDS.slice(0, 8));
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true, jockeyRequestLimit: 30 });
    expect(fetcher.calls).toHaveLength(19 + 8);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(16);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toEqual([]);
  });

  it("上限が騎手より前の取得で既に埋まっていれば、騎手は 1 人も取らない(保存済みの人は使う)", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - DAY, JOCKEY_IDS.slice(0, 4));
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore: store }, { includeJockeyStats: true, jockeyRequestLimit: 19 });
    expect(fetcher.jockeyCalls).toHaveLength(0);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(4);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")[0]!.message).toContain("12 人");
  });

  it("既定の上限 40 で、中央 16 頭・組合せ ON・冷えた状態(騎手以外が 25 本)は、騎手を 15 人まで取る(合計 40 本)。1 人は取らない", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true, includeComboOdds: true });
    expect(fetcher.calls.filter((c) => !c.url.includes("/jockey/result.html"))).toHaveLength(25); // 比較の前提(出馬表 1・戦績 16・調教 1・オッズ 1・組合せ 6)
    expect(fetcher.jockeyCalls).toHaveLength(15);
    expect(fetcher.calls).toHaveLength(40);
    expect(Object.keys(data.jockeyStats!)).toHaveLength(15);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")[0]!.message).toContain("1 人");
  });

  it("includeJockeyStats が false なら、上限の影響を受けない(従来の本数)", async () => {
    const fetcher = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { jockeyRequestLimit: 1 });
    expect(fetcher.calls).toHaveLength(19);
  });
});

describe("騎手を足す前の本数の式(docs の根拠): 中央 N+9(組合せ ON)・地方 2N+4(組合せ ON。三連単は取らない)", () => {
  it("地方 12 頭・組合せ ON: 騎手以外の呼び出しは 2N+4 = 28 本。騎手 12 人を足して合計 40 本(上限ちょうど)で、警告なし", async () => {
    const narHandler = (url: string): string => {
      if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
      if (url.includes("type=b3")) return loadFixture("nar_odds_b3_202654071210.html");
      if (url.includes("type=b4")) return loadFixture("nar_odds_b4_202654071210.html");
      if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
      if (url.includes("type=b6")) return loadFixture("nar_odds_b6_202654071210.html");
      if (url.includes("type=b7")) return loadFixture("nar_odds_b7_jiku1_202654071210.html");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      if (url.includes("/jockey/result.html")) return loadFixture("nar_jockey_results_05496.html");
      throw new Error(`未知のURL(NAR): ${url}`);
    };
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(
      parseRaceId("202654071210"),
      { fetcher, now: FIXED_NOW },
      { includeJockeyStats: true, includeComboOdds: true },
    );
    const n = data.horses.length;
    expect(n).toBe(12);
    expect(fetcher.calls.filter((c) => !c.url.includes("/jockey/result.html"))).toHaveLength(2 * n + 4);
    expect(fetcher.jockeyCalls).toHaveLength(12);
    expect(fetcher.calls).toHaveLength(40);
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toEqual([]);
  });

  it("中央 16 頭・組合せ ON: 騎手以外の呼び出しは N+9 = 25 本", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeComboOdds: true });
    expect(fetcher.calls).toHaveLength(data.horses.length + 9);
  });
});
