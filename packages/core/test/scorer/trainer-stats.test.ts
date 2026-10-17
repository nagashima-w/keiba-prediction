/**
 * 調教師の前2年の3着内率(Issue #354〈#348 の TR1〉)。
 *
 * - 窓: レースの年 Y の (Y−2, Y−1)。当年(Y)の行は使わない(先読みを避ける。検証と同じ)。ライブと過去日の区別はない。
 * - 率: 窓の3着内と出走を合算し、全体の率(0.222)へ出走 50 ぶん寄せて縮小する。
 * - 特徴量: 率 − レース内の「値のある馬」の平均。値が無い馬は 0。補正 = w × 特徴量。
 */

import { describe, expect, it } from "vitest";
import {
  TRAINER_NAME,
  TRAINER_PLACE_RATE_BASE,
  TRAINER_SHRINK_STARTS,
  computeFieldTrainerContributions,
  selectTrainerStats,
  shrunkTrainerRate,
  trainerStatsWindow,
  type TrainerStats,
} from "../../src/scorer/trainer-stats.js";
import type { JockeyYearRecord } from "../../src/scraper/parse-jockey-results.js";

const rec = (year: number, starts: number, placed: number): JockeyYearRecord => ({ year, starts, placed });

describe("定数", () => {
  it("縮小の基準は 0.222、縮小の強さは出走 50 ぶん、寄与度の項目名は「調教師成績」", () => {
    expect(TRAINER_PLACE_RATE_BASE).toBe(0.222);
    expect(TRAINER_SHRINK_STARTS).toBe(50);
    expect(TRAINER_NAME).toBe("調教師成績");
  });
});

describe("trainerStatsWindow(窓の年)", () => {
  it.each([
    ["2026/10/17", [2024, 2025]],
    ["2027/01/04", [2025, 2026]],
    ["2026/01/01", [2024, 2025]],
    ["2026/12/31", [2024, 2025]],
  ] as const)("分析日 %s の窓は %j(当年は含めない)", (date, expected) => {
    expect(trainerStatsWindow(date)).toEqual(expected);
  });

  it("YYYY/MM/DD でない分析日は失敗させる(黙って別の窓にしない)", () => {
    expect(() => trainerStatsWindow("2026-10-17")).toThrow(/YYYY\/MM\/DD/);
    expect(() => trainerStatsWindow("")).toThrow(/YYYY\/MM\/DD/);
  });
});

describe("selectTrainerStats(年ごとの記録から窓の2年だけを足す)", () => {
  const records = [rec(2026, 90, 40), rec(2025, 200, 50), rec(2024, 100, 30), rec(2023, 300, 99)];

  it("2026 年のレースは 2024+2025 だけを足す(2026 の行も 2023 以前の行も入らない)", () => {
    expect(selectTrainerStats(records, "2026/10/17")).toEqual({ starts: 300, placed: 80 });
  });

  it("2027 年のレースは 2025+2026(窓が1年ずれる)", () => {
    expect(selectTrainerStats(records, "2027/01/09")).toEqual({ starts: 290, placed: 90 });
  });

  it("記録そのものが無い(取得できなかった・調教師IDが無い)ときは undefined", () => {
    expect(selectTrainerStats(undefined, "2026/10/17")).toBeUndefined();
  });

  it("記録はあるが窓の年の行が無いときは出走 0(「データなし」と区別する)", () => {
    expect(selectTrainerStats([rec(2026, 10, 3), rec(2022, 50, 20)], "2026/10/17")).toEqual({ starts: 0, placed: 0 });
    expect(selectTrainerStats([], "2026/10/17")).toEqual({ starts: 0, placed: 0 });
  });
});

describe("shrunkTrainerRate(縮小した率)", () => {
  it("(3着内 + 50×0.222) ÷ (出走 + 50)", () => {
    // (300 + 11.1) / (1000 + 50) = 0.29628571...
    expect(shrunkTrainerRate({ starts: 1000, placed: 300 })).toBeCloseTo(311.1 / 1050, 12);
    // 出走が少ないほど 0.222 に寄る: (2 + 11.1) / (5 + 50)
    expect(shrunkTrainerRate({ starts: 5, placed: 2 })).toBeCloseTo(13.1 / 55, 12);
  });

  it("出走 0 は null(値なし)。undefined も null", () => {
    expect(shrunkTrainerRate({ starts: 0, placed: 0 })).toBeNull();
    expect(shrunkTrainerRate(undefined)).toBeNull();
  });
});

describe("computeFieldTrainerContributions", () => {
  const W = 0.77;
  const ctx = { venueKind: "central", courseType: "芝", weight: W } as const;
  // A: 率 311.1/1050、B: 率 (22+11.1)/150。C は値なし(undefined)、D は出走 0。
  const A: TrainerStats = { starts: 1000, placed: 300 };
  const B: TrainerStats = { starts: 100, placed: 22 };
  const rateA = 311.1 / 1050;
  const rateB = 33.1 / 150;
  const mean = (rateA + rateB) / 2;

  it("前提: 手計算の率が A > B で、差が 0 でない", () => {
    expect(shrunkTrainerRate(A)).toBeCloseTo(rateA, 12);
    expect(shrunkTrainerRate(B)).toBeCloseTo(rateB, 12);
    expect(rateA - rateB).toBeGreaterThan(0.05);
  });

  it("特徴量 = 率 − 値のある馬の平均、補正 = w × 特徴量。値の無い馬は 0・applied:false", () => {
    const cs = computeFieldTrainerContributions([A, B, undefined, { starts: 0, placed: 0 }], ctx);
    expect(cs).toHaveLength(4);
    expect(cs[0]!.correction).toBeCloseTo(W * (rateA - mean), 12);
    expect(cs[1]!.correction).toBeCloseTo(W * (rateB - mean), 12);
    expect(cs[0]!.applied).toBe(true);
    expect(cs[1]!.applied).toBe(true);
    // 符号: 率の高い A が正、低い B が負。
    expect(cs[0]!.correction).toBeGreaterThan(0.01);
    expect(cs[1]!.correction).toBeLessThan(-0.01);
    for (const c of [cs[2]!, cs[3]!]) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toContain("補正なし");
    }
    for (const c of cs) {
      expect(c.biasName).toBe("調教師成績");
      expect(c.weight).toBe(W);
    }
  });

  it("値のある馬の補正の和は 0(平均を引いているので)。値のある馬が3頭でも同じ", () => {
    const C: TrainerStats = { starts: 400, placed: 70 };
    const cs = computeFieldTrainerContributions([A, B, C, undefined], ctx);
    const known = cs.filter((c) => c.applied);
    expect(known).toHaveLength(3);
    expect(Math.abs(known[0]!.correction)).toBeGreaterThan(1e-3); // 和が 0 なのが全部 0 だからではない
    expect(known.reduce((s, c) => s + c.correction, 0)).toBeCloseTo(0, 12);
  });

  it("寄与度の記録: sampleCount = 窓の出走、targetRate = 縮小した率、overallRate = レース内の平均", () => {
    const cs = computeFieldTrainerContributions([A, B], ctx);
    expect(cs[0]!.sampleCount).toBe(1000);
    expect(cs[0]!.targetRate).toBeCloseTo(rateA, 12);
    expect(cs[0]!.overallRate).toBeCloseTo(mean, 12);
    expect(cs[1]!.sampleCount).toBe(100);
  });

  it("値のある馬が2頭未満なら全頭 0・applied:false(比べる相手がいない)", () => {
    for (const stats of [[A, undefined, undefined], [undefined, undefined], [A], [A, { starts: 0, placed: 0 }]] as const) {
      const cs = computeFieldTrainerContributions(stats, ctx);
      expect(cs).toHaveLength(stats.length);
      for (const c of cs) {
        expect(c.applied).toBe(false);
        expect(c.correction).toBe(0);
      }
    }
  });

  it("地方のレースは全頭 0・applied:false・「NARのため対象外」(値のある馬がいても)", () => {
    const cs = computeFieldTrainerContributions([A, B, A], { ...ctx, venueKind: "nar" });
    expect(cs).toHaveLength(3);
    for (const c of cs) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("NARのため対象外");
    }
  });

  it("障害のレースは全頭 0・applied:false・「障害のため対象外」", () => {
    const cs = computeFieldTrainerContributions([A, B, A], { ...ctx, courseType: "障" });
    for (const c of cs) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("障害のため対象外");
    }
  });

  it("重み 0 なら補正は 0(applied は値のある馬で true のまま)", () => {
    const cs = computeFieldTrainerContributions([A, B], { ...ctx, weight: 0 });
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.correction === 0)).toBe(true); // -0 も 0 と見なす
  });

  it("0頭は空配列", () => {
    expect(computeFieldTrainerContributions([], ctx)).toEqual([]);
  });
});
