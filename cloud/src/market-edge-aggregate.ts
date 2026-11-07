/**
 * 騎手・調教師の「市場の予測との差」の毎晩の集計(Issue #642)。
 * 窓(計算する日から 2 年)の市場の行を D1 から読み、係数を**毎晩当て直し**、指標と記録を置き換え、窓より古い市場の行を消す。
 * ストアは注入(本番は {@link D1MarketEdgeStore})。R2 には触れない。
 *
 * ## 読み取りの見積もり
 * 窓の市場の行は約 7,700 行(中央の 2 年分)。ページ({@link MARKET_AGGREGATE_PAGE} 行)ごとに D1 を 1 回呼ぶ(約 16 回)。1 回の呼び出しで使える D1 の文・サブリクエストの数に収まる
 * (書き込みは batch 1 回 + 削除 1 回。計 約 19 回)。当てはめは約 10.5 万頭 × 7 回ほどの反復(手元の実測で 100ms 前後)。
 *
 * ## 不収束の晩(ユーザーの決定。#642)
 * 当てはめが収束しなかった晩は、**前日の係数**(`market_edge_meta` に残した係数)で指標を計算し、`converged = false` で記録する。前日の係数が無いときは何も書かない(`fit-failed`)。
 */
import { computeMarketEdges, fitMarketBase, marketWindowCutoff, type MarketCoef, type MarketRow } from "./market-edge-calc";
import type { MarketEdgeMeta, MarketEdgeSnapshot, MarketRowsPage, MarketWindowCursor } from "./market-edge-repository";

/** 1 回の読み取りで読む市場の行の数(1 行 約 1KB)。 */
export const MARKET_AGGREGATE_PAGE = 500;

/** 集計が使うストアの部分(`D1MarketEdgeStore` の部分集合)。 */
export interface MarketAggregateStore {
  readWindowRowsPage(after: MarketWindowCursor, limit: number): Promise<MarketRowsPage>;
  readMeta(): Promise<MarketEdgeMeta | null>;
  replaceEdges(snapshot: MarketEdgeSnapshot): Promise<{ rowsWritten: number }>;
  pruneBefore(cutoff: string): Promise<{ rowsWritten: number }>;
}

export type MarketAggregateResult =
  | { readonly status: "no-rows" }
  | { readonly status: "fit-failed" }
  | {
      readonly status: "written";
      readonly rowsWritten: number;
      readonly races: number;
      readonly horses: number;
      readonly jockeys: number;
      readonly trainers: number;
      readonly converged: boolean;
      /** 不収束で、前日の係数を使った。 */
      readonly usedPreviousCoef: boolean;
      /** 読めなかった(壊れた)市場の行の数。 */
      readonly broken: number;
    };

export async function aggregateMarketEdges(store: MarketAggregateStore, today: string, options: { readonly pageSize?: number } = {}): Promise<MarketAggregateResult> {
  const pageSize = options.pageSize ?? MARKET_AGGREGATE_PAGE;
  const cutoff = marketWindowCutoff(today);
  const rows: MarketRow[] = [];
  let broken = 0;
  let cursor: MarketWindowCursor | null = { raceDate: cutoff, raceId: "" };
  while (cursor !== null) {
    const page: MarketRowsPage = await store.readWindowRowsPage(cursor, pageSize);
    rows.push(...page.rows);
    broken += page.broken;
    cursor = page.next;
  }
  if (rows.length === 0) return { status: "no-rows" };

  const fit = fitMarketBase(rows);
  let coef: MarketCoef = fit.coef;
  let usedPreviousCoef = false;
  if (!fit.converged) {
    const previous = await store.readMeta();
    if (previous === null) return { status: "fit-failed" };
    coef = previous.coef;
    usedPreviousCoef = true;
  }
  const { jockeys, trainers } = computeMarketEdges(rows, coef);
  let windowTo = rows[0]!.raceDate;
  let horses = 0;
  for (const r of rows) {
    if (r.raceDate > windowTo) windowTo = r.raceDate;
    horses += r.horses.length;
  }
  const replaced = await store.replaceEdges({ computedOn: today, windowFrom: cutoff, windowTo, coef, converged: fit.converged, iterations: fit.iterations, races: rows.length, horses, jockeys, trainers });
  const pruned = await store.pruneBefore(cutoff);
  return { status: "written", rowsWritten: replaced.rowsWritten + pruned.rowsWritten, races: rows.length, horses, jockeys: jockeys.length, trainers: trainers.length, converged: fit.converged, usedPreviousCoef, broken };
}
