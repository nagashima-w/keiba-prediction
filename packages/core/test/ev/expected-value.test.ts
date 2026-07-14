import { describe, expect, it } from "vitest";
import {
  computeEstimatedRaceEv,
  computeRaceEv,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
  estimatePlaceOddsMinFromWin,
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

/**
 * estimatePlaceOddsMinFromWin(推定複勝下限の換算)。
 * ユーザー要望(Task#25): 発売前(oddsStatus=yoso)は予想単勝オッズしかなく複勝が無いため、
 * 単勝オッズから複勝下限を経験則ベースで概算する。既定式:
 *   推定複勝下限 = max(1.0, 1.0 + (winOdds − 1.0) × coef)、coef 既定0.2。
 */
describe("estimatePlaceOddsMinFromWin(単勝オッズ→推定複勝下限の換算)", () => {
  describe("既定係数(coef=0.2)での換算値", () => {
    const cases: Array<{ winOdds: number; expected: number }> = [
      { winOdds: 1.5, expected: 1.1 },
      { winOdds: 10, expected: 2.8 },
      { winOdds: 50, expected: 10.8 },
    ];
    for (const c of cases) {
      it(`単勝${c.winOdds}倍 → 推定複勝下限${c.expected}`, () => {
        expect(
          estimatePlaceOddsMinFromWin(c.winOdds, DEFAULT_ESTIMATED_PLACE_CONFIG),
        ).toBeCloseTo(c.expected, 10);
      });
    }

    it("configを省略するとデフォルト係数(0.2)が使われる", () => {
      expect(DEFAULT_ESTIMATED_PLACE_CONFIG.coef).toBe(0.2);
      expect(estimatePlaceOddsMinFromWin(10)).toBeCloseTo(2.8, 10);
    });
  });

  describe("境界・異常値の扱い", () => {
    it("単勝オッズが1.0ちょうどのときは推定複勝下限も1.0(max(1.0, ...)の下限)", () => {
      expect(estimatePlaceOddsMinFromWin(1.0)).toBeCloseTo(1.0, 10);
    });

    it("winOddsがnullのときはnullを返す", () => {
      expect(estimatePlaceOddsMinFromWin(null)).toBeNull();
    });

    it("winOddsが1未満のときはnullを返す(オッズとして不正)", () => {
      expect(estimatePlaceOddsMinFromWin(0.9)).toBeNull();
    });

    it("winOddsがNaNのときはnullを返す(非有限)", () => {
      expect(estimatePlaceOddsMinFromWin(Number.NaN)).toBeNull();
    });

    it("winOddsがInfinityのときはnullを返す(非有限)", () => {
      expect(estimatePlaceOddsMinFromWin(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("coefを変えると換算値も変わる(config化されていること)", () => {
      expect(
        estimatePlaceOddsMinFromWin(10, { coef: 0.5 }),
      ).toBeCloseTo(1.0 + 9 * 0.5, 10);
    });
  });
});

/**
 * computeEstimatedRaceEv(推定EV計算)。
 * 発売前(複勝オッズが存在しない)レースで、単勝オッズから推定した複勝下限を用いてEVを概算する。
 * 確定EV経路(computeRaceEv)とは別関数とし、結果の型(EstimatedHorseEv)にも evEstimated: true を
 * 持たせて確定EVと型レベルで区別する。
 */
describe("computeEstimatedRaceEv(推定複勝下限によるEV概算)", () => {
  it("単勝オッズから推定した複勝下限でEVを計算し、evEstimated=trueを付与すること", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    // yoso想定: place は空、win のみ存在。
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    // 推定複勝下限 = 1.0 + (10-1)×0.2 = 2.8。EV = 0.5×2.8 = 1.4。
    expect(result!.placeOddsMin).toBeCloseTo(2.8, 10);
    expect(result!.ev).toBeCloseTo(1.4, 10);
    expect(result!.isPositive).toBe(true);
    expect(result!.evEstimated).toBe(true);
    expect(result!.excludedReason).toBeNull();
  });

  it("単勝オッズも欠損している馬は対象外(ev=null・理由付き)", () => {
    const priors: HorsePrior[] = [{ umaban: 3, placeProb: 0.4 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 3: { odds: null, ninki: null } }, // 取消等で単勝オッズも欠損
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    expect(result!.ev).toBeNull();
    expect(result!.placeOddsMin).toBeNull();
    expect(result!.isPositive).toBe(false);
    expect(result!.evEstimated).toBe(true);
    expect(result!.excludedReason).not.toBeNull();
  });

  it("単勝オッズに馬番自体が無い馬も対象外(ev=null・理由付き)", () => {
    const priors: HorsePrior[] = [{ umaban: 9, placeProb: 0.4 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: {},
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    expect(result!.ev).toBeNull();
    expect(result!.excludedReason).not.toBeNull();
  });

  it("EvConfig(閾値)は確定EV経路と同じ意味で効くこと", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    // EV=1.4なので閾値1.5だとプラスではない。
    const [result] = computeEstimatedRaceEv(priors, odds, { threshold: 1.5 });
    expect(result!.ev).toBeCloseTo(1.4, 10);
    expect(result!.isPositive).toBe(false);
  });

  it("estimatedPlaceConfig(coef)を差し替えられること", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    const [result] = computeEstimatedRaceEv(
      priors,
      odds,
      DEFAULT_EV_CONFIG,
      { coef: 0.5 },
    );
    // 推定複勝下限 = 1.0 + 9×0.5 = 5.5。EV = 0.5×5.5 = 2.75。
    expect(result!.placeOddsMin).toBeCloseTo(5.5, 10);
    expect(result!.ev).toBeCloseTo(2.75, 10);
  });

  it("全馬を入力順で返し、対象外馬も欠落させない", () => {
    const priors: HorsePrior[] = [
      { umaban: 5, placeProb: 0.6 },
      { umaban: 2, placeProb: 0.5 }, // 単勝オッズ欠損
    ];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 5: { odds: 5.5, ninki: 1 }, 2: { odds: null, ninki: null } },
      place: {},
    };
    const results = computeEstimatedRaceEv(priors, odds);
    expect(results.map((r) => r.umaban)).toEqual([5, 2]);
    expect(results[0]!.ev).not.toBeNull();
    expect(results[1]!.ev).toBeNull();
  });
});
