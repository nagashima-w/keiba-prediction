import { describe, expect, it } from "vitest";
import { winProbabilitiesFromStrengths } from "../../src/ev/plackett-luce-win-prob.js";
import { fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";

function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

describe("winProbabilitiesFromStrengths(θ→1着確率の純関数)", () => {
  it("Σ winProb = 1", () => {
    const theta = [2, 3, 5];
    const winProb = winProbabilitiesFromStrengths(theta);
    const sum = winProb.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("winProb_i ∝ θ_i(比率が保たれる)", () => {
    const theta = [2, 4, 6];
    const winProb = winProbabilitiesFromStrengths(theta);
    // θ[1]/θ[0]=2 なので winProb[1]/winProb[0]も2のはず。
    expect(winProb[1]! / winProb[0]!).toBeCloseTo(2, 9);
    expect(winProb[2]! / winProb[0]!).toBeCloseTo(3, 9);
  });

  describe("AC-8: k=1のときwinProbが入力pと一致する(Σp=1ちょうどの場合のみ厳密一致)", () => {
    it("Σp=1ちょうどの入力: winProbが入力pと一致し、rescaleApplied=falseも固定する", () => {
      const probs = [0.5, 0.3, 0.2];
      const fit = fitPlackettLuceStrengths(horses(probs), 1);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.rescaleApplied).toBe(false); // 前提: λが効いていないことを固定する
      const winProb = winProbabilitiesFromStrengths(fit.theta as number[]);
      for (let i = 0; i < probs.length; i++) {
        expect(winProb[i]).toBeCloseTo(probs[i]!, 6);
      }
    });

    it("Σp≠1の対照: winProbは入力pと一致せず、再スケール後の値(λ・p)と一致する", () => {
      const probs = [0.3, 0.3, 0.3, 0.3]; // Σ=1.2 ≠ 1
      const fit = fitPlackettLuceStrengths(horses(probs), 1);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.rescaleApplied).toBe(true); // 前提: 再スケールが働いたことを固定する
      const winProb = winProbabilitiesFromStrengths(fit.theta as number[]);
      // 入力pとは一致しないことを先に固定する(空振り防止)。
      expect(Math.abs(winProb[0]! - probs[0]!)).toBeGreaterThan(1e-6);
      // 再スケール後の値(λ・p_i)と一致することを固定する。
      const lambda = fit.rescaleFactor;
      for (let i = 0; i < probs.length; i++) {
        expect(winProb[i]).toBeCloseTo(lambda * probs[i]!, 6);
      }
    });

    it("k'=1の反復回数はリテラルで0(閉形式・反復不要)", () => {
      const fit = fitPlackettLuceStrengths(horses([0.5, 0.3, 0.2]), 1);
      expect(fit.ok).toBe(true);
      if (fit.ok) expect(fit.iterations).toBe(0);
    });
  });

  describe("既知の制約: θに2個以上のInfinityを含む場合は例外を投げる", () => {
    it("Infinityが2個ある場合は例外を投げる", () => {
      const theta = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 3, 2];
      expect(() => winProbabilitiesFromStrengths(theta)).toThrow();
    });

    it("Infinityが1個の場合はそれが1・他は0(正の対照。1個は不定にならない)", () => {
      const theta = [Number.POSITIVE_INFINITY, 3, 2];
      const winProb = winProbabilitiesFromStrengths(theta);
      expect(winProb).toEqual([1, 0, 0]);
    });
  });

  it("θの合計が0以下・非有限なら例外を投げる", () => {
    expect(() => winProbabilitiesFromStrengths([0, 0, 0])).toThrow();
    expect(() => winProbabilitiesFromStrengths([Number.NaN, 1, 1])).toThrow();
  });
});
