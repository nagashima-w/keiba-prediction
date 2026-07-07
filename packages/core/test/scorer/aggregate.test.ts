import { describe, expect, it } from "vitest";
import type { PlacedResult } from "../../src/scorer/derive-features.js";
import {
  aggregatePlaceRate,
  computeDifferenceCorrection,
} from "../../src/scorer/aggregate.js";

/** 複勝圏内(placed:true)の判定結果。 */
const 圏内: PlacedResult = { kind: "判定", placed: true };
/** 複勝圏外(placed:false)の判定結果。 */
const 圏外: PlacedResult = { kind: "判定", placed: false };
/** 集計対象外(中止など)。 */
const 対象外: PlacedResult = { kind: "対象外", reason: "非数値着順" };

describe("aggregatePlaceRate(複勝率集計)", () => {
  it("空配列は母数0・複勝率0を返すこと", () => {
    expect(aggregatePlaceRate([])).toEqual({
      sampleCount: 0,
      placedCount: 0,
      rate: 0,
    });
  });

  it("全走複勝圏内なら複勝率1.0になること", () => {
    expect(aggregatePlaceRate([圏内, 圏内, 圏内])).toEqual({
      sampleCount: 3,
      placedCount: 3,
      rate: 1,
    });
  });

  it("圏内・圏外の混在で複勝率が正しく計算されること", () => {
    // 4走中2走圏内 → 0.5。
    const agg = aggregatePlaceRate([圏内, 圏外, 圏内, 圏外]);
    expect(agg).toEqual({ sampleCount: 4, placedCount: 2, rate: 0.5 });
  });

  it("対象外(中止など)は母数(sampleCount)から除外されること", () => {
    // 圏内2・圏外1・対象外2 → 母数3・複勝2走 → 2/3。
    const agg = aggregatePlaceRate([圏内, 圏内, 圏外, 対象外, 対象外]);
    expect(agg.sampleCount).toBe(3);
    expect(agg.placedCount).toBe(2);
    expect(agg.rate).toBeCloseTo(2 / 3, 10);
  });

  it("すべて対象外なら母数0・複勝率0(ゼロ除算にならない)こと", () => {
    expect(aggregatePlaceRate([対象外, 対象外])).toEqual({
      sampleCount: 0,
      placedCount: 0,
      rate: 0,
    });
  });
});

describe("computeDifferenceCorrection(差分ベース補正の組み立て)", () => {
  const overall = { sampleCount: 10, placedCount: 3, rate: 0.3 };

  it("対象サンプルが閾値未満(2走未満)なら補正なし(0)・applied=falseになること", () => {
    const target = { sampleCount: 1, placedCount: 1, rate: 1 };
    const c = computeDifferenceCorrection({
      biasName: "テスト",
      target,
      overall,
      weight: 1,
      minSample: 2,
      insufficientReason: "サンプル不足",
      appliedReason: "適用",
    });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
    expect(c.reason).toBe("サンプル不足");
    // 内訳(寄与度ログ用)は補正なしでも保持されること。
    expect(c.sampleCount).toBe(1);
    expect(c.targetRate).toBeCloseTo(1, 10);
    expect(c.overallRate).toBeCloseTo(0.3, 10);
  });

  it("対象サンプルが閾値ちょうど(2走)なら補正が適用されること", () => {
    const target = { sampleCount: 2, placedCount: 2, rate: 1 };
    const c = computeDifferenceCorrection({
      biasName: "テスト",
      target,
      overall,
      weight: 1,
      minSample: 2,
      insufficientReason: "サンプル不足",
      appliedReason: "適用",
    });
    expect(c.applied).toBe(true);
    // 補正 = (対象複勝率 − 全体複勝率) × 重み = (1.0 − 0.3) × 1。
    expect(c.correction).toBeCloseTo(0.7, 10);
  });

  it("対象複勝率が全体より高ければプラス、低ければマイナス補正になること", () => {
    const high = computeDifferenceCorrection({
      biasName: "テスト",
      target: { sampleCount: 5, placedCount: 4, rate: 0.8 },
      overall,
      weight: 1,
      minSample: 2,
      insufficientReason: "x",
      appliedReason: "y",
    });
    const low = computeDifferenceCorrection({
      biasName: "テスト",
      target: { sampleCount: 5, placedCount: 0, rate: 0 },
      overall,
      weight: 1,
      minSample: 2,
      insufficientReason: "x",
      appliedReason: "y",
    });
    expect(high.correction).toBeCloseTo(0.5, 10); // (0.8-0.3)
    expect(low.correction).toBeCloseTo(-0.3, 10); // (0-0.3)
  });

  it("重み係数が補正値に乗算されること", () => {
    const c = computeDifferenceCorrection({
      biasName: "テスト",
      target: { sampleCount: 5, placedCount: 4, rate: 0.8 },
      overall,
      weight: 2,
      minSample: 2,
      insufficientReason: "x",
      appliedReason: "y",
    });
    // (0.8-0.3) × 2 = 1.0。
    expect(c.correction).toBeCloseTo(1, 10);
    expect(c.weight).toBe(2);
  });
});
