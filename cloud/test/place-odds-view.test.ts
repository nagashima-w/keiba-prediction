import { describe, expect, it } from "vitest";

import { resolvePlaceBetTarget } from "../../packages/app/src/shared/race-allocation";
import { estimateFairPlaceOdds } from "../../packages/core/src/ev/place-odds-estimate";
import { estimatePlaceOddsForRace, placeOddsBasisOf } from "../src/place-odds-view";

/**
 * Issue #253: 出走頭数から想定複勝オッズの基準を決める(8頭以上=3着内率・5〜7頭=2着内率・4頭以下と判定不能=出さない)。
 * 判定は配分の複勝の対象判定(`resolvePlaceBetTarget`)をそのまま使う(頭数のしきい値を2か所に持たない)。
 */

const rows = (probs: readonly number[]): { umaban: number; adjustedProb: number }[] => probs.map((adjustedProb, i) => ({ umaban: i + 1, adjustedProb }));

describe("placeOddsBasisOf(出走頭数 → 基準)", () => {
  it.each([
    [0, null],
    [1, null],
    [2, null],
    [3, null],
    [4, null],
    [5, "top2"],
    [6, "top2"],
    [7, "top2"],
    [8, "top3"],
    [9, "top3"],
    [16, "top3"],
    [18, "top3"],
    [Number.NaN, null],
    [7.5, null],
    [-1, null],
  ] as const)("%d頭 → %s", (n, expected) => {
    expect(placeOddsBasisOf(n)).toBe(expected);
  });

  it("配分の複勝の対象判定(resolvePlaceBetTarget)と食い違わない: 0〜20頭すべてで、available → top3・two-place-only → top2・それ以外 → null", () => {
    const seen = new Set<string>();
    for (let n = 0; n <= 20; n++) {
      const target = resolvePlaceBetTarget(n);
      const expected = target.available ? "top3" : target.reason === "two-place-only" ? "top2" : null;
      expect(placeOddsBasisOf(n), `${n}頭`).toBe(expected);
      seen.add(String(expected));
    }
    expect([...seen].sort()).toEqual(["null", "top2", "top3"]); // 前提: 3分類すべてを通っている
  });
});

describe("estimatePlaceOddsForRace(馬ごとの想定複勝オッズ)", () => {
  const TWELVE = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];
  const SIX = [0.7, 0.6, 0.5, 0.5, 0.4, 0.3];

  it("12頭(8頭以上): basis=top3。想定は 0.8 ÷ 3着内率", () => {
    const r = estimatePlaceOddsForRace(rows(TWELVE));
    expect(r.basis).toBe("top3");
    expect(r.byUmaban.get(1)!).toBeCloseTo(0.8 / 0.55, 12);
    expect(r.byUmaban.get(12)!).toBeCloseTo(0.8 / 0.03, 12);
    expect(r.byUmaban.size).toBe(12);
  });

  it("6頭(5〜7頭): basis=top2。想定は 2着内率から(core の estimateFairPlaceOdds と一致)。3着内率から出した値より高い", () => {
    const r = estimatePlaceOddsForRace(rows(SIX));
    expect(r.basis).toBe("top2");
    const core = estimateFairPlaceOdds(SIX.map((p, i) => ({ umaban: i + 1, placeProb: p })), "top2");
    expect(core.every((e) => e.fairPlaceOdds !== null)).toBe(true); // 前提
    for (const e of core) {
      expect(r.byUmaban.get(e.umaban)).toBe(e.fairPlaceOdds);
    }
    expect(r.byUmaban.get(1)! - 0.8 / 0.7).toBeGreaterThan(0.3);
  });

  it("4頭以下: basis=null。想定は全馬 null(3着内率が入っていても出さない)", () => {
    const r = estimatePlaceOddsForRace(rows([0.9, 0.7, 0.6, 0.5]));
    expect(r.basis).toBeNull();
    expect(r.byUmaban.size).toBe(4); // 前提: 馬は全頭いる
    expect([...r.byUmaban.values()].every((v) => v === null)).toBe(true);
  });

  it("出走0頭: basis=null で空", () => {
    const r = estimatePlaceOddsForRace([]);
    expect(r.basis).toBeNull();
    expect(r.byUmaban.size).toBe(0);
  });

  it("5〜7頭で判定不能(固定馬が2頭以上)は、basis=top2 のまま全馬 null(throw しない)", () => {
    const r = estimatePlaceOddsForRace(rows([0.99, 0.98, 0.3, 0.1, 0.05, 0.05]));
    expect(r.basis).toBe("top2");
    expect(r.byUmaban.size).toBe(6);
    expect([...r.byUmaban.values()].every((v) => v === null)).toBe(true);
  });
});
