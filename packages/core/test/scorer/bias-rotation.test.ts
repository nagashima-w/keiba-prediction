import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import {
  deriveRaceFeatures,
  isPlaced,
  type DerivedRaceFeature,
} from "../../src/scorer/derive-features.js";
import {
  buildRotationCurve,
  classifyRotationType,
  computeRotationBias,
} from "../../src/scorer/bias-rotation.js";
import type { PlaceRateAggregate } from "../../src/scorer/aggregate.js";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";
import type { FinishPosition } from "../../src/scraper/types.js";
import { makeResult, rank } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * ローテーションテスト用に、休み明け走目と着順だけを指定した派生特徴量を直接組み立てる。
 * 走目カーブは f.restRunNumber と f.placed のみを参照するため、日付計算を経由せず
 * restRunNumber を直接与えられるようにする(境界値・重複タイプの検証を簡潔にするため)。
 */
function rotFeat(
  restRunNumber: number | null,
  finish: number | "対象外",
): DerivedRaceFeature {
  const fin: FinishPosition =
    finish === "対象外" ? { kind: "非数値", text: "中" } : rank(finish);
  const result = makeResult({ date: null, finishPosition: fin });
  return {
    result,
    placed: isPlaced(result.finishPosition),
    daysSincePrev: null,
    interval: "不明",
    restRunNumber,
    season: null,
    frameZone: null,
    trackWetness: null,
  };
}

/** 手組みの複勝率集計。 */
function agg(sampleCount: number, placedCount: number): PlaceRateAggregate {
  return {
    sampleCount,
    placedCount,
    rate: sampleCount === 0 ? 0 : placedCount / sampleCount,
  };
}

describe("buildRotationCurve(走目ごとの複勝率カーブ)", () => {
  it("走目ごとに複勝率を集計し、restRunNumber null は母数から除外すること", () => {
    const features = [
      rotFeat(1, 1), // N1 圏内
      rotFeat(1, 8), // N1 圏外
      rotFeat(2, 3), // N2 圏内
      rotFeat(3, 2), // N3 圏内
      rotFeat(4, 9), // N4+ 圏外
      rotFeat(5, 1), // N4+ 圏内
      rotFeat(null, 1), // 日付欠損 → 除外
    ];
    const curve = buildRotationCurve(features);
    expect(curve.n1.sampleCount).toBe(2);
    expect(curve.n1.placedCount).toBe(1);
    expect(curve.n2.sampleCount).toBe(1);
    expect(curve.n3.sampleCount).toBe(1);
    expect(curve.n4plus.sampleCount).toBe(2);
    expect(curve.n4plus.placedCount).toBe(1);
    // n2plus = N2以降全体(N2,N3,N4+) = 4走中3圏内。
    expect(curve.n2plus.sampleCount).toBe(4);
    expect(curve.n2plus.placedCount).toBe(3);
    // n23 = N2,N3 = 2走中2圏内。
    expect(curve.n23.sampleCount).toBe(2);
    expect(curve.n23.placedCount).toBe(2);
    // all = restRunNumber を持つ全走(nullを除く6走中4圏内)。
    expect(curve.all.sampleCount).toBe(6);
    expect(curve.all.placedCount).toBe(4);
  });

  it("非数値着順(対象外)は各バケットの母数から除外されること", () => {
    const features = [rotFeat(1, "対象外"), rotFeat(1, 1)];
    const curve = buildRotationCurve(features);
    expect(curve.n1.sampleCount).toBe(1);
    expect(curve.n1.placedCount).toBe(1);
  });
});

describe("classifyRotationType(タイプ分類・フラグの組み合わせ)", () => {
  const config = DEFAULT_SCORER_CONFIG;

  it("休み明けが通常時と同等以上なら鉄砲型になること", () => {
    const curve = {
      n1: agg(3, 3), // 1.0
      n2: agg(3, 1),
      n3: agg(3, 1),
      n4plus: agg(3, 1),
      n2plus: agg(9, 3), // 0.333
      n23: agg(6, 2),
      all: agg(12, 6),
    };
    const t = classifyRotationType(curve, config);
    expect(t.freshHorse).toBe(true);
    expect(t.improveWithRacing).toBe(false);
  });

  it("休み明けが2〜3走目より明確に低いなら叩き良化型になること", () => {
    const curve = {
      n1: agg(4, 0), // 0
      n2: agg(3, 2),
      n3: agg(3, 3),
      n4plus: agg(3, 1),
      n2plus: agg(9, 6),
      n23: agg(6, 5), // 0.833
      all: agg(13, 6),
    };
    const t = classifyRotationType(curve, config);
    expect(t.improveWithRacing).toBe(true);
    expect(t.freshHorse).toBe(false);
  });

  it("4走目以降がピーク走目より明確に低いなら使い込み下降型になること", () => {
    const curve = {
      n1: agg(3, 3), // ピーク 1.0
      n2: agg(3, 2),
      n3: agg(3, 2),
      n4plus: agg(4, 0), // 0.0 ≤ 1.0 − 0.1
      n2plus: agg(10, 4),
      n23: agg(6, 4),
      all: agg(13, 7),
    };
    const t = classifyRotationType(curve, config);
    expect(t.declineWithUse).toBe(true);
    // 休み明けがピークなので鉄砲型とも重複する。
    expect(t.freshHorse).toBe(true);
  });

  it("鉄砲型と使い込み下降型は重複しうること(排他でないこと)", () => {
    // 休み明け1.0でピーク、以降下降。fresh と decline が同時に立つ。
    const curve = {
      n1: agg(3, 3),
      n2: agg(2, 1),
      n3: agg(2, 0),
      n4plus: agg(3, 0),
      n2plus: agg(7, 1), // 0.143 < 1.0 → fresh
      n23: agg(4, 1),
      all: agg(10, 4),
    };
    const t = classifyRotationType(curve, config);
    expect(t.freshHorse).toBe(true);
    expect(t.declineWithUse).toBe(true);
  });

  it("休み明け実績(N1)が2走未満のときはN1依存の型(鉄砲・叩き良化)を判定しないこと", () => {
    // N1が1走のみ。鉄砲型・叩き良化型はN1に依存するため判定不能(false)。
    // 使い込み下降型はN1に依存しない(n4plusとピーク走目のみ)ため独立に判定される。
    // ここでは4走目以降がピークと同等(下降なし)になるようにして全フラグfalseを確認する。
    const curve = {
      n1: agg(1, 0), // 1走のみ
      n2: agg(3, 2), // 0.667
      n3: agg(3, 2), // 0.667(ピーク)
      n4plus: agg(3, 2), // 0.667 → ピークと同等なので下降型でない
      n2plus: agg(9, 6),
      n23: agg(6, 4),
      all: agg(10, 6),
    };
    const t = classifyRotationType(curve, config);
    expect(t.freshHorse).toBe(false);
    expect(t.improveWithRacing).toBe(false);
    expect(t.declineWithUse).toBe(false);
  });

  it("使い込み下降型は休み明け実績(N1)に依存せず判定されること", () => {
    // N1が1走のみでも、n4plusがn2/n3のピークより明確に低ければ下降型は立つ。
    const curve = {
      n1: agg(1, 1),
      n2: agg(3, 3), // ピーク 1.0
      n3: agg(3, 2),
      n4plus: agg(3, 0), // 0.0 ≤ 1.0 − 0.1
      n2plus: agg(9, 5),
      n23: agg(6, 5),
      all: agg(10, 6),
    };
    const t = classifyRotationType(curve, config);
    expect(t.declineWithUse).toBe(true);
    expect(t.freshHorse).toBe(false); // N1不足で鉄砲判定なし
  });
});

describe("computeRotationBias(走目に応じた補正)", () => {
  it("鉄砲型×休み明けは補正なし(0)になること", () => {
    const features = [
      rotFeat(1, 1),
      rotFeat(1, 1),
      rotFeat(1, 3),
      rotFeat(2, 8),
      rotFeat(2, 9),
      rotFeat(3, 8),
    ];
    const c = computeRotationBias(features, { restRunNumber: 1 });
    expect(c.types.freshHorse).toBe(true);
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("叩き良化型×休み明けはマイナス補正 (n1率 − 全体率) になること", () => {
    // N1: 2走0圏内(0.0)、N2: 2走2圏内、N3: 2走2圏内。n23=1.0、明確に低い → 叩き良化。
    const features = [
      rotFeat(1, 8),
      rotFeat(1, 9),
      rotFeat(2, 1),
      rotFeat(2, 2),
      rotFeat(3, 1),
      rotFeat(3, 3),
    ];
    const c = computeRotationBias(features, { restRunNumber: 1 });
    expect(c.types.improveWithRacing).toBe(true);
    expect(c.applied).toBe(true);
    // n1率=0、全体率=4/6 → 補正 = 0 − 4/6 < 0。
    expect(c.correction).toBeCloseTo(0 - 4 / 6, 10);
    expect(c.correction).toBeLessThan(0);
  });

  it("叩き良化型×叩き2走目はプラス補正 (n23率 − 全体率) になること", () => {
    const features = [
      rotFeat(1, 8),
      rotFeat(1, 9),
      rotFeat(2, 1),
      rotFeat(2, 2),
      rotFeat(3, 1),
      rotFeat(3, 3),
    ];
    const c = computeRotationBias(features, { restRunNumber: 2 });
    expect(c.types.improveWithRacing).toBe(true);
    expect(c.applied).toBe(true);
    // n23率=4/4=1.0、全体率=4/6 → 補正 = 1.0 − 4/6 > 0。
    expect(c.correction).toBeCloseTo(1 - 4 / 6, 10);
    expect(c.correction).toBeGreaterThan(0);
  });

  it("使い込み下降型×4走目以降はマイナス補正 (n4plus率 − 全体率) になること", () => {
    // N1:2走2圏内(ピーク1.0)、N2:2走1、N3:2走1、N4+:2走0圏内。
    const features = [
      rotFeat(1, 1),
      rotFeat(1, 2),
      rotFeat(2, 1),
      rotFeat(2, 8),
      rotFeat(3, 3),
      rotFeat(3, 9),
      rotFeat(4, 8),
      rotFeat(5, 9),
    ];
    const c = computeRotationBias(features, { restRunNumber: 4 });
    expect(c.types.declineWithUse).toBe(true);
    expect(c.applied).toBe(true);
    // n4plus率=0、全体率=4/8=0.5 → 補正 = 0 − 0.5 < 0。
    expect(c.correction).toBeCloseTo(0 - 0.5, 10);
    expect(c.correction).toBeLessThan(0);
  });

  it("叩き2〜3走目でも叩き良化型でなければ補正0になること", () => {
    // 鉄砲型(叩き良化でない)の馬が2走目。
    const features = [
      rotFeat(1, 1),
      rotFeat(1, 1),
      rotFeat(2, 8),
      rotFeat(2, 9),
      rotFeat(3, 8),
    ];
    const c = computeRotationBias(features, { restRunNumber: 2 });
    expect(c.types.improveWithRacing).toBe(false);
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("computeRotationBias(符号保証・仕様の補正方向をクランプで担保)", () => {
  it("叩き良化型×休み明けは、全体率が下がって差分が正になっても必ず ≤0 になること", () => {
    // 使い込み下降が併発し、4走目以降の凡走で全体率が n1率より下がるカーブ。
    // n1率=1/5=0.2 > 全体率=3/19≈0.158 のため、素の差分(n1率−全体率)は正になる。
    // 仕様L85「叩き良化型×休み明け → マイナス補正」を担保するためクランプで0以下にする。
    const features = [
      rotFeat(1, 1),
      rotFeat(1, 8),
      rotFeat(1, 8),
      rotFeat(1, 8),
      rotFeat(1, 8), // N1: 5走1圏内
      rotFeat(2, 1),
      rotFeat(2, 8), // N2: 2走1圏内
      rotFeat(3, 1),
      rotFeat(3, 8), // N3: 2走1圏内
      ...Array.from({ length: 10 }, () => rotFeat(4, 8)), // N4+: 10走0圏内
    ];
    const c = computeRotationBias(features, { restRunNumber: 1 });
    expect(c.types.improveWithRacing).toBe(true);
    // 素の差分は正だが、クランプで0以下に補正される。
    expect(c.correction).toBeLessThanOrEqual(0);
  });

  it("叩き良化型×叩き2〜3走目は、全体率が上がって差分が負になっても必ず ≥0 になること", () => {
    // 4走目以降が好走続きで全体率が n23率を上回るカーブ。
    // n23率=0.5 < 全体率=8/12≈0.667 のため、素の差分(n23率−全体率)は負になる。
    // 仕様L86「叩き良化型×叩き2〜3走目 → プラス補正」を担保するためクランプで0以上にする。
    const features = [
      rotFeat(1, 8),
      rotFeat(1, 9), // N1: 2走0圏内
      rotFeat(2, 1),
      rotFeat(2, 8), // N2: 2走1圏内
      rotFeat(3, 1),
      rotFeat(3, 8), // N3: 2走1圏内
      ...Array.from({ length: 6 }, () => rotFeat(4, 1)), // N4+: 6走6圏内
    ];
    const c = computeRotationBias(features, { restRunNumber: 2 });
    expect(c.types.improveWithRacing).toBe(true);
    expect(c.correction).toBeGreaterThanOrEqual(0);
  });
});

describe("computeRotationBias(休み明け実績2走未満の弱いマイナス)", () => {
  const penalty = DEFAULT_SCORER_CONFIG.rotation.unknownRestPenalty;
  const weight = DEFAULT_SCORER_CONFIG.weights.rotation;

  it("休み明け実績1走かつ今回休み明けなら弱いマイナス補正のみになること", () => {
    const features = [rotFeat(1, 5), rotFeat(2, 3)];
    const c = computeRotationBias(features, { restRunNumber: 1 });
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(-penalty * weight, 10);
    expect(c.correction).toBeLessThan(0);
  });

  it("休み明け実績不足でも今回が2走目以降なら弱いマイナスは適用されず0になること", () => {
    const features = [rotFeat(1, 5), rotFeat(2, 3)];
    const c = computeRotationBias(features, { restRunNumber: 2 });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("休み明け実績2走ちょうどならタイプ分類が発動し弱いマイナスにはならないこと", () => {
    // N1:2走(1圏内)、N2:2走(1圏内)、N3:2走(1圏内)。fresh/改善どちらでもない中庸 → 補正0。
    const features = [
      rotFeat(1, 1),
      rotFeat(1, 8),
      rotFeat(2, 1),
      rotFeat(2, 8),
      rotFeat(3, 1),
      rotFeat(3, 8),
    ];
    const c = computeRotationBias(features, { restRunNumber: 1 });
    // n1率=0.5 = n2plus率0.5 → 鉄砲型(同等以上)。弱いマイナスではない。
    expect(c.correction).not.toBeCloseTo(-penalty * weight, 10);
    expect(c.types.freshHorse).toBe(true);
  });

  it("今回の走目が不明(null)なら補正なしになること", () => {
    const features = [rotFeat(1, 1), rotFeat(1, 8), rotFeat(2, 3)];
    const c = computeRotationBias(features, { restRunNumber: null });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("computeRotationBias(実フィクスチャ)", () => {
  it("ウィンターガーデン: 叩き良化型と分類されること", () => {
    const results = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(results);
    const curve = buildRotationCurve(features);
    // 手計算: N1=1/7, N23=5/12, N4+=1/2, 全体=8/23。
    expect(curve.n1.sampleCount).toBe(7);
    expect(curve.n1.placedCount).toBe(1);
    expect(curve.all.sampleCount).toBe(23);
    expect(curve.all.placedCount).toBe(8);
    const t = classifyRotationType(curve, DEFAULT_SCORER_CONFIG);
    expect(t.improveWithRacing).toBe(true);
    expect(t.freshHorse).toBe(false);
    expect(t.declineWithUse).toBe(false);
  });

  it("ウィンターガーデン×休み明けは (1/7 − 8/23) のマイナス補正になること", () => {
    const results = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(results);
    const c = computeRotationBias(features, { restRunNumber: 1 });
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(1 / 7 - 8 / 23, 10);
  });

  it("ウィンターガーデン×叩き2走目は (5/12 − 8/23) のプラス補正になること", () => {
    const results = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(results);
    const c = computeRotationBias(features, { restRunNumber: 2 });
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(5 / 12 - 8 / 23, 10);
  });
});
