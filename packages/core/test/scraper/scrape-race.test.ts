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
  listNarRaces,
  listRaces,
  scrapeRace,
  type RaceFetcher,
} from "../../src/scraper/scrape-race.js";
import { buildComboCandidates } from "../../src/ev/combo-bet-allocation.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";
import { narTrioOddsAxisUrl } from "../../src/scraper/urls.js";

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

/** テストで使う地方(NAR)レース(高知10R・終了後・12頭)。 */
const NAR_RACE_ID = parseRaceId("202654071210");

/** URL種別ごとに対応する地方(NAR)フィクスチャ。 */
const NAR_FIXTURES = {
  shutuba: loadFixture("nar_shutuba_202654071210.html"),
  odds: loadFixture("nar_odds_b1_202654071210.html"),
  // 戦績は「NARドメイン経由の通常フローが動くこと」の確認が目的で、馬IDごとの内容一致は
  // 検証しないため、全馬に同一の実フィクスチャを返す(既存 resultsFallback と同じ考え方)。
  results: loadFixture("horse_results_2021104387.json"),
  raceList: loadFixture("nar_race_list_sub_20260712.html"),
};

/** 地方(NAR)フィクスチャを返す既定ハンドラ。 */
function narHandler(url: string): string {
  if (url.includes("shutuba.html")) return NAR_FIXTURES.shutuba;
  if (url.includes("ajax_horse_results")) return NAR_FIXTURES.results;
  if (url.includes("odds/index.html")) return NAR_FIXTURES.odds;
  if (url.includes("race_list_sub")) return NAR_FIXTURES.raceList;
  throw new Error(`未知のURL(NARテスト): ${url}`);
}

describe("scrapeRace(地方(NAR)対応)", () => {
  it("oikiriを取得試行せず、警告も出さずに全馬oikiri:nullで返すこと(NAR対象外)", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(NAR_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(12);
    expect(data.horses.every((h) => h.oikiri === null)).toBe(true);
    expect(data.meta.warnings.filter((w) => w.kind === "調教")).toEqual([]);
    // oikiriページへの取得試行そのものが無いこと(警告でもなく単に対象外)。
    expect(
      fetcher.calls.some((c) => c.url.includes("oikiri.html")),
    ).toBe(false);
  });

  it("オッズはnarOddsPageUrl(type=b1)経由でparseNarOddsを使い取得できること", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(NAR_RACE_ID, { fetcher, now: FIXED_NOW });

    // NARページ単体では確定判別できないため middle 相当として正規化される。
    expect(data.odds.oddsStatus).toBe("middle");
    expect(Object.keys(data.odds.win)).toHaveLength(12);
    expect(data.odds.win[1]).toEqual({ odds: 24.8, ninki: null });
    expect(data.odds.place[1]).toEqual({
      oddsMin: 6.8,
      oddsMax: 8.5,
      ninki: null,
    });
    // 中央用JSON APIは呼ばれないこと。
    expect(
      fetcher.calls.some((c) => c.url.includes("api_get_jra_odds")),
    ).toBe(false);
    expect(fetcher.callFor("odds/index.html").url).toContain("type=b1");
  });

  it("出馬表・戦績はNAR/dbドメイン経由の通常フローのまま取得できること", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const data = await scrapeRace(NAR_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.race.courseType).toBe("ダ");
    expect(data.race.distance).toBe(1400);
    expect(fetcher.callFor("shutuba.html").url).toContain(
      "nar.netkeiba.com",
    );
    expect(fetcher.callFor("ajax_horse_results").url).toContain(
      "db.netkeiba.com",
    );
    expect(data.horses.every((h) => h.results !== null)).toBe(true);
    // 戦績・オッズとも正常なので、oikiri対象外以外の警告は出ない。
    expect(data.meta.warnings).toEqual([]);
  });
});

describe("listNarRaces(地方の開催日→レース一覧)", () => {
  it("narRaceListSubUrl(nar.netkeiba.com)経由で取得し、ばんえいを除いた一覧を返すこと", async () => {
    const fetcher = new RecordingFetcher(narHandler);
    const entries = await listNarRaces(parseKaisaiDate("20260712"), {
      fetcher,
    });
    // フィクスチャは4場44レース中、帯広(ばんえい・場コード65)12レースを除く32レース。
    expect(entries).toHaveLength(32);
    expect(fetcher.callFor("race_list_sub").url).toContain(
      "nar.netkeiba.com",
    );
  });
});

/**
 * 組合せオッズ(ワイド・3連複)のオプトイン配線(機能D-2b-B・Issue #33第4段)のテスト。
 *
 * `defaultHandler`/`narHandler`は未知のURLでthrowするため、既存のdescribeブロックを
 * 1行も変更せずに全緑のままであること自体が「既定呼び出しでURL列が現行と1件も変わらない」
 * (AC4)ことの間接証拠になる。本ブロックはそれに加えて明示的な回帰ピンを立てる。
 */
describe("scrapeRace(組合せオッズのオプトイン配線。機能D-2b-B・Issue #33第4段)", () => {
  it("デフォルト(includeComboOdds未指定)ではwideCombo/trioComboを含まず、comboOddsも設定されないこと", async () => {
    const fetcher = new RecordingFetcher(defaultHandler);
    const data = await scrapeRace(RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.odds.wideCombo).toBeUndefined();
    expect(data.odds.trioCombo).toBeUndefined();
    expect(data.meta.comboOdds).toBeUndefined();
    // 組合せオッズ関連のURL(type=5/type=7/odds_get_form.html)への発行が1件も無いこと。
    expect(
      fetcher.calls.some(
        (c) =>
          c.url.includes("type=5") ||
          c.url.includes("type=7") ||
          c.url.includes("odds_get_form.html"),
      ),
    ).toBe(false);
  });

  describe("中央(includeComboOdds:true)", () => {
    /** 中央3連複・ワイドの実フィクスチャを追加で解決する既定ハンドラ(既存defaultHandlerを包む)。 */
    function comboAwareCentralHandler(url: string): string {
      if (url.includes("type=5")) return loadFixture("odds_wide_202603020211.json");
      if (url.includes("type=7")) return loadFixture("odds_trio_202603020211.json");
      return defaultHandler(url);
    }

    it("wideCombo/trioComboがRecordとして載り、JSON.stringifyを通しても値が消えないこと(Map化していないことの回帰テスト)", async () => {
      const fetcher = new RecordingFetcher(comboAwareCentralHandler);
      const data = await scrapeRace(
        RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      expect(data.odds.wideCombo).toBeDefined();
      expect(data.odds.trioCombo).toBeDefined();
      // Mapではない(plainオブジェクト)ことを直接確認する。
      expect(data.odds.wideCombo instanceof Map).toBe(false);
      expect(data.odds.trioCombo instanceof Map).toBe(false);
      expect(Object.keys(data.odds.wideCombo!)).toHaveLength(120); // C(16,2)、実測(urls.ts JSDoc)
      expect(Object.keys(data.odds.trioCombo!)).toHaveLength(560); // C(16,3)、実測

      // JSON.stringify→JSON.parseを通しても中身が消えないこと。Mapを載せていたら
      // JSON.stringify(new Map(...))は"{}"になり、roundTrip後は0件になる(この回帰を検知する)。
      const roundTripped = JSON.parse(JSON.stringify(data.odds)) as {
        wideCombo: Record<string, number | null>;
        trioCombo: Record<string, number | null>;
      };
      expect(Object.keys(roundTripped.wideCombo)).toHaveLength(120);
      expect(Object.keys(roundTripped.trioCombo)).toHaveLength(560);

      // 診断値が取り出せること(第3段ComboOddsFetchDiagnosticsの受け渡し)。
      expect(data.meta.comboOdds?.wide?.state).toBe("available");
      expect(data.meta.comboOdds?.trio?.state).toBe("available");
      expect(data.meta.comboOdds?.wide?.diagnostics.requestCount).toBe(1);
      expect(data.meta.comboOdds?.trio?.diagnostics.requestCount).toBe(1);
      expect(data.meta.comboOdds?.wide?.diagnostics.obtainedComboCount).toBe(120);
      expect(data.meta.comboOdds?.trio?.diagnostics.obtainedComboCount).toBe(560);

      // 全件取得できているため、組合せオッズに関する警告は出ないこと。
      expect(data.meta.warnings.filter((w) => w.kind === "組合せオッズ")).toEqual([]);
    });

    it("未発売(unavailable)では警告0件・stateが\"unavailable\"であること", async () => {
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=5")) {
          return loadFixture("odds_wide_presale_202604020511_20260806.json");
        }
        if (url.includes("type=7")) {
          return loadFixture("odds_trio_presale_202604020511_20260806.json");
        }
        return defaultHandler(url);
      });
      const data = await scrapeRace(
        RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      expect(data.meta.comboOdds?.wide?.state).toBe("unavailable");
      expect(data.meta.comboOdds?.trio?.state).toBe("unavailable");
      expect(data.odds.wideCombo).toEqual({});
      expect(data.odds.trioCombo).toEqual({});
      expect(data.meta.warnings.filter((w) => w.kind === "組合せオッズ")).toEqual([]);
    });

    it("trioComboをtoComboOddsScalarMap相当の橋渡しでbuildComboCandidates(#14)にそのまま渡せること(end-to-end)", async () => {
      const fetcher = new RecordingFetcher(comboAwareCentralHandler);
      const data = await scrapeRace(
        RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      const oddsByKey = new Map(Object.entries(data.odds.trioCombo!));
      const horses: JointModelHorse[] = data.horses.map((h) => ({
        umaban: h.shutuba.umaban,
        placeProb: 0.3, // 橋渡しの型・値検証が目的でありEV値そのものの妥当性は検証しない
      }));
      const result = buildComboCandidates(horses, 3, 3, oddsByKey);

      expect(result.diagnostics.enumeratedCount).toBe(560); // C(16,3)
      // スカラー変換された値は常に正の有限値かnullのいずれかであり、malformed(不正値)にならないこと。
      expect(result.diagnostics.unjudged.oddsMalformedCount).toBe(0);
      const total =
        result.diagnostics.judged.positiveCount +
        result.diagnostics.judged.notPositiveCount +
        result.diagnostics.unjudged.oddsMissingCount +
        result.diagnostics.unjudged.oddsUnfetchedCount +
        result.diagnostics.unjudged.oddsMalformedCount;
      expect(total).toBe(560);
    });
  });

  describe("地方(NAR)3連複の軸走査(includeComboOdds:true)", () => {
    /** 最小限の合成NAR3連複オッズHTML(fetch-combo-odds.test.tsと同じ流儀)。 */
    function narTrioHtml(
      entries: ReadonlyArray<readonly [number, number, number, string]>,
    ): string {
      const cells = entries
        .map(
          ([a, b, c, value]) =>
            `<tr><td class="Odds" id="chk_x_b7_c0_${a}_${b}_${c}">${value}</td></tr>`,
        )
        .join("");
      return `<div id="odds_view_form"><table class="Odds_Table">${cells}</table></div>`;
    }

    /** 発売前などで組合せセルが1件も無い(構造は正当な)合成NARオッズHTML。 */
    const NAR_UNAVAILABLE_HTML = `<div id="odds_view_form"></div>`;

    it("全軸unavailable(首尾一貫して未発売/発売なし)→ 警告0件であること", async () => {
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return NAR_UNAVAILABLE_HTML;
        if (url.includes("odds_get_form.html")) return NAR_UNAVAILABLE_HTML;
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      expect(data.meta.comboOdds?.wide?.state).toBe("unavailable");
      expect(data.meta.comboOdds?.trio?.state).toBe("unavailable");
      expect(data.meta.warnings.filter((w) => w.kind === "組合せオッズ")).toEqual([]);
    });

    it("一部の軸だけHTTP失敗(部分被覆)→ 警告あり。失敗軸にしか属さない組がtrioComboに存在しないこと(第3段AC-5bのend-to-end確認)", async () => {
      // 出走12頭→軸は[1..10]。軸9だけHTTP失敗させる。他の軸kは{k,11,12}という
      // 軸kにしか属さない組を1件だけ返す(11・12は軸集合に含まれない上位2頭)。
      // {9,11,12}は軸9にしか属さないため、軸9の失敗でこの1件だけが丸ごと欠落するはず。
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
        const jikuMatch = /[?&]jiku=(\d+)/.exec(url);
        if (jikuMatch) {
          const axis = Number(jikuMatch[1]);
          if (axis === 9) throw new Error("軸9のHTTP取得に失敗した(模擬)");
          return narTrioHtml([[axis, 11, 12, "10.0"]]);
        }
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      expect(data.meta.comboOdds?.trio?.state).toBe("available"); // 部分被覆でもavailable
      expect(data.meta.comboOdds?.trio?.diagnostics.axisUmabans).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]); // 前提固定(12頭→軸10件)
      // 軸1..8,10の9軸が成功し、それぞれ1件ずつ({k,11,12})を返すため9件になる。
      expect(Object.keys(data.odds.trioCombo!)).toHaveLength(9);
      const key9_11_12 = [9, 11, 12].map((n) => String(n).padStart(2, "0")).join("");
      expect(Object.prototype.hasOwnProperty.call(data.odds.trioCombo!, key9_11_12)).toBe(
        false,
      ); // AC-5b: 値nullで存在するのではなくキーごと不在
      expect(data.meta.warnings.filter((w) => w.kind === "組合せオッズ").length).toBeGreaterThan(
        0,
      );
    });

    it("全軸HTTP失敗 → 警告あり、state=\"failed\"であること(\"unavailable\"と区別できる)", async () => {
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
        if (url.includes("odds_get_form.html")) throw new Error("軸取得に全滅した(模擬)");
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      expect(data.meta.comboOdds?.trio?.state).toBe("failed");
      expect(data.odds.trioCombo).toEqual({});
      const comboWarnings = data.meta.warnings.filter((w) => w.kind === "組合せオッズ");
      expect(comboWarnings.length).toBeGreaterThan(0);
      // "unavailable"ケース(前テスト)とは異なり、"failed"を示す文言を含むこと。
      expect(comboWarnings.some((w) => w.message.includes("失敗"))).toBe(true);
    });

    it('一部の軸がunavailable・一部がHTTP失敗の混在(取得0件)→ 警告あり、state="failed"であること(code-reviewer指摘2)', async () => {
      // 出走12頭→軸は[1..10]。軸1〜5はunavailable(市場が首尾一貫して未発売/発売なしに
      // 見える)、軸6〜10はHTTP失敗とする。取得できた組合せは0件だが、②③(市場が無い)と
      // ④(取得できず分からない)の混同を防ぐのが本関数の核心(AC7b)であり、この混在は
      // "unavailable"に丸めてはならず"failed"になる必要がある。
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
        const jikuMatch = /[?&]jiku=(\d+)/.exec(url);
        if (jikuMatch) {
          const axis = Number(jikuMatch[1]);
          if (axis <= 5) return NAR_UNAVAILABLE_HTML;
          throw new Error(`軸${axis}のHTTP取得に失敗した(模擬)`);
        }
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      // 前提固定(空振り防止): 混在の内訳そのものを先に固定する。
      const trioAttempts = data.meta.comboOdds?.trio?.diagnostics.attempts ?? [];
      expect(trioAttempts.filter((a) => a.state === "unavailable").length).toBe(5);
      expect(trioAttempts.filter((a) => a.state === "fetchFailed").length).toBe(5);
      expect(data.odds.trioCombo).toEqual({});

      expect(data.meta.comboOdds?.trio?.state).toBe("failed"); // "unavailable"に丸めない
      const comboWarnings = data.meta.warnings.filter((w) => w.kind === "組合せオッズ");
      expect(comboWarnings.length).toBeGreaterThan(0);
    });

    it("構造異常(parseError)が1件でもあれば、警告メッセージに構造異常件数が明示されること(boss指摘・要修正3。message文字列だけがユーザーに届く唯一のチャネルであるため)", async () => {
      // 出走12頭→軸は[1..10]。軸1は構造異常(#odds_select・#odds_view_formのいずれも
      // 持たない)でparseErrorになる。軸2〜10はunavailable。
      const malformedHtml = `<html><body>no markers here</body></html>`;
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
        const jikuMatch = /[?&]jiku=(\d+)/.exec(url);
        if (jikuMatch) {
          const axis = Number(jikuMatch[1]);
          if (axis === 1) return malformedHtml;
          return NAR_UNAVAILABLE_HTML;
        }
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      // 前提固定(空振り防止): 内訳そのものを先に固定する。
      const trioAttempts = data.meta.comboOdds?.trio?.diagnostics.attempts ?? [];
      expect(trioAttempts.filter((a) => a.state === "parseError").length).toBe(1);
      expect(trioAttempts.filter((a) => a.state === "unavailable").length).toBe(9);
      expect(data.meta.comboOdds?.trio?.state).toBe("failed"); // ②③に丸めない(AC7b)

      const trioWarning = data.meta.warnings.find(
        (w) => w.kind === "組合せオッズ" && w.message.includes("3連複"),
      );
      expect(trioWarning).toBeDefined();
      // 「取得に失敗しました」という④一般の文言だけに丸めず、構造異常であることが
      // メッセージ文字列自体から読み取れること(kindも診断値も落とすUI側の唯一のチャネル)。
      expect(trioWarning!.message.includes("構造異常")).toBe(true);
      expect(trioWarning!.message.includes("構造異常1件")).toBe(true);
    });

    it("値がnull(missing)の組はtrioComboにキーごと存在し、失敗軸由来の組(unfetched)はキーごと不在であること。JSON往復後も両方向とも保たれること(code-reviewer/boss指摘・要修正1)", async () => {
      // n=5相当の縮小シナリオ(軸=[1,2,3])。{1,2,4}は軸1・軸2とも値が確定していない
      // (NAR側の非数値表示"---.-"→oddsMin=null。missing)。軸3はHTTP失敗させ、
      // 軸3にしか属さない{3,4,5}は取得自体していない(unfetched)。
      //
      // NAR_RACE_ID自体は12頭のレースだが、本テストは軸1・2・3のみを制御し、
      // 残りの軸(4〜10)はunavailableを返す(全体のstate判定には影響しない。
      // 軸1・2がavailableのため"available"になる)。
      const axis1Html = narTrioHtml([
        [1, 2, 3, "10.0"],
        [1, 2, 4, "---.-"], // missing(値null)
        [1, 3, 4, "13.0"],
        [1, 3, 5, "14.0"],
        [1, 4, 5, "15.0"],
      ]);
      const axis2Html = narTrioHtml([
        [1, 2, 3, "10.0"],
        [1, 2, 4, "---.-"], // 軸1と同じnull(衝突ではなく完全同値)
        [2, 3, 4, "16.0"],
        [2, 3, 5, "17.0"],
        [2, 4, 5, "18.0"],
      ]);
      const fetcher = new RecordingFetcher((url) => {
        if (url.includes("type=b5")) return loadFixture("nar_odds_b5_202654071210.html");
        if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 1)) return axis1Html;
        if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return axis2Html;
        const jikuMatch = /[?&]jiku=(\d+)/.exec(url);
        if (jikuMatch) {
          const axis = Number(jikuMatch[1]);
          if (axis === 3) throw new Error("軸3のHTTP取得に失敗した(模擬)");
          return NAR_UNAVAILABLE_HTML; // 軸4〜10
        }
        return narHandler(url);
      });
      const data = await scrapeRace(
        NAR_RACE_ID,
        { fetcher, now: FIXED_NOW },
        { includeComboOdds: true },
      );

      const key124 = [1, 2, 4].map((n) => String(n).padStart(2, "0")).join("");
      const key345 = [3, 4, 5].map((n) => String(n).padStart(2, "0")).join("");

      // (1) missing: キーは存在し、値はnullであること。
      expect(Object.prototype.hasOwnProperty.call(data.odds.trioCombo!, key124)).toBe(true);
      expect(data.odds.trioCombo![key124]).toBeNull();
      // (3) unfetched: 失敗軸(軸3)にしか属さない組はキーごと不在であること。
      expect(Object.prototype.hasOwnProperty.call(data.odds.trioCombo!, key345)).toBe(false);

      // (2) JSON.stringify→JSON.parse往復後も、両方向とも保たれていること
      // (nullを黙って落とす退化〈#29永続化で最も出やすい「掃除」の形〉を検知する)。
      const roundTripped = JSON.parse(JSON.stringify(data.odds)) as {
        trioCombo: Record<string, number | null>;
      };
      expect(Object.prototype.hasOwnProperty.call(roundTripped.trioCombo, key124)).toBe(true);
      expect(roundTripped.trioCombo[key124]).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(roundTripped.trioCombo, key345)).toBe(false);
    });
  });
});
