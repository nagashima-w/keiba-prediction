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
 *
 * **Issue #339(#258 第 2 段 a)で、既定重みを本番の書き出しに当て直した**(近走着順 0.2→0.7・上がり3F 0.1→0.15・コース距離 0.15→0.30・
 * バイアスの一律減衰 0.3→0.05)。当てていない期間の検証で Brier が良くなったので、prior の広がりは意図して大きくなった。
 * それに合わせて、(a)(b)の範囲を次のように見直した。保証していた内容は変えていない(床・天井に飽和しない / 中堅馬と強馬の相対的な序列):
 *  - (a) 中堅馬の上限 0.30 → 0.40(新しい値は 0.330。16 頭立ての中立確率 0.1875 の約 1.8 倍。床 0.02 や天井 0.95 には遠い)。
 *  - (b) 強馬の単独の prior の上限 0.65 → 天井(0.95)未満(新しい値は 0.92)。天井に当たってクランプされていないことは rawPrior で確かめる。
 *  - (b2) 追加: レースの中(computeFieldPriors。production が使う正規化後)でも、強馬が天井に飽和せず、平均馬を過度に引き下げないこと。
 *    単独の prior(b)が天井近くまで上がるようになったので、実際に使われる値の側で飽和を固定する。
 */
describe("prior較正(既定重みでの過剰補正防止)", () => {
  it("(a) 中堅馬(フィクスチャ23走)の prior が常識的範囲[0.08, 0.40]に収まること(Issue #339 で上限を 0.30 から 0.40 に見直した。理由は冒頭の JSDoc)", () => {
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
      },
      fieldSize: 16,
    });
    expect(r.prior).toBeGreaterThanOrEqual(0.08);
    expect(r.prior).toBeLessThanOrEqual(0.4);
  });

  it("(b) 強馬合成(直近5走全複勝圏+コース適性抜群)の単独の prior が[0.35, 0.95)で、天井に飽和しないこと(Issue #339 で上限を 0.65 から天井未満に見直した)", () => {
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
      },
      fieldSize: 12,
    });
    expect(r.prior).toBeGreaterThanOrEqual(0.35);
    expect(r.prior).toBeLessThan(DEFAULT_SCORER_CONFIG.prior.maxPrior);
    // 前提(空振り防止): 天井に当たってクランプされたのではなく、raw そのものが天井未満(クランプ前後で同じ値)。
    expect(r.rawPrior).toBe(r.prior);
  });

  it("(b2) 同じ強馬が、補正ゼロの平均馬11頭の中にいる(レースの prior = 正規化後)と、天井に飽和せず[0.5, 0.95)で、平均馬を過度に引き下げないこと(Issue #339 で追加)", () => {
    // 単独の prior(b)は天井近くまで上がるので、レースの中での値(production が使う computeFieldPriors の出力)でも飽和しないことを固定する。
    const runs: HorseRaceResult[] = ["2025/11/01", "2025/10/01", "2025/05/01", "2025/04/01", "2025/03/01"].map((date) =>
      makeResult({ date, courseType: "芝", distance: 1600, finishPosition: rank(1), kinryo: 55, wakuban: 5, venue: venue("東京"), venueKind: "中央", bodyWeight: { weight: 480, diff: 0 } }),
    );
    const today: TodayRaceConditions = { courseType: "芝", distance: 1600, venueName: "東京", isWet: false, season: "春秋", frameZone: "中", restRunNumber: null, stableLocation: "美浦", kinryo: 55 };
    const strong: PriorInput = { features: deriveRaceFeatures(runs), today, fieldSize: 12 };
    const avg: PriorInput = { features: deriveRaceFeatures([]), today, fieldSize: 12 };
    const priors = computeFieldPriors([strong, ...new Array(11).fill(avg)]);
    expect(priors).toHaveLength(12);
    expect(priors[0]!.prior).toBeGreaterThanOrEqual(0.8);
    expect(priors[0]!.prior).toBeLessThan(DEFAULT_SCORER_CONFIG.prior.maxPrior);
    // 平均馬(中立 3/12 = 0.25)は、強馬に引っ張られても 0.1 以上のまま。
    for (let i = 1; i < priors.length; i++) {
      expect(priors[i]!.prior).toBeGreaterThan(0.1);
      expect(priors[i]!.prior).toBeLessThanOrEqual(0.25);
    }
    expect(priors.reduce((sum, p) => sum + p.prior, 0)).toBeCloseTo(3, 9);
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
    // 平均馬(index 1..15)は中立0.1875から大きく下がらない(raw を [minPrior,maxPrior] に収めてから共通項を求めるため)。
    for (let i = 1; i < priors.length; i++) {
      expect(priors[i]!.prior).toBeGreaterThan(0.13);
      expect(priors[i]!.prior).toBeLessThanOrEqual(0.1875);
    }
    // 強馬は依然として高い(天井付近)。
    expect(priors[0]!.prior).toBeGreaterThan(0.5);
  });

  it("全馬弱め(Σraw が目標を大きく下回る)でも Σ=目標 に持ち上げられ、広がり(ロジット差)と順序が保たれること(Issue #258 でロジットシフトに書き換え)", () => {
    // 旧版は「scale>1 が実際に発動し、平均馬が maxPrior に再クランプされる」ことを 0.125・0.95 の
    // 乗算の数値で固定していた。ロジットシフトでは乗算の数値は無意味になるため、性質に書き換える
    // (新旧の保証の対応は prior-normalize.test.ts 冒頭の表)。
    // 構成: fieldSize=10。平均馬1頭(補正0 → raw=中立0.3)+ 弱い馬9頭(大敗続き → raw は minPrior 0.02 以下)。
    const fieldSize = 10;
    const average: PriorInput = {
      features: deriveRaceFeatures([]),
      today: NEUTRAL_TODAY,
      fieldSize,
      config: strongConfig(),
    };
    const weak: PriorInput = {
      features: deriveRaceFeatures([
        makeResult({ date: "2025/01/01", finishPosition: rank(18) }),
      ]),
      today: NEUTRAL_TODAY,
      fieldSize,
      config: strongConfig(),
    };
    const priors = computeFieldPriors([average, ...new Array(9).fill(weak)]);

    // 前提(無条件): 弱い馬の raw は minPrior 以下、平均馬の raw は 0.3 で、合計は目標 3 を大きく下回る
    // (旧版が scale>1 を発動した状況と同じ)。
    const { minPrior, maxPrior } = DEFAULT_SCORER_CONFIG.prior;
    expect(priors[0]!.rawPrior).toBeCloseTo(0.3, 10);
    for (let i = 1; i < priors.length; i++) {
      expect(priors[i]!.rawPrior).toBeLessThanOrEqual(minPrior);
    }
    const rawSum = priors.reduce((s, p) => s + Math.min(maxPrior, Math.max(minPrior, p.rawPrior)), 0);
    expect(rawSum).toBeLessThan(1);

    // Σ=目標(3)に持ち上げられる。
    expect(priors.reduce((s, p) => s + p.prior, 0)).toBeCloseTo(3, 10);
    // 弱い馬は全員同じ値で、minPrior から実際に持ち上がり、上限未満。
    for (let i = 1; i < priors.length; i++) {
      expect(priors[i]!.prior).toBeCloseTo(priors[1]!.prior, 12);
      expect(priors[i]!.prior).toBeGreaterThan(minPrior + 0.1);
      expect(priors[i]!.prior).toBeLessThan(maxPrior);
    }
    // 平均馬は弱い馬より上(順序の保存)で、上限を超えない。
    expect(priors[0]!.prior).toBeGreaterThan(priors[1]!.prior);
    expect(priors[0]!.prior).toBeLessThanOrEqual(maxPrior);
    // 広がり(ロジット差)は、raw を [minPrior, maxPrior] に収めた値の差のまま保たれる。
    const logit = (p: number): number => Math.log(p / (1 - p));
    expect(logit(priors[0]!.prior) - logit(priors[1]!.prior)).toBeCloseTo(
      logit(0.3) - logit(minPrior),
      9,
    );
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
