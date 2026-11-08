/**
 * #664 の学習モデル(足した後のオッズなし版)で 3着内率を作る試算の道具(Issue #664 段階 1b)の純粋な部分。
 * #662 の `lrTop3`(docs/investigations/prior-swap-662/lr.ts)と同じ規則で、特徴量に旗 14 個と見習の印 5 個を足せるようにしたもの。
 * 特徴量の順と中身は scripts/stat-features-664/fit_eval.py の noodds_all(BASE_NO + ALL_ADD)と同じ。
 */
import { normalizeLogitShift } from "../../../packages/core/src/ev/stat-shadow.js";
import type { ShadowModelCoef } from "../../../packages/core/src/ev/stat-shadow-coef.js";
import { LR_MIN_FIELD, type LrHorse } from "../prior-swap-662/lr.js";

const EPS = 1e-6;
const clamp = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number): number => Math.log(p / (1 - p));

/** fit_eval.py の FLAGS から、参考表だけの版(foreignJCnoLemaire・foreignJCnoLD)を除いた 14 個。 */
export const FLAG_FEATURES = [
  "noprev", "turf2dirt", "dirt2turf", "rest180", "mid1w", "distUp400", "filly", "age7", "wLight", "wHeavy",
  "eastInWest", "westInEast", "foreignJC", "gain4",
] as const;
/** #652 の見習の印 5 種(fit_eval.py の MK と同じ順)。 */
export const MARK_FEATURES = ["mk_▲", "mk_△", "mk_☆", "mk_◇", "mk_★"] as const;

export interface Lr664Horse extends LrHorse {
  /** 旗と印(名前 → 0/1)。`buildExtra` で作る。 */
  readonly extra: Readonly<Record<string, number>>;
}

/** 特徴量の行(feat664)と印から、旗と印の値を作る。行が無い馬は noprev=1・ほかの旗は 0(fit_eval.py と同じ)。 */
export function buildExtra(row: Readonly<Record<string, number>> | undefined, mark: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FLAG_FEATURES) out[f] = row !== undefined ? Number(row[f] ?? 0) : f === "noprev" ? 1 : 0;
  for (const m of MARK_FEATURES) out[m] = mark !== null && m === `mk_${mark}` ? 1 : 0;
  return out;
}

/** #664 の学習モデル(3着内率の係数)で全馬の 3着内率を作る。5 頭未満は null。知らない特徴量は例外。 */
export function lr664Top3(horses: readonly Lr664Horse[], coef: ShadowModelCoef): Map<number, number> | null {
  const n = horses.length;
  if (n < LR_MIN_FIELD) return null;
  const feature = (name: string, h: Lr664Horse): number => {
    if (name === "log_n") return Math.log(n);
    if (name === "prior_logit") return logit(Math.min(1 - 1e-4, Math.max(1e-4, h.prior)));
    if (name.startsWith("c_")) return h.contrib[name.slice(2)] ?? 0;
    const v = h.extra[name];
    if (v === undefined) throw new Error(`この道具が扱わない特徴量です: ${name}`);
    return v;
  };
  const scores = horses.map((h) => coef.features.reduce((s, f, k) => s + feature(f, h) * coef.top3.weights[k]!, coef.top3.intercept));
  const p = normalizeLogitShift(scores, 3).map(clamp);
  return new Map(horses.map((h, i) => [h.umaban, p[i]!] as const));
}
