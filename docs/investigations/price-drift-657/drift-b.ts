/** #657-0b の純粋な部分。計画は plan-0b.md。 */

/** 確定の単勝オッズ → 勝率(1/オッズをレース内で正規化)。 */
export function marketWinProbs(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((v) => v / s);
}

/** 勝率 → 3 着内率。q3 = 1 − (1 − q)^k を Σq3 = 3 になる k で決める(二分法)。3 頭以下は null。 */
export function marketTop3Probs(q: readonly number[]): number[] | null {
  if (q.length <= 3) return null;
  const sum = (k: number): number => q.reduce((a, v) => a + (1 - (1 - v) ** k), 0);
  let lo = 1, hi = 64; // k=1 で Σ = 1、k が大きいほど増える
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) < 3) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return q.map((v) => 1 - (1 - v) ** k);
}

/** 比率の Wilson の 95% 区間。 */
export function wilson(x: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964, p = x / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function band(ninki: number): number { return ninki <= 3 ? 0 : ninki <= 6 ? 1 : 2; }

/** 人気帯ごとに ln(比) の下位 10%(帯の頭数 × 0.1 を切り捨て、最低 1 頭)に印を付ける。入力の順に返す。 */
export function bandDropFlags(hs: readonly { ninki: number; ratio: number }[]): boolean[] {
  const flags = hs.map(() => false);
  for (let b = 0; b < 3; b++) {
    const idx = hs.map((h, i) => ({ i, h })).filter((x) => band(x.h.ninki) === b).sort((a, c) => a.h.ratio - c.h.ratio);
    const n = Math.max(1, Math.floor(idx.length * 0.1));
    if (idx.length === 0) continue;
    for (let j = 0; j < n; j++) flags[idx[j]!.i] = true;
  }
  return flags;
}

export function weightBand(w: number | null): "不明" | "-439" | "440-479" | "480-519" | "520-" {
  if (w === null) return "不明";
  return w < 440 ? "-439" : w < 480 ? "440-479" : w < 520 ? "480-519" : "520-";
}
