import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../src/scorer/config.js";
import {
  buildPriorInput,
  computeFieldPriors,
  computePrior,
  type PriorInput,
  type TodayRaceConditions,
} from "../../src/scorer/prior.js";
import { makeResult, rank } from "./helpers.js";
import type { ShutubaHorse } from "../../src/scraper/types.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 全バイアス重みを0にし、基礎スコアの一部項目だけを効かせた設定を作る(prior合成式の検算用)。 */
function offCfg(
  baseWeights: Partial<ScorerConfig["baseScore"]["weights"]>,
  baseOverrides: Partial<ScorerConfig["baseScore"]> = {},
): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    weights: {
      trackCondition: 0,
      venue: 0,
      season: 0,
      frame: 0,
      summerFatigue: 0,
      transport: 0,
      rotation: 0,
    },
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      ...baseOverrides,
      weights: {
        recentForm: 0,
        last3f: 0,
        courseDistance: 0,
        jockey: 0,
        weightChange: 0,
        courseFrameBias: 0,
        ...baseWeights,
      },
    },
  };
}

/** 最小の今回条件(テーブル未登録の場・良馬場・春秋)。 */
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

describe("computePrior(prior合成式)", () => {
  it("prior = 中立確率 + 補正合計 をクランプ範囲内で返すこと", () => {
    // 直近1着のみ有効。近走重み0.2・中立0.5 → 補正 = (1.0-0.5)*0.2 = 0.1。
    // 頭数10 → 中立確率 = 3/10 = 0.3。raw = 0.4。
    const input: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 10,
      config: offCfg({ recentForm: 0.2 }, { neutralPlaceRate: 0.5 }),
    };
    const r = computePrior(input);
    expect(r.neutralProb).toBeCloseTo(0.3, 10);
    expect(r.correctionSum).toBeCloseTo(0.1, 10);
    expect(r.rawPrior).toBeCloseTo(0.4, 10);
    expect(r.prior).toBeCloseTo(0.4, 10);
  });

  it("補正が大きすぎるときは上限にクランプされること", () => {
    const input: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 10,
      config: offCfg({ recentForm: 10 }, { neutralPlaceRate: 0.5 }),
    };
    const r = computePrior(input);
    expect(r.rawPrior).toBeGreaterThan(DEFAULT_SCORER_CONFIG.prior.maxPrior);
    expect(r.prior).toBeCloseTo(DEFAULT_SCORER_CONFIG.prior.maxPrior, 10);
  });

  it("補正が小さすぎるときは下限にクランプされること", () => {
    // 単走18着 → 近走スコア0、中立0.5、重み10 → 補正 -5。raw 大幅マイナス。
    const input: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(18) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 10,
      config: offCfg({ recentForm: 10 }, { neutralPlaceRate: 0.5 }),
    };
    const r = computePrior(input);
    expect(r.rawPrior).toBeLessThan(DEFAULT_SCORER_CONFIG.prior.minPrior);
    expect(r.prior).toBeCloseTo(DEFAULT_SCORER_CONFIG.prior.minPrior, 10);
  });

  it("寄与度ログに基礎6項目+7バイアスの全13項目がそろうこと", () => {
    const input: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 10,
    };
    const r = computePrior(input);
    const names = new Set(r.contributions.map((c) => c.biasName));
    for (const n of [
      "近走着順",
      "上がり3F",
      "コース・距離適性",
      "騎手当該コース",
      "斤量・馬体重",
      "コース枠順バイアス",
      "馬場状態適性",
      "競馬場適性",
      "季節適性",
      "夏負けフラグ",
      "枠順適性",
      "輸送・滞在バイアス",
      "ローテーション適性",
    ]) {
      expect(names.has(n)).toBe(true);
    }
    expect(r.contributions).toHaveLength(13);
  });
});

describe("computeFieldPriors(頭数レベルの健全性)", () => {
  it("全馬同一データなら全馬同確率になること", () => {
    const one: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1), last3f: 34, kinryo: 55 }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 8,
    };
    const priors = computeFieldPriors([one, one, one, one, one, one, one, one]);
    const first = priors[0]!.prior;
    for (const p of priors) {
      expect(p.prior).toBeCloseTo(first, 10);
    }
  });

  // 注: 「補正0の平均馬で合計=中立の和=3」はトートロジー(中立確率の定義そのもの)のため削除し、
  // 健全性の担保は下記の「正規化発動」テストと prior-calibration.test.ts の巻き添え防止テストに寄せた。

  it("全馬が強くrawの合計が大きく逸脱する場合は正規化で合計が3付近に戻ること", () => {
    // 各馬 直近1着で近走補正が大きい → rawの合計が3を大きく超える。
    const strong: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize: 8,
      config: offCfg({ recentForm: 1 }, { neutralPlaceRate: 0.3 }),
    };
    const priors = computeFieldPriors(new Array(8).fill(strong));
    const sum = priors.reduce((s, p) => s + p.prior, 0);
    expect(sum).toBeGreaterThan(2.7);
    expect(sum).toBeLessThan(3.3);
    // 全馬同一なので依然として同確率。
    const first = priors[0]!.prior;
    for (const p of priors) {
      expect(p.prior).toBeCloseTo(first, 10);
    }
  });
});

describe("buildPriorInput(scraper出力からの組み立て)", () => {
  it("出馬表馬+戦績+レース条件から今回条件を組み立てること", () => {
    const horse: ShutubaHorse = {
      wakuban: 8,
      umaban: 16,
      name: "テスト馬",
      horseId: "2020100000" as ShutubaHorse["horseId"],
      sex: "牡",
      age: 5,
      kinryo: 57,
      jockeyName: "騎手",
      jockeyId: null,
      stableLocation: "栗東",
      trainerName: "調教師",
      trainerId: null,
      bodyWeight: { weight: 500, diff: -4 },
    };
    const input = buildPriorInput({
      horse,
      raceResults: [makeResult({ date: "2025/06/01", finishPosition: rank(3) })],
      race: {
        courseType: "芝",
        distance: 2000,
        venueName: "函館",
        isWet: false,
        date: "2025/07/06",
      },
      fieldSize: 12,
    });
    expect(input.today.frameZone).toBe("外"); // 8枠 → 外
    expect(input.today.season).toBe("夏"); // 7月 → 夏
    expect(input.today.stableLocation).toBe("栗東");
    expect(input.today.kinryo).toBe(57);
    expect(input.today.bodyWeightDiff).toBe(-4);
    expect(input.fieldSize).toBe(12);
  });
});

describe("computePrior 実フィクスチャ(ウィンターガーデン23走)", () => {
  it("priorがクランプ範囲内で、寄与度ログが全項目そろうこと", () => {
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
    const { minPrior, maxPrior } = DEFAULT_SCORER_CONFIG.prior;
    expect(r.prior).toBeGreaterThanOrEqual(minPrior);
    expect(r.prior).toBeLessThanOrEqual(maxPrior);
    expect(r.contributions).toHaveLength(13);
    // コース枠順バイアス(中山ダ内)は発動していること。
    const cf = r.contributions.find((c) => c.biasName === "コース枠順バイアス");
    expect(cf?.applied).toBe(true);
  });
});
