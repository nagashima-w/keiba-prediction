/**
 * prior を学習モデルに入れ替える試算の道具(Issue #662 段階 1。docs/investigations/prior-swap-662/lr.ts)の純粋な部分のテスト。
 */
import { describe, expect, it } from "vitest";
import { computeShadowProbs, SHADOW_MODEL_NODDS } from "../../packages/core/src/ev/stat-shadow.js";
import { SHADOW_COEF_NODDS, SHADOW_CONTRIB_NAMES } from "../../packages/core/src/ev/stat-shadow-coef.js";
import { calibrationBand, contribRecordFromArray, logLoss, lrTop3 } from "../../docs/investigations/prior-swap-662/lr.js";

/** 疑似乱数(再現のため固定)。 */
function rng(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function field(n: number, seed: number) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    umaban: i + 1,
    prior: 0.05 + 0.5 * r(),
    contrib: Object.fromEntries(SHADOW_CONTRIB_NAMES.map((k) => [k, (r() - 0.5) * 0.2])) as Record<string, number>,
  }));
}

describe("lrTop3(本番の computeShadowProbs〈オッズなし版〉との突き合わせ)", () => {
  it.each([5, 8, 12, 18])("%i 頭: 本番の関数と 3着内率が 1e-12 以内で一致し、差の確認のため値は 0.01 以上ばらつく", (n) => {
    const horses = field(n, n);
    const mine = lrTop3(horses, SHADOW_COEF_NODDS)!;
    const prod = computeShadowProbs(horses.map((h) => ({
      umaban: h.umaban, prior: h.prior, winOdds: null,
      contributions: Object.entries(h.contrib).map(([biasName, correction]) => ({ biasName, applied: true, weight: 1, correction, reason: "" })),
    }))).filter((p) => p.model === SHADOW_MODEL_NODDS);
    expect(prod).toHaveLength(n);
    const vals = prod.map((p) => p.top3Prob);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.01);
    for (const p of prod) expect(Math.abs(mine.get(p.umaban)! - p.top3Prob)).toBeLessThan(1e-12);
    expect([...mine.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(3, 9);
  });

  it("5 頭未満は計算しない(null)", () => {
    expect(lrTop3(field(4, 1), SHADOW_COEF_NODDS)).toBeNull();
  });

  it("寄与に無い名前は 0 として扱う(空の寄与と、全項目 0 の寄与が同じ結果)", () => {
    const base = field(8, 3);
    const empty = base.map((h) => ({ ...h, contrib: {} }));
    const zero = base.map((h) => ({ ...h, contrib: Object.fromEntries(SHADOW_CONTRIB_NAMES.map((k) => [k, 0])) }));
    const a = lrTop3(empty, SHADOW_COEF_NODDS)!, b = lrTop3(zero, SHADOW_COEF_NODDS)!;
    for (const [u, p] of a) expect(b.get(u)).toBeCloseTo(p, 12);
    const withContrib = lrTop3(base, SHADOW_COEF_NODDS)!;
    expect(Math.abs(withContrib.get(1)! - a.get(1)!)).toBeGreaterThan(1e-4); // 寄与を入れると値が動く(上の一致が自明でない)
  });
});

describe("contribRecordFromArray(R2 の寄与の配列 → 名前 → 補正値)", () => {
  it("同じ名前が複数あれば最初の 1 つ(本番の find と同じ)、applied=false も補正値 0 としてそのまま", () => {
    const r = contribRecordFromArray([
      { biasName: "近走着順", correction: -0.066, applied: true },
      { biasName: "上がり3F", correction: 0, applied: false },
      { biasName: "近走着順", correction: 9, applied: true },
    ]);
    expect(r).toEqual({ 近走着順: -0.066, 上がり3F: 0 });
  });
});

describe("logLoss", () => {
  it("手計算: p=0.8 で的中・p=0.25 で外れ → −(ln0.8 + ln0.75)/2", () => {
    expect(logLoss([{ p: 0.8, y: 1 }, { p: 0.25, y: 0 }])).toBeCloseTo(-(Math.log(0.8) + Math.log(0.75)) / 2, 12);
  });
  it("確率 0・1 の端は 1e-6 に切る(無限大にしない)", () => {
    expect(Number.isFinite(logLoss([{ p: 0, y: 1 }]))).toBe(true);
    expect(logLoss([{ p: 0, y: 1 }])).toBeCloseTo(-Math.log(1e-6), 9);
  });
  it("空は NaN", () => { expect(logLoss([])).toBeNaN(); });
});

describe("calibrationBand(人気の順位 → 帯)", () => {
  it.each([[1, "1〜3番人気"], [3, "1〜3番人気"], [4, "4〜6番人気"], [6, "4〜6番人気"], [7, "7番人気〜"], [18, "7番人気〜"]])("%i → %s", (rank, band) => {
    expect(calibrationBand(rank as number)).toBe(band);
  });
});
