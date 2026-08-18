import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
} from "../../src/ev/place-joint-model.js";

/** 出走馬を umaban 昇順で組み立てる補助関数。 */
function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** 分布の確率合計。 */
function sumProbability(distribution: readonly { probability: number }[]): number {
  return distribution.reduce((acc, o) => acc + o.probability, 0);
}

describe("CONDITIONAL_BERNOULLI_MODEL(条件付きベルヌーイ同時分布)", () => {
  it("approximate=true・id が設定されていること(UIの近似計算表記の機械導出に使う)", () => {
    expect(CONDITIONAL_BERNOULLI_MODEL.approximate).toBe(true);
    expect(CONDITIONAL_BERNOULLI_MODEL.id).toBe("conditional-bernoulli");
  });

  describe("確率合計が1になること(頭数の境界をテーブル駆動で確認)", () => {
    const cases: Array<{ name: string; n: number; placeCount: number }> = [
      { name: "頭数0", n: 0, placeCount: 3 },
      { name: "頭数1", n: 1, placeCount: 3 },
      { name: "頭数2", n: 2, placeCount: 3 },
      { name: "頭数3(組1通り)", n: 3, placeCount: 3 },
      { name: "頭数4", n: 4, placeCount: 3 },
      { name: "頭数18(C(18,3)=816組)", n: 18, placeCount: 3 },
    ];

    for (const c of cases) {
      it(c.name, () => {
        // 頭数に応じて確率をずらし、同一値による偶然の対称性に頼らない。
        const probs = Array.from({ length: c.n }, (_, i) => 0.1 + (i % 5) * 0.05);
        const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
          horses(probs),
          c.placeCount,
        );
        expect(sumProbability(distribution)).toBeCloseTo(1, 10);
      });
    }

    it("頭数18・複勝人数3で組数がC(18,3)=816であること", () => {
      const probs = Array.from({ length: 18 }, (_, i) => 0.1 + (i % 5) * 0.05);
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses(probs), 3);
      expect(distribution.length).toBe(816);
    });
  });

  describe("確率0/1の境界(ゼロ除算・NaN・Infinityが出ないこと)", () => {
    it("p=0の馬はどの組にも実質現れない", () => {
      // 4頭・複勝2人数。馬1の確率を0にし、他は妙味のある値にする。
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0, 0.4, 0.4, 0.2]),
        2,
      );
      for (const outcome of distribution) {
        expect(Number.isFinite(outcome.probability)).toBe(true);
        expect(Number.isNaN(outcome.probability)).toBe(false);
      }
      const horse1Marginal = distribution
        .filter((o) => o.placed.includes(1))
        .reduce((acc, o) => acc + o.probability, 0);
      expect(horse1Marginal).toBeLessThan(1e-6);
      expect(sumProbability(distribution)).toBeCloseTo(1, 10);
    });

    it("p=1の馬は実質全ての組に現れる", () => {
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([1, 0.4, 0.4, 0.2]),
        2,
      );
      for (const outcome of distribution) {
        expect(Number.isFinite(outcome.probability)).toBe(true);
      }
      const horse1Marginal = distribution
        .filter((o) => o.placed.includes(1))
        .reduce((acc, o) => acc + o.probability, 0);
      expect(horse1Marginal).toBeGreaterThan(1 - 1e-6);
      expect(sumProbability(distribution)).toBeCloseTo(1, 10);
    });
  });

  describe("placeCountと頭数の関係", () => {
    it("placeCount >= 頭数のとき組は1通り(確率1・全頭が複勝圏内)", () => {
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0.3, 0.5, 0.2]),
        5, // 頭数3 < placeCount5
      );
      expect(distribution).toEqual([{ placed: [1, 2, 3], probability: 1 }]);
    });

    it("placeCount === 頭数のとき組は1通り", () => {
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0.3, 0.5, 0.2]),
        3,
      );
      expect(distribution).toEqual([{ placed: [1, 2, 3], probability: 1 }]);
    });

    it("placeCount === 0 のとき空集合が確率1(合計1の不変条件を維持)", () => {
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0.3, 0.5, 0.2]),
        0,
      );
      expect(distribution).toEqual([{ placed: [], probability: 1 }]);
    });

    it("頭数0のとき空集合が確率1", () => {
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution([], 3);
      expect(distribution).toEqual([{ placed: [], probability: 1 }]);
    });

    it("placeCount === NaN のとき空集合が確率1になること(負値クランプと同じ挙動に揃える)", () => {
      // Math.max(0, NaN) は NaN のまま素通りしてしまい(負値クランプが効かない)、
      // kCombinationsの基底条件が恒久的に成立せずcombos=[]になる回帰バグの再発防止テスト。
      // NaNを0(複勝人数なし)として扱うことで、負値(0にクランプ)と一貫した結果になる。
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0.3, 0.5, 0.2]),
        Number.NaN,
      );
      expect(distribution).toEqual([{ placed: [], probability: 1 }]);
    });

    it("placeCount === -Infinity のとき空集合が確率1になること(既存のMath.maxクランプのまま。回帰防止)", () => {
      // -InfinityはNaNと異なりMath.max(0, -Infinity)が既に正しく0を返すため、修正の有無に
      // 関わらず既存の挙動が維持されることを固定する(NaN修正が誤って-Infinityの経路まで
      // 変えていないことの確認)。
      const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([0.3, 0.5, 0.2]),
        Number.NEGATIVE_INFINITY,
      );
      expect(distribution).toEqual([{ placed: [], probability: 1 }]);
    });
  });

  describe("確率合計が乖離する入力でも条件付け後の分布合計は必ず1(LLM補正後の未保証な合計を吸収)", () => {
    const cases: Array<{ name: string; probs: number[] }> = [
      { name: "合計1.2に偏るケース", probs: [0.3, 0.3, 0.3, 0.3] },
      { name: "合計3.0(過大)のケース", probs: [0.7, 0.7, 0.7, 0.5, 0.4] },
      { name: "合計4.8(著しく過大)のケース", probs: [0.9, 0.9, 0.9, 0.9, 0.6, 0.6] },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
          horses(c.probs),
          3,
        );
        expect(sumProbability(distribution)).toBeCloseTo(1, 10);
      });
    }
  });

  it("全馬同一確率なら全組が等確率(対称性)", () => {
    const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
      horses([0.4, 0.4, 0.4, 0.4, 0.4]),
      2,
    );
    const expected = 1 / distribution.length;
    for (const outcome of distribution) {
      expect(outcome.probability).toBeCloseTo(expected, 10);
    }
  });

  it("病的入力(NaN)でも例外を投げず均等分布へフォールバックすること", () => {
    // NaNはEPSクランプをすり抜けて重み計算に伝播し、分母を非有限にする(意図した経路)。
    expect(() =>
      CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
        horses([Number.NaN, 0.4, 0.3, 0.2]),
        2,
      ),
    ).not.toThrow();
    const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
      horses([Number.NaN, 0.4, 0.3, 0.2]),
      2,
    );
    const expectedUniform = 1 / distribution.length;
    for (const outcome of distribution) {
      expect(Number.isFinite(outcome.probability)).toBe(true);
      expect(outcome.probability).toBeCloseTo(expectedUniform, 10);
    }
    expect(sumProbability(distribution)).toBeCloseTo(1, 10);
  });

  it("出力のplacedが馬番昇順で決定的であること", () => {
    const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
      horses([0.3, 0.5, 0.2, 0.4]),
      2,
    );
    for (const outcome of distribution) {
      const sorted = [...outcome.placed].sort((a, b) => a - b);
      expect(outcome.placed).toEqual(sorted);
    }
  });

  it("馬番が昇順でない入力でも結果は馬番基準で正しく決定的であること", () => {
    // umaban が入力配列の順序と一致しないケース(欠番・出走順のシャッフル)。
    const shuffled: JointModelHorse[] = [
      { umaban: 8, placeProb: 0.5 },
      { umaban: 3, placeProb: 0.3 },
      { umaban: 5, placeProb: 0.2 },
    ];
    const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(shuffled, 5);
    expect(distribution).toEqual([{ placed: [3, 5, 8], probability: 1 }]);
  });
});
