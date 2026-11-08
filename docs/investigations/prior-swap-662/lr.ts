/**
 * prior を学習モデルに入れ替える試算の道具(Issue #662 段階 1)の純粋な部分。
 *
 * - `lrTop3`: 本番の `stat-shadow.ts` と同じ規則(特徴量 = log(頭数)・logit(prior)・名前で引く 15 項目の寄与〈無ければ 0〉、
 *   馬ごとのスコアにレース共通のロジットを足して合計 3 に合わせる〈`normalizeLogitShift` を本番から import〉、確率は [1e-6, 1−1e-6] に切る)で、
 *   係数だけを差し替えられるようにしたもの。本番の `computeShadowProbs` は係数が固定なので、同じ値になることをテストで固定した。
 * - `logLoss`・`calibrationBand`: 馬単位の 3着内率の当たり具合(対数損失・人気の帯)。
 */
import { normalizeLogitShift } from "../../../packages/core/src/ev/stat-shadow.js";
import type { ShadowModelCoef } from "../../../packages/core/src/ev/stat-shadow-coef.js";
import { bandOf } from "../combo-sharpen-661/sharpen.js";

/** 本番と同じ 5 頭未満は計算しない。 */
export const LR_MIN_FIELD = 5;
const EPS = 1e-6;
const clamp = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number): number => Math.log(p / (1 - p));

export interface LrHorse {
  readonly umaban: number;
  /** LLM の補正の前の統計モデルの 3着内率。 */
  readonly prior: number;
  /** 名前 → 補正値(無い名前は 0)。 */
  readonly contrib: Readonly<Record<string, number>>;
}

/** 学習モデル(3着内率の係数)で全馬の 3着内率を作る。5 頭未満は null。係数の特徴量は `log_n`・`prior_logit`・`c_<名前>` だけ(オッズなし版)。 */
export function lrTop3(horses: readonly LrHorse[], coef: ShadowModelCoef): Map<number, number> | null {
  const n = horses.length;
  if (n < LR_MIN_FIELD) return null;
  const feature = (name: string, h: LrHorse): number => {
    if (name === "log_n") return Math.log(n);
    if (name === "prior_logit") return logit(Math.min(1 - 1e-4, Math.max(1e-4, h.prior)));
    if (name.startsWith("c_")) return h.contrib[name.slice(2)] ?? 0;
    throw new Error(`この道具が扱わない特徴量です: ${name}`);
  };
  const scores = horses.map((h) => coef.features.reduce((s, f, k) => s + feature(f, h) * coef.top3.weights[k]!, coef.top3.intercept));
  const p = normalizeLogitShift(scores, 3).map(clamp);
  return new Map(horses.map((h, i) => [h.umaban, p[i]!] as const));
}

/** R2 の寄与の配列を 名前 → 補正値 にする。同じ名前は最初の 1 つ(本番の `find` と同じ)。applied は見ない(applied=false の補正値は 0)。 */
export function contribRecordFromArray(items: ReadonlyArray<{ readonly biasName: string; readonly correction: number; readonly applied?: boolean }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of items) if (!(c.biasName in out)) out[c.biasName] = c.correction;
  return out;
}

/** 馬単位の対数損失(平均)。確率は [1e-6, 1−1e-6] に切る。空は NaN。 */
export function logLoss(items: ReadonlyArray<{ readonly p: number; readonly y: 0 | 1 }>): number {
  if (items.length === 0) return Number.NaN;
  return -items.reduce((s, { p, y }) => s + (y === 1 ? Math.log(clamp(p)) : Math.log(1 - clamp(p))), 0) / items.length;
}

/** 人気の順位 → 帯(#661 と同じ区切り)。 */
export const calibrationBand = bandOf;
