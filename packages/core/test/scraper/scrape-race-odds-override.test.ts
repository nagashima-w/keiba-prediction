/**
 * scrapeRace の oddsOverride(中央のオッズを別の取得元に差し替える差し込み口。Issue #673 段階 B)のテスト。
 * 実際の取得元(JRA)は使わない。netkeiba のフィクスチャをパースした値を「差し込み側の値」に見立てる。
 * 出馬表は福島 16 頭(202603020211)。実サイトへのリクエストは含まない。
 */
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseComboOdds } from "../../src/scraper/parse-combo-odds.js";
import { parseOdds } from "../../src/scraper/parse-odds.js";
import type { ComboBetType, ComboOddsCell } from "../../src/scraper/combo-odds-key.js";
import { scrapeRace, type OddsOverride, type RaceFetcher } from "../../src/scraper/scrape-race.js";
import { loadFixture } from "../support/fixtures.js";

const RACE_ID = parseRaceId("202603020211");
const NOW = () => new Date("2026-06-28T06:00:00.000Z");

const COMBO_FIXTURE: Record<ComboBetType, string> = {
  wide: "odds_wide_202603020211.json",
  trio: "odds_trio_202603020211.json",
  quinella: "odds_quinella_202603020211.json",
  exacta: "odds_exacta_202603020211.json",
  trifecta: "odds_trifecta_202603020211.json",
  bracketQuinella: "odds_wakuren_202603020211.json",
};
const COMBO_TYPE_PARAM: Record<ComboBetType, string> = { bracketQuinella: "type=3", quinella: "type=4", wide: "type=5", exacta: "type=6", trio: "type=7", trifecta: "type=8" };

function handler(url: string): string {
  if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
  if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021105857.json");
  if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
  for (const bet of Object.keys(COMBO_TYPE_PARAM) as ComboBetType[]) {
    if (url.includes("api_get_jra_odds") && url.includes(COMBO_TYPE_PARAM[bet])) return loadFixture(COMBO_FIXTURE[bet]);
  }
  if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
  throw new Error(`未知のURL: ${url}`);
}

class Recording implements RaceFetcher {
  readonly urls: string[] = [];
  async fetchText(url: string, _options?: CachedFetchTextOptions): Promise<string> {
    this.urls.push(url);
    return handler(url);
  }
}

function comboMap(bet: ComboBetType): Map<string, ComboOddsCell> {
  const parsed = parseComboOdds(loadFixture(COMBO_FIXTURE[bet]), bet);
  expect(parsed.state).toBe("available");
  if (parsed.state !== "available") throw new Error("unreachable");
  return new Map(parsed.odds);
}

/** 差し込み側の値を作る補助。呼び出された券種を記録する。 */
function makeOverride(parts: { winPlace?: () => Promise<ReturnType<typeof parseOdds> | null>; combo?: (bet: ComboBetType) => Promise<{ odds: ReadonlyMap<string, ComboOddsCell>; officialDatetime: string | null } | null> }) {
  const calls: string[] = [];
  const override: OddsOverride = {
    source: "jra",
    winPlace: async () => {
      calls.push("winPlace");
      return parts.winPlace ? parts.winPlace() : null;
    },
    combo: async (bet) => {
      calls.push(bet);
      return parts.combo ? parts.combo(bet) : null;
    },
  };
  return { override, calls };
}

const OPTIONS = { includeComboOdds: true } as const;
const BETS = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;

describe("oddsOverride 未指定・全部 null のときは今と同じ", () => {
  it("未指定: meta に oddsSources のキーが無い(従来の形のまま)", async () => {
    const data = await scrapeRace(RACE_ID, { fetcher: new Recording(), now: NOW }, OPTIONS);
    expect("oddsSources" in data.meta).toBe(false);
  });

  it("全部 null を返す差し込み: 発行する URL 列が未指定のときと完全に同じで、オッズも同じ。各券種が netkeiba・理由 override-unavailable", async () => {
    const plain = new Recording();
    const base = await scrapeRace(RACE_ID, { fetcher: plain, now: NOW }, OPTIONS);
    const withNull = new Recording();
    const { override, calls } = makeOverride({});
    const data = await scrapeRace(RACE_ID, { fetcher: withNull, now: NOW, oddsOverride: override }, OPTIONS);
    expect(plain.urls.length).toBeGreaterThan(10); // 空振り防止
    expect(withNull.urls).toEqual(plain.urls);
    expect(data.odds).toEqual(base.odds);
    expect(calls).toEqual(["winPlace", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"]);
    expect(data.meta.oddsSources).toEqual({
      winPlace: { source: "netkeiba", officialDatetime: base.odds.officialDatetime, fallbackReason: "override-unavailable" },
      wide: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
      trio: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
      quinella: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
      exacta: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
      trifecta: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
      bracketQuinella: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
    });
  });
});

describe("単勝・複勝の差し込み", () => {
  it("採用すると netkeiba のオッズの URL を取らず、差し込みの値と時刻が RaceData に載り、oddsSources が jra になる", async () => {
    const snapshot = parseOdds(loadFixture("odds_202603020211.json"));
    const edited = { ...snapshot, officialDatetime: "2026-06-28 15:10:00", oddsStatus: "middle" as const, win: { ...snapshot.win, 1: { odds: 123.4, ninki: 9 } } };
    const fetcher = new Recording();
    const { override } = makeOverride({ winPlace: async () => edited });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override });
    expect(fetcher.urls.some((u) => u.includes("api_get_jra_odds"))).toBe(false);
    expect(data.odds.win[1]).toEqual({ odds: 123.4, ninki: 9 });
    expect(data.odds.officialDatetime).toBe("2026-06-28 15:10:00");
    expect(data.meta.oddsSources?.winPlace).toEqual({ source: "jra", officialDatetime: "2026-06-28 15:10:00" });
    // 組合せは includeComboOdds が無いので問い合わせない
    expect(Object.keys(data.meta.oddsSources ?? {})).toEqual(["winPlace"]);
  });

  it("出走馬と馬番の集合が違う(馬が足りない/余分にいる)なら採用せず netkeiba に戻り、理由 horse-set-mismatch", async () => {
    const snapshot = parseOdds(loadFixture("odds_202603020211.json"));
    const { 16: _dropped, ...fewer } = snapshot.win;
    expect(Object.keys(snapshot.win)).toHaveLength(16); // 前提
    const missing = { ...snapshot, win: fewer };
    const extra = { ...snapshot, win: { ...snapshot.win, 17: { odds: 5, ninki: 1 } } };
    for (const bad of [missing, extra]) {
      const fetcher = new Recording();
      const { override } = makeOverride({ winPlace: async () => bad });
      const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override });
      expect(fetcher.urls.filter((u) => u.includes("api_get_jra_odds"))).toHaveLength(1);
      expect(data.odds.win[1]).toEqual(snapshot.win[1]);
      expect(data.meta.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    }
  });

  it("出走馬のオッズが null の欄がある場合は採用しない。出走馬以外の欄は、単勝が null(取消馬の空欄)なら残っていても採用する", async () => {
    const snapshot = parseOdds(loadFixture("odds_202603020211.json"));
    const nullRunner = { ...snapshot, win: { ...snapshot.win, 3: { odds: null, ninki: null } } };
    const scratchedBlank = { ...snapshot, win: { ...snapshot.win, 17: { odds: null, ninki: 9999 } } };
    const f1 = new Recording();
    const r1 = await scrapeRace(RACE_ID, { fetcher: f1, now: NOW, oddsOverride: makeOverride({ winPlace: async () => nullRunner }).override });
    expect(r1.meta.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    const f2 = new Recording();
    const r2 = await scrapeRace(RACE_ID, { fetcher: f2, now: NOW, oddsOverride: makeOverride({ winPlace: async () => scratchedBlank }).override });
    expect(f2.urls.some((u) => u.includes("api_get_jra_odds"))).toBe(false);
    expect(r2.meta.oddsSources?.winPlace).toMatchObject({ source: "jra" });
  });

  it("出走馬の複勝の下限が欠けている(place に無い・oddsMin が null)なら採用せず netkeiba に戻る(#675 記録 5)", async () => {
    const snapshot = parseOdds(loadFixture("odds_202603020211.json"));
    // 前提: 元の値は全 16 頭に複勝の下限がある(欠けを作る前に、欠けていないことを固定する)
    expect(Object.keys(snapshot.place)).toHaveLength(16);
    expect(Object.values(snapshot.place).every((p) => p.oddsMin !== null)).toBe(true);
    const { 5: _dropped, ...withoutFive } = snapshot.place;
    const noPlaceEntry = { ...snapshot, place: withoutFive };
    const nullMin = { ...snapshot, place: { ...snapshot.place, 5: { oddsMin: null, oddsMax: null, ninki: null } } };
    for (const [label, bad] of [["place に馬が無い", noPlaceEntry], ["下限が null", nullMin]] as const) {
      const fetcher = new Recording();
      const { override } = makeOverride({ winPlace: async () => bad });
      const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override });
      expect(fetcher.urls.filter((u) => u.includes("api_get_jra_odds")), label).toHaveLength(1);
      expect(data.odds.place[5], label).toEqual(snapshot.place[5]);
      expect(data.meta.oddsSources?.winPlace, label).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    }
  });

  it("差し込みが例外を投げても scrapeRace は失敗せず、netkeiba に戻って理由 override-error", async () => {
    const fetcher = new Recording();
    const { override } = makeOverride({
      winPlace: async () => {
        throw new Error("壊れた");
      },
    });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override });
    expect(data.odds.win[1]).toBeDefined();
    expect(data.meta.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-error" });
  });
});

describe("組合せの差し込み(券種ごと)", () => {
  it("1 券種(ワイド)だけ採用: その URL は取らず、ほかの券種は netkeiba。診断値は available・requestCount 0・取得数=期待数", async () => {
    const wide = comboMap("wide");
    const edited = new Map(wide);
    const firstKey = [...wide.keys()][0]!;
    edited.set(firstKey, { ...wide.get(firstKey)!, oddsMin: 777.7 });
    const plain = new Recording();
    await scrapeRace(RACE_ID, { fetcher: plain, now: NOW }, OPTIONS);
    const fetcher = new Recording();
    const { override } = makeOverride({ combo: async (bet) => (bet === "wide" ? { odds: edited, officialDatetime: "2026-06-28 15:10:00" } : null) });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
    expect(plain.urls.filter((u) => u.includes("type=5"))).toHaveLength(1); // 前提
    expect(fetcher.urls.filter((u) => u.includes("type=5"))).toHaveLength(0);
    expect(fetcher.urls).toEqual(plain.urls.filter((u) => !u.includes("type=5")));
    expect(data.odds.wideCombo![firstKey]).toBe(777.7);
    expect(Object.keys(data.odds.wideCombo!)).toHaveLength(120);
    expect(data.meta.comboOdds?.wide).toMatchObject({ state: "available", diagnostics: { requestCount: 0, expectedComboCount: 120, obtainedComboCount: 120, missingComboCount: 0 } });
    expect(data.meta.oddsSources?.wide).toEqual({ source: "jra", officialDatetime: "2026-06-28 15:10:00" });
    expect(data.meta.oddsSources?.trio).toMatchObject({ source: "netkeiba" });
    expect(data.meta.warnings.filter((w) => w.kind === "組合せオッズ")).toEqual([]);
  });

  it("全券種を採用すると、組合せ・単勝・複勝のどのオッズ URL も取らない(出馬表・戦績・調教だけ)", async () => {
    const snapshot = parseOdds(loadFixture("odds_202603020211.json"));
    const fetcher = new Recording();
    const { override, calls } = makeOverride({
      winPlace: async () => snapshot,
      combo: async (bet) => ({ odds: comboMap(bet), officialDatetime: null }),
    });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
    expect(fetcher.urls.some((u) => u.includes("api_get_jra_odds"))).toBe(false);
    expect(calls).toHaveLength(7);
    for (const bet of BETS) expect(data.meta.oddsSources?.[bet]?.source, bet).toBe("jra");
    expect(Object.keys(data.odds.trifectaCombo!)).toHaveLength(3360);
    expect(Object.keys(data.odds.bracketQuinellaCombo!)).toHaveLength(36);
  });

  it("馬番が出走馬の外(17 番)を含む、または取得数が期待数と違う組合せは採用せず netkeiba に戻る", async () => {
    const wide = comboMap("wide");
    const withExtra = new Map(wide).set("0117", { oddsMin: 5, oddsMax: 6, ninki: null });
    const short = new Map([...wide].slice(1));
    expect(short.size).toBe(wide.size - 1); // 前提
    for (const [label, bad] of [["余分", withExtra], ["不足", short]] as const) {
      const fetcher = new Recording();
      const { override } = makeOverride({ combo: async (bet) => (bet === "wide" ? { odds: bad, officialDatetime: null } : null) });
      const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
      expect(fetcher.urls.filter((u) => u.includes("type=5")), label).toHaveLength(1);
      expect(Object.keys(data.odds.wideCombo!), label).toHaveLength(120);
      expect(data.meta.oddsSources?.wide, label).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    }
  });

  it("組の数が期待数と同じでも、キーに範囲外の馬番(17)が混ざっていれば採用せず netkeiba に戻る(#675 記録 4。数の検査では落ちない)", async () => {
    const wide = comboMap("wide");
    const [firstKey] = [...wide.keys()];
    const swapped = new Map(wide);
    swapped.delete(firstKey!);
    swapped.set("0117", { oddsMin: 5, oddsMax: 6, ninki: null });
    expect(swapped.size).toBe(wide.size); // 前提: 数は一致(数の検査では落ちない)
    expect(swapped.has("0117") && !wide.has("0117")).toBe(true); // 前提: 範囲外のキーが入れ替わっている
    const fetcher = new Recording();
    const { override } = makeOverride({ combo: async (bet) => (bet === "wide" ? { odds: swapped, officialDatetime: null } : null) });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
    expect(fetcher.urls.filter((u) => u.includes("type=5"))).toHaveLength(1);
    expect(data.meta.oddsSources?.wide).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
  });

  it("枠連は枠の構成から期待数 36 を求めて判定する(35 件は戻る)", async () => {
    const bracket = comboMap("bracketQuinella");
    expect(bracket.size).toBe(36); // 前提
    const short = new Map([...bracket].slice(1));
    const fetcher = new Recording();
    const { override } = makeOverride({ combo: async (bet) => (bet === "bracketQuinella" ? { odds: short, officialDatetime: null } : null) });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
    expect(data.meta.oddsSources?.bracketQuinella).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    expect(Object.keys(data.odds.bracketQuinellaCombo!)).toHaveLength(36);
  });

  it("差し込みが例外を投げた券種だけ netkeiba に戻り(理由 override-error)、ほかの券種は採用される", async () => {
    const fetcher = new Recording();
    const { override } = makeOverride({
      combo: async (bet) => {
        if (bet === "trio") throw new Error("壊れた");
        return bet === "quinella" ? { odds: comboMap("quinella"), officialDatetime: null } : null;
      },
    });
    const data = await scrapeRace(RACE_ID, { fetcher, now: NOW, oddsOverride: override }, OPTIONS);
    expect(data.meta.oddsSources?.trio).toMatchObject({ source: "netkeiba", fallbackReason: "override-error" });
    expect(data.meta.oddsSources?.quinella).toMatchObject({ source: "jra" });
    expect(Object.keys(data.odds.trioCombo!)).toHaveLength(560);
  });

  it("oddsSources は JSON を往復しても消えない", async () => {
    const { override } = makeOverride({ combo: async (bet) => (bet === "wide" ? { odds: comboMap("wide"), officialDatetime: "2026-06-28 15:10:00" } : null) });
    const data = await scrapeRace(RACE_ID, { fetcher: new Recording(), now: NOW, oddsOverride: override }, OPTIONS);
    const round = JSON.parse(JSON.stringify(data.meta)) as { oddsSources: Record<string, unknown> };
    expect(round.oddsSources.wide).toEqual({ source: "jra", officialDatetime: "2026-06-28 15:10:00" });
  });
});

describe("地方(NAR)は差し込みの対象外", () => {
  it("差し込みを渡しても一度も呼ばず、meta に oddsSources を付けない(地方の取得は今のまま)", async () => {
    const NAR_RACE_ID = parseRaceId("202654071210");
    const unavailable = `<div id="odds_view_form"></div>`;
    const narFetcher: RaceFetcher = {
      fetchText: async (url) => {
        if (url.includes("shutuba.html")) return loadFixture("nar_shutuba_202654071210.html");
        if (url.includes("ajax_horse_results")) return loadFixture("horse_results_2021104387.json");
        if (url.includes("type=b4") || url.includes("type=b3")) return unavailable;
        if (url.includes("odds/index.html")) return loadFixture("nar_odds_b1_202654071210.html");
        throw new Error(`未知のURL: ${url}`);
      },
    };
    const { override, calls } = makeOverride({ winPlace: async () => parseOdds(loadFixture("odds_202603020211.json")) });
    const data = await scrapeRace(NAR_RACE_ID, { fetcher: narFetcher, now: NOW, oddsOverride: override });
    expect(calls).toEqual([]);
    expect("oddsSources" in data.meta).toBe(false);
    expect(Object.keys(data.odds.win).length).toBeGreaterThan(0); // 地方の単勝は netkeiba から取れている
  });
});
