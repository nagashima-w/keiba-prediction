import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../src/scorer/config.js";
import {
  computeFieldPriors,
  computePrior,
  type PriorInput,
  type TodayRaceConditions,
} from "../../src/scorer/prior.js";
import { makeResult, rank, venue } from "./helpers.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * prior の較正(過剰補正・クランプ飽和の防止)。仕様L135「バイアス項目が多いため過剰補正に注意」。
 * 既定重みで、中堅馬が床/天井に張り付かず、強馬も天井に飽和しない分布になることを担保する。
 * analyzer の「priorから±10%補正」(仕様L105)が意味を持つ範囲に prior を収めるのが目的。
 */
describe("prior較正(既定重みでの過剰補正防止)", () => {
  it("(a) 中堅馬(フィクスチャ23走)の prior が常識的範囲[0.08, 0.30]に収まること", () => {
    const winter = parseHorseResults(loadFixture("horse_results_2021105857.json"));
    const features = deriveRaceFeatures(winter);
    const r = computePrior({
      features,
      today: {
        courseType: "ダ",
        distance: 1800,
        venueName: "中山",
        isWet: false,
        season: "春秋",
        frameZone: "内",
        restRunNumber: 1,
        stableLocation: "栗東",
        kinryo: 56,
        bodyWeightDiff: 2,
      },
      fieldSize: 16,
    });
    expect(r.prior).toBeGreaterThanOrEqual(0.08);
    expect(r.prior).toBeLessThanOrEqual(0.3);
  });

  it("(b) 強馬合成(直近5走全複勝圏+コース適性抜群)の prior が[0.35, 0.65]で天井飽和しないこと", () => {
    // 直近5走すべて1着・今回と同じ芝1600・同一場/枠/季節(条件系バイアスは自己平均比0)。
    const runs: HorseRaceResult[] = [
      "2025/11/01",
      "2025/10/01",
      "2025/05/01",
      "2025/04/01",
      "2025/03/01",
    ].map((date) =>
      makeResult({
        date,
        courseType: "芝",
        distance: 1600,
        finishPosition: rank(1),
        kinryo: 55,
        wakuban: 5,
        venue: venue("東京"),
        venueKind: "中央",
        bodyWeight: { weight: 480, diff: 0 },
      }),
    );
    const r = computePrior({
      features: deriveRaceFeatures(runs),
      today: {
        courseType: "芝",
        distance: 1600,
        venueName: "東京",
        isWet: false,
        season: "春秋",
        frameZone: "中",
        restRunNumber: null,
        stableLocation: "美浦",
        kinryo: 55,
        bodyWeightDiff: 0,
      },
      fieldSize: 12,
    });
    expect(r.prior).toBeGreaterThanOrEqual(0.35);
    expect(r.prior).toBeLessThanOrEqual(0.65);
    expect(r.prior).toBeLessThan(DEFAULT_SCORER_CONFIG.prior.maxPrior);
  });

  it("(c) 平均的な馬(強い偏りなし)がクランプ床に張り付かず中立確率付近に来ること", () => {
    // 目立った実績がない馬 → 補正はほぼ0 → 中立確率(3/16)付近。床(0.02)には張り付かない。
    const r = computePrior({
      features: deriveRaceFeatures([]),
      today: {
        courseType: "ダ",
        distance: 1800,
        venueName: "中山",
        isWet: false,
        season: "春秋",
        frameZone: "中",
        restRunNumber: null,
        stableLocation: "美浦",
        kinryo: 55,
        bodyWeightDiff: null,
      },
      fieldSize: 16,
    });
    expect(r.correctionSum).toBeCloseTo(0, 10);
    expect(r.prior).toBeGreaterThan(DEFAULT_SCORER_CONFIG.prior.minPrior + 0.05);
    expect(r.prior).toBeCloseTo(3 / 16, 10);
  });
});

describe("computeFieldPriors 正規化の巻き添え防止(要修正2)", () => {
  it("飽和馬1頭の巨大rawが、補正ゼロの平均馬を過度に引き下げないこと", () => {
    // 1頭だけ極端に強い(raw>>maxPrior)+ 平均馬15頭(補正0 → raw=中立3/16=0.1875)。
    const strong: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 16,
      // 近走重み5で raw を天井(0.95)より大きく振り切らせる。
      config: strongConfig(),
    };
    const avg: PriorInput = {
      features: deriveRaceFeatures([]),
      today: NEUTRAL_TODAY,
      fieldSize: 16,
    };
    const inputs = [strong, ...new Array(15).fill(avg)];
    const priors = computeFieldPriors(inputs);
    // 平均馬(index 1..15)は中立0.1875から大きく下がらない(クランプ後値でスケール計算するため)。
    for (let i = 1; i < priors.length; i++) {
      expect(priors[i]!.prior).toBeGreaterThan(0.13);
      expect(priors[i]!.prior).toBeLessThanOrEqual(0.1875);
    }
    // 強馬は依然として高い(天井付近)。
    expect(priors[0]!.prior).toBeGreaterThan(0.5);
  });

  it("正規化後になおmaxPriorを超える馬はクランプされること", () => {
    const strong: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 2,
      config: strongConfig(),
    };
    const weak: PriorInput = {
      features: deriveRaceFeatures([]),
      today: NEUTRAL_TODAY,
      fieldSize: 2,
    };
    const priors = computeFieldPriors([strong, weak]);
    expect(priors[0]!.prior).toBeCloseTo(DEFAULT_SCORER_CONFIG.prior.maxPrior, 10);
  });
});

const NEUTRAL_TODAY: TodayRaceConditions = {
  courseType: "ダ",
  distance: 1800,
  venueName: "東京",
  isWet: false,
  season: "春秋",
  frameZone: "内",
  restRunNumber: null,
  stableLocation: "美浦",
  kinryo: 55,
  bodyWeightDiff: null,
};

/** 近走重みを極端に大きくして raw を天井超過させる設定(正規化テスト用)。 */
function strongConfig(): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      neutralPlaceRate: 0.3,
      weights: { ...DEFAULT_SCORER_CONFIG.baseScore.weights, recentForm: 5 },
    },
  };
}
