import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { computeFrameBias } from "../../src/scorer/bias-frame.js";
import { makeResult, rank } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 枠と着順だけの合成戦績を作る。 */
function frameRun(date: string, waku: number, finish: number) {
  return makeResult({ date, wakuban: waku, finishPosition: rank(finish) });
}

describe("computeFrameBias(枠順適性・馬個別)", () => {
  it("対象ゾーン0走のときは補正なし(不明)になること", () => {
    // 内枠実績なし、今回内枠。
    const features = deriveRaceFeatures([
      frameRun("2025/02/01", 7, 1),
      frameRun("2025/01/01", 8, 2),
    ]);
    const c = computeFrameBias(features, { frameZone: "内" });
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(0);
    expect(c.correction).toBe(0);
  });

  it("対象ゾーン1走のときは補正なし(2走未満)になること", () => {
    const features = deriveRaceFeatures([
      frameRun("2025/02/01", 1, 1), // 内1走
      frameRun("2025/01/01", 7, 5),
    ]);
    const c = computeFrameBias(features, { frameZone: "内" });
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
  });

  it("対象ゾーン2走ちょうどで補正が適用されること", () => {
    // 外枠2走(圏内2)、他ゾーン1走(圏外)。
    // 外率 = 1.0、全体 2/3。差分 = +1/3。
    const features = deriveRaceFeatures([
      frameRun("2025/03/01", 7, 1),
      frameRun("2025/02/01", 8, 3),
      frameRun("2025/01/01", 1, 8),
    ]);
    const c = computeFrameBias(features, { frameZone: "外" });
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1, 10);
    expect(c.overallRate).toBeCloseTo(2 / 3, 10);
    expect(c.correction).toBeCloseTo(1 / 3, 10);
  });

  it("外枠複勝率が明確に低い馬が今回外枠ならマイナス補正になること", () => {
    // 外枠3走とも圏外(率0)、内枠2走圏内 → 全体 2/5=0.4。差分 = -0.4。
    const features = deriveRaceFeatures([
      frameRun("2025/05/01", 7, 10),
      frameRun("2025/04/01", 8, 9),
      frameRun("2025/03/01", 7, 12),
      frameRun("2025/02/01", 1, 1),
      frameRun("2025/01/01", 2, 2),
    ]);
    const c = computeFrameBias(features, { frameZone: "外" });
    expect(c.correction).toBeCloseTo(-0.4, 10);
  });

  it("枠番のない過去走(海外など)は母数から除外されること", () => {
    // 枠null1走 + 内枠2走(圏内1・圏外1)。内率0.5、全体は枠のある走のみで集計。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/03/01", wakuban: null, finishPosition: rank(1) }),
      frameRun("2025/02/01", 1, 1),
      frameRun("2025/01/01", 2, 8),
    ]);
    const c = computeFrameBias(features, { frameZone: "内" });
    expect(c.sampleCount).toBe(2);
    expect(c.overallRate).toBeCloseTo(0.5, 10); // 枠null走は全体母数からも除外
  });

  it("実フィクスチャ(ウィンターガーデン): 内枠の補正が (2/8 − 8/23) になること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeFrameBias(features, { frameZone: "内" });
    // 内枠(1〜3枠)8走中2走圏内 → 0.25。全体23走中8走圏内 → 8/23。
    expect(c.sampleCount).toBe(8);
    expect(c.targetRate).toBeCloseTo(2 / 8, 10);
    expect(c.overallRate).toBeCloseTo(8 / 23, 10);
    expect(c.correction).toBeCloseTo(2 / 8 - 8 / 23, 10);
  });

  it("実フィクスチャ(ウィンターガーデン): 外枠の補正が (2/4 − 8/23) になること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeFrameBias(features, { frameZone: "外" });
    expect(c.sampleCount).toBe(4);
    expect(c.targetRate).toBeCloseTo(0.5, 10);
    expect(c.correction).toBeCloseTo(0.5 - 8 / 23, 10);
  });
});
