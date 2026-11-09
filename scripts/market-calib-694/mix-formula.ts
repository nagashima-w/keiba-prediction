/**
 * #694 の試算用: `allocation-shrink-656/mix.ts` と同じ混ぜ方・ずらし方で、市場の 3着内率 m の式だけを差し替えられるようにしたもの。本番には入れない。
 * 式の係数は `docs/investigations/market-calib-694/fit-coef.json`(F_prod・F0〜F3)。
 */
import { readFileSync } from "node:fs";

export type FormulaId = "F_prod" | "F0" | "F1" | "F2" | "F3";
export interface FitCoef { readonly knots: readonly number[]; readonly coef: Readonly<Record<FormulaId, readonly number[]>> }

export const loadFitCoef = (path: string): FitCoef => JSON.parse(readFileSync(path, "utf8")) as FitCoef;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(Math.min(z, 35), -35)));
const logit = (p: number): number => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

/** 1 頭の m。L = logit(q)、n = 頭数。 */
export function formulaM(f: FormulaId, fc: FitCoef, L: number, n: number): number {
  const w = fc.coef[f];
  const lnn = Math.log(n);
  let z: number;
  if (f === "F_prod" || f === "F0") z = w[0]! + w[1]! * L + w[2]! * lnn;
  else if (f === "F1") z = w[0]! + w[1]! * L + w[2]! * lnn + w[3]! * L * L;
  else if (f === "F3") z = w[0]! + w[1]! * L + w[2]! * lnn + w[3]! * L * L + w[4]! * L * lnn;
  else z = w[0]! + w[1]! * L + w[2]! * lnn + fc.knots.reduce((a, k, i) => a + w[3 + i]! * Math.max(0, L - k), 0);
  return sigmoid(z);
}

export interface MixHorse { readonly umaban: number; readonly p: number; readonly winOdds: number | null }

/** 馬ごとの m(単勝オッズの無い馬は含めない)。頭数は単勝オッズのある馬の数。 */
export function marketProbs(horses: readonly MixHorse[], f: FormulaId, fc: FitCoef): Map<number, number> {
  const used = horses.filter((h) => h.winOdds !== null && h.winOdds > 0);
  const out = new Map<number, number>();
  if (used.length === 0) return out;
  const inv = used.map((h) => 1 / (h.winOdds as number));
  const total = inv.reduce((a, b) => a + b, 0);
  used.forEach((h, i) => out.set(h.umaban, formulaM(f, fc, logit(inv[i]! / total), used.length)));
  return out;
}

/** 混ぜた 3着内率(馬番 → p')。`allocation-shrink-656/mix.ts` の `mixProbs` と同じ。 */
export function mixWith(horses: readonly MixHorse[], w: number, f: FormulaId, fc: FitCoef): Map<number, number> {
  const m = marketProbs(horses, f, fc);
  const z = horses.map((h) => {
    const mm = m.get(h.umaban);
    return w * logit(h.p) + (1 - w) * (mm === undefined ? logit(h.p) : logit(mm));
  });
  const target = Math.min(3, horses.length);
  let lo = -20, hi = 20;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const s = z.reduce((a, v) => a + sigmoid(v + mid), 0);
    if (s < target) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  return new Map(horses.map((h, i) => [h.umaban, sigmoid(z[i]! + d)] as const));
}
