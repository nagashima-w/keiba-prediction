/**
 * 確率を市場に寄せる計算(Issue #656 の試算用)。本番には入れない。
 * logit(p') = w·logit(p) + (1−w)·logit(m) を混ぜ、レース内の合計が min(3, 頭数) になるよう共通のロジットのずらしで合わせる。
 * m は 単勝オッズの 1/オッズをレース内で割り戻した q から、切片 + logit(q) + log(頭数) のロジスティック(係数は #642・#649 と同じ)で出した 3着内率。
 */
export const MARKET_COEF = [2.857, 0.9216, -0.5561] as const;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(Math.min(z, 35), -35)));
const logit = (p: number): number => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

export interface MixHorse { readonly umaban: number; readonly p: number; readonly winOdds: number | null }

/** 馬ごとの市場の 3着内率 m(単勝オッズが無い馬は null)。頭数は単勝オッズのある馬の数。 */
export function marketPlaceProbs(horses: readonly MixHorse[]): Map<number, number> {
  const used = horses.filter((h) => h.winOdds !== null && h.winOdds > 0);
  const out = new Map<number, number>();
  if (used.length === 0) return out;
  const inv = used.map((h) => 1 / (h.winOdds as number));
  const total = inv.reduce((a, b) => a + b, 0);
  const lf = Math.log(used.length);
  used.forEach((h, i) => out.set(h.umaban, sigmoid(MARKET_COEF[0] + MARKET_COEF[1] * logit(inv[i]! / total) + MARKET_COEF[2] * lf)));
  return out;
}

/** 混ぜた 3着内率(馬番 → p')。単勝オッズの無い馬は混ぜず(m = p)、ずらしの対象には含める。 */
export function mixProbs(horses: readonly MixHorse[], w: number): Map<number, number> {
  const m = marketPlaceProbs(horses);
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
