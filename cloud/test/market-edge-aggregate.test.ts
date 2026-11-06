import { describe, expect, it } from "vitest";
import type { MarketHorse, MarketRow } from "../src/market-edge-calc";
import { computeMarketEdges, fitMarketBase } from "../src/market-edge-calc";
import { aggregateMarketEdges, type MarketAggregateStore } from "../src/market-edge-aggregate";
import type { MarketEdgeMeta, MarketEdgeSnapshot, MarketRowsPage, MarketWindowCursor } from "../src/market-edge-repository";

/**
 * Issue #642: 毎晩の集計(窓の市場の行を読む → 係数を当て直す → 指標を置き換える → 窓より古い行を消す)。
 * 偽のストアで、読み方(窓の開始日・ページ送り)・不収束の晩の扱い・書く内容を固定する。D1 の上の動きは market-edge-repository.integration.test.ts。
 */

const horses = (hits: number[], j = "J1"): MarketHorse[] => hits.map((y, i) => [i === 0 ? j : `X${i}`, i === 0 ? `名${j}` : `名${i}`, "T1", "厩1", 0.2, y as 0 | 1]);
/** 騎手 J1 が 1 着〜5 着までの様々な結果になる、変化のあるレースを作る(完全分離にならないよう y を混ぜる)。 */
function race(n: number, date: string, hits: number[]): MarketRow {
  return { raceId: `2025010${String(10000 + n)}`, raceDate: date, horses: horses(hits) };
}
const PATTERNS = [[1, 0, 0, 0, 0], [0, 1, 1, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 0, 0, 0, 0]];
function rowsOf(count: number, date = "2025-06-01"): MarketRow[] {
  return Array.from({ length: count }, (_, i) => race(i, date, PATTERNS[i % PATTERNS.length]!));
}

function fakeStore(rows: MarketRow[], prev: MarketEdgeMeta | null = null) {
  const calls = { pages: [] as Array<{ after: MarketWindowCursor; limit: number }>, snapshots: [] as MarketEdgeSnapshot[], pruned: [] as string[] };
  const sorted = [...rows].sort((a, b) => (a.raceDate + a.raceId < b.raceDate + b.raceId ? -1 : 1));
  const store: MarketAggregateStore = {
    async readWindowRowsPage(after, limit): Promise<MarketRowsPage> {
      calls.pages.push({ after, limit });
      const rest = sorted.filter((r) => r.raceDate + "|" + r.raceId > after.raceDate + "|" + after.raceId);
      const page = rest.slice(0, limit);
      const last = page[page.length - 1];
      return { rows: page, broken: 0, next: page.length >= limit && last !== undefined ? { raceDate: last.raceDate, raceId: last.raceId } : null };
    },
    async readMeta() {
      return prev;
    },
    async replaceEdges(s) {
      calls.snapshots.push(s);
      return { rowsWritten: s.jockeys.length + s.trainers.length + 1 };
    },
    async pruneBefore(cutoff) {
      calls.pruned.push(cutoff);
      return { rowsWritten: 3 };
    },
  };
  return { store, calls };
}

describe("aggregateMarketEdges", () => {
  it("窓の開始日(計算する日の 2 年前)から読み、全ページを集めて当てはめ、指標と記録を書き、窓より前を消す", async () => {
    const rows = rowsOf(10);
    const { store, calls } = fakeStore(rows);
    const res = await aggregateMarketEdges(store, "2026-11-07", { pageSize: 4 });
    expect(calls.pages[0]).toEqual({ after: { raceDate: "2024-11-07", raceId: "" }, limit: 4 });
    expect(calls.pages).toHaveLength(3); // 4 + 4 + 2(最後のページは満杯でなく、そこで終わる)
    expect(calls.snapshots).toHaveLength(1);
    const snap = calls.snapshots[0]!;
    const fit = fitMarketBase(rows);
    expect(fit.converged).toBe(true);
    expect(snap.coef).toEqual(fit.coef);
    expect(snap.converged).toBe(true);
    expect(snap.iterations).toBe(fit.iterations);
    expect(snap.computedOn).toBe("2026-11-07");
    expect(snap.windowFrom).toBe("2024-11-07");
    expect(snap.windowTo).toBe("2025-06-01");
    expect(snap.races).toBe(10);
    expect(snap.horses).toBe(50);
    expect(snap.jockeys).toEqual(computeMarketEdges(rows, fit.coef).jockeys);
    expect(calls.pruned).toEqual(["2024-11-07"]);
    expect(res).toMatchObject({ status: "written", races: 10, horses: 50, converged: true, usedPreviousCoef: false, rowsWritten: snap.jockeys.length + snap.trainers.length + 1 + 3 });
  });

  it("ちょうどページの大きさで終わるときは、空のページを 1 回読んで終わる", async () => {
    const { store, calls } = fakeStore(rowsOf(8));
    await aggregateMarketEdges(store, "2026-11-07", { pageSize: 4 });
    expect(calls.pages).toHaveLength(3); // 4 + 4 + 0
  });

  it("窓に行が 1 つも無いときは何も書かず、消しもしない(no-rows)", async () => {
    const { store, calls } = fakeStore([]);
    expect(await aggregateMarketEdges(store, "2026-11-07")).toEqual({ status: "no-rows" });
    expect(calls.snapshots).toEqual([]);
    expect(calls.pruned).toEqual([]);
  });

  it("不収束の晩は前日の係数を使い、converged = false で記録する(前日の係数がそのまま使われ、当てはめ直した係数は使わない)", async () => {
    // 全員が 3 着内(完全分離)で収束しない行
    const rows = Array.from({ length: 10 }, (_, i) => race(i, "2025-06-01", [1, 1, 1, 1, 1]));
    expect(fitMarketBase(rows).converged).toBe(false);
    const prev: MarketEdgeMeta = { computedOn: "2026-11-06", windowFrom: "2024-11-06", windowTo: "2026-11-05", coef: [1, 0.9, -0.5], converged: true, iterations: 6, races: 100, horses: 500 };
    const { store, calls } = fakeStore(rows, prev);
    const res = await aggregateMarketEdges(store, "2026-11-07");
    const snap = calls.snapshots[0]!;
    expect(snap.coef).toEqual([1, 0.9, -0.5]);
    expect(snap.converged).toBe(false);
    expect(snap.jockeys).toEqual(computeMarketEdges(rows, [1, 0.9, -0.5]).jockeys);
    expect(res).toMatchObject({ status: "written", converged: false, usedPreviousCoef: true });
  });

  it("不収束で前日の係数も無いときは、何も書かない(fit-failed)", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => race(i, "2025-06-01", [1, 1, 1, 1, 1]));
    const { store, calls } = fakeStore(rows, null);
    expect(await aggregateMarketEdges(store, "2026-11-07")).toEqual({ status: "fit-failed" });
    expect(calls.snapshots).toEqual([]);
    expect(calls.pruned).toEqual([]);
  });

  it("壊れた行の数は結果に出す", async () => {
    const { store } = fakeStore(rowsOf(6));
    const inner = store.readWindowRowsPage.bind(store);
    store.readWindowRowsPage = async (after, limit) => ({ ...(await inner(after, limit)), broken: 2 });
    expect(await aggregateMarketEdges(store, "2026-11-07")).toMatchObject({ status: "written", broken: 2 });
  });
});
