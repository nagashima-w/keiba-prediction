import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { JRA_ODDS_PAGES, type JraOddsPage, type JraOddsRaceLinks } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { JraOddsFetcher, JraOddsSession } from "../src/jra-odds-fetch";
import { jraLinksCacheKey, jraOddsCacheKey } from "../src/jra-odds-cache";
import { jraOddsPagesFor, MemoryJraOddsStageStore } from "../src/race-day-jra-odds";
import { JraOddsStage, linksMatch } from "../src/race-day-jra-odds-stage";

/**
 * Issue #676: 締切の再計算が使う、メモリ上の進み具合({@link MemoryJraOddsStageStore})と、段の時間の守り(`stopAt`)・1 頁ずつの順序。
 * 偽の取得口・偽のキャッシュ(Map)だけを使うユニット。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jraHtml = (name: string): string => new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const RACE = "202605050208";
const DATE = "20260517";
const DIGIT: Record<string, string> = { tanpuku: "1", wakuren: "3", umaren: "4", wide: "5", umatan: "6", sanrenpuku: "7", sanrentan: "8" };
const FIXTURE: Record<string, string> = Object.fromEntries(Object.keys(DIGIT).map((p) => [p, `jra_odds_${p}_202605050208.html`]));
const cname = (page: string): string => `pw15${DIGIT[page]}ouS3${RACE.slice(4, 6)}${RACE.slice(0, 4)}${RACE.slice(6, 8)}${RACE.slice(8, 10)}${RACE.slice(10, 12)}${DATE}Z/AA`;
const links: JraOddsRaceLinks = {
  raceId: RACE,
  race: "08",
  cnames: Object.fromEntries(Object.keys(DIGIT).map((p) => [p, cname(p)])) as unknown as JraOddsRaceLinks["cnames"],
};

describe("MemoryJraOddsStageStore", () => {
  it("nextBatch: 三連単以外がまとめて先、残りが三連単だけなら三連単だけ(DO の表と同じ規則)。mark と failAllPending で進む", () => {
    const store = new MemoryJraOddsStageStore(jraOddsPagesFor(true));
    expect(jraOddsPagesFor(true)).toHaveLength(7); // 前提: 7 頁
    expect(store.nextBatch()).toEqual(["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku"]);
    for (const p of store.nextBatch()) store.mark("r", 0, p, "done");
    expect(store.hasPending()).toBe(true);
    expect(store.nextBatch()).toEqual(["sanrentan"]);
    expect(store.failAllPending()).toBe(1);
    expect(store.hasPending()).toBe(false);
    expect(store.nextBatch()).toEqual([]);
  });

  it("組合せ OFF は単勝複勝だけ。頁の順は JRA_ODDS_PAGES の順(三連単が最後)", () => {
    expect(new MemoryJraOddsStageStore(jraOddsPagesFor(false)).nextBatch()).toEqual(["tanpuku"]);
    expect(JRA_ODDS_PAGES.at(-1)).toBe("sanrentan");
  });
});

describe("JraOddsStage: 1 頁ずつ・時間の守り", () => {
  function setup(opts: { advance?: number; stopAt?: number } = {}) {
    const events: string[] = [];
    const cache = new Map<string, { value: string; fetchedAt: number }>();
    cache.set(jraLinksCacheKey(RACE), { value: JSON.stringify(links), fetchedAt: 0 });
    const clock = { now: 1_000_000 };
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher: JraOddsFetcher = {
      open(): JraOddsSession {
        let sent = 0;
        return {
          get requestCount() {
            return sent;
          },
          async listVenues() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async listRaces() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async fetchOdds(c) {
            sent += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const page = Object.keys(DIGIT).find((p) => c.startsWith(`pw15${DIGIT[p]}`))!;
            events.push(`fetch:${page}`);
            await Promise.resolve();
            clock.now += opts.advance ?? 0;
            inFlight -= 1;
            return { status: "ok", value: jraHtml(FIXTURE[page]!) };
          },
        };
      },
    };
    const warnings: string[] = [];
    const store = new MemoryJraOddsStageStore(jraOddsPagesFor(true));
    const stage = new JraOddsStage({
      store,
      fetcher,
      cache: {
        get: (k) => cache.get(k),
        set: (k, v) => {
          events.push(`set:${k.split(":")[2]}`);
          cache.set(k, { value: v, fetchedAt: clock.now });
        },
      },
      now: () => clock.now,
      onWarn: (m) => warnings.push(m),
    });
    return { events, cache, clock, store, stage, warnings, maxInFlight: () => maxInFlight };
  }

  it("頁は「取る → JSON を置く」を 1 頁ずつ順に行い、次の頁は前の頁を置いてから取る(同時に 2 本出ない)", async () => {
    const t = setup();
    await t.stage.run(RACE, 0, DATE);
    await t.stage.run(RACE, 0, DATE); // 三連単
    const pages = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
    expect(t.events).toEqual(pages.flatMap((p) => [`fetch:${p}`, `set:${p}`]));
    expect(t.maxInFlight()).toBe(1);
    for (const p of pages) expect(t.cache.has(jraOddsCacheKey(RACE, p as JraOddsPage)), p).toBe(true);
    expect(t.cache.get(jraOddsCacheKey(RACE, "tanpuku"))!.value.length).toBeLessThan(jraHtml(FIXTURE["tanpuku"]!).length); // 置くのは HTML ではなく小さな JSON
  });

  it("stopAt: 頁を送る前に now >= stopAt なら送らず、残り(三連単を含む)を failed にして、警告は固定の語(deadline)", async () => {
    const t = setup({ advance: 10 });
    // 1 本ごとに 10 進む。stopAt は開始(1_000_000)の 25 後 → 3 本目の前(20 後)は取る、4 本目の前(30 後)は取らない
    await t.stage.run(RACE, 0, DATE, { stopAt: 1_000_025 });
    expect(t.events.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:tanpuku", "fetch:wakuren", "fetch:umaren"]);
    expect(t.store.hasPending()).toBe(false); // 三連単も failed
    expect(t.warnings.join("\n")).toMatch(/deadline/);
    expect(t.warnings.join("\n")).not.toMatch(/https?:|cname|pw15/);
  });

  it("stopAt の境界: 送る前の now が stopAt とちょうど等しければ送らない", async () => {
    const t = setup({ advance: 10 });
    await t.stage.run(RACE, 0, DATE, { stopAt: 1_000_020 }); // 3 本目の前がちょうど 20 後
    expect(t.events.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:tanpuku", "fetch:wakuren"]);
  });
});

describe("JraOddsStage: 頁の失敗の語を構造的に渡す(onPageFailure。#756)", () => {
  function setup(fetchOdds: (page: string) => { status: string; value?: string }) {
    const cache = new Map<string, { value: string; fetchedAt: number }>();
    cache.set(jraLinksCacheKey(RACE), { value: JSON.stringify(links), fetchedAt: 0 });
    const fetcher: JraOddsFetcher = {
      open(): JraOddsSession {
        return {
          requestCount: 0,
          async listVenues() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async listRaces() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async fetchOdds(c) {
            const page = Object.keys(DIGIT).find((p) => c.startsWith(`pw15${DIGIT[p]}`))!;
            return fetchOdds(page) as never;
          },
        };
      },
    };
    const failures: { page: string; kind: string; word: string }[] = [];
    const warnings: string[] = [];
    const stage = new JraOddsStage({
      store: new MemoryJraOddsStageStore(["tanpuku", "umaren"]),
      fetcher,
      cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, { value: v, fetchedAt: 1 }) },
      now: () => 1,
      onWarn: (m) => warnings.push(m),
      onPageFailure: (f) => failures.push(f),
    });
    return { stage, failures, warnings };
  }

  it("取得の失敗は kind=fetch-failed と取得口の語、読み取りの失敗は kind=parse-failed と読み取りの語で、頁ごとに渡す。成功した頁は渡さない", async () => {
    const t = setup((page) => (page === "tanpuku" ? { status: "timeout" } : { status: "ok", value: "<html><body>表なし</body></html>" }));
    await t.stage.run(RACE, 0, DATE);
    expect(t.failures).toEqual([
      { page: "tanpuku", kind: "fetch-failed", word: "timeout" },
      { page: "umaren", kind: "parse-failed", word: "unavailable" },
    ]);
  });

  it("全部成功なら渡さない", async () => {
    const t = setup((page) => ({ status: "ok", value: jraHtml(FIXTURE[page]!) }));
    await t.stage.run(RACE, 0, DATE);
    expect(t.failures).toEqual([]);
  });

  it("onPageFailure が投げても、段は続けて警告も出す(取得の邪魔をしない)", async () => {
    const cache = new Map<string, { value: string; fetchedAt: number }>();
    cache.set(jraLinksCacheKey(RACE), { value: JSON.stringify(links), fetchedAt: 0 });
    const warnings: string[] = [];
    const stage = new JraOddsStage({
      store: new MemoryJraOddsStageStore(["tanpuku", "umaren"]),
      fetcher: { open: () => ({ requestCount: 0, listVenues: async () => ({ status: "timeout" }), listRaces: async () => ({ status: "timeout" }), fetchOdds: async () => ({ status: "timeout" }) }) as never },
      cache: { get: (k) => cache.get(k), set: () => undefined },
      now: () => 1,
      onWarn: (m) => warnings.push(m),
      onPageFailure: () => {
        throw new Error("x");
      },
    });
    await stage.run(RACE, 0, DATE);
    expect(warnings.filter((m) => m.includes("取得に失敗しました"))).toHaveLength(2); // 前提: 2 頁とも失敗し、警告が 2 件
  });
});

describe("JraOddsStage: 発売の無い式別(枠連が無いレース。Issue #817)", () => {
  const noWakuren: JraOddsRaceLinks = { ...links, cnames: Object.fromEntries(Object.entries(links.cnames).filter(([p]) => p !== "wakuren")) as unknown as JraOddsRaceLinks["cnames"] };

  it("linksMatch: 枠連の cname が無くても有効(単複があれば)。単複が無ければ無効。ある式別は照合する", () => {
    expect(linksMatch(noWakuren, RACE, DATE)).toBe(true);
    expect(linksMatch(links, RACE, DATE)).toBe(true); // 7 式別の既存の形も読める
    const noTanpuku = { ...links, cnames: Object.fromEntries(Object.entries(links.cnames).filter(([p]) => p !== "tanpuku")) };
    expect(linksMatch(noTanpuku, RACE, DATE)).toBe(false);
    expect(linksMatch({ ...links, cnames: { ...links.cnames, umaren: links.cnames.wide } }, RACE, DATE), "式別が合わない cname は無効").toBe(false);
  });

  it("枠連の頁は JRA に取りに行かず、ほかの 6 頁は取って置く。枠連は failed(netkeiba のまま)で、失敗の警告も通知(onPageFailure)も出さない", async () => {
    const cache = new Map<string, { value: string; fetchedAt: number }>();
    cache.set(jraLinksCacheKey(RACE), { value: JSON.stringify(noWakuren), fetchedAt: 0 });
    const fetched: string[] = [];
    const fetcher: JraOddsFetcher = {
      open(): JraOddsSession {
        return {
          requestCount: 0,
          async listVenues() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async listRaces() {
            throw new Error("リンクがあるので呼ばれない");
          },
          async fetchOdds(c) {
            const page = Object.keys(DIGIT).find((p) => c.startsWith(`pw15${DIGIT[p]}`))!;
            fetched.push(page);
            return { status: "ok", value: jraHtml(FIXTURE[page]!) };
          },
        };
      },
    };
    const warnings: string[] = [];
    const failures: unknown[] = [];
    const store = new MemoryJraOddsStageStore(jraOddsPagesFor(true));
    const stage = new JraOddsStage({
      store,
      fetcher,
      cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, { value: v, fetchedAt: 1 }) },
      now: () => 1,
      onWarn: (m) => warnings.push(m),
      onPageFailure: (f) => failures.push(f),
    });
    await stage.run(RACE, 0, DATE);
    await stage.run(RACE, 0, DATE); // 三連単
    expect(fetched).toEqual(["tanpuku", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"]);
    expect(cache.has(jraOddsCacheKey(RACE, "wakuren"))).toBe(false);
    for (const p of ["tanpuku", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"] as const) expect(cache.has(jraOddsCacheKey(RACE, p)), p).toBe(true);
    expect(store.hasPending()).toBe(false);
    expect(warnings.join("\n")).not.toMatch(/失敗/);
    expect(failures).toEqual([]);
  });
});
