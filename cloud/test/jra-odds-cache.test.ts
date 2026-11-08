import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { comboMatchesRunners, winPlaceMatchesRunners } from "../../packages/core/src/scraper/odds-override";
import { parseJraComboOdds, parseJraWinPlaceOdds } from "../../packages/core/src/scraper/parse-jra-odds";
import { JRA_PAGE_FOR_BET, createJraOddsOverride, jraLinksCacheKey, jraOddsCacheKey, parseJraOddsPage } from "../src/jra-odds-cache";

/**
 * Issue #675 段階 A: JRA のオッズの頁を、パース済みの小さな JSON にして取得キャッシュに置き、計算の段が `OddsOverride` として読む。
 * 見本は 東京 8R(202605050208。14 頭)。実際の JRA には出ない。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = (name: string): string => new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const RACE = "202605050208";
const DATE = "2026-05-05";
const FIXTURE: Record<keyof typeof JRA_PAGE_FOR_BET | "winPlace", string> = {
  winPlace: "jra_odds_tanpuku_202605050208.html",
  wide: "jra_odds_wide_202605050208.html",
  trio: "jra_odds_sanrenpuku_202605050208.html",
  quinella: "jra_odds_umaren_202605050208.html",
  exacta: "jra_odds_umatan_202605050208.html",
  trifecta: "jra_odds_sanrentan_202605050208.html",
  bracketQuinella: "jra_odds_wakuren_202605050208.html",
};
const BETS = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
const FETCHED_AT = 1_000_000;

/** 取得キャッシュの代わり(キー → 値と取得時刻)。 */
function memoryCache(): { readonly rows: Map<string, { value: string; fetchedAt: number }>; get(key: string): { value: string; fetchedAt: number } | undefined } {
  const rows = new Map<string, { value: string; fetchedAt: number }>();
  return { rows, get: (key) => rows.get(key) };
}

function put(cache: ReturnType<typeof memoryCache>, kind: "winPlace" | (typeof BETS)[number], fetchedAt = FETCHED_AT): void {
  const parsed = parseJraOddsPage(kind === "winPlace" ? "tanpuku" : JRA_PAGE_FOR_BET[kind], html(FIXTURE[kind]), DATE, kind === "winPlace" ? undefined : kind);
  expect(parsed.status).toBe("ok");
  if (parsed.status !== "ok") throw new Error("unreachable");
  cache.rows.set(jraOddsCacheKey(RACE, parsed.page), { value: parsed.json, fetchedAt });
}

describe("式別と頁の対応・キー", () => {
  it("組合せ 6 券種が JRA の 6 つの式別に 1 対 1 で対応する(単勝複勝は tanpuku)", () => {
    expect(Object.keys(JRA_PAGE_FOR_BET).sort()).toEqual([...BETS].sort());
    expect(new Set(Object.values(JRA_PAGE_FOR_BET)).size).toBe(6);
    expect(Object.values(JRA_PAGE_FOR_BET)).not.toContain("tanpuku");
  });
  it("キャッシュのキーは netkeiba のオッズ URL の分類(api_get_jra_odds・/odds/)に当たらず、レースと頁で別になる", () => {
    const keys = [jraOddsCacheKey(RACE, "tanpuku"), jraOddsCacheKey(RACE, "sanrentan"), jraOddsCacheKey("202605050209", "tanpuku"), jraLinksCacheKey(RACE)];
    expect(new Set(keys).size).toBe(4);
    for (const k of keys) expect(k).not.toMatch(/api_get_jra_odds|\/odds\//);
  });
});

describe("頁のパース → JSON(生の HTML は置かない)", () => {
  it("単勝・複勝: パーサの結果と同じ値が JSON に入り、HTML の断片は含まれない", () => {
    const parsed = parseJraOddsPage("tanpuku", html(FIXTURE.winPlace), DATE);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    const direct = parseJraWinPlaceOdds(html(FIXTURE.winPlace), DATE);
    expect(direct.state).toBe("available");
    if (direct.state !== "available") return;
    expect(JSON.parse(parsed.json).snapshot).toEqual(JSON.parse(JSON.stringify(direct.snapshot)));
    expect(parsed.json).not.toContain("<");
    expect(parsed.json.length).toBeLessThan(20_000);
  });
  it("組合せ 6 券種: セル数がパーサの結果と一致し(空振り防止に件数を固定)、三連単でも JSON は 2MiB に十分収まる", () => {
    for (const bet of BETS) {
      const parsed = parseJraOddsPage(JRA_PAGE_FOR_BET[bet], html(FIXTURE[bet]), DATE, bet);
      expect(parsed.status, bet).toBe("ok");
      if (parsed.status !== "ok") continue;
      const direct = parseJraComboOdds(html(FIXTURE[bet]), bet);
      expect(direct.state, bet).toBe("available");
      if (direct.state !== "available") continue;
      const cells = JSON.parse(parsed.json).cells as [string, unknown][];
      expect(cells.length, bet).toBe(direct.odds.size);
      expect(cells.length, bet).toBeGreaterThan(10);
      expect(parsed.json.length, bet).toBeLessThan(1024 * 1024);
    }
  });
  it("読めない頁(見出しが無い)は unavailable。壊れた構造で例外を投げずに failure の語にする", () => {
    expect(parseJraOddsPage("tanpuku", "<html><body>x</body></html>", DATE)).toEqual({ status: "unavailable" });
    expect(parseJraOddsPage("wide", "<html><body>x</body></html>", DATE, "wide")).toEqual({ status: "unavailable" });
  });
});

describe("createJraOddsOverride(計算の段が読む)", () => {
  it("単勝・複勝: 置いた JSON から OddsSnapshot を復元し、14 頭の出走馬に対して採用できる", async () => {
    const cache = memoryCache();
    put(cache, "winPlace");
    const override = createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT });
    const snapshot = await override.winPlace!();
    expect(snapshot).not.toBeNull();
    const runners = Array.from({ length: 14 }, (_, i) => i + 1);
    expect(winPlaceMatchesRunners(snapshot!, runners)).toBe(true);
    expect(override.source).toBe("jra");
    expect(snapshot!.win[1]).toEqual({ odds: 40, ninki: 11 });
    expect(snapshot!.place[1]).toEqual({ oddsMin: 8.5, oddsMax: 13.6, ninki: 11 });
    expect(snapshot!.officialDatetime).toBe("2026-05-05 10:37:00");
  });
  it("組合せ 6 券種: セルが Map に復元され、キーの範囲・期待数の判定に通る(馬連系は 14 頭、枠連は枠の構成)", async () => {
    const cache = memoryCache();
    for (const bet of BETS) put(cache, bet);
    const override = createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT });
    const horses = new Set(Array.from({ length: 14 }, (_, i) => i + 1));
    const sizes: Record<string, number> = {};
    for (const bet of BETS) {
      const got = await override.combo!(bet);
      expect(got, bet).not.toBeNull();
      sizes[bet] = got!.odds.size;
      if (bet === "bracketQuinella") {
        expect(comboMatchesRunners(got!.odds, new Set([1, 2, 3, 4, 5, 6, 7, 8]), got!.odds.size), bet).toBe(true);
      } else {
        expect(comboMatchesRunners(got!.odds, horses, got!.odds.size), bet).toBe(true);
      }
    }
    expect(sizes.wide).toBe(91); // 14 頭のワイド = C(14,2)
    expect(sizes.trio).toBe(364); // C(14,3)
    expect(sizes.trifecta).toBe(14 * 13 * 12);
  });
  it("置いていない頁は null(netkeiba に戻る)", async () => {
    const override = createJraOddsOverride({ cache: memoryCache(), raceId: RACE, oddsSince: 0 });
    expect(await override.winPlace!()).toBeNull();
    expect(await override.combo!("wide")).toBeNull();
  });
  it("取得時刻が oddsSince より古い JSON は使わない(ちょうど同時刻は使う)", async () => {
    const cache = memoryCache();
    put(cache, "winPlace", FETCHED_AT);
    put(cache, "wide", FETCHED_AT);
    expect(await createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT }).winPlace!()).not.toBeNull();
    expect(await createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT + 1 }).winPlace!()).toBeNull();
    expect(await createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT }).combo!("wide")).not.toBeNull();
    expect(await createJraOddsOverride({ cache, raceId: RACE, oddsSince: FETCHED_AT + 1 }).combo!("wide")).toBeNull();
  });
  it("壊れた JSON・版が違う JSON・頁の種別が違う JSON は null(例外にしない)", async () => {
    const cache = memoryCache();
    cache.rows.set(jraOddsCacheKey(RACE, "tanpuku"), { value: "{", fetchedAt: FETCHED_AT });
    cache.rows.set(jraOddsCacheKey(RACE, "wide"), { value: JSON.stringify({ v: 2, page: "wide", cells: [] }), fetchedAt: FETCHED_AT });
    cache.rows.set(jraOddsCacheKey(RACE, "umaren"), { value: JSON.stringify({ v: 1, page: "wide", cells: [] }), fetchedAt: FETCHED_AT });
    const override = createJraOddsOverride({ cache, raceId: RACE, oddsSince: 0 });
    expect(await override.winPlace!()).toBeNull();
    expect(await override.combo!("wide")).toBeNull();
    expect(await override.combo!("quinella")).toBeNull();
  });
});
