/**
 * #649 段階 1(統計モデルで勝率・2着内率を直接見積もる)の測る道具の、純粋な部分。
 * ファイルの読み書き・Python の学習・本番の関数の呼び出しは `replay.ts`・`eval.ts`・`fit.py` が担う。
 * ここは、特徴量の材料(騎手・調教師の年別成績)と、確率の正規化・評価の指標だけを持つ(テストは `scripts/test/stat-model-649-lib.test.ts`)。
 */

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => Math.log(p / (1 - p));

/** `YYYY-MM-DD` から `YYYY-MM`。 */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * 単勝オッズから市場の確率(1/オッズをレース内で合計 1 に割り戻す。#548・`cloud/src/market-edge-calc.ts` と同じ式)。
 * 1 頭でもオッズが欠けている(null・0 以下・非有限)レースは null(欠けた馬を黙って埋めると、残りの馬の確率が歪む)。
 */
export function marketShares(odds: ReadonlyArray<number | null>): number[] | null {
  const inv: number[] = [];
  for (const o of odds) {
    if (o === null || !Number.isFinite(o) || o <= 0) {
      return null;
    }
    inv.push(1 / o);
  }
  const total = inv.reduce((s, v) => s + v, 0);
  return inv.map((v) => v / total);
}

/**
 * 全馬に共通のロジット c を足して、Σ sigmoid(l_i + c) = target にする(`scorer/prior.ts` の `normalizeFieldPriors` と同じ考え方。
 * あちらは minPrior・maxPrior のクランプを持つが、ここは評価用なので持たない)。target ≥ 頭数なら全頭 1。
 */
export function normalizeLogitShift(logits: readonly number[], target: number): number[] {
  const n = logits.length;
  if (target >= n) {
    return logits.map(() => 1);
  }
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const total = logits.reduce((s, l) => s + sigmoid(l + mid), 0);
    if (total > target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const c = (lo + hi) / 2;
  return logits.map((l) => sigmoid(l + c));
}

const PROB_EPS = 1e-6;
const clampProb = (p: number): number => Math.min(1 - PROB_EPS, Math.max(PROB_EPS, p));

/** 平均の対数損失(確率は [1e-6, 1−1e-6] に切る)。 */
export function logLoss(ps: readonly number[], ys: readonly number[]): number {
  let s = 0;
  ps.forEach((p, i) => {
    const q = clampProb(p);
    s += ys[i]! === 1 ? -Math.log(q) : -Math.log(1 - q);
  });
  return s / ps.length;
}

/** 平均の Brier スコア。 */
export function brier(ps: readonly number[], ys: readonly number[]): number {
  let s = 0;
  ps.forEach((p, i) => {
    s += (p - ys[i]!) ** 2;
  });
  return s / ps.length;
}

export interface LogisticFit {
  /** [切片, x の列ごとの係数]。 */
  readonly coef: number[];
  /** 係数の標準誤差(情報行列の逆行列の対角)。 */
  readonly se: number[];
  readonly iterations: number;
}

/** 小さな連立一次方程式(ガウスの消去。部分ピボット)。A は破壊する。逆行列も欲しいので、右辺は行列で受ける。 */
function solve(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]!.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) {
        piv = r;
      }
    }
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    const d = a[col]![col]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      for (let c = 0; c < m; c++) b[r]![c]! -= f * b[col]![c]!;
    }
  }
  return b.map((row, i) => row.map((v) => v / (a[i]![i]! || 1e-12)));
}

/**
 * ロジスティック回帰(ニュートン法)。切片は自動で足す。係数が発散しないよう、ごく弱い L2(1e-6)と反復の上限(50)を置く。
 * 市場への係数の検定(Issue 本文の「市場と並べたロジスティック回帰」)に使う。学習そのものは Python 側。
 */
export function fitLogistic(x: ReadonlyArray<readonly number[]>, y: readonly number[]): LogisticFit {
  const k = x[0]!.length + 1;
  const beta = new Array<number>(k).fill(0);
  let iterations = 0;
  let info: number[][] = [];
  for (let it = 0; it < 50; it++) {
    iterations = it + 1;
    const grad = new Array<number>(k).fill(0);
    const h: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    x.forEach((row, i) => {
      const z = beta[0]! + row.reduce((s, v, j) => s + v * beta[j + 1]!, 0);
      const p = sigmoid(z);
      const w = p * (1 - p);
      const r = y[i]! - p;
      const xi = [1, ...row];
      for (let a = 0; a < k; a++) {
        grad[a]! += xi[a]! * r;
        for (let b = 0; b < k; b++) h[a]![b]! += w * xi[a]! * xi[b]!;
      }
    });
    for (let a = 0; a < k; a++) {
      h[a]![a]! += 1e-6;
      grad[a]! -= 1e-6 * beta[a]!;
    }
    info = h.map((r) => [...r]);
    const step = solve(
      h,
      grad.map((g) => [g]),
    ).map((r) => r[0]!);
    let maxStep = 0;
    for (let a = 0; a < k; a++) {
      // 完全分離での発散を抑える(1 反復の更新幅を 5 までに)。
      const s = Math.max(-5, Math.min(5, step[a]!));
      beta[a]! += s;
      maxStep = Math.max(maxStep, Math.abs(s));
    }
    if (maxStep < 1e-8) break;
  }
  const identity = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  const inv = solve(
    info.map((r) => [...r]),
    identity,
  );
  return { coef: beta, se: inv.map((r, i) => Math.sqrt(Math.max(0, r[i]!))), iterations };
}

/** 年ごとの記録(`scraper/parse-jockey-results.ts` の `JockeyYearRecord` と同じ形)。 */
export interface YearRecord {
  readonly year: number;
  readonly starts: number;
  readonly placed: number;
}

/**
 * 騎手・調教師の年別成績を、**基準日より前の騎乗だけ**から集計する索引。
 * 本番の年別成績は netkeiba のページの値(分析の時点で確定している年と、当年の分析時点まで)で、
 * ここではその代わりに過去の結果(手元の過去のレース)から同じ形を作る。
 */
export class RideIndex {
  private readonly rides = new Map<string, Array<{ date: string; placed: boolean }>>();
  private cum = new Map<string, { dates: string[]; placed: number[] }>();

  add(id: string, date: string, placed: boolean): void {
    let list = this.rides.get(id);
    if (list === undefined) {
      list = [];
      this.rides.set(id, list);
    }
    list.push({ date, placed });
  }

  /** 日付順に整列して累積を作る(add の順序に依存しない)。add を終えたら 1 回呼ぶ。 */
  finalize(): void {
    this.cum = new Map();
    for (const [id, list] of this.rides) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const placed: number[] = [0];
      list.forEach((r) => placed.push(placed[placed.length - 1]! + (r.placed ? 1 : 0)));
      this.cum.set(id, { dates: list.map((r) => r.date), placed });
    }
  }

  /** dates のうち `d` より小さいものの個数(二分探索)。 */
  private countBefore(dates: readonly string[], d: string): number {
    let lo = 0;
    let hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid]! < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * `asOf`(YYYY-MM-DD。この日の騎乗は含めない)より前の騎乗を、`years` の各年について集計する。
   * ID が一度も add されていなければ undefined(データなし。騎乗 0 件の年だけが並ぶ配列とは別)。
   */
  records(id: string, asOf: string, years: readonly number[]): YearRecord[] | undefined {
    const c = this.cum.get(id);
    if (c === undefined) {
      return undefined;
    }
    return years.map((year) => {
      const from = this.countBefore(c.dates, `${year}-01-01`);
      const to = this.countBefore(c.dates, minDate(`${year + 1}-01-01`, asOf));
      const end = Math.max(from, to);
      return { year, starts: end - from, placed: c.placed[end]! - c.placed[from]! };
    });
  }
}

const minDate = (a: string, b: string): string => (a < b ? a : b);

/** 再現できる乱数(mulberry32)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RaceLossPair {
  /** モデル A のそのレースの損失の合計(馬ごとの対数損失の和)。 */
  readonly a: number;
  readonly b: number;
  /** そのレースの頭数。 */
  readonly n: number;
}

export interface BootstrapResult {
  /** (A − B) の頭あたり損失の差(負なら A の方が良い)。 */
  readonly meanDiff: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  /** ブートストラップで差が負になった割合。 */
  readonly shareBelowZero: number;
}

/** 同じレース集合の 2 モデルの損失の差を、レース単位の復元抽出で評価する(95% の百分位区間)。 */
export function pairedRaceBootstrap(races: readonly RaceLossPair[], iterations: number, seed: number): BootstrapResult {
  const meanOf = (idx: ReadonlyArray<RaceLossPair>): number => {
    let d = 0;
    let n = 0;
    for (const r of idx) {
      d += r.a - r.b;
      n += r.n;
    }
    return d / n;
  };
  const rnd = mulberry32(seed);
  const diffs: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const sample: RaceLossPair[] = [];
    for (let i = 0; i < races.length; i++) {
      sample.push(races[Math.floor(rnd() * races.length)]!);
    }
    diffs.push(meanOf(sample));
  }
  diffs.sort((x, y) => x - y);
  const q = (p: number): number => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(p * diffs.length)))]!;
  return {
    meanDiff: meanOf(races),
    ciLow: q(0.025),
    ciHigh: q(0.975),
    shareBelowZero: diffs.filter((d) => d < 0).length / diffs.length,
  };
}

export interface RoiResult {
  readonly bets: number;
  readonly stake: number;
  readonly payout: number;
  /** 払い戻し ÷ 賭け金。賭けが 0 件なら null。 */
  readonly roi: number | null;
}

/** 確率 × オッズが 1 を超える馬に 1 ずつ賭ける単勝の回収率(オッズは賭けた時点で使えるものを呼び出し側が渡す)。 */
export function singleWinRoi(rows: ReadonlyArray<{ p: number; odds: number; win: boolean }>): RoiResult {
  let bets = 0;
  let payout = 0;
  for (const r of rows) {
    if (r.p * r.odds > 1) {
      bets += 1;
      if (r.win) payout += r.odds;
    }
  }
  return { bets, stake: bets, payout, roi: bets === 0 ? null : payout / bets };
}
