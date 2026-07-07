import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import {
  computeSeasonBias,
  computeSummerFatigueBias,
} from "../../src/scorer/bias-season.js";
import type { BodyWeight } from "../../src/scraper/types.js";
import { makeResult, rank } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 体重(増減)を作る小ヘルパ。 */
function bw(weight: number, diff: number): BodyWeight {
  return { weight, diff };
}

describe("computeSeasonBias(季節適性)", () => {
  it("対象季節1走のときは補正なし(2走未満)になること", () => {
    // 夏1走のみ、今回夏。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/07/01", finishPosition: rank(1) }), // 夏
      makeResult({ date: "2025/03/01", finishPosition: rank(5) }), // 春秋
    ]);
    const c = computeSeasonBias(features, { season: "夏" });
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
    expect(c.correction).toBe(0);
  });

  it("対象季節2走ちょうどで補正が適用されること", () => {
    // 夏2走(圏内2)、春秋1走(圏外)。夏率1.0、全体2/3、差分+1/3。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/08/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/07/01", finishPosition: rank(2) }),
      makeResult({ date: "2025/03/01", finishPosition: rank(8) }),
    ]);
    const c = computeSeasonBias(features, { season: "夏" });
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(2);
    expect(c.correction).toBeCloseTo(1 / 3, 10);
  });

  it("冬に強い馬が今回冬ならプラス補正になること", () => {
    // 冬3走(圏内3)、夏2走(圏外)。冬率1.0、全体3/5=0.6、差分+0.4。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/12/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/01/15", finishPosition: rank(2) }),
      makeResult({ date: "2024/02/01", finishPosition: rank(3) }),
      makeResult({ date: "2024/07/01", finishPosition: rank(8) }),
      makeResult({ date: "2024/06/01", finishPosition: rank(9) }),
    ]);
    const c = computeSeasonBias(features, { season: "冬" });
    expect(c.correction).toBeCloseTo(0.4, 10);
  });

  it("実フィクスチャ(ウィンターガーデン): 今回夏の季節補正が (2/9 − 8/23) になること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeSeasonBias(features, { season: "夏" });
    // 夏9走中2走圏内 → 2/9。全体23走中8走 → 8/23。
    expect(c.sampleCount).toBe(9);
    expect(c.targetRate).toBeCloseTo(2 / 9, 10);
    expect(c.correction).toBeCloseTo(2 / 9 - 8 / 23, 10);
  });
});

describe("computeSummerFatigueBias(夏負けフラグ)", () => {
  it("今回が夏でないときは判定せず補正なしになること", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/07/01", bodyWeight: bw(490, -10) }),
      makeResult({ date: "2025/06/01", bodyWeight: bw(500, -12) }),
    ]);
    const c = computeSummerFatigueBias(features, { season: "冬" });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("夏走2走未満のときは判定せず補正なしになること", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/07/01", bodyWeight: bw(490, -10) }), // 夏1走のみ
      makeResult({ date: "2025/03/01", bodyWeight: bw(500, -12) }), // 春秋
    ]);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    expect(c.applied).toBe(false);
    expect(c.summerRunCount).toBe(1);
    expect(c.correction).toBe(0);
  });

  it("夏開催の平均体重変化が-6kg以下ならマイナス補正(夏負け)になること", () => {
    // 夏3走の平均 = (-6 + -8 + -10)/3 = -8kg ≤ -6 → 夏負け。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/08/01", bodyWeight: bw(490, -6) }),
      makeResult({ date: "2025/07/01", bodyWeight: bw(498, -8) }),
      makeResult({ date: "2025/06/01", bodyWeight: bw(506, -10) }),
    ]);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    expect(c.applied).toBe(true);
    expect(c.summerRunCount).toBe(3);
    expect(c.avgWeightDiff).toBeCloseTo(-8, 10);
    expect(c.correction).toBeLessThan(0);
  });

  it("平均-6kgちょうど(境界)は夏負けと判定されること", () => {
    // 平均 = (-6 + -6)/2 = -6 ちょうど。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/08/01", bodyWeight: bw(490, -6) }),
      makeResult({ date: "2025/07/01", bodyWeight: bw(496, -6) }),
    ]);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    expect(c.applied).toBe(true);
    expect(c.avgWeightDiff).toBeCloseTo(-6, 10);
  });

  it("平均が-6kgより大きい(減が浅い)なら夏負けなし・補正0になること", () => {
    // 平均 = (-4 + -2)/2 = -3 > -6 → 夏負けなし。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/08/01", bodyWeight: bw(490, -4) }),
      makeResult({ date: "2025/07/01", bodyWeight: bw(494, -2) }),
    ]);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("馬体重が欠損している夏走は平均から除外されること", () => {
    // 欠損1走 + 実測2走(-8, -10)。平均 = -9(欠損は除外)→ 夏負け。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/08/15", bodyWeight: null }),
      makeResult({ date: "2025/08/01", bodyWeight: bw(490, -8) }),
      makeResult({ date: "2025/07/01", bodyWeight: bw(498, -10) }),
    ]);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    expect(c.summerRunCount).toBe(2); // 体重の取れた夏走のみ
    expect(c.avgWeightDiff).toBeCloseTo(-9, 10);
    expect(c.applied).toBe(true);
  });

  it("実フィクスチャ(ウィンターガーデン): 夏の平均体重変化はプラス寄りで夏負けなしになること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeSummerFatigueBias(features, { season: "夏" });
    // 夏9走の体重変化平均 = +12/9 ≈ +1.33 → 夏負けなし。
    expect(c.summerRunCount).toBe(9);
    expect(c.avgWeightDiff).toBeCloseTo(12 / 9, 6);
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});
