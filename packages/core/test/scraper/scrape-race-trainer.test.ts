import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import type { RaceIdVenueKind } from "../../src/scraper/ids.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseJockeyResults, type JockeyYearRecord } from "../../src/scraper/parse-jockey-results.js";
import {
  DEFAULT_TRAINER_TTL_MS,
  scrapeRace,
  type RaceFetcher,
} from "../../src/scraper/scrape-race.js";
import type { StoredTrainerResults, TrainerResultsStore } from "../../src/scraper/trainer-results-store.js";

/**
 * Issue #354: 調教師の年度別成績(`db.netkeiba.com/trainer/result.html?id=…`。表の形は騎手と同じで `parseJockeyResults` が読む)を、
 * 出走馬の調教師 ID で一意にして取得し、`RaceData.trainerStats` に載せる。流れは騎手(#226)と同じ:
 * 日をまたいで共有する保存先(`TrainerResultsStore`。クラウド版は D1)から先に読み、無い・古いものだけ取得し、取得したぶんをまとめて 1 回保存する。
 *
 * 騎手との違い:
 *  - 鮮度: 取得日時が**レースの年の 1 月 1 日(JST)以降**なら使う(年度別の前2年の行は確定値なので、年に 1 回の取得で足りる。7 日では切らない)。
 *  - 地方のレースは対象外(取得せず、保存先にも触れない。検証したのは中央だけ)。
 *  - fetcher の呼び出しの上限(`jockeyRequestLimit`。既定 40)は騎手と共有する(Free の 50 本に対する保険を増やさない)。
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
  get trainerCalls(): string[] {
    return this.calls.filter((c) => c.url.includes("/trainer/result.html")).map((c) => c.url);
  }
  get jockeyCalls(): string[] {
    return this.calls.filter((c) => c.url.includes("/jockey/result.html")).map((c) => c.url);
  }
}

interface SaveEntry {
  readonly trainerId: string;
  readonly years: readonly JockeyYearRecord[];
  readonly fetchedAtMs: number;
}

class MemoryStore implements TrainerResultsStore {
  readonly entries = new Map<string, StoredTrainerResults>();
  readonly loads: Array<{ ids: readonly string[]; kind: RaceIdVenueKind }> = [];
  readonly saves: Array<{ kind: RaceIdVenueKind; entries: readonly SaveEntry[] }> = [];
  failLoad = false;
  failSave = false;
  put(kind: RaceIdVenueKind, trainerId: string, years: readonly JockeyYearRecord[], fetchedAtMs: number): void {
    this.entries.set(`${kind}:${trainerId}`, { fetchedAtMs, years });
  }
  async loadMany(ids: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredTrainerResults>> {
    this.loads.push({ ids, kind });
    if (this.failLoad) throw new Error("D1 を読めません");
    const out = new Map<string, StoredTrainerResults>();
    for (const id of ids) {
      const hit = this.entries.get(`${kind}:${id}`);
      if (hit !== undefined) out.set(id, hit);
    }
    return out;
  }
  async saveMany(kind: RaceIdVenueKind, entries: readonly SaveEntry[]): Promise<void> {
    this.saves.push({ kind, entries });
    if (this.failSave) throw new Error("D1 に書けません");
    for (const e of entries) this.put(kind, e.trainerId, e.years, e.fetchedAtMs);
  }
}

const NOW_MS = Date.parse("2026-06-28T06:00:00.000Z");
const FIXED_NOW = () => new Date(NOW_MS);
const DAY = 24 * 60 * 60 * 1000;
/** 2026 年 1 月 1 日 00:00 JST(= 2025-12-31T15:00:00Z)。 */
const YEAR_START_2026_JST = Date.parse("2025-12-31T15:00:00.000Z");

const RACE_ID = parseRaceId("202603020211");
const SHUTUBA = loadFixture("shutuba_202603020211.html");
const PAGE_01126 = loadFixture("trainer_results_01126.html");
const PAGE_NEW = loadFixture("trainer_results_01213.html");
const YEARS_01126 = parseJockeyResults(PAGE_01126);
const YEARS_NEW = parseJockeyResults(PAGE_NEW);

/** 出馬表のフィクスチャ(16 頭)の調教師 ID(重複なし)。 */
const TRAINER_IDS = [
  "01051", "01070", "01071", "01079", "01080", "01084", "01086", "01087",
  "01092", "01105", "01124", "01126", "01141", "01175", "01185", "01205",
];

function handler(url: string): string {
  if (url.includes("shutuba.html")) return SHUTUBA;
  if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
  if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
  if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
  if (url.includes("/jockey/result.html")) return loadFixture("jockey_results_01220.html");
  if (url.includes("/trainer/result.html")) return url.includes("id=01126") ? PAGE_01126 : PAGE_NEW;
  throw new Error(`未知のURL: ${url}`);
}

const yearsOf = (id: string): readonly JockeyYearRecord[] => (id === "01126" ? YEARS_01126 : YEARS_NEW);
const fillStore = (store: MemoryStore, fetchedAtMs: number, ids: readonly string[] = TRAINER_IDS): void => {
  for (const id of ids) store.put("central", id, yearsOf(id), fetchedAtMs);
};
const OPTIONS = { includeTrainerStats: true } as const;

describe("前提(フィクスチャ)", () => {
  it("出馬表の調教師は 16 人(重複なし)で、2 つのページの年ごとの成績は異なる(取り違えを検出できる)", () => {
    const horses = [...SHUTUBA.matchAll(/trainer\/result\/recent\/([0-9a-zA-Z]+)/g)].map((m) => m[1]!);
    expect(horses.slice().sort()).toEqual(TRAINER_IDS);
    expect(YEARS_01126.length).toBeGreaterThan(1);
    expect(YEARS_01126).not.toEqual(YEARS_NEW);
    expect(YEARS_NEW.map((y) => y.year)).toEqual([2026]); // 新人: 窓(2024・2025)の行が無い
  });

  it("騎手と同じく、既定の許容鮮度(fetcher のキャッシュ)は 7 日", () => {
    expect(DEFAULT_TRAINER_TTL_MS).toBe(7 * DAY);
  });
});

describe("保存先から読む(年に 1 回の更新)", () => {
  it("保存先が空: 16 人を netkeiba から取得し(中央の URL・&syusai なし)、まとめて 1 回で保存する。読みも 1 回", async () => {
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(16);
    expect(fetcher.trainerCalls.every((u) => /^https:\/\/db\.netkeiba\.com\/trainer\/result\.html\?id=[0-9a-zA-Z]+$/.test(u))).toBe(true);
    expect(fetcher.calls.find((c) => c.url.includes("/trainer/result.html"))!.options).toEqual({ maxAgeMs: DEFAULT_TRAINER_TTL_MS });
    expect(store.loads).toHaveLength(1);
    expect([...store.loads[0]!.ids].sort()).toEqual(TRAINER_IDS);
    expect(store.loads[0]!.kind).toBe("central");
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.kind).toBe("central");
    expect(store.saves[0]!.entries).toHaveLength(16);
    expect(store.saves[0]!.entries.every((e) => e.fetchedAtMs === NOW_MS)).toBe(true);
    expect(store.saves[0]!.entries.find((e) => e.trainerId === "01126")!.years).toEqual(YEARS_01126);
    expect(data.trainerStats!["01126"]).toEqual(YEARS_01126);
    expect(data.trainerStats!["01051"]).toEqual(YEARS_NEW);
    expect(Object.keys(data.trainerStats!)).toHaveLength(16);
    expect("jockeyStats" in data).toBe(false); // 騎手は includeJockeyStats が別
  });

  it("今年(レースの年)に取得済み: 5 か月前でも使い、netkeiba の調教師のURLは 0 本・書き込みもしない(7 日では切らない)", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - 150 * DAY); // 2026-01-29 ごろ
    expect(NOW_MS - 150 * DAY).toBeGreaterThan(YEAR_START_2026_JST); // 前提: 今年の内
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(19); // 既存の 19 本だけ
    expect(store.saves).toHaveLength(0);
    expect(data.trainerStats!["01126"]).toEqual(YEARS_01126);
    expect(data.trainerStats!["01070"]).toEqual(YEARS_NEW);
  });

  it("境界: レースの年の 1 月 1 日 00:00 JST ちょうどは新しい(取得しない)・1 ミリ秒前は古い(取り直して保存し直す)", async () => {
    const exactly = new MemoryStore();
    fillStore(exactly, YEAR_START_2026_JST);
    const f1 = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher: f1, now: FIXED_NOW, trainerStore: exactly }, OPTIONS);
    expect(f1.trainerCalls).toHaveLength(0);

    const over = new MemoryStore();
    fillStore(over, YEAR_START_2026_JST - 1); // 2025 年の大晦日 23:59:59.999 JST に取得 → 2025 年の行が途中までの可能性
    const f2 = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher: f2, now: FIXED_NOW, trainerStore: over }, OPTIONS);
    expect(f2.trainerCalls).toHaveLength(16);
    expect(over.saves).toHaveLength(1);
    expect(over.entries.get("central:01126")!.fetchedAtMs).toBe(NOW_MS);
  });

  it("去年に取得した記録は古い(1 年前でも、今年の 1 月 1 日より前なら取り直す)", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - 365 * DAY);
    const fetcher = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(16);
  });

  it("新しい人と古い人が混ざる: 古い人・無い人だけを取得し、その人だけを保存する", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - DAY, TRAINER_IDS.slice(0, 10));
    fillStore(store, YEAR_START_2026_JST - DAY, TRAINER_IDS.slice(10, 13)); // 古い
    // 残り 3 人は保存先に無い。
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls.map((u) => /id=(\w+)/.exec(u)![1]).sort()).toEqual(TRAINER_IDS.slice(10).sort());
    expect(store.saves[0]!.entries.map((e) => e.trainerId).sort()).toEqual(TRAINER_IDS.slice(10).sort());
    expect(Object.keys(data.trainerStats!)).toHaveLength(16);
  });

  it("実質無期限の許容鮮度(計算ステップ用の ttl.trainerMs)でも、年の規則は変わらない: 去年の記録は使わず、取得のキャッシュ(fetcher)から読む", async () => {
    const store = new MemoryStore();
    fillStore(store, NOW_MS - 365 * DAY);
    const fetcher = new RecordingFetcher(handler);
    await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store, ttl: { trainerMs: Number.MAX_SAFE_INTEGER } }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(16);
    expect(fetcher.calls.find((c) => c.url.includes("/trainer/result.html"))!.options).toEqual({ maxAgeMs: Number.MAX_SAFE_INTEGER });
  });

  it("保存先が無い構成でも動く(全員を取得して載せる。保存はしない)", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(16);
    expect(Object.keys(data.trainerStats!)).toHaveLength(16);
  });

  it("includeTrainerStats が false(既定)なら、保存先にも触れない・調教師のURLも出さない・trainerStats のキーも無い", async () => {
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store });
    expect(store.loads).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect(fetcher.trainerCalls).toHaveLength(0);
    expect("trainerStats" in data).toBe(false);
  });
});

describe("対象外・欠け", () => {
  it("地方のレースは対象外: 取得せず、保存先にも触れず、trainerStats のキーも無い(警告も出さない)", async () => {
    const narHandler = (url: string): string => {
      if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
      if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
      throw new Error(`未知のURL: ${url}`);
    };
    const store = new MemoryStore();
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(parseRaceId("202654071210"), { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(0);
    expect(store.loads).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect("trainerStats" in data).toBe(false);
    expect(data.meta.warnings.filter((w) => w.kind === "調教師")).toEqual([]);
  });

  it("調教師 ID の無い馬は取得せず、警告も出さない。同じ調教師の馬が複数いても 1 回だけ取る", async () => {
    // 01205 の馬の調教師リンクを外し(ID なし)、01185 の馬を 01126 に付け替える(01126 が 2 頭)。
    const edited = SHUTUBA.replace("trainer/result/recent/01205", "trainer/none/01205").replace("trainer/result/recent/01185", "trainer/result/recent/01126");
    expect(edited).not.toBe(SHUTUBA);
    const h = (url: string): string => (url.includes("shutuba.html") ? edited : handler(url));
    const fetcher = new RecordingFetcher(h);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(14); // 16 − (ID なし 1) − (重複 1)
    expect(fetcher.trainerCalls.filter((u) => u.includes("id=01126"))).toHaveLength(1);
    expect(Object.keys(data.trainerStats!)).toHaveLength(14);
    expect(data.meta.warnings.filter((w) => w.kind === "調教師")).toEqual([]);
  });

  it("1 人の取得に失敗: その人だけ載らず、警告(種別=調教師・trainerId 入り)が 1 件。ほかの人は載る", async () => {
    const h = (url: string): string => {
      if (url.includes("/trainer/result.html") && url.includes("id=01070")) throw new Error("HTTP 500");
      return handler(url);
    };
    const fetcher = new RecordingFetcher(h);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, OPTIONS);
    expect(Object.keys(data.trainerStats!)).toHaveLength(15);
    expect("01070" in data.trainerStats!).toBe(false);
    const warns = data.meta.warnings.filter((w) => w.kind === "調教師");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.trainerId).toBe("01070");
    expect(warns[0]!.message).toContain("HTTP 500");
  });

  it("壊れたページ(表が無い)は取得失敗と同じ扱い: その人だけ載らず警告 1 件。保存もしない", async () => {
    const store = new MemoryStore();
    const h = (url: string): string => (url.includes("/trainer/result.html") && url.includes("id=01070") ? "<html><body>メンテナンス中</body></html>" : handler(url));
    const data = await scrapeRace(RACE_ID, { fetcher: new RecordingFetcher(h), now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect("01070" in data.trainerStats!).toBe(false);
    expect(data.meta.warnings.filter((w) => w.kind === "調教師")).toHaveLength(1);
    expect(store.saves[0]!.entries.map((e) => e.trainerId)).not.toContain("01070");
    expect(store.saves[0]!.entries).toHaveLength(15);
  });
});

describe("保存先の失敗は取得にフォールバックする(分析は止めない)", () => {
  it("読み出しに失敗: 投げず、16 人を netkeiba から取得して使い、警告(種別=調教師)を 1 件残す。取得できたぶんは保存を試みる", async () => {
    const store = new MemoryStore();
    store.failLoad = true;
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(fetcher.trainerCalls).toHaveLength(16);
    const warns = data.meta.warnings.filter((w) => w.kind === "調教師");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("読めなかった");
    expect(warns[0]!.message).toContain("D1 を読めません");
    expect(store.saves).toHaveLength(1);
  });

  it("書き込みに失敗: 投げず、取得した成績はそのまま使い、警告(種別=調教師)を 1 件残す", async () => {
    const store = new MemoryStore();
    store.failSave = true;
    const data = await scrapeRace(RACE_ID, { fetcher: new RecordingFetcher(handler), now: FIXED_NOW, trainerStore: store }, OPTIONS);
    expect(Object.keys(data.trainerStats!)).toHaveLength(16);
    const warns = data.meta.warnings.filter((w) => w.kind === "調教師");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("保存できなかった");
    expect(warns[0]!.message).toContain("D1 に書けません");
  });
});

describe("fetcher 呼び出しの上限は騎手と共有する(合計 40 を超えない)", () => {
  it("騎手も調教師も ON・冷えた状態: 騎手以外 19 本 + 騎手 16 人 = 35 本のあと、調教師は 5 人まで取る(合計 40 本)。11 人は取らず、警告 1 件(人数・補正なし入り)", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeJockeyStats: true, includeTrainerStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(16);
    expect(fetcher.trainerCalls).toHaveLength(5);
    expect(fetcher.calls).toHaveLength(40);
    expect(Object.keys(data.trainerStats!)).toHaveLength(5);
    const warns = data.meta.warnings.filter((w) => w.kind === "調教師");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("11 人");
    expect(warns[0]!.message).toContain("40");
    expect(warns[0]!.message).toContain("補正なし");
    expect(warns[0]!.trainerId).toBeUndefined();
    expect(data.meta.warnings.filter((w) => w.kind === "騎手")).toEqual([]); // 騎手の側は全員取れている
  });

  it("騎手が保存先から読めれば、調教師の枠が増える: 騎手 16 人が保存済みなら調教師は 16 人全員(合計 19 + 16 = 35 本)取れる", async () => {
    const jockeyStore = {
      async loadMany(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, { fetchedAtMs: NOW_MS - DAY, years: [] as JockeyYearRecord[] }]));
      },
      async saveMany() {},
    };
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW, jockeyStore }, { includeJockeyStats: true, includeTrainerStats: true });
    expect(fetcher.jockeyCalls).toHaveLength(0);
    expect(fetcher.trainerCalls).toHaveLength(16);
    expect(fetcher.calls).toHaveLength(35);
    expect(data.meta.warnings.filter((w) => w.kind === "調教師")).toEqual([]);
  });

  it("includeJockeyStats が false でも、調教師は上限(騎手以外の呼び出しを含めた合計)に従う", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW }, { includeTrainerStats: true, jockeyRequestLimit: 30 });
    expect(fetcher.calls).toHaveLength(30);
    expect(fetcher.trainerCalls).toHaveLength(11);
    expect(Object.keys(data.trainerStats!)).toHaveLength(11);
    expect(data.meta.warnings.filter((w) => w.kind === "調教師")[0]!.message).toContain("5 人");
  });

  it("上限を実質無制限にする(計算ステップ)と、全員取れて警告も出ない", async () => {
    const fetcher = new RecordingFetcher(handler);
    const data = await scrapeRace(
      RACE_ID,
      { fetcher, now: FIXED_NOW },
      { includeJockeyStats: true, includeTrainerStats: true, jockeyRequestLimit: Number.MAX_SAFE_INTEGER },
    );
    expect(fetcher.trainerCalls).toHaveLength(16);
    expect(data.meta.warnings).toEqual([]);
  });
});
