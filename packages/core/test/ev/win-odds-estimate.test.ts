import { describe, expect, it } from "vitest";
import {
  aggregateWinProbabilities,
  estimateFairWinOdds,
  estimateWinProbabilities,
  fairWinOddsOf,
  WIN_PAYOUT_RATE,
  WIN_PROB_TOP_FINISH_COUNT,
} from "../../src/ev/win-odds-estimate.js";
import { buildWinCandidates } from "../../src/ev/combo-bet-allocation.js";
import { PLACKETT_LUCE_MODEL, type JointModelHorse } from "../../src/ev/place-joint-model.js";
import { fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";
import { winProbabilitiesFromStrengths } from "../../src/ev/plackett-luce-win-prob.js";

/**
 * Issue #247: 分析から見た想定単勝オッズ(払戻率 ÷ 勝率)。勝率は配分(`buildWinCandidates`)と同じ経路
 * (Plackett-Luce の順序付き分布の `order[0]`)で、補正後の3着内率から推定する。
 */

function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** 12頭の典型的な入力(Σp=2.88。水詰めの再スケールで固定馬が出ない)。 */
const TYPICAL = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];
/** 固定馬がちょうど1頭になる入力(Σp<3 で、最上位が λ·p ≥ 1 に達する)。前提は下のテストで fit から固定する。 */
const ONE_FIXED = [0.99, 0.2, 0.2, 0.2, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.02, 0.02];
/** 固定馬が2頭になる入力。 */
const TWO_FIXED = [0.99, 0.98, 0.2, 0.2, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.02, 0.02];

describe("定数", () => {
  it("払戻率は 0.8、勝率の推定に使う上位着数は 3(配分の COMBO_TOP_FINISH_COUNT と同じ)", () => {
    expect(WIN_PAYOUT_RATE).toBe(0.8);
    expect(WIN_PROB_TOP_FINISH_COUNT).toBe(3);
  });
});

describe("aggregateWinProbabilities(順序付き分布の order[0] を馬ごとに合算)", () => {
  it("同じ馬が1着の outcome を足し合わせる", () => {
    const m = aggregateWinProbabilities([
      { order: [1, 2], probability: 0.2 },
      { order: [1, 3], probability: 0.3 },
      { order: [2, 1], probability: 0.5 },
    ]);
    expect(m.get(1)).toBeCloseTo(0.5, 12);
    expect(m.get(2)).toBeCloseTo(0.5, 12);
    expect(m.has(3)).toBe(false);
  });

  it("空の着順(出走0頭の縮退)は読み飛ばし、空の Map を返す", () => {
    expect(aggregateWinProbabilities([{ order: [], probability: 1 }]).size).toBe(0);
  });
});

describe("estimateWinProbabilities(補正後の3着内率 → 勝率)", () => {
  it("典型入力: Σ勝率=1 で、均等(1/12)ではなく、3着内率の高い馬ほど高く、独立に求めた θ/Σθ と一致する", () => {
    const hs = horses(TYPICAL);
    const win = estimateWinProbabilities(hs);
    expect(win).not.toBeNull();
    const probs = hs.map((h) => win!.get(h.umaban) ?? Number.NaN);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // 均等分布に潰れていないこと(前提を無条件に固定する)。
    expect(Math.max(...probs) - Math.min(...probs)).toBeGreaterThan(0.1);
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i - 1]!).toBeGreaterThan(probs[i]!);
    }
    // 別経路(θ から直接)との一致。
    const fit = fitPlackettLuceStrengths(hs, WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    const direct = winProbabilitiesFromStrengths(fit.theta);
    expect(direct).toHaveLength(probs.length);
    for (let i = 0; i < probs.length; i++) {
      expect(Math.abs(probs[i]! - direct[i]!)).toBeLessThan(1e-12);
    }
  });

  it("3着内率が 0 の馬は勝率 0(Map にはキーが残る)", () => {
    const win = estimateWinProbabilities(horses([...TYPICAL.slice(0, 10), 0, 0]));
    expect(win).not.toBeNull();
    expect(win!.get(11)).toBe(0);
    expect(win!.get(12)).toBe(0);
    expect(win!.get(1)!).toBeGreaterThan(0.2);
  });

  it("固定馬が1頭: その馬が勝率1、ほかは0(配分と同じ判定)", () => {
    const hs = horses(ONE_FIXED);
    const fit = fitPlackettLuceStrengths(hs, WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok && fit.degenerateFixedCount).toBe(1); // 前提
    const win = estimateWinProbabilities(hs)!;
    // 順序付き分布の確率の合算なので、浮動小数の端数(1 − 6e-16 程度)は残る。
    expect(win.get(1)!).toBeCloseTo(1, 12);
    expect(win.get(2)).toBe(0);
    expect(Math.abs(win.get(1)! - 1)).toBeLessThan(1e-12);
  });

  it("固定馬が2頭以上: 判定不能(null)。throw しない", () => {
    const hs = horses(TWO_FIXED);
    const fit = fitPlackettLuceStrengths(hs, WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok && fit.degenerateFixedCount).toBeGreaterThanOrEqual(2); // 前提
    expect(estimateWinProbabilities(hs)).toBeNull();
  });

  it("頭数が3以下(2頭以上): 判定不能(null)。配分の buildOrderedDistribution と同じ", () => {
    expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses([0.9, 0.6, 0.5]), 3)).toBeNull(); // 前提
    expect(estimateWinProbabilities(horses([0.9, 0.6, 0.5]))).toBeNull();
    expect(estimateWinProbabilities(horses([0.9, 0.6]))).toBeNull();
  });

  it("1頭だけなら勝率1", () => {
    expect(estimateWinProbabilities(horses([0.7]))!.get(1)).toBe(1);
  });

  it("出走0頭は空の Map", () => {
    expect(estimateWinProbabilities([])!.size).toBe(0);
  });
});

describe("配分との同一性(Issue #247: 配分の計算と同じ関数・同じ入力)", () => {
  it("buildWinCandidates の候補の ev は、estimateWinProbabilities の勝率 × オッズに一致する", () => {
    const hs = horses(TYPICAL);
    const win = estimateWinProbabilities(hs)!;
    // 全馬が EV プラスになるよう十分大きいオッズを渡す(候補の ev を全頭ぶん取り出すため)。
    const odds = new Map<number, number | null>(hs.map((h) => [h.umaban, 500]));
    const built = buildWinCandidates(hs, WIN_PROB_TOP_FINISH_COUNT, odds);
    expect(built.candidates).toHaveLength(hs.length); // 前提: 全頭ぶん取れている
    for (const c of built.candidates) {
      const u = c.umabans[0]!;
      expect(c.ev).toBe(win.get(u)! * 500);
    }
  });

  it("固定馬が1頭の入力でも、配分の候補の ev(勝率1 × オッズ)と一致する", () => {
    const hs = horses(ONE_FIXED);
    const odds = new Map<number, number | null>(hs.map((h) => [h.umaban, 500]));
    const built = buildWinCandidates(hs, WIN_PROB_TOP_FINISH_COUNT, odds);
    const first = built.candidates.find((c) => c.umabans[0] === 1);
    expect(first?.ev).toBeCloseTo(500, 9);
    expect(first?.ev).toBe(estimateWinProbabilities(hs)!.get(1)! * 500); // 同じ勝率なのでビット一致
    expect(built.candidates).toHaveLength(1); // 他の馬は勝率0で EV=0(候補にならない)
  });
});

describe("fairWinOddsOf(想定オッズ = 払戻率 ÷ 勝率)", () => {
  it.each([
    { winProb: 0.1, expected: 8 },
    { winProb: 0.2, expected: 4 },
    { winProb: 0.8, expected: 1 },
    { winProb: 1, expected: 0.8 },
  ])("勝率 $winProb → $expected 倍", ({ winProb, expected }) => {
    expect(fairWinOddsOf(winProb)).toBeCloseTo(expected, 12);
  });

  it("勝率 0・負・非有限は null(0除算で Infinity や NaN を出さない)", () => {
    expect(fairWinOddsOf(0)).toBeNull();
    expect(fairWinOddsOf(-0.1)).toBeNull();
    expect(fairWinOddsOf(Number.NaN)).toBeNull();
    expect(fairWinOddsOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("勝率が極小でも有限の巨大な値になる。結果が非有限になる勝率(オーバーフロー)は null", () => {
    expect(fairWinOddsOf(1e-9)).toBeCloseTo(8e8, 0);
    expect(Number.isFinite(fairWinOddsOf(1e-9)!)).toBe(true);
    expect(fairWinOddsOf(Number.MIN_VALUE)).toBeNull(); // 0.8 / 5e-324 = Infinity
  });
});

describe("estimateFairWinOdds(馬ごとの勝率と想定オッズ。throw しない)", () => {
  it("典型入力: 馬番ごとに winProb と fairWinOdds(= 0.8 / winProb)を返す。順序は入力と同じ", () => {
    const rows = estimateFairWinOdds(horses(TYPICAL));
    expect(rows.map((r) => r.umaban)).toEqual(TYPICAL.map((_, i) => i + 1));
    for (const r of rows) {
      expect(r.winProb).not.toBeNull();
      expect(r.fairWinOdds).toBeCloseTo(WIN_PAYOUT_RATE / r.winProb!, 12);
    }
    // 例: 最上位馬の想定は 0.8 / 勝率(= 3.65 倍付近)。丸め前の値で固定する。
    expect(rows[0]!.fairWinOdds!).toBeGreaterThan(3.5);
    expect(rows[0]!.fairWinOdds!).toBeLessThan(3.8);
  });

  it("3着内率 0 の馬は winProb=0・fairWinOdds=null", () => {
    const rows = estimateFairWinOdds(horses([...TYPICAL.slice(0, 11), 0]));
    expect(rows[11]).toEqual({ umaban: 12, winProb: 0, fairWinOdds: null });
    expect(rows[0]!.fairWinOdds).not.toBeNull();
  });

  it("固定馬1頭: 想定 0.8 倍。ほかは winProb=0・fairWinOdds=null", () => {
    const rows = estimateFairWinOdds(horses(ONE_FIXED));
    expect(rows[0]!.winProb!).toBeCloseTo(1, 12);
    expect(rows[0]!.fairWinOdds!).toBeCloseTo(WIN_PAYOUT_RATE, 12);
    expect(rows[1]).toEqual({ umaban: 2, winProb: 0, fairWinOdds: null });
  });

  it("判定不能(固定馬2頭以上・3頭以下)は全馬 winProb=null・fairWinOdds=null", () => {
    for (const probs of [TWO_FIXED, [0.9, 0.6, 0.5]]) {
      const rows = estimateFairWinOdds(horses(probs));
      expect(rows).toHaveLength(probs.length);
      for (const r of rows) {
        expect(r.winProb).toBeNull();
        expect(r.fairWinOdds).toBeNull();
      }
    }
  });

  it("不正な入力(範囲外・NaN の3着内率)でも throw せず、全馬 null", () => {
    for (const bad of [Number.NaN, 1.5, -0.2]) {
      const rows = estimateFairWinOdds(horses([bad, ...TYPICAL.slice(1)]));
      expect(rows).toHaveLength(TYPICAL.length);
      expect(rows.every((r) => r.winProb === null && r.fairWinOdds === null)).toBe(true);
    }
  });

  it("出走0頭は空配列", () => {
    expect(estimateFairWinOdds([])).toEqual([]);
  });

  it("取消の馬がいない前提: 出走頭数ぶんだけ返り、Σ勝率=1(頭数を減らした入力でも 1)", () => {
    for (const probs of [TYPICAL, TYPICAL.slice(0, 11)]) {
      const rows = estimateFairWinOdds(horses(probs));
      expect(rows).toHaveLength(probs.length);
      expect(rows.reduce((s, r) => s + (r.winProb ?? Number.NaN), 0)).toBeCloseTo(1, 12);
    }
  });
});
