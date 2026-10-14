import { describe, expect, it } from "vitest";
import {
  estimateFairPlaceOdds,
  fairPlaceOddsOf,
  PLACE_PAYOUT_RATE,
} from "../../src/ev/place-odds-estimate.js";
import {
  aggregateTopFinishProbabilities,
  aggregateWinProbabilities,
  estimateWinProbabilities,
  WIN_PROB_TOP_FINISH_COUNT,
} from "../../src/ev/win-odds-estimate.js";
import { PLACKETT_LUCE_MODEL, type JointModelHorse } from "../../src/ev/place-joint-model.js";
import { fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";

/**
 * Issue #253: 分析から見た想定複勝オッズ(払戻率 0.8 ÷ 複勝の的中率)。
 *  - 8頭以上(3着まで払戻): 的中率 = 補正後の3着内率(`adjustedProb`)そのもの(basis="top3")
 *  - 5〜7頭(2着まで払戻): 的中率 = 2着内率 = Plackett-Luce の上位3着の分布(勝率と同じ経路)の order[0] と order[1] の確率の合算(basis="top2")
 * 頭数から basis を決めるのは呼び出し側(`resolvePlaceBetTarget`。core は app に依存しない)。
 */

function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** 6頭・Σp=3(5〜7頭の典型。水詰めの再スケールが働かず、入力がそのまま周辺確率になる)。 */
const SIX = [0.7, 0.6, 0.5, 0.5, 0.4, 0.3];
/** 7頭・Σp=3。 */
const SEVEN = [0.9, 0.8, 0.5, 0.4, 0.2, 0.1, 0.1];
/** 6頭・Σp=2.25(≠3。再スケールが働く)。 */
const SIX_LOW = [0.5, 0.45, 0.4, 0.4, 0.3, 0.2];
/** 12頭の典型(Σp=2.88)。 */
const TWELVE = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];

describe("定数", () => {
  it("払戻率は 0.8", () => {
    expect(PLACE_PAYOUT_RATE).toBe(0.8);
  });
});

describe("aggregateTopFinishProbabilities(順序付き分布の上位 depth 着を馬ごとに合算)", () => {
  const ordered = [
    { order: [1, 2, 3], probability: 0.2 },
    { order: [1, 3, 2], probability: 0.3 },
    { order: [2, 1, 3], probability: 0.5 },
  ];

  it("depth=1 は1着の合算。aggregateWinProbabilities と同じ結果(勝率も同じ関数を通す)", () => {
    const one = aggregateTopFinishProbabilities(ordered, 1);
    expect(one.get(1)).toBeCloseTo(0.5, 12);
    expect(one.get(2)).toBeCloseTo(0.5, 12);
    expect(one.has(3)).toBe(false);
    expect([...aggregateWinProbabilities(ordered)]).toEqual([...one]);
  });

  it("depth=2 は1着と2着の合算(排反なので 2着以内の確率になる)。手計算: 馬1=0.2+0.3+0.5(2着)=1.0、馬2=0.5(1着)+0.2(2着)=0.7、馬3=0.3(2着)=0.3", () => {
    const two = aggregateTopFinishProbabilities(ordered, 2);
    expect(two.get(1)).toBeCloseTo(1.0, 12);
    expect(two.get(2)).toBeCloseTo(0.7, 12);
    expect(two.get(3)).toBeCloseTo(0.3, 12);
  });

  it("depth が着順の長さ以上でも3着まで(存在しない着は読み飛ばす)。depth=3 の合計は 3", () => {
    const three = aggregateTopFinishProbabilities(ordered, 5);
    expect([...three.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(3, 12);
  });

  it("空の着順(出走0頭の縮退)は読み飛ばし、空の Map を返す", () => {
    expect(aggregateTopFinishProbabilities([{ order: [], probability: 1 }], 2).size).toBe(0);
  });

  it("実分布(6頭): 1着の合計は 1、2着以内の合計は 2、馬ごとに 勝率 < 2着内率。勝率は estimateWinProbabilities と一致", () => {
    const hs = horses(SIX);
    const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, WIN_PROB_TOP_FINISH_COUNT)!;
    const win = aggregateTopFinishProbabilities(dist, 1);
    const top2 = aggregateTopFinishProbabilities(dist, 2);
    expect([...win.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect([...top2.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(2, 12);
    for (const h of hs) {
      expect(top2.get(h.umaban)!).toBeGreaterThan(win.get(h.umaban)!);
    }
    expect([...estimateWinProbabilities(hs)!]).toEqual([...win]);
  });
});

describe("fairPlaceOddsOf(想定複勝オッズ = 払戻率 ÷ 的中率)", () => {
  it.each([
    { prob: 0.4, expected: 2 },
    { prob: 0.8, expected: 1 },
    { prob: 0.25, expected: 3.2 },
    { prob: 1, expected: 0.8 },
  ])("的中率 $prob → $expected 倍", ({ prob, expected }) => {
    expect(fairPlaceOddsOf(prob)).toBeCloseTo(expected, 12);
  });

  it("的中率 0・負・非有限は null。結果が非有限になる(オーバーフロー)ときも null", () => {
    expect(fairPlaceOddsOf(0)).toBeNull();
    expect(fairPlaceOddsOf(-0.1)).toBeNull();
    expect(fairPlaceOddsOf(Number.NaN)).toBeNull();
    expect(fairPlaceOddsOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(fairPlaceOddsOf(Number.MIN_VALUE)).toBeNull();
  });

  it("的中率が 80% を超えると 1.0 倍未満になる(境界: 0.8 ちょうどは 1.0、0.81 は 1.0 未満)", () => {
    expect(fairPlaceOddsOf(0.8)).toBeCloseTo(1, 12);
    expect(fairPlaceOddsOf(0.81)!).toBeLessThan(1);
    expect(fairPlaceOddsOf(0.79)!).toBeGreaterThan(1);
  });
});

describe('estimateFairPlaceOdds(basis="top3": 8頭以上。3着内率そのもの)', () => {
  it("想定 = 0.8 ÷ 補正後の3着内率。入力と同じ順序・馬番。placeProb は 3着内率のまま", () => {
    const rows = estimateFairPlaceOdds(horses(TWELVE), "top3");
    expect(rows.map((r) => r.umaban)).toEqual(TWELVE.map((_, i) => i + 1));
    for (let i = 0; i < TWELVE.length; i++) {
      expect(rows[i]!.basis).toBe("top3");
      expect(rows[i]!.placeProb).toBe(TWELVE[i]);
      expect(rows[i]!.fairPlaceOdds!).toBeCloseTo(0.8 / TWELVE[i]!, 12);
    }
    // 例: 3着内率 40% なら 2.0 倍(Issue の例)
    expect(estimateFairPlaceOdds(horses([0.4, ...TWELVE.slice(1)]), "top3")[0]!.fairPlaceOdds).toBeCloseTo(2, 12);
  });

  it("勝率の経路(Plackett-Luce)を通さない: 判定不能になる入力(固定馬2頭)でも、3着内率から直接求まる", () => {
    const twoFixed = [0.99, 0.98, 0.2, 0.2, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.02, 0.02];
    const fit = fitPlackettLuceStrengths(horses(twoFixed), WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok && fit.degenerateFixedCount).toBeGreaterThanOrEqual(2); // 前提: 勝率側は判定不能
    expect(estimateWinProbabilities(horses(twoFixed))).toBeNull(); // 前提
    const rows = estimateFairPlaceOdds(horses(twoFixed), "top3");
    expect(rows[0]!.fairPlaceOdds!).toBeCloseTo(0.8 / 0.99, 12);
    expect(rows[2]!.fairPlaceOdds!).toBeCloseTo(4, 12);
  });

  it("3着内率が 80% 超の馬は 1.0 倍未満の値(丸めず返す)。100% は 0.8 倍", () => {
    const rows = estimateFairPlaceOdds(horses([0.85, 1, ...TWELVE.slice(2)]), "top3");
    expect(rows[0]!.fairPlaceOdds!).toBeCloseTo(0.8 / 0.85, 12);
    expect(rows[0]!.fairPlaceOdds!).toBeLessThan(1);
    expect(rows[1]!.fairPlaceOdds!).toBeCloseTo(0.8, 12);
  });

  it("3着内率が 0・負・NaN の馬は fairPlaceOdds=null(他の馬は出る)。非有限は placeProb も null", () => {
    const rows = estimateFairPlaceOdds(horses([0, -0.1, Number.NaN, ...TWELVE.slice(3)]), "top3");
    expect(rows[0]).toEqual({ umaban: 1, placeProb: 0, basis: "top3", fairPlaceOdds: null });
    expect(rows[1]).toEqual({ umaban: 2, placeProb: -0.1, basis: "top3", fairPlaceOdds: null });
    expect(rows[2]).toEqual({ umaban: 3, placeProb: null, basis: "top3", fairPlaceOdds: null });
    expect(rows[3]!.fairPlaceOdds).not.toBeNull();
  });

  it("出走0頭は空配列", () => {
    expect(estimateFairPlaceOdds([], "top3")).toEqual([]);
  });
});

describe('estimateFairPlaceOdds(basis="top2": 5〜7頭。2着内率)', () => {
  /** 独立に求める2着内率(order[0] と order[1] を数え上げる。実装の関数を使わない)。 */
  function independentTop2(hs: readonly JointModelHorse[]): Map<number, number> {
    const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)!;
    const m = new Map<number, number>();
    for (const o of dist) {
      m.set(o.order[0]!, (m.get(o.order[0]!) ?? 0) + o.probability);
      m.set(o.order[1]!, (m.get(o.order[1]!) ?? 0) + o.probability);
    }
    return m;
  }

  it.each([
    ["6頭 Σp=3", SIX],
    ["7頭 Σp=3", SEVEN],
    ["6頭 Σp=2.25(再スケール)", SIX_LOW],
  ] as const)("%s: placeProb は独立に求めた2着内率と一致し、想定 = 0.8 ÷ 2着内率。Σ2着内率 = 2", (_name, probs) => {
    const hs = horses(probs);
    const expected = independentTop2(hs);
    const rows = estimateFairPlaceOdds(hs, "top2");
    expect(rows).toHaveLength(probs.length);
    for (const r of rows) {
      expect(r.basis).toBe("top2");
      expect(Math.abs(r.placeProb! - expected.get(r.umaban)!)).toBeLessThan(1e-12);
      expect(r.fairPlaceOdds!).toBeCloseTo(0.8 / r.placeProb!, 12);
    }
    expect(rows.reduce((s, r) => s + r.placeProb!, 0)).toBeCloseTo(2, 12);
  });

  it("均等な6頭: 2着内率は各 1/3、想定は 2.4 倍(3着内率 1/2 から出す 1.6 倍とは違う値になる)", () => {
    const rows = estimateFairPlaceOdds(horses([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), "top2");
    for (const r of rows) {
      expect(r.placeProb!).toBeCloseTo(1 / 3, 9);
      expect(r.fairPlaceOdds!).toBeCloseTo(2.4, 8);
    }
    expect(estimateFairPlaceOdds(horses([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), "top3")[0]!.fairPlaceOdds!).toBeCloseTo(1.6, 12);
  });

  it("具体値(6頭・Σp=3): 最上位馬は2着内率 約 0.505 → 想定 約 1.58 倍。最下位馬は 約 0.184 → 約 4.35 倍(丸め前の値で固定)", () => {
    const rows = estimateFairPlaceOdds(horses(SIX), "top2");
    expect(rows[0]!.placeProb!).toBeGreaterThan(0.50);
    expect(rows[0]!.placeProb!).toBeLessThan(0.51);
    expect(rows[0]!.fairPlaceOdds!).toBeGreaterThan(1.55);
    expect(rows[0]!.fairPlaceOdds!).toBeLessThan(1.62);
    expect(rows[5]!.placeProb!).toBeGreaterThan(0.18);
    expect(rows[5]!.placeProb!).toBeLessThan(0.19);
    expect(rows[5]!.fairPlaceOdds!).toBeGreaterThan(4.2);
    expect(rows[5]!.fairPlaceOdds!).toBeLessThan(4.5);
  });

  it("2着内率は3着内率より小さいので、同じ馬の想定は top2 のほうが top3 より高い(差が0でないことを固定)", () => {
    const hs = horses(SIX);
    const t2 = estimateFairPlaceOdds(hs, "top2");
    const t3 = estimateFairPlaceOdds(hs, "top3");
    for (let i = 0; i < SIX.length; i++) {
      expect(t2[i]!.fairPlaceOdds! - t3[i]!.fairPlaceOdds!).toBeGreaterThan(0.1);
    }
  });

  it("3着内率が 0 の馬は placeProb=0・fairPlaceOdds=null(他の馬は出る)", () => {
    const rows = estimateFairPlaceOdds(horses([0.8, 0.7, 0.6, 0.5, 0.4, 0]), "top2");
    expect(rows[5]).toEqual({ umaban: 6, placeProb: 0, basis: "top2", fairPlaceOdds: null });
    expect(rows[0]!.fairPlaceOdds).not.toBeNull();
  });

  it("固定馬が1頭: その馬の2着内率は 1(想定 0.8 倍)。ほかの馬は合計 1 を分け合う", () => {
    const hs = horses([0.99, 0.5, 0.5, 0.4, 0.3, 0.2]);
    const fit = fitPlackettLuceStrengths(hs, WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok && fit.degenerateFixedCount).toBe(1); // 前提
    const rows = estimateFairPlaceOdds(hs, "top2");
    expect(rows[0]!.placeProb!).toBeCloseTo(1, 12);
    expect(rows[0]!.fairPlaceOdds!).toBeCloseTo(0.8, 12);
    expect(rows.reduce((s, r) => s + r.placeProb!, 0)).toBeCloseTo(2, 12);
  });

  it("判定不能(固定馬2頭以上)は全馬 placeProb=null・fairPlaceOdds=null。throw しない", () => {
    const hs = horses([0.99, 0.98, 0.3, 0.1, 0.05, 0.05]);
    const fit = fitPlackettLuceStrengths(hs, WIN_PROB_TOP_FINISH_COUNT);
    expect(fit.ok && fit.degenerateFixedCount).toBeGreaterThanOrEqual(2); // 前提
    const rows = estimateFairPlaceOdds(hs, "top2");
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.placeProb === null && r.fairPlaceOdds === null && r.basis === "top2")).toBe(true);
  });

  it("不正な入力(NaN・範囲外の3着内率)でも throw せず、全馬 null", () => {
    for (const bad of [Number.NaN, 1.5, -0.2]) {
      const rows = estimateFairPlaceOdds(horses([bad, ...SIX.slice(1)]), "top2");
      expect(rows).toHaveLength(SIX.length);
      expect(rows.every((r) => r.placeProb === null && r.fairPlaceOdds === null)).toBe(true);
    }
  });

  it("出走0頭は空配列", () => {
    expect(estimateFairPlaceOdds([], "top2")).toEqual([]);
  });
});
