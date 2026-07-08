import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { computeTrackConditionBias } from "../../src/scorer/bias-track-condition.js";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";
import { makeResult, rank } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 合成戦績から派生特徴量を作る。 */
function featuresOf(results: Parameters<typeof deriveRaceFeatures>[0]) {
  return deriveRaceFeatures(results);
}

describe("computeTrackConditionBias(馬場状態適性)", () => {
  it("今回が良馬場のときは非発動(補正なし)になること", () => {
    const features = featuresOf([
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2024/12/01",
        courseType: "ダ",
        trackCondition: "不",
        finishPosition: rank(1),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: false,
    });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("道悪実績0走のときは補正なし(不明)になること", () => {
    const features = featuresOf([
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(1),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
    expect(c.sampleCount).toBe(0);
  });

  it("道悪実績1走のときは補正なし(2走未満)になること", () => {
    const features = featuresOf([
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2024/12/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(5),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
    expect(c.correction).toBe(0);
  });

  it("道悪実績2走ちょうど・複勝率が高いときはプラス補正になること", () => {
    // 同種別(ダ)道悪2走とも複勝圏内 → 道悪率1.0。
    // 全体(ダ)は道悪2走+良1走(圏外)→ 2/3。差分 = 1.0 - 2/3 = +1/3。
    const features = featuresOf([
      makeResult({
        date: "2025/03/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "ダ",
        trackCondition: "稍",
        finishPosition: rank(2),
      }),
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(8),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1, 10);
    expect(c.overallRate).toBeCloseTo(2 / 3, 10);
    expect(c.correction).toBeCloseTo(1 / 3, 10);
  });

  it("道悪で明確に凡走している馬はマイナス補正になること", () => {
    // ダ道悪3走とも圏外(率0)、良2走圏内 → 全体 2/5=0.4。差分 = 0 - 0.4 = -0.4。
    const features = featuresOf([
      makeResult({
        date: "2025/05/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(10),
      }),
      makeResult({
        date: "2025/04/01",
        courseType: "ダ",
        trackCondition: "稍",
        finishPosition: rank(9),
      }),
      makeResult({
        date: "2025/03/01",
        courseType: "ダ",
        trackCondition: "不",
        finishPosition: rank(12),
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(2),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(3);
    expect(c.correction).toBeCloseTo(-0.4, 10);
  });

  it("芝とダートを別集計する(今回ダートなら芝の道悪実績は使わない)こと", () => {
    // 芝道悪3走(圏内)は今回ダートでは無視。ダ道悪は1走のみ → 補正なし。
    const features = featuresOf([
      makeResult({
        date: "2025/05/01",
        courseType: "芝",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/04/01",
        courseType: "芝",
        trackCondition: "稍",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/03/01",
        courseType: "芝",
        trackCondition: "不",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(3),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.applied).toBe(false); // ダ道悪1走のみ
    expect(c.sampleCount).toBe(1);
  });

  it("芝とダートを別集計する(今回芝ならダートの道悪実績は使わない)こと", () => {
    // 逆方向: ダ道悪3走(圏内)は今回芝では無視。芝道悪は1走のみ → 補正なし。
    const features = featuresOf([
      makeResult({
        date: "2025/05/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/04/01",
        courseType: "ダ",
        trackCondition: "稍",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/03/01",
        courseType: "ダ",
        trackCondition: "不",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "芝",
        trackCondition: "重",
        finishPosition: rank(3),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "芝",
      isWet: true,
    });
    expect(c.applied).toBe(false); // 芝道悪1走のみ
    expect(c.sampleCount).toBe(1);
  });

  it("対象外行(中止)は母数から除外されること", () => {
    // ダ道悪: 中止1・圏内2 → 母数2・複勝2 → 率1.0(中止は数えない)。
    const features = featuresOf([
      makeResult({
        date: "2025/03/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: { kind: "非数値", text: "中止" },
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "ダ",
        trackCondition: "稍",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(3),
      }),
    ]);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    expect(c.sampleCount).toBe(2); // 中止を除いた道悪母数
    expect(c.targetRate).toBeCloseTo(1, 10);
  });

  it("重み係数(config)で補正の大きさを調整できること", () => {
    const features = featuresOf([
      makeResult({
        date: "2025/03/01",
        courseType: "ダ",
        trackCondition: "重",
        finishPosition: rank(1),
      }),
      makeResult({
        date: "2025/02/01",
        courseType: "ダ",
        trackCondition: "稍",
        finishPosition: rank(2),
      }),
      makeResult({
        date: "2025/01/01",
        courseType: "ダ",
        trackCondition: "良",
        finishPosition: rank(8),
      }),
    ]);
    const base = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    const doubled = computeTrackConditionBias(
      features,
      { courseType: "ダ", isWet: true },
      {
        ...DEFAULT_SCORER_CONFIG,
        weights: { ...DEFAULT_SCORER_CONFIG.weights, trackCondition: 2 },
      },
    );
    expect(doubled.correction).toBeCloseTo(base.correction * 2, 10);
  });

  it("実フィクスチャ(ウィンターガーデン): 今回ダート道悪の補正が (1/4 − 8/22) になること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeTrackConditionBias(features, {
      courseType: "ダ",
      isWet: true,
    });
    // ダ道悪4走(稍/重)中1走圏内 → 0.25。ダ全体22走中8走圏内 → 8/22。
    expect(c.sampleCount).toBe(4);
    expect(c.targetRate).toBeCloseTo(0.25, 10);
    expect(c.overallRate).toBeCloseTo(8 / 22, 10);
    expect(c.correction).toBeCloseTo(0.25 - 8 / 22, 10);
  });
});
