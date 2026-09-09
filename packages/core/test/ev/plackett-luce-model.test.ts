import { describe, expect, it, vi, afterEach } from "vitest";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import { CONDITIONAL_BERNOULLI_MODEL, type JointModelHorse } from "../../src/ev/place-joint-model.js";
import * as strengthModule from "../../src/ev/plackett-luce-strength.js";
import { PlackettLuceFitError, fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";

/** 出走馬を umaban 昇順で組み立てる補助関数。 */
function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** 分布の確率合計。 */
function sumProbability(distribution: readonly { probability: number }[]): number {
  return distribution.reduce((acc, o) => acc + o.probability, 0);
}

/** n個からk個を選ぶ組合せ数(小さい値のみ想定)。 */
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PLACKETT_LUCE_MODEL", () => {
  it("id='plackett-luce'・approximate=falseが設定されている", () => {
    expect(PLACKETT_LUCE_MODEL.id).toBe("plackett-luce");
    expect(PLACKETT_LUCE_MODEL.approximate).toBe(false);
  });

  describe("AC-1: kごとの契約がCONDITIONAL_BERNOULLI_MODELと同一(縮退入力)", () => {
    it("頭数0のとき空集合が確率1(CBと同一)", () => {
      const cb = CONDITIONAL_BERNOULLI_MODEL.buildDistribution([], 3);
      const pl = PLACKETT_LUCE_MODEL.buildDistribution([], 3);
      expect(pl).toEqual(cb);
      expect(pl).toEqual([{ placed: [], probability: 1 }]);
    });

    it("placeCount=0のとき空集合が確率1(CBと同一)", () => {
      const h = horses([0.3, 0.5, 0.2]);
      const cb = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(h, 0);
      const pl = PLACKETT_LUCE_MODEL.buildDistribution(h, 0);
      expect(pl).toEqual(cb);
    });

    it("n=1・k=1(k>=n)のとき全頭が確率1(CBと同一)", () => {
      const h = horses([0.5]);
      const cb = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(h, 1);
      const pl = PLACKETT_LUCE_MODEL.buildDistribution(h, 1);
      expect(pl).toEqual(cb);
      expect(pl).toEqual([{ placed: [1], probability: 1 }]);
    });

    it("placeCount>=頭数のとき全頭が確率1(CBと同一)", () => {
      const h = horses([0.3, 0.5, 0.2]);
      const cb = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(h, 5);
      const pl = PLACKETT_LUCE_MODEL.buildDistribution(h, 5);
      expect(pl).toEqual(cb);
    });

    it("placeCount===頭数のとき全頭が確率1(CBと同一)", () => {
      const h = horses([0.3, 0.5, 0.2]);
      const cb = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(h, 3);
      const pl = PLACKETT_LUCE_MODEL.buildDistribution(h, 3);
      expect(pl).toEqual(cb);
    });

    it("縮退入力ではfitPlackettLuceStrengthsを呼ばない(spy)", () => {
      const spy = vi.spyOn(strengthModule, "fitPlackettLuceStrengths");
      PLACKETT_LUCE_MODEL.buildDistribution([], 3);
      PLACKETT_LUCE_MODEL.buildDistribution(horses([0.3, 0.5, 0.2]), 0);
      PLACKETT_LUCE_MODEL.buildDistribution(horses([0.3, 0.5, 0.2]), 3);
      PLACKETT_LUCE_MODEL.buildDistribution(horses([0.3, 0.5, 0.2]), 5);
      expect(spy).not.toHaveBeenCalled();
    });

    it("非縮退入力ではfitPlackettLuceStrengthsを呼ぶ(spy。上のテストとの対照)", () => {
      const spy = vi.spyOn(strengthModule, "fitPlackettLuceStrengths");
      PLACKETT_LUCE_MODEL.buildDistribution(horses([0.3, 0.5, 0.2, 0.4]), 2);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC-6: 出力契約", () => {
    it("18頭・k=3で確率合計が1(toBeCloseTeの桁数を明示)・outcome数がC(18,3)=816", () => {
      const probs = Array.from({ length: 18 }, (_, i) => 0.05 + (i % 6) * 0.03);
      const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 3);
      expect(distribution.length).toBe(comb(18, 3));
      expect(distribution.length).toBe(816);
      expect(sumProbability(distribution)).toBeCloseTo(1, 9);
    });

    it("全outcomeの確率が有限・非負", () => {
      const probs = Array.from({ length: 10 }, (_, i) => 0.1 + (i % 4) * 0.05);
      const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 3);
      for (const o of distribution) {
        expect(Number.isFinite(o.probability)).toBe(true);
        expect(o.probability).toBeGreaterThanOrEqual(0);
      }
    });

    it("placedが昇順・重複なし・決定的", () => {
      const probs = [0.3, 0.5, 0.2, 0.4, 0.1];
      const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 2);
      for (const o of distribution) {
        const sorted = [...o.placed].sort((a, b) => a - b);
        expect(o.placed).toEqual(sorted);
        expect(new Set(o.placed).size).toBe(o.placed.length);
      }
    });
  });

  describe("フィット不能な入力は例外を投げる(均等分布へフォールバックしない)", () => {
    it("invalid-probabilityを含む入力は例外を投げる", () => {
      expect(() =>
        PLACKETT_LUCE_MODEL.buildDistribution(horses([0.5, 1.5, 0.3]), 2),
      ).toThrow(PlackettLuceFitError);
    });

    it("投げた例外のreasonが入力検証結果と一致する", () => {
      try {
        PLACKETT_LUCE_MODEL.buildDistribution(horses([0.5, 1.5, 0.3]), 2);
        expect.fail("例外が投げられるべき");
      } catch (e) {
        expect(e).toBeInstanceOf(PlackettLuceFitError);
        expect((e as PlackettLuceFitError).reason).toBe("invalid-probability");
        expect((e as PlackettLuceFitError).name).toBe("PlackettLuceFitError");
      }
    });

    it("infeasible-supportな入力は例外を投げる", () => {
      expect(() => PLACKETT_LUCE_MODEL.buildDistribution(horses([0.9, 0, 0, 0]), 2)).toThrow(
        PlackettLuceFitError,
      );
    });

    it("2契約の分離: 同じ入力でfitPlackettLuceStrengthsは投げず{ok:false}を返し、buildDistributionは投げる", () => {
      const badHorses = horses([0.5, 1.5, 0.3]);
      const k = 2;
      // fitPlackettLuceStrengths 自体は例外を投げない。
      let fitResult: ReturnType<typeof strengthModule.fitPlackettLuceStrengths> | undefined;
      expect(() => {
        fitResult = strengthModule.fitPlackettLuceStrengths(badHorses, k);
      }).not.toThrow();
      expect(fitResult).toBeDefined();
      expect(fitResult!.ok).toBe(false);
      // buildDistributionは同じ入力で投げる。
      expect(() => PLACKETT_LUCE_MODEL.buildDistribution(badHorses, k)).toThrow(
        PlackettLuceFitError,
      );
    });

    it("placeCountが非有限/負/非整数のときinvalid-place-countとして例外を投げる", () => {
      const h = horses([0.5, 0.3, 0.2]);
      try {
        PLACKETT_LUCE_MODEL.buildDistribution(h, -1);
        expect.fail("例外が投げられるべき");
      } catch (e) {
        expect((e as PlackettLuceFitError).reason).toBe("invalid-place-count");
      }
    });
  });

  describe("p=1をm頭含む入力は(n-m,k-m)の縮約問題と一致する(ブルートフォース照合)", () => {
    it("5頭中2頭がp=1・k=3のとき、固定2頭を含む組合せの確率合計は縮約問題(3頭,k=1)の分布と一致する", () => {
      const probs = [1, 1, 0.5, 0.3, 0.2];
      const distribution = PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 3);
      // 固定2頭(馬番1,2)を含まない組合せは全て確率0のはず。
      const withoutFixed = distribution.filter(
        (o) => !(o.placed.includes(1) && o.placed.includes(2)),
      );
      for (const o of withoutFixed) {
        expect(o.probability).toBe(0);
      }
      // 固定2頭を含む組合せの確率合計は1(縮約問題の分布の合計と一致)。
      const withFixed = distribution.filter(
        (o) => o.placed.includes(1) && o.placed.includes(2),
      );
      expect(sumProbability(withFixed)).toBeCloseTo(1, 9);
      expect(withFixed.length).toBe(3); // 縮約後(3頭,k'=1)なのでC(3,1)=3通り。
    });
  });

  describe("正の対照: 正常入力では例外を投げない(fail-open検出のための対照)", () => {
    it("18頭・k=3の本番相当入力では例外を投げない", () => {
      const probs = Array.from({ length: 18 }, (_, i) => 0.05 + (i % 6) * 0.03);
      expect(() => PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 3)).not.toThrow();
    });
  });

  describe("AC-3: marginalDeviationMax(要修正6で追加。自分のフィクスチャで測定)", () => {
    /** 分布からの周辺確率(馬iを含むoutcomeの確率合計)。 */
    function marginalOf(distribution: readonly { placed: readonly number[]; probability: number }[], umaban: number): number {
      return distribution
        .filter((o) => o.placed.includes(umaban))
        .reduce((a, o) => a + o.probability, 0);
    }

    /** marginalDeviationMax = max_i |周辺確率 - 入力placeProb|。 */
    function marginalDeviationMax(
      hs: readonly JointModelHorse[],
      distribution: readonly { placed: readonly number[]; probability: number }[],
    ): number {
      let maxDev = 0;
      for (const h of hs) {
        maxDev = Math.max(maxDev, Math.abs(marginalOf(distribution, h.umaban) - h.placeProb));
      }
      return maxDev;
    }

    // 18頭のベース形状(降順の重みを正規化。Σ=1)。boss の数値は転記せず、この形状に対して
    // 自分でΣpを変えて測定する。
    const baseRaw = Array.from({ length: 18 }, (_, i) => 18 - i);
    const baseSum = baseRaw.reduce((a, b) => a + b, 0);
    const base = baseRaw.map((v) => v / baseSum);

    it("恒等式: 収束したフィットについてmarginalDeviationMaxはmax_i|min(1,λ・p_i)-p_i|に一致する(許容誤差1e-4)", () => {
      const probs = base.map((v) => v * 2.7); // Σp=2.7(<k=3。再スケールが働く非自明なケース)。
      const hs = horses(probs);
      const fit = fitPlackettLuceStrengths(hs, 3);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.rescaleApplied).toBe(true); // 前提: λが効いていることを固定する(空振り防止)。

      const distribution = PLACKETT_LUCE_MODEL.buildDistribution(hs, 3);
      const observedDev = marginalDeviationMax(hs, distribution);

      const lambda = fit.rescaleFactor;
      let identityDev = 0;
      for (const h of hs) {
        identityDev = Math.max(identityDev, Math.abs(Math.min(1, lambda * h.placeProb) - h.placeProb));
      }
      // 許容誤差はフィットの残差(FIT_TOLERANCE=1e-6)由来のズレを吸収するリテラル値。
      expect(Math.abs(observedDev - identityDev)).toBeLessThan(1e-4);
      // 値そのものも自分の実測でリテラル固定する(恒等式の自己参照だけに頼らない)。
      expect(observedDev).toBeCloseTo(0.03158, 4);
    });

    describe("PLがCBより悪化する側を実測リテラルで固定する(#76型の片側検出のみ、を防ぐ)", () => {
      // Σp=3.3・3.6(>k=3)で、自分のフィクスチャにおいてPLがCBより悪化することを実測して固定する
      // (boss の数値は転記せず、この base 形状に対して自分で測り直した値)。
      const cases: Array<{ name: string; scale: number; plDev: number; cbDev: number }> = [
        { name: "Σp=3.3", scale: 3.3, plDev: 0.031578, cbDev: 0.021512 },
        { name: "Σp=3.6", scale: 3.6, plDev: 0.063157, cbDev: 0.044611 },
      ];
      for (const c of cases) {
        it(c.name, () => {
          const probs = base.map((v) => v * c.scale);
          const hs = horses(probs);
          const plDistribution = PLACKETT_LUCE_MODEL.buildDistribution(hs, 3);
          const cbDistribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(hs, 3);
          const plDev = marginalDeviationMax(hs, plDistribution);
          const cbDev = marginalDeviationMax(hs, cbDistribution);
          // 前提: 差が実際に0でないことを先に固定する(空振り防止)。
          expect(Math.abs(plDev - cbDev)).toBeGreaterThan(1e-4);
          // 自分の実測値をリテラルで固定する。
          expect(plDev).toBeCloseTo(c.plDev, 5);
          expect(cbDev).toBeCloseTo(c.cbDev, 5);
          // PLがCBより悪化する(値が大きい)ことを固定する。
          expect(plDev).toBeGreaterThan(cbDev);
        });
      }
    });

    it("対照: Σp=kちょうどではPLの方がCBより明確に良い(方向が両方あることを示す)", () => {
      const probs = base.map((v) => v * 3.0);
      const hs = horses(probs);
      const plDistribution = PLACKETT_LUCE_MODEL.buildDistribution(hs, 3);
      const cbDistribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(hs, 3);
      const plDev = marginalDeviationMax(hs, plDistribution);
      const cbDev = marginalDeviationMax(hs, cbDistribution);
      expect(plDev).toBeCloseTo(0.0, 5);
      expect(cbDev).toBeCloseTo(0.01077, 5);
      expect(plDev).toBeLessThan(cbDev);
    });
  });
});
