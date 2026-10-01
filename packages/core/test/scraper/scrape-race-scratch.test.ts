import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";
import { scrapeRace, type RaceFetcher } from "../../src/scraper/scrape-race.js";
import { narTrioOddsAxisUrl } from "../../src/scraper/urls.js";

/**
 * Issue #154: 出馬表に残った取消・除外の馬を `scrapeRace` が出走馬から除くこと。
 *
 * 除く位置を `scrapeRace` の `parseShutuba` 直後(戦績取得の前)にした理由: 取消は分析日に依らない
 * 事実で、除くと (1)戦績の無駄な取得、(2)組合せオッズの期待組合せ数・枠連の枠構成、
 * (3)地方3連複の軸馬の導出 がまとめて正しくなる(いずれも `shutuba.horses` から作られるため)。
 *
 * 実物は中央 202606040901(発走後に取得)の1本だけ。発走前の印・地方の印・「除外」の文言は
 * 未観測で、同じ雛形・同じ印と見込んだ合成HTMLで検証している(各テスト名に「合成」と明記する)。
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
}

const FIXED_NOW = () => new Date("2026-09-27T01:00:00.000Z");

/** 取消馬(馬番6 ニシノドリーマー)の horse_id(`shutuba_202606040901.html` の実値)。 */
const SCRATCHED_HORSE_ID = "2024105198";

// ───────────── 中央: 実フィクスチャ(取消1・出走15) ─────────────

const CENTRAL_RACE_ID = parseRaceId("202606040901");
const CENTRAL_SHUTUBA = loadFixture("shutuba_202606040901.html");
const RESULTS_FIXTURE = loadFixture("horse_results_2021105857.json");

/**
 * 16頭ぶんの合成オッズJSON(中央API形式)。取消馬(馬番6)は実取得と同じく単勝・複勝とも
 * オッズ null・人気 9999 とする(`RaceData` で観測した値。raw の文字列表現は合成)。
 */
function centralOddsJson(): string {
  const win: Record<string, [string, string, string]> = {};
  const place: Record<string, [string, string, string]> = {};
  for (let n = 1; n <= 16; n++) {
    const key = String(n).padStart(2, "0");
    if (n === 6) {
      win[key] = ["---.-", "0.0", "9999"];
      place[key] = ["---.-", "---.-", "9999"];
    } else {
      win[key] = [`${5 + n}.0`, "0.0", String(n)];
      place[key] = ["2.0", "3.0", String(n)];
    }
  }
  return JSON.stringify({
    status: "result",
    data: { official_datetime: "2026-09-27 09:50:00", odds: { "1": win, "2": place } },
  });
}

function centralHandler(shutubaHtml: string): (url: string) => string {
  return (url) => {
    if (url.includes("shutuba.html")) return shutubaHtml;
    if (url.includes("ajax_horse_results")) return RESULTS_FIXTURE;
    if (url.includes("oikiri.html")) throw new Error("調教ページ(このテストでは使わない)");
    if (url.includes("api_get_jra_odds")) return centralOddsJson();
    throw new Error(`未知のURL: ${url}`);
  };
}

describe("scrapeRace: 取消・除外の馬を出走馬から除く(Issue #154・中央の実フィクスチャ)", () => {
  it("出馬表の実データ行は16(出走15+取消1)で、RaceData.horses は取消馬を除いた15頭になること", async () => {
    // 前提: パーサは16行を返す(取消馬を落とさない)。
    expect(parseShutuba(CENTRAL_SHUTUBA).horses).toHaveLength(16);
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(15);
    expect(data.horses.map((h) => h.shutuba.umaban)).toEqual([
      1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    // 残った馬は scratch を持たない(出走馬の型に取消の印は残さない)。
    expect(data.horses.some((h) => "scratch" in h.shutuba)).toBe(false);
  });

  it("取消馬の戦績は取得しないこと(リクエストが1頭ぶん減る)", async () => {
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    const resultCalls = fetcher.calls.filter((c) => c.url.includes("ajax_horse_results"));
    expect(resultCalls).toHaveLength(15);
    expect(resultCalls.some((c) => c.url.includes(SCRATCHED_HORSE_ID))).toBe(false);
  });

  it("除いた馬は meta.scratched に馬番・枠番・馬名・horse_id・区分・原文で残ること", async () => {
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.meta.scratched).toEqual([
      {
        umaban: 6,
        wakuban: 3,
        name: "ニシノドリーマー",
        horseId: SCRATCHED_HORSE_ID,
        status: "取消",
        text: "取消",
      },
    ]);
  });

  it("警告(kind=出走取消)が1件付き、馬番・馬名・区分・horseId を含むこと(画面の警告欄に出る)", async () => {
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    const warns = data.meta.warnings.filter((w) => w.kind === "出走取消");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.horseId).toBe(SCRATCHED_HORSE_ID);
    expect(warns[0]!.message).toContain("6番");
    expect(warns[0]!.message).toContain("ニシノドリーマー");
    expect(warns[0]!.message).toContain("取消");
    // 他の警告(戦績・調教)は、調教の取得失敗(このテストの handler が投げる)の1件だけ。
    expect(data.meta.warnings.filter((w) => w.kind !== "出走取消").map((w) => w.kind)).toEqual([
      "調教",
    ]);
  });

  it("単勝・複勝オッズ(RaceData.odds)には手を付けず、取消馬の欄(null/9999)がそのまま残ること", async () => {
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(Object.keys(data.odds.win)).toHaveLength(16);
    expect(data.odds.win[6]).toEqual({ odds: null, ninki: 9999 });
    expect(data.odds.place[6]!.oddsMin).toBeNull();
  });

  it("組合せオッズの期待組合せ数・枠連の枠構成は出走15頭から作られること(取消込みの16頭ならワイドC(16,2)=120・枠連36)", async () => {
    // 組合せオッズの応答の中身はここでは問わない(診断値の期待数だけを見る。取得の成否に依らず付く)。
    const fetcher = new RecordingFetcher(centralHandler(CENTRAL_SHUTUBA));
    const data = await scrapeRace(
      CENTRAL_RACE_ID,
      { fetcher, now: FIXED_NOW },
      { includeComboOdds: true },
    );
    const outcome = data.meta.comboOdds!;
    expect(outcome.wide!.diagnostics.expectedComboCount).toBe(105); // C(15,2)
    expect(outcome.trio!.diagnostics.expectedComboCount).toBe(455); // C(15,3)
    expect(outcome.exacta!.diagnostics.expectedComboCount).toBe(210); // P(15,2)
    expect(outcome.trifecta!.diagnostics.expectedComboCount).toBe(2730); // P(15,3)
    // 枠連: 馬番6は3枠(5・6番の2頭)。6番を除くと3枠は1頭になり、同枠の組が1つ減る(36 → 35)。
    expect(outcome.bracketQuinella!.diagnostics.expectedComboCount).toBe(35);
  });

  it("未知の文言(合成)でも出走しない側に倒して除き、警告に原文を載せること", async () => {
    const synthetic = CENTRAL_SHUTUBA.replace(
      `<td class="Cancel_Txt">取消</td>`,
      `<td class="Cancel_Txt">出走回避?</td>`,
    );
    expect(synthetic).not.toBe(CENTRAL_SHUTUBA); // 前提: 置換が効いている。
    const fetcher = new RecordingFetcher(centralHandler(synthetic));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(15);
    expect(data.meta.scratched).toHaveLength(1);
    expect(data.meta.scratched![0]!.status).toBe("不明");
    expect(data.meta.scratched![0]!.text).toBe("出走回避?");
    const warn = data.meta.warnings.find((w) => w.kind === "出走取消")!;
    expect(warn.message).toContain("出走回避?");
  });

  it("「除外」(合成。実物の文言は未観測)も同じく除かれ、区分が除外になること", async () => {
    const synthetic = CENTRAL_SHUTUBA.replace(
      `<td class="Cancel_Txt">取消</td>`,
      `<td class="Cancel_Txt">除外</td>`,
    );
    expect(synthetic).not.toBe(CENTRAL_SHUTUBA);
    const fetcher = new RecordingFetcher(centralHandler(synthetic));
    const data = await scrapeRace(CENTRAL_RACE_ID, { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(15);
    expect(data.meta.scratched![0]!.status).toBe("除外");
  });
});

describe("scrapeRace: 取消馬のいないレースは従来と同じであること(Issue #154 回帰)", () => {
  it("meta.scratched というキー自体が無く、出走取消の警告も出ないこと(中央・既存フィクスチャ)", async () => {
    const fetcher = new RecordingFetcher((url) => {
      if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
      if (url.includes("ajax_horse_results")) return RESULTS_FIXTURE;
      if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
      if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
      throw new Error(`未知のURL: ${url}`);
    });
    const data = await scrapeRace(parseRaceId("202603020211"), { fetcher, now: FIXED_NOW });

    expect(data.horses).toHaveLength(16);
    expect("scratched" in data.meta).toBe(false);
    expect(data.meta.warnings).toEqual([]);
  });
});

// ───────────── 地方: 合成(取消の実物なし) ─────────────

const NAR_RACE_ID = parseRaceId("202654071210");
const NAR_SHUTUBA = loadFixture("nar_shutuba_202654071210.html");
const NAR_ODDS = loadFixture("nar_odds_b1_202654071210.html");
const NAR_RESULTS = loadFixture("horse_results_2021104387.json");
const NAR_UNAVAILABLE_HTML = `<div id="odds_view_form"></div>`;

/** 地方フィクスチャの馬番1の行を取消行に書き換えた合成HTML(地方の取消の実物は未観測)。 */
function narShutubaWithHorse1Scratched(): string {
  const rowOpen = `<tr class="HorseList" id="tr_1">`;
  const umabanCell = `<td class="Umaban1">1</td>`;
  return NAR_SHUTUBA.replace(rowOpen, `<tr class="HorseList Cancel" id="tr_">`).replace(
    umabanCell,
    `${umabanCell}\n<td class="Cancel_Txt">取消</td>`,
  );
}

function narHandler(shutubaHtml: string): (url: string) => string {
  return (url) => {
    if (url.includes("shutuba.html")) return shutubaHtml;
    if (url.includes("ajax_horse_results")) return NAR_RESULTS;
    // 組合せオッズはすべて「発売前・未発売」の形(リクエスト先の検証だけが目的)。
    if (url.includes("odds_get_form.html")) return NAR_UNAVAILABLE_HTML;
    if (/type=b[3-7]\b/.test(url)) return NAR_UNAVAILABLE_HTML;
    if (url.includes("odds/index.html")) return NAR_ODDS;
    throw new Error(`未知のURL(NAR): ${url}`);
  };
}

describe("scrapeRace: 地方の取消(合成。実物は未観測で、中央と同じ雛形・同じ印と見込む)", () => {
  it("合成の取消馬が除かれ、残りの馬の組合せオッズ・軸馬は出走馬だけから導出されること", async () => {
    // 前提: 元のフィクスチャは馬番1〜12の連番(軸の期待値の導出に使う)。
    const baseUmabans = parseShutuba(NAR_SHUTUBA).horses.map((h) => h.umaban);
    expect(baseUmabans).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 対照: 取消なし → 3連複の軸は先頭 n-2=10頭 = 馬番1〜10。
    const control = new RecordingFetcher(narHandler(NAR_SHUTUBA));
    await scrapeRace(NAR_RACE_ID, { fetcher: control, now: FIXED_NOW }, { includeComboOdds: true });
    const controlAxes = control.calls
      .map((c) => c.url)
      .filter((u) => u.includes("odds_get_form.html"));
    expect(controlAxes).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => narTrioOddsAxisUrl(NAR_RACE_ID, k)),
    );

    // 取消あり(馬番1): 出走11頭 = 馬番2〜12 → 軸は先頭 n-2=9頭 = 馬番2〜10。馬番1は叩かない。
    const fetcher = new RecordingFetcher(narHandler(narShutubaWithHorse1Scratched()));
    const data = await scrapeRace(
      NAR_RACE_ID,
      { fetcher, now: FIXED_NOW },
      { includeComboOdds: true },
    );
    expect(data.horses).toHaveLength(11);
    expect(data.horses.some((h) => h.shutuba.umaban === 1)).toBe(false);
    expect(data.meta.scratched!.map((s) => s.umaban)).toEqual([1]);
    const axes = fetcher.calls.map((c) => c.url).filter((u) => u.includes("odds_get_form.html"));
    expect(axes).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => narTrioOddsAxisUrl(NAR_RACE_ID, k)),
    );
    // 取消馬の戦績も取得しない(出走11頭ぶん)。
    expect(fetcher.calls.filter((c) => c.url.includes("ajax_horse_results"))).toHaveLength(11);
  });

  it("3連複の期待組合せ数は出走馬の頭数から作られること(C(11,3)=165。取消込みの12頭ならC(12,3)=220)", async () => {
    const fetcher = new RecordingFetcher(narHandler(narShutubaWithHorse1Scratched()));
    const data = await scrapeRace(
      NAR_RACE_ID,
      { fetcher, now: FIXED_NOW },
      { includeComboOdds: true },
    );
    const diag = data.meta.comboOdds!.trio!.diagnostics;
    expect(diag.expectedComboCount).toBe(165);
  });
});
