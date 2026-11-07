/**
 * #653(2 本目の探索): 事前登録した判断(計画 §7)を候補の結果(confirm.py の results.json)に当てて、残った条件と残らなかった条件の表を出す。
 *
 * 判断(後半でも「残った」とする条件):
 *  1. 後半の件数 n ≥ 300。
 *  2. 前半と同じ向き(d の符号が同じ)。
 *  3. 候補になった指標(3着内または勝ち)で、後半の片側 p 値が、仮説の数(候補 × 指標)で Holm 補正しても 0.05 未満。
 *  4. 後半の |d| が 1.0 pt 以上(3着内)または 0.5 pt 以上(勝ち)。
 * 加えて、前半の |z| が走査の総数 M で Bonferroni 補正した 0.05 水準(両側)を超えるものに印(strictA)を付ける。
 *
 * 使い方: pnpm tsx scripts/market-blindspots-653-fable/judge.ts <results.json>  → Markdown の表を標準出力に出す。
 * 純粋な判定の関数(holmAdjust・judgeHypotheses)は scripts/test/market-blindspots-653-judge.test.ts で検査する。
 */

import { readFileSync } from "node:fs";

export type Target = "place" | "win";

export interface PeriodStats {
  readonly n: number;
  readonly d_place: number;
  readonly z_place: number;
  readonly d_win: number;
  readonly z_win: number;
  readonly roi_win: number;
}

export interface CandidateResult {
  readonly family: string;
  readonly name: string;
  readonly metrics: readonly Target[];
  readonly A: PeriodStats;
  readonly B: PeriodStats;
  readonly tests: Readonly<Record<string, { readonly sign: 1 | -1; readonly p_one_sided_B: number; readonly ci_A: readonly [number, number]; readonly ci_B: readonly [number, number] }>>;
}

export interface Hypothesis {
  readonly index: number;
  readonly family: string;
  readonly name: string;
  readonly target: Target;
  readonly nA: number;
  readonly nB: number;
  readonly dA: number;
  readonly dB: number;
  readonly zA: number;
  readonly zB: number;
  readonly pB: number;
  readonly holmP: number;
  readonly sameSign: boolean;
  readonly enoughB: boolean;
  readonly bigEnough: boolean;
  readonly strictA: boolean;
  readonly survived: boolean;
  readonly roiA: number;
  readonly roiB: number;
  readonly ciA: readonly [number, number];
  readonly ciB: readonly [number, number];
}

export const MIN_N_B = 300;
export const HOLM_ALPHA = 0.05;
export const MIN_D: Readonly<Record<Target, number>> = { place: 1.0, win: 0.5 };

/** Holm 補正。入力の順序のまま、補正した p 値を返す(単調性を保つ)。 */
export function holmAdjust(pvals: readonly number[]): number[] {
  const m = pvals.length;
  const order = pvals.map((_, i) => i).sort((a, b) => pvals[a]! - pvals[b]!);
  const adj = new Array<number>(m).fill(0);
  let running = 0;
  order.forEach((i, rank) => {
    const val = Math.min(1, (m - rank) * pvals[i]!);
    running = Math.max(running, val);
    adj[i] = running;
  });
  return adj;
}

/** 標準正規の上側確率(両側 0.05/M の水準に使う)。Abramowitz–Stegun 26.2.17 の近似(誤差 < 7.5e-8)。 */
export function normalSf(z: number): number {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const sf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * poly;
  return z >= 0 ? sf : 1 - sf;
}

/** 候補 × 指標を仮説に展開し、事前登録の判断を当てる。M は走査した条件の総数(Bonferroni の分母)。 */
export function judgeHypotheses(results: readonly CandidateResult[], M: number): Hypothesis[] {
  const flat: { r: CandidateResult; t: Target; p: number }[] = [];
  for (const r of results) {
    for (const t of r.metrics) {
      const test = r.tests[t];
      if (test === undefined) throw new Error(`tests に ${t} が無い: ${r.name}`);
      flat.push({ r, t, p: test.p_one_sided_B });
    }
  }
  const holm = holmAdjust(flat.map((h) => h.p));
  return flat.map(({ r, t, p }, i) => {
    const dA = r.A[`d_${t}`];
    const dB = r.B[`d_${t}`];
    const zA = r.A[`z_${t}`];
    const sameSign = Math.sign(dA) === Math.sign(dB) && dB !== 0;
    const enoughB = r.B.n >= MIN_N_B;
    const bigEnough = Math.abs(dB) >= MIN_D[t];
    const holmP = holm[i]!;
    const strictA = 2 * normalSf(Math.abs(zA)) < 0.05 / M;
    const test = r.tests[t]!;
    return {
      index: i, family: r.family, name: r.name, target: t, nA: r.A.n, nB: r.B.n, dA, dB, zA, zB: r.B[`z_${t}`], pB: p, holmP,
      sameSign, enoughB, bigEnough, strictA, survived: enoughB && sameSign && holmP < HOLM_ALPHA && bigEnough,
      roiA: r.A.roi_win, roiB: r.B.roi_win, ciA: test.ci_A, ciB: test.ci_B,
    };
  });
}

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "—");
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "—");
const tgt = (t: Target): string => (t === "place" ? "3着内" : "勝ち");

export function renderMarkdown(hyps: readonly Hypothesis[], M: number): string {
  const survived = hyps.filter((h) => h.survived);
  const failed = hyps.filter((h) => !h.survived);
  const row = (h: Hypothesis): string =>
    `| ${h.family} | ${h.name} | ${tgt(h.target)} | ${h.nA} / ${h.nB} | ${f2(h.dA)} [${f1(h.ciA[0])}, ${f1(h.ciA[1])}] | ${f2(h.zA)}${h.strictA ? " ★" : ""} | ${f2(h.dB)} [${f1(h.ciB[0])}, ${f1(h.ciB[1])}] | ${f2(h.zB)} | ${h.holmP.toExponential(1)} | ${f2(h.roiA)} / ${f2(h.roiB)} |`;
  const header = "| 族 | 条件 | 指標 | n 前半 / 後半 | 前半 d pt [95%] | 前半 z | 後半 d pt [95%] | 後半 z | Holm p(後半) | 単勝回収率 前半 / 後半 |\n|---|---|---|---|---|---|---|---|---|---|";
  const lines = [
    `走査した条件 M=${M}、仮説 ${hyps.length}(候補 ${new Set(hyps.map((h) => h.name + h.family)).size} 件)、残った ${survived.length}。★ = 前半の |z| が Bonferroni(0.05/M、両側)を超える。`,
    "",
    "### 後半でも残った条件",
    header,
    ...survived.sort((a, b) => Math.abs(b.zB) - Math.abs(a.zB)).map(row),
    "",
    "### 前半だけだった条件(残らなかった候補)",
    header,
    ...failed.sort((a, b) => Math.abs(b.zA) - Math.abs(a.zA)).map((h) => row(h) + ` ${[!h.enoughB ? "後半 n<300" : "", !h.sameSign ? "向きが逆" : "", h.sameSign && h.holmP >= HOLM_ALPHA ? "Holm p≥0.05" : "", h.sameSign && !h.bigEnough ? "差が小さい" : ""].filter((s) => s !== "").join("・")}`),
  ];
  return lines.join("\n");
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) throw new Error("使い方: judge.ts <results.json>");
  const data = JSON.parse(readFileSync(path, "utf8")) as { M: number; results: CandidateResult[] };
  const hyps = judgeHypotheses(data.results, data.M);
  process.stdout.write(renderMarkdown(hyps, data.M) + "\n");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("judge.ts")) {
  main();
}
