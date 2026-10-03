import { describe, expect, it } from "vitest";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import {
  isOrderedPlaceJointModel,
  type JointModelHorse,
  type OrderedOutcome,
} from "../../src/ev/place-joint-model.js";
import { fitPlackettLuceStrengths, PlackettLuceFitError } from "../../src/ev/plackett-luce-strength.js";
import { winProbabilitiesFromStrengths } from "../../src/ev/plackett-luce-win-prob.js";

/**
 * PLACKETT_LUCE_MODEL.buildOrderedDistribution(Issue #92・#23-B1b)のテスト。
 *
 * AC-B1b-1(a)(b): 順序 outcome 空間の1着周辺・上位k集合周辺が、それぞれ
 * winProbabilitiesFromStrengths・buildDistribution(集合空間)と一致すること。
 * AC-B1b-4: degenerateFixedCount(以下deg)=0/1/2以上の3層で振る舞いが異なること。
 *
 * 許容誤差はすべて自分で計測した値であり(boss裁定「転記するな、自分で測れ」)、
 * ブリーフから転記した数値はここには存在しない。
 */

/** 出走馬を umaban 昇順で組み立てる補助関数。 */
function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** n個からk個を選ぶ順列数 P(n,k)=n!/(n-k)!。 */
function perm(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}

/** n個からk個を選ぶ組合せ数。 */
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** 順序 outcome 分布の確率合計。 */
function sumProbability(distribution: readonly OrderedOutcome[]): number {
  return distribution.reduce((acc, o) => acc + o.probability, 0);
}

/** 順序 outcome 分布から、各馬の1着周辺確率(order[0]===umaban となる確率の合計)を導出する。 */
function winMarginals(
  hs: readonly JointModelHorse[],
  distribution: readonly OrderedOutcome[],
): Map<number, number> {
  const m = new Map<number, number>(hs.map((h) => [h.umaban, 0]));
  for (const outcome of distribution) {
    const winner = outcome.order[0];
    if (winner !== undefined) {
      m.set(winner, (m.get(winner) ?? 0) + outcome.probability);
    }
  }
  return m;
}

/** 順序 outcome 分布から、上位k集合(順序を無視した馬番の組)ごとの周辺確率を導出する。 */
function setMarginals(distribution: readonly OrderedOutcome[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const outcome of distribution) {
    const key = [...outcome.order].sort((a, b) => a - b).join(",");
    m.set(key, (m.get(key) ?? 0) + outcome.probability);
  }
  return m;
}

describe("PLACKETT_LUCE_MODEL.buildOrderedDistribution(Issue #92)", () => {
  it("isOrderedPlaceJointModelでtrueと判定される(モデル契約)", () => {
    expect(isOrderedPlaceJointModel(PLACKETT_LUCE_MODEL)).toBe(true);
  });

  describe("縮退入力(n=0/k=0/n=1/k>=n)", () => {
    it("頭数0なら空の着順が確率1", () => {
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution([], 3)).toEqual([
        { order: [], probability: 1 },
      ]);
    });

    it("topFinishCount=0なら空の着順が確率1(place/wide/trioのk=0と同型の縮退)", () => {
      const hs = horses([0.5, 0.3, 0.2]);
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 0)).toEqual([
        { order: [], probability: 1 },
      ]);
    });

    it("頭数1なら、topFinishCountによらずその1頭が確実に1着(判定不能ではない)", () => {
      const hs = horses([0.4]);
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1)).toEqual([
        { order: [1], probability: 1 },
      ]);
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)).toEqual([
        { order: [1], probability: 1 },
      ]);
    });

    it("頭数2以上でtopFinishCount>=頭数なら判定不能(null)。placeProbが全員1に潰れ順序の情報を持たないため", () => {
      const hs = horses([0.6, 0.4]);
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 2)).toBeNull();
      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 5)).toBeNull();
    });
  });

  describe("deg=0(固定馬なし。通常ケース)", () => {
    const hs = horses([0.5, 0.3, 0.2]);
    const fit = fitPlackettLuceStrengths(hs, 1);

    it("前提: このフィクスチャはdeg=0であること(空振り防止)", () => {
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.degenerateFixedCount).toBe(0);
    });

    it("k=1の順序空間はP(3,1)=3件、確率の合計は1", () => {
      const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1);
      expect(dist).not.toBeNull();
      expect(dist!.length).toBe(perm(3, 1));
      expect(dist!.length).toBe(3);
      expect(sumProbability(dist!)).toBeCloseTo(1, 9);
    });

    it("AC-B1b-1(a): k=1の1着周辺はwinProbabilitiesFromStrengthsと一致する", () => {
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1)!;
      const expectedWin = winProbabilitiesFromStrengths(fit.theta);
      const marginals = winMarginals(hs, dist);
      for (let i = 0; i < hs.length; i++) {
        expect(marginals.get(hs[i]!.umaban)).toBeCloseTo(expectedWin[i]!, 9);
      }
    });

    it("k=1では順序空間と集合空間が一致する(P(n,1)=C(n,1))。buildDistributionと同じ確率を持つ", () => {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1)!;
      const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hs, 1);
      expect(ordered.length).toBe(setDist.length);
      const setMap = new Map(setDist.map((o) => [o.placed.join(","), o.probability]));
      for (const outcome of ordered) {
        expect(outcome.order.length).toBe(1);
        expect(setMap.get(outcome.order.join(","))).toBeCloseTo(outcome.probability, 9);
      }
    });

    describe("k=3(topFinishCount=3。ワイド・三連複と共有する次元。n>kの通常ケース)", () => {
      const hs5 = horses([0.7, 0.65, 0.6, 0.55, 0.5]);

      it("前提: このフィクスチャはdeg=0であること(空振り防止)", () => {
        const fit5 = fitPlackettLuceStrengths(hs5, 3);
        expect(fit5.ok).toBe(true);
        if (!fit5.ok) return;
        expect(fit5.degenerateFixedCount).toBe(0);
      });

      it("順序空間はP(5,3)=60件", () => {
        const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs5, 3);
        expect(dist).not.toBeNull();
        expect(dist!.length).toBe(perm(5, 3));
        expect(dist!.length).toBe(60);
        expect(sumProbability(dist!)).toBeCloseTo(1, 9);
      });

      it("AC-B1b-1(b): 上位3集合周辺はbuildDistribution(集合空間)と一致する", () => {
        const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs5, 3)!;
        const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hs5, 3);
        const orderedSetMarginals = setMarginals(ordered);
        expect(setDist.length).toBe(comb(5, 3));
        expect(setDist.length).toBe(10);
        let matchedNonZero = 0;
        for (const outcome of setDist) {
          const key = [...outcome.placed].sort((a, b) => a - b).join(",");
          expect(orderedSetMarginals.get(key)).toBeCloseTo(outcome.probability, 9);
          if (outcome.probability > 0) matchedNonZero++;
        }
        // 空振り防止: 確率0の組合せだけで自明に一致するテストになっていないことを固定する。
        expect(matchedNonZero).toBeGreaterThan(0);
      });

      it("AC-B1b-1(a): k=3のθでも1着周辺はwinProbabilitiesFromStrengths(θ_i/Σθ)と一致する(1着周辺はkによらないPLの構造的性質)", () => {
        const fit5 = fitPlackettLuceStrengths(hs5, 3);
        expect(fit5.ok).toBe(true);
        if (!fit5.ok) return;
        const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs5, 3)!;
        const expectedWin = winProbabilitiesFromStrengths(fit5.theta);
        const marginals = winMarginals(hs5, ordered);
        for (let i = 0; i < hs5.length; i++) {
          expect(marginals.get(hs5[i]!.umaban)).toBeCloseTo(expectedWin[i]!, 9);
        }
      });
    });

    it("18頭・k=3ではP(18,3)=18・17・16=4896件、C(18,3)=816件(算術。丸めではない)", () => {
      const hs18 = horses(Array.from({ length: 18 }, () => 1 / 18 * 3));
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs18, 3);
      expect(ordered).not.toBeNull();
      expect(ordered!.length).toBe(18 * 17 * 16);
      expect(ordered!.length).toBe(perm(18, 3));
      const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hs18, 3);
      expect(setDist.length).toBe(comb(18, 3));
      expect(setDist.length).toBe(816);
      expect(sumProbability(ordered!)).toBeCloseTo(1, 6);
    });
  });

  describe("deg=1(固定馬がちょうど1頭)。9頭・[0.9, 0.2×8]・k=3", () => {
    // 前提の検算(自分で実測。転記ではない): このフィクスチャがdeg=1であることを固定する。
    const hs = horses([0.9, ...Array(8).fill(0.2)]);
    const fit = fitPlackettLuceStrengths(hs, 3);

    it("前提: このフィクスチャはdeg=1であること(空振り防止。deg>=2と混同しない)", () => {
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.degenerateFixedCount).toBe(1);
      expect(fit.theta.filter((t) => t === Number.POSITIVE_INFINITY).length).toBe(1);
    });

    it("順序空間はNaNを含まない(素朴にΘ=Infinityで計算するとNaN汚染する。殺す変異の実測固定)", () => {
      const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3);
      expect(dist).not.toBeNull();
      expect(dist!.length).toBeGreaterThan(0);
      for (const outcome of dist!) {
        expect(Number.isFinite(outcome.probability)).toBe(true);
        expect(outcome.probability).toBeGreaterThanOrEqual(0);
      }
      expect(sumProbability(dist!)).toBeCloseTo(1, 6);
    });

    it("固定馬(umaban=1)は確率1で1着(1着=固定馬という契約)", () => {
      const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)!;
      const marginals = winMarginals(hs, dist);
      expect(marginals.get(1)).toBeCloseTo(1, 9);
      for (const h of hs.slice(1)) {
        expect(marginals.get(h.umaban)).toBeCloseTo(0, 9);
      }
    });

    it("順序空間はP(9,3)のうち固定馬が1着の分だけ(=P(8,2)件)。2着以下は自由集合のPL(k'=2)", () => {
      const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)!;
      expect(dist.length).toBe(perm(8, 2));
      for (const outcome of dist) {
        expect(outcome.order[0]).toBe(1); // 固定馬(umaban=1)が常に1着
      }
    });

    it("上位3集合周辺はbuildDistribution(集合空間。同じθ)と一致する(AC-B1b-1(b)がdeg=1でも成立)", () => {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)!;
      const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hs, 3);
      const orderedSetMarginals = setMarginals(ordered);
      expect(setDist.length).toBeGreaterThan(0);
      let matchedNonZero = 0;
      for (const outcome of setDist) {
        const key = [...outcome.placed].sort((a, b) => a - b).join(",");
        const orderedValue = orderedSetMarginals.get(key) ?? 0;
        expect(orderedValue).toBeCloseTo(outcome.probability, 6);
        if (outcome.probability > 0) matchedNonZero++;
      }
      // 空振り防止: 確率0の組合せだけを比較して自明に一致するテストになっていないことを固定する。
      expect(matchedNonZero).toBeGreaterThan(0);
    });
  });

  describe("deg>=2(固定馬が2頭以上)。判定不能(null)", () => {
    it("p=1が2頭あるとdeg=2になり、buildOrderedDistributionはnullを返す(集合空間は影響を受けない)", () => {
      const hs = horses([1, 1, 0.5, 0.3, 0.2]);
      const fit = fitPlackettLuceStrengths(hs, 3);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      // 前提の固定(空振り防止): deg=1ではなくdeg>=2であることを確認する。
      expect(fit.degenerateFixedCount).toBeGreaterThanOrEqual(2);

      expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)).toBeNull();

      // 既存側(集合空間)は誤っていない: deg>=2でもbuildDistributionは正常に確率を返す。
      const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hs, 3);
      expect(setDist.length).toBeGreaterThan(0);
      expect(setDist.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 9);
    });
  });

  describe("topFinishCountの数値検証(非有限/負/非整数)", () => {
    it("非整数(1.5)はPlackettLuceFitErrorをthrowする(buildDistributionと同じ契約)", () => {
      const hs = horses([0.5, 0.3, 0.2]);
      expect(() => PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1.5)).toThrow();
    });

    it("負値はthrowする", () => {
      const hs = horses([0.5, 0.3, 0.2]);
      expect(() => PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, -1)).toThrow();
    });
  });

  describe("フィット失敗(infeasible-support)。buildDistributionと同じ経路のPlackettLuceFitErrorをthrowすること(code-reviewer.md(d)指摘: 既存側〈buildDistribution〉には専用テストがあるのに新設側に無かった空白セル)", () => {
    it("p>0の頭数がk未満(infeasible-support)ならPlackettLuceFitErrorをthrowする(plackett-luce-model.test.tsと同一フィクスチャ)", () => {
      const hs = horses([0.9, 0, 0, 0]);
      expect(() => PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 2)).toThrow(PlackettLuceFitError);
    });
  });

  describe("除外馬(θ=0)混在(code-reviewer.md(d)指摘: buildOrderedOutcomesFromFullThetaが集合空間側のθ分類を複製しているのに、θ=0を含むフィクスチャが1件も無かった空白セル)", () => {
    // 7頭・[0.5,0.45,0.4,0.35,0.3,0,0]・k=3。umaban=6,7がplaceProb=0(除外馬)、
    // 残り5頭は自由集合(deg=0。固定馬なし)という非退化フィクスチャ。
    const hsWithZero = horses([0.5, 0.45, 0.4, 0.35, 0.3, 0, 0]);

    it("前提固定(空振り防止): このフィクスチャはdeg=0で、除外馬(θ=0)がちょうど2頭であること", () => {
      const fit = fitPlackettLuceStrengths(hsWithZero, 3);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.degenerateFixedCount).toBe(0);
      expect(fit.degenerateZeroCount).toBe(2);
      expect(fit.theta.filter((t) => t === 0).length).toBe(2);
    });

    it("除外馬(umaban=6,7)はどの着順にも一切現れないこと(JSDocの契約を直接expect)", () => {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hsWithZero, 3);
      expect(ordered).not.toBeNull();
      expect(ordered!.length).toBeGreaterThan(0);
      for (const outcome of ordered!) {
        expect(outcome.order).not.toContain(6);
        expect(outcome.order).not.toContain(7);
      }
    });

    it("AC-B1b-1(b): θ=0混在でも上位3集合周辺はbuildDistribution(集合空間)と一致すること", () => {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hsWithZero, 3)!;
      const setDist = PLACKETT_LUCE_MODEL.buildDistribution(hsWithZero, 3);
      const orderedSetMarginals = setMarginals(ordered);
      // 前提(空振り防止): 除外馬を含む組合せの確率が実際に0であること(除外が正しく効いている)。
      const comboWithExcluded = setDist.find(
        (o) => o.placed.includes(6) || o.placed.includes(7),
      );
      expect(comboWithExcluded).toBeDefined();
      expect(comboWithExcluded!.probability).toBe(0);
      let matchedNonZero = 0;
      for (const outcome of setDist) {
        const key = [...outcome.placed].sort((a, b) => a - b).join(",");
        const orderedValue = orderedSetMarginals.get(key) ?? 0;
        expect(orderedValue).toBeCloseTo(outcome.probability, 6);
        if (outcome.probability > 0) matchedNonZero++;
      }
      // 空振り防止: 確率0の組合せだけで自明に一致するテストになっていないことを固定する
      // (除外馬を含まない組合せどうしの非ゼロ一致が複数あることを要求する)。
      expect(matchedNonZero).toBeGreaterThan(1);
    });
  });

  describe("組合せ軸の空白セル(code-reviewer提案1): fixedIndices.length===1×zero>=1・fixedIndices.length>=2×zero>=1", () => {
    describe("fixedIndices.length===1 かつ zero>=1。6頭・[1,0.6,0.5,0.4,0,0]・k=3", () => {
      const hs = horses([1, 0.6, 0.5, 0.4, 0, 0]);

      it("前提固定(空振り防止): degenerateFixedCount=1・degenerateZeroCount=2であること", () => {
        const fit = fitPlackettLuceStrengths(hs, 3);
        expect(fit.ok).toBe(true);
        if (!fit.ok) return;
        expect(fit.degenerateFixedCount).toBe(1);
        expect(fit.degenerateZeroCount).toBe(2);
      });

      it("固定馬1着分岐(fixedIndices.length===1)の内部でも、除外馬(umaban=5,6)はどの着順にも一切現れないこと(典型的なリファクタバグ〈この分岐内でfreeIndicesをθ=0除外なしに再計算する〉を殺す)", () => {
        const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3);
        expect(ordered).not.toBeNull();
        expect(ordered!.length).toBeGreaterThan(0);
        for (const outcome of ordered!) {
          expect(outcome.order).not.toContain(5);
          expect(outcome.order).not.toContain(6);
          // 固定馬(umaban=1)が常に1着であることも併せて固定する(この分岐の主契約)。
          expect(outcome.order[0]).toBe(1);
        }
      });
    });

    describe("fixedIndices.length>=2 かつ zero>=1。6頭・[1,1,0.5,0.4,0,0]・k=3", () => {
      const hs = horses([1, 1, 0.5, 0.4, 0, 0]);

      it("前提固定(空振り防止): degenerateFixedCount=2・degenerateZeroCount=2であること", () => {
        const fit = fitPlackettLuceStrengths(hs, 3);
        expect(fit.ok).toBe(true);
        if (!fit.ok) return;
        expect(fit.degenerateFixedCount).toBe(2);
        expect(fit.degenerateZeroCount).toBe(2);
      });

      it("除外馬が混在していても、buildOrderedDistributionはnullを返すこと(判定不能の原因は除外馬の有無に左右されない)", () => {
        expect(PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 3)).toBeNull();
      });
    });
  });

  describe("kPrime===0到達経路の直接テスト(code-reviewer提案2): fixedIndices.length===1 && topFinishCount===1の1通りのみで到達する", () => {
    // 3頭のうち1頭だけplaceProb>0(m===k=1分岐)。k=1でfixedIndices.length===1になる
    // 唯一の構成(k=1でp_maxが固定されるにはp>0の頭数がちょうど1でなければならない。
    // JSDoc「水詰めのm===k分岐」参照)。
    const hs = horses([0.5, 0, 0]);

    it("前提固定(空振り防止): degenerateFixedCount=1・reducedHorseCount=0(自由集合が空。kPrime=k-1=0に到達する構成)であること", () => {
      const fit = fitPlackettLuceStrengths(hs, 1);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.degenerateFixedCount).toBe(1);
      expect(fit.reducedHorseCount).toBe(0);
      expect(fit.reducedPlaceCount).toBe(0);
    });

    it("固定馬が確率1で1着(=k=1の全体)であること。自由集合が空(kPrime=0)でも順序空間が正しく1件に定まる", () => {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, 1);
      expect(ordered).toEqual<readonly OrderedOutcome[]>([{ order: [1], probability: 1 }]);
    });
  });
});
