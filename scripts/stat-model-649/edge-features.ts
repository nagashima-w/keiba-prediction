/**
 * #652: 騎手・調教師の市場比の指標(#642 の式)を、先読みなしで作る純粋な部分。`extras.ts` が使う。
 *
 *  - 基準の係数は、月ごとに「その月の初日より前の直近 2 年」の行だけで当てはめる(最初の月など行が無いときは [0, 1, 0])。
 *  - 各騎乗の読み残し(y − p)は、その騎乗の月の係数で一度だけ決める。
 *  - レース日 D の指標 = D より前(D は含まない)かつ D の 2 年前(含む)以降の読み残しの合計 ÷ (件数 + 30)。
 */

import {
  MARKET_EDGE_SHRINK,
  buildMarketRow,
  fitMarketBase,
  marketWindowCutoff,
  type MarketCoef,
  type MarketRow,
  type MarketSourceRecord,
} from "../../cloud/src/market-edge-calc.js";
import { SumIndex, logit, shrunkEdge, sigmoid } from "./lib.js";

const clampP = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p));

export interface EdgeIndex {
  readonly coefByMonth: ReadonlyMap<string, MarketCoef>;
  readonly jockeys: SumIndex;
  readonly trainers: SumIndex;
}

/** 結果の記録(市場の行を作れるもの)から、月ごとの係数と、騎手・調教師の読み残しの索引を作る。 */
export function buildEdgeIndex(records: readonly MarketSourceRecord[]): EdgeIndex {
  const rows: MarketRow[] = [];
  for (const rec of records) {
    const row = buildMarketRow(rec);
    if (row !== null) rows.push(row);
  }
  const months = new Set(rows.map((r) => r.raceDate.slice(0, 7)));
  const coefByMonth = new Map<string, MarketCoef>();
  for (const month of months) {
    const start = `${month}-01`;
    const cutoff = marketWindowCutoff(start);
    const prior = rows.filter((r) => r.raceDate >= cutoff && r.raceDate < start);
    coefByMonth.set(month, prior.length === 0 ? [0, 1, 0] : fitMarketBase(prior).coef);
  }
  const jockeys = new SumIndex();
  const trainers = new SumIndex();
  for (const row of rows) {
    const c = coefByMonth.get(row.raceDate.slice(0, 7))!;
    const lf = Math.log(row.horses.length);
    for (const h of row.horses) {
      const resid = h[5] - sigmoid(c[0] + c[1] * logit(clampP(h[4])) + c[2] * lf);
      if (h[0] !== null) jockeys.add(h[0], row.raceDate, resid);
      if (h[2] !== null) trainers.add(h[2], row.raceDate, resid);
    }
  }
  jockeys.finalize();
  trainers.finalize();
  return { coefByMonth, jockeys, trainers };
}

/** レース日 `date` の時点の、騎手(または調教師)の指標と件数。 */
export function edgeAt(index: SumIndex, id: string | null, date: string): { edge: number; n: number } {
  if (id === null) return { edge: 0, n: 0 };
  const s = index.sumBetween(id, marketWindowCutoff(date), date);
  return { edge: shrunkEdge(s, MARKET_EDGE_SHRINK), n: s?.n ?? 0 };
}
