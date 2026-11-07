/**
 * #653(2 本目の探索)の事前登録した判断(judge.ts)のテスト。
 * 計画: docs/investigations/market-blindspots-653-fable/plan.md §7。
 */

import { describe, expect, it } from "vitest";
import { holmAdjust, judgeHypotheses, normalSf, type CandidateResult } from "../market-blindspots-653-fable/judge.js";

const stats = (n: number, dPlace: number, zPlace: number, dWin = 0, zWin = 0) => ({
  n, d_place: dPlace, z_place: zPlace, d_win: dWin, z_win: zWin, roi_win: 0.8,
});

const cand = (name: string, over: Partial<CandidateResult> & { pB: number; dB: number; nB?: number; dA?: number; metric?: "place" | "win" }): CandidateResult => {
  const metric = over.metric ?? "place";
  const dA = over.dA ?? 2;
  const A = metric === "place" ? stats(1000, dA, 3) : stats(1000, 0, 0, dA, 3);
  const B = metric === "place" ? stats(over.nB ?? 1000, over.dB, 2) : stats(over.nB ?? 1000, 0, 0, over.dB, 2);
  return {
    family: "A:全体", name, metrics: [metric], A, B,
    tests: { [metric]: { sign: dA > 0 ? 1 : -1, p_one_sided_B: over.pB, ci_A: [0, 1], ci_B: [0, 1] } },
  };
};

describe("holmAdjust(Holm 補正)", () => {
  it("小さい順に (m−順位) 倍し、単調性を保つ", () => {
    const adj = holmAdjust([0.01, 0.04, 0.03]);
    // 順位: 0.01(×3=0.03), 0.03(×2=0.06), 0.04(×1=0.04 → 単調性で 0.06)
    expect(adj).toEqual([0.03, 0.06, 0.06]);
  });
  it("1 を超えない", () => {
    expect(holmAdjust([0.5, 0.9])).toEqual([1, 1]);
  });
  it("空なら空", () => {
    expect(holmAdjust([])).toEqual([]);
  });
});

describe("normalSf(標準正規の上側確率)", () => {
  it("z=1.96 で約 0.025、z=0 で 0.5、負の z で 1 に近づく", () => {
    expect(normalSf(1.96)).toBeCloseTo(0.025, 3);
    expect(normalSf(0)).toBeCloseTo(0.5, 6);
    expect(normalSf(-1.96)).toBeCloseTo(0.975, 3);
  });
});

describe("judgeHypotheses(事前登録の判断)", () => {
  it("向きが同じ・Holm p<0.05・後半 n≥300・差 ≥1pt(3着内)をすべて満たすと残る", () => {
    const hyps = judgeHypotheses([cand("残る", { pB: 0.001, dB: 1.5 })], 900);
    expect(hyps).toHaveLength(1);
    expect(hyps[0]!.survived).toBe(true);
    expect(hyps[0]!.holmP).toBeCloseTo(0.001, 9);
  });
  it("後半の向きが逆なら残らない", () => {
    const hyps = judgeHypotheses([cand("逆", { pB: 0.001, dB: -1.5 })], 900);
    expect(hyps[0]!.sameSign).toBe(false);
    expect(hyps[0]!.survived).toBe(false);
  });
  it("後半の件数が 300 未満なら残らない", () => {
    const hyps = judgeHypotheses([cand("少", { pB: 0.001, dB: 1.5, nB: 299 })], 900);
    expect(hyps[0]!.enoughB).toBe(false);
    expect(hyps[0]!.survived).toBe(false);
  });
  it("3着内の差が 1.0pt 未満なら残らない(勝ちは 0.5pt が境)", () => {
    const hyps = judgeHypotheses([cand("小", { pB: 0.001, dB: 0.9 }), cand("勝ち小", { pB: 0.001, dB: 0.4, metric: "win" }), cand("勝ち可", { pB: 0.001, dB: 0.5, metric: "win" })], 900);
    expect(hyps.map((h) => h.bigEnough)).toEqual([false, false, true]);
    expect(hyps.map((h) => h.survived)).toEqual([false, false, true]);
  });
  it("Holm 補正は仮説の数で行う(単独なら通る p が、3 つ並ぶと落ちる)", () => {
    const alone = judgeHypotheses([cand("x", { pB: 0.02, dB: 1.5 })], 900);
    expect(alone[0]!.survived).toBe(true);
    const three = judgeHypotheses([cand("x", { pB: 0.02, dB: 1.5 }), cand("y", { pB: 0.03, dB: 1.5 }), cand("z", { pB: 0.04, dB: 1.5 })], 900);
    expect(three.map((h) => h.holmP)).toEqual([0.06, 0.06, 0.06]);
    expect(three.every((h) => !h.survived)).toBe(true);
  });
  it("候補が 2 つの指標を持つと仮説が 2 つに展開される", () => {
    const c: CandidateResult = {
      family: "B:木", name: "両方", metrics: ["place", "win"], A: stats(1000, 2, 3, 1, 2.6), B: stats(1000, 1.2, 2, 0.6, 2),
      tests: { place: { sign: 1, p_one_sided_B: 0.01, ci_A: [0, 1], ci_B: [0, 1] }, win: { sign: 1, p_one_sided_B: 0.2, ci_A: [0, 1], ci_B: [0, 1] } },
    };
    const hyps = judgeHypotheses([c], 900);
    expect(hyps.map((h) => h.target)).toEqual(["place", "win"]);
    expect(hyps.map((h) => h.holmP)).toEqual([0.02, 0.2]);
    expect(hyps.map((h) => h.survived)).toEqual([true, false]);
  });
  it("★(strictA)は前半の |z| が Bonferroni 0.05/M(両側)を超えるときだけ", () => {
    // M=900: 両側 0.05/900 ≈ 5.6e-5 → |z| > 4.03。
    const strong: CandidateResult = { ...cand("強", { pB: 0.001, dB: 1.5 }), A: stats(1000, 2, 4.5) };
    const weak: CandidateResult = { ...cand("弱", { pB: 0.001, dB: 1.5 }), A: stats(1000, 2, 3.5) };
    const hyps = judgeHypotheses([strong, weak], 900);
    expect(hyps.map((h) => h.strictA)).toEqual([true, false]);
  });
});
