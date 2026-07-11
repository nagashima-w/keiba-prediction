import { describe, expect, it } from "vitest";
import {
  computeRaceEv,
  DEFAULT_EV_CONFIG,
  type EvConfig,
  type HorsePrior,
} from "../../src/ev/expected-value.js";
import type { OddsSnapshot, PlaceOdds } from "../../src/scraper/types.js";

/** 複勝オッズ(下限・上限・人気)を最小構成で組み立てる。 */
function place(oddsMin: number | null, oddsMax: number | null = null): PlaceOdds {
  return { oddsMin, oddsMax: oddsMax ?? oddsMin, ninki: null };
}

/** 馬番→複勝オッズの OddsSnapshot を組み立てる(単勝は空でよい)。 */
function oddsSnapshot(place: Record<number, PlaceOdds>): OddsSnapshot {
  return { officialDatetime: null, oddsStatus: "result", win: {}, place };
}

describe("computeRaceEv(複勝期待値計算)", () => {
  describe("基本計算(EV = place_prob × 複勝オッズ下限)", () => {
    // 仕様「4. ev」: 複勝期待値 = place_prob × 複勝オッズ(下限値を使用)、EV>閾値のみ抽出。
    // 境界(EV=閾値ちょうど)は「プラスではない」(> 判定)。
    const cases: Array<{
      name: string;
      placeProb: number;
      oddsMin: number;
      threshold: number;
      expectedEv: number;
      expectedPositive: boolean;
    }> = [
      {
        name: "EVが閾値を上回る馬はプラス",
        placeProb: 0.5,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 1.25,
        expectedPositive: true,
      },
      {
        name: "EVが閾値ちょうどの馬はプラスではない(> 判定)",
        placeProb: 0.4,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 1.0,
        expectedPositive: false,
      },
      {
        name: "EVが閾値を下回る馬はプラスではない",
        placeProb: 0.3,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 0.75,
        expectedPositive: false,
      },
      {
        name: "閾値を上げると同じEVでもプラス判定が変わる(EV=1.25 < 閾値1.3)",
        placeProb: 0.5,
        oddsMin: 2.5,
        threshold: 1.3,
        expectedEv: 1.25,
        expectedPositive: false,
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const priors: HorsePrior[] = [{ umaban: 1, placeProb: c.placeProb }];
        const odds = oddsSnapshot({ 1: place(c.oddsMin) });
        const [result] = computeRaceEv(priors, odds, { threshold: c.threshold });
        expect(result!.ev).toBeCloseTo(c.expectedEv, 10);
        expect(result!.isPositive).toBe(c.expectedPositive);
        expect(result!.placeOddsMin).toBe(c.oddsMin);
        expect(result!.excludedReason).toBeNull();
      });
    }
  });

  describe("オッズ欠損馬の扱い(EV計算対象外)", () => {
    it("複勝オッズに馬番が存在しない馬は対象外(ev=null・理由付き)", () => {
      const priors: HorsePrior[] = [{ umaban: 7, placeProb: 0.5 }];
      const odds = oddsSnapshot({ 1: place(2.5) }); // 馬番7のオッズがない
      const [result] = computeRaceEv(priors, odds);
      expect(result!.ev).toBeNull();
      expect(result!.placeOddsMin).toBeNull();
      expect(result!.isPositive).toBe(false);
      expect(result!.excludedReason).not.toBeNull();
      expect(result!.excludedReason).toContain("馬番");
    });

    it("複勝オッズ下限がnullの馬は対象外(ev=null・理由付き)", () => {
      const priors: HorsePrior[] = [{ umaban: 3, placeProb: 0.5 }];
      const odds = oddsSnapshot({ 3: place(null) });
      const [result] = computeRaceEv(priors, odds);
      expect(result!.ev).toBeNull();
      expect(result!.placeOddsMin).toBeNull();
      expect(result!.isPositive).toBe(false);
      expect(result!.excludedReason).not.toBeNull();
      expect(result!.excludedReason).toContain("下限");
    });
  });

  describe("入力全体の扱い", () => {
    it("全馬を入力順で返し、対象外馬も欠落させない", () => {
      const priors: HorsePrior[] = [
        { umaban: 5, placeProb: 0.6 },
        { umaban: 2, placeProb: 0.5 }, // オッズ欠損
        { umaban: 8, placeProb: 0.2 },
      ];
      const odds = oddsSnapshot({ 5: place(2.0), 8: place(3.0) });
      const results = computeRaceEv(priors, odds);
      expect(results.map((r) => r.umaban)).toEqual([5, 2, 8]);
      expect(results[0]!.ev).toBeCloseTo(1.2, 10);
      expect(results[1]!.ev).toBeNull();
      expect(results[2]!.ev).toBeCloseTo(0.6, 10);
    });

    it("configを省略するとデフォルト閾値(1.0)が使われる", () => {
      expect(DEFAULT_EV_CONFIG.threshold).toBe(1.0);
      const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.45 }];
      const odds = oddsSnapshot({ 1: place(2.5) }); // EV=1.125
      const [result] = computeRaceEv(priors, odds);
      expect(result!.isPositive).toBe(true);
    });
  });
});
