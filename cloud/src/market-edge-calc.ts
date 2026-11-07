/**
 * 騎手・調教師の「市場の予測との差」の指標の純関数(Issue #642。#548 の分析の `explore.py` と同じ式)。
 * `cloudflare:workers` や D1 を import しない(Node でテストできる)。D1 への読み書きは `market-edge-repository.ts`、毎晩の段取りは `market-edge-core.ts`。
 *
 * ## 式
 *  - 市場の予測: 馬ごとに q = (1/単勝オッズ) を、レースの中で合計 1 に割り戻した値。3 着内(finish ≤ 3)を、
 *    切片 + logit(q) + log(頭数) のロジスティック回帰({@link fitMarketBase})で予測した確率を p とする。
 *  - 読み残し = y − p(y は 3 着内なら 1)。
 *  - 指標 = 騎手(調教師)ごとの読み残しの合計 ÷ (件数 + {@link MARKET_EDGE_SHRINK})。件数・3 着内率・p の平均も持つ({@link computeMarketEdges})。
 *
 * ## 計算に入れる馬とレース({@link buildMarketRow})
 *  - 単勝オッズが正で、着順が数字の馬だけ(取消・除外・中止などは除く)。頭数は、その計算に入った馬の数。
 *  - **残りが {@link MARKET_MIN_FIELD}(5)頭に満たないレースは使わない**。参照実装(`explore.py` の `len(hs) < 5`)と同じ。手元の 7,718 レースでは 1 レース(4 頭)が除かれ、
 *    105,316 頭になる(最小頭数を付けないと 105,320 頭で、参照の係数と小数第 3 位まで一致しない可能性がある)。
 *  - 中央だけ(`kind` が central)。
 */

/** 指標の縮み(件数が少ないほど 0 に寄せる)。分母は 件数 + この値。 */
export const MARKET_EDGE_SHRINK = 30;
/** 計算に入る馬がこの頭数に満たないレースは使わない。 */
export const MARKET_MIN_FIELD = 5;
/** 集計する期間(年)。計算する日から遡る。 */
export const MARKET_WINDOW_YEARS = 2;

/** 結果の記録のうち、市場の行を作るのに読む部分(`RaceRecord` の構造的な部分集合)。 */
export interface MarketSourceRecord {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly kind: "central" | "nar";
  readonly horses: ReadonlyArray<{
    readonly finish: number | null;
    readonly winOdds: number | null;
    readonly jockeyId: string | null;
    readonly jockeyName: string | null;
    readonly trainerId: string | null;
    readonly trainerName: string | null;
  }>;
}

/** 1 頭分: [騎手 ID, 騎手名, 調教師 ID, 調教師名, q(レース内で合計 1 に割り戻した確率), y(3 着内なら 1)]。 */
export type MarketHorse = readonly [jockeyId: string | null, jockeyName: string | null, trainerId: string | null, trainerName: string | null, q: number, y: 0 | 1];

/** 1 レース分の市場の行(D1 の `race_market_rows` の 1 行に対応)。頭数は `horses.length`。 */
export interface MarketRow {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly raceDate: string;
  readonly horses: readonly MarketHorse[];
}

/** 結果の記録から市場の行を作る。中央でない・計算に入る馬が最小頭数に満たないときは null。 */
export function buildMarketRow(record: MarketSourceRecord): MarketRow | null {
  if (record.kind !== "central") return null;
  const used = record.horses.filter((h) => h.finish !== null && h.winOdds !== null && Number.isFinite(h.winOdds) && h.winOdds > 0);
  if (used.length < MARKET_MIN_FIELD) return null;
  const inv = used.map((h) => 1 / (h.winOdds as number));
  const total = inv.reduce((a, b) => a + b, 0);
  const horses = used.map((h, i): MarketHorse => [h.jockeyId, h.jockeyName, h.trainerId, h.trainerName, inv[i]! / total, (h.finish as number) <= 3 ? 1 : 0]);
  return { raceId: record.raceId, raceDate: record.date, horses };
}

/** D1 に入れる `horses_json`。 */
export function encodeMarketHorses(horses: readonly MarketHorse[]): string {
  return JSON.stringify(horses);
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** `horses_json` を読む。形が違えば null(壊れた行は集計に入れず、呼び出し側が数える)。 */
export function decodeMarketHorses(json: string): MarketHorse[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const h of parsed) {
    if (!Array.isArray(h) || h.length !== 6) return null;
    if (!isNullableString(h[0]) || !isNullableString(h[1]) || !isNullableString(h[2]) || !isNullableString(h[3])) return null;
    if (typeof h[4] !== "number" || !(h[4] > 0 && h[4] < 1)) return null;
    if (h[5] !== 0 && h[5] !== 1) return null;
  }
  return parsed as MarketHorse[];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 集計の窓の開始日(含む)。計算する日(JST の YYYY-MM-DD)から {@link MARKET_WINDOW_YEARS} 年遡る。遡り先に同じ日が無い(2/29)ときは 2/28。 */
export function marketWindowCutoff(today: string): string {
  const m = DATE_RE.exec(today);
  if (m === null) throw new RangeError(`today は YYYY-MM-DD でなければなりません: ${JSON.stringify(today)}`);
  const y = Number(m[1]) - MARKET_WINDOW_YEARS;
  const month = Number(m[2]);
  let day = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (month === 2 && day === 29 && !leap) day = 28;
  return `${String(y).padStart(4, "0")}-${m[2]}-${String(day).padStart(2, "0")}`;
}

// ---- ロジスティック回帰 ----

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(Math.min(z, 35), -35)));
const logit = (p: number): number => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

/** ニュートン法の反復の上限・収束の判定(最大の更新幅)・ヘッセ行列の対角に足す小さな値。参照実装と同じ。 */
const FIT_MAX_ITERATIONS = 25;
const FIT_TOLERANCE = 1e-8;
const FIT_RIDGE = 1e-6;

/** 3 元連立方程式 A x = v をピボット選択つきの掃き出しで解く(特異に近い軸は 0 を返す。参照実装と同じ)。 */
function solve3(A: number[][], v: number[]): number[] {
  const n = 3;
  const M = A.map((row, i) => [...row, v[i]!]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[piv]![i]!)) piv = r;
    [M[i], M[piv]] = [M[piv]!, M[i]!];
    if (Math.abs(M[i]![i]!) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]! / M[i]![i]!;
      for (let c = i; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[i]![c]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) > 1e-12 ? row[n]! / row[i]! : 0));
}

export type MarketCoef = readonly [number, number, number];

export interface MarketFit {
  /** [切片, logit(q) の係数, log(頭数) の係数] */
  readonly coef: MarketCoef;
  /** 最後の更新幅が許容より小さくなったら true。行が無い・反復の上限に達したら false。 */
  readonly converged: boolean;
  readonly iterations: number;
}

/** 全レースの全馬で、3 着内を 切片 + logit(q) + log(頭数) のロジスティック回帰に当てる(ニュートン法・初期値 0)。 */
export function fitMarketBase(rows: readonly MarketRow[]): MarketFit {
  const x1: number[] = [];
  const x2: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const lf = Math.log(r.horses.length);
    for (const h of r.horses) {
      x1.push(logit(h[4]));
      x2.push(lf);
      ys.push(h[5]);
    }
  }
  const N = ys.length;
  if (N === 0) return { coef: [0, 0, 0], converged: false, iterations: 0 };
  let b: [number, number, number] = [0, 0, 0];
  for (let it = 1; it <= FIT_MAX_ITERATIONS; it++) {
    const g = [0, 0, 0];
    const H = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < N; i++) {
      const xi = [1, x1[i]!, x2[i]!];
      const p = sigmoid(b[0] + b[1] * xi[1]! + b[2] * xi[2]!);
      const w = p * (1 - p);
      const e = ys[i]! - p;
      for (let a = 0; a < 3; a++) {
        g[a] = g[a]! + e * xi[a]!;
        for (let c = 0; c < 3; c++) H[a]![c] = H[a]![c]! + w * xi[a]! * xi[c]!;
      }
    }
    for (let a = 0; a < 3; a++) H[a]![a] = H[a]![a]! + FIT_RIDGE;
    const step = solve3(H, g);
    b = [b[0] + step[0]!, b[1] + step[1]!, b[2] + step[2]!];
    if (!b.every((c) => Number.isFinite(c))) return { coef: [0, 0, 0], converged: false, iterations: it };
    if (Math.max(Math.abs(step[0]!), Math.abs(step[1]!), Math.abs(step[2]!)) < FIT_TOLERANCE) return { coef: b, converged: true, iterations: it };
  }
  return { coef: b, converged: false, iterations: FIT_MAX_ITERATIONS };
}

// ---- 指標 ----

export interface MarketEdge {
  readonly id: string;
  /** 窓の中で最後に出たレース(開催日 → race_id の順)の名前。結果ページの略称。 */
  readonly name: string | null;
  /** 件数(計算に入った馬の数) */
  readonly n: number;
  /** 読み残しの合計 ÷ (件数 + {@link MARKET_EDGE_SHRINK}) */
  readonly edge: number;
  /** 3 着内率 */
  readonly hitRate: number;
  /** 市場の予測(p)の平均 */
  readonly predMean: number;
}

interface Acc {
  n: number;
  resid: number;
  hits: number;
  preds: number;
  name: string | null;
}

/** 係数 `coef` で p を出し、騎手・調教師ごとに指標を集計する。ID が無い馬はその側の集計に入れない。結果は ID の昇順。 */
export function computeMarketEdges(rows: readonly MarketRow[], coef: MarketCoef): { jockeys: MarketEdge[]; trainers: MarketEdge[] } {
  const sorted = [...rows].sort((a, b) => (a.raceDate === b.raceDate ? (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0) : a.raceDate < b.raceDate ? -1 : 1));
  const jockeys = new Map<string, Acc>();
  const trainers = new Map<string, Acc>();
  const add = (map: Map<string, Acc>, id: string | null, name: string | null, y: number, p: number): void => {
    if (id === null) return;
    let a = map.get(id);
    if (a === undefined) {
      a = { n: 0, resid: 0, hits: 0, preds: 0, name: null };
      map.set(id, a);
    }
    a.n += 1;
    a.resid += y - p;
    a.hits += y;
    a.preds += p;
    if (name !== null) a.name = name;
  };
  for (const r of sorted) {
    const lf = Math.log(r.horses.length);
    for (const h of r.horses) {
      const p = sigmoid(coef[0] + coef[1] * logit(h[4]) + coef[2] * lf);
      add(jockeys, h[0], h[1], h[5], p);
      add(trainers, h[2], h[3], h[5], p);
    }
  }
  const out = (map: Map<string, Acc>): MarketEdge[] =>
    [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, a]) => ({ id, name: a.name, n: a.n, edge: a.resid / (a.n + MARKET_EDGE_SHRINK), hitRate: a.hits / a.n, predMean: a.preds / a.n }));
  return { jockeys: out(jockeys), trainers: out(trainers) };
}
