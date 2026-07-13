import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../src/scorer/config.js";
import {
  computeBaseScore,
  computeCourseDistanceScore,
  computeCourseFrameBiasScore,
  computeJockeyScore,
  computeLast3fScore,
  computeRecentFormScore,
  computeWeightChangeScore,
} from "../../src/scorer/base-score.js";
import type { BaseScoreConfig, BaseScoreWeights } from "../../src/scorer/config.js";
import { makeResult, rank } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** DEFAULT_SCORER_CONFIG の baseScore を部分上書きした設定を作る(weights も部分指定可)。 */
function cfg(
  base: Partial<Omit<BaseScoreConfig, "weights">> & {
    weights?: Partial<BaseScoreWeights>;
  },
): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      ...base,
      weights: {
        ...DEFAULT_SCORER_CONFIG.baseScore.weights,
        ...(base.weights ?? {}),
      },
    },
  };
}

describe("computeRecentFormScore(近走着順・重み減衰付き)", () => {
  it("戦績0走のときは補正なしになること", () => {
    const c = computeRecentFormScore([], DEFAULT_SCORER_CONFIG);
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("幾何減衰の重み付き複勝スコアが検算どおりになること", () => {
    // 減衰0.5、中立0.5、重み1、圏外ステップ0.1。
    // 直近: 1着(スコア1.0)、その前: 13着(スコア max(0,1-(13-3)*0.1)=0)。
    // 加重平均 = (1*1.0 + 0.5*0)/(1+0.5) = 0.6667。補正 = (0.6667-0.5)*1。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/02/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/01/01", finishPosition: rank(13) }),
    ]);
    const c = computeRecentFormScore(
      features,
      cfg({
        recentFormDecay: 0.5,
        neutralPlaceRate: 0.5,
        outOfPlaceStep: 0.1,
        recentFormMaxRuns: 6,
        weights: { recentForm: 1 },
      }),
    );
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(2 / 3 - 0.5, 10);
  });

  it("圏外の着順悪化ほどスコアが線形に下がること(4着は満点未満・床は0)", () => {
    // 単走4着 → スコア = 1-(4-3)*0.1 = 0.9。中立0.5・重み1 → 補正0.4。
    const four = computeRecentFormScore(
      deriveRaceFeatures([makeResult({ date: "2025/02/01", finishPosition: rank(4) })]),
      cfg({ neutralPlaceRate: 0.5, outOfPlaceStep: 0.1, weights: { recentForm: 1 } }),
    );
    expect(four.correction).toBeCloseTo(0.9 - 0.5, 10);
  });

  it("中止など対象外の走は加重から除外されること", () => {
    // 直近が中止(対象外)、その前が1着。中止を飛ばして1着のみで評価 → スコア1.0。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/02/01", finishPosition: { kind: "非数値", text: "中" } }),
      makeResult({ date: "2025/01/01", finishPosition: rank(1) }),
    ]);
    const c = computeRecentFormScore(
      features,
      cfg({ neutralPlaceRate: 0.5, weights: { recentForm: 1 } }),
    );
    expect(c.correction).toBeCloseTo(0.5, 10);
  });

  it("recentFormMaxRuns で直近走のみに打ち切られ、古い走は無視されること", () => {
    // 直近3走すべて1着(スコア1.0)、それ以前の3走すべて18着(スコア0)。maxRuns=3 なら
    // 直近3走のみ評価 → 加重平均1.0 → 補正 (1.0-0.5)=0.5(古い凡走に引きずられない)。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/06/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/05/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/04/01", finishPosition: rank(1) }),
      makeResult({ date: "2025/03/01", finishPosition: rank(18) }),
      makeResult({ date: "2025/02/01", finishPosition: rank(18) }),
      makeResult({ date: "2025/01/01", finishPosition: rank(18) }),
    ]);
    const cut = computeRecentFormScore(
      features,
      cfg({ neutralPlaceRate: 0.5, recentFormMaxRuns: 3, weights: { recentForm: 1 } }),
    );
    expect(cut.sampleCount).toBe(3);
    expect(cut.correction).toBeCloseTo(0.5, 10);
    // maxRuns を6に広げれば古い18着(スコア0)が母数に入り、加重平均は下がる。
    const full = computeRecentFormScore(
      features,
      cfg({ neutralPlaceRate: 0.5, recentFormMaxRuns: 6, weights: { recentForm: 1 } }),
    );
    expect(full.sampleCount).toBe(6);
    expect(full.correction).toBeLessThan(cut.correction);
  });
});

describe("computeLast3fScore(上がり3F水準の代替評価)", () => {
  it("速い上がりを使えた率で補正されること(芝閾値)", () => {
    // 芝閾値34.9、上がり[34.0, 35.5, 34.9] → 速い(<=34.9)は2走 → 率2/3。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/03/01", courseType: "芝", last3f: 34.0 }),
      makeResult({ date: "2025/02/01", courseType: "芝", last3f: 35.5 }),
      makeResult({ date: "2025/01/01", courseType: "芝", last3f: 34.9 }),
    ]);
    const c = computeLast3fScore(
      features,
      cfg({
        fastLast3fThresholdSec: { 芝: 34.9, ダ: 36.5, 障: 38.0 },
        neutralFastLast3fRate: 0.2,
        weights: { last3f: 1 },
      }),
    );
    expect(c.sampleCount).toBe(3);
    expect(c.targetRate).toBeCloseTo(2 / 3, 10);
    expect(c.correction).toBeCloseTo(2 / 3 - 0.2, 10);
  });

  it("コース種別ごとに閾値を引くこと(ダートは芝より緩い閾値)", () => {
    // ダ閾値36.5。ダ走[36.0(速い), 37.0(遅い)] → 率0.5。芝閾値34.9なら両方遅い=0になる。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/02/01", courseType: "ダ", last3f: 36.0 }),
      makeResult({ date: "2025/01/01", courseType: "ダ", last3f: 37.0 }),
    ]);
    const c = computeLast3fScore(
      features,
      cfg({
        fastLast3fThresholdSec: { 芝: 34.9, ダ: 36.5, 障: 38.0 },
        neutralFastLast3fRate: 0.2,
        weights: { last3f: 1 },
      }),
    );
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(0.5, 10);
  });

  it("上がり取得走が2走未満なら補正なしになること", () => {
    const c = computeLast3fScore(
      deriveRaceFeatures([makeResult({ date: "2025/01/01", last3f: 34.0 })]),
      DEFAULT_SCORER_CONFIG,
    );
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
  });

  it("上がり欠損走は母数から除外されること", () => {
    // last3f null が1走 + 有効2走(芝閾値34.9で1走だけ速い) → 母数2、率0.5。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/03/01", courseType: "芝", last3f: null }),
      makeResult({ date: "2025/02/01", courseType: "芝", last3f: 34.0 }),
      makeResult({ date: "2025/01/01", courseType: "芝", last3f: 36.0 }),
    ]);
    const c = computeLast3fScore(
      features,
      cfg({
        fastLast3fThresholdSec: { 芝: 34.9, ダ: 36.5, 障: 38.0 },
        weights: { last3f: 1 },
      }),
    );
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(0.5, 10);
  });
});

describe("computeCourseDistanceScore(コース・距離適性)", () => {
  it("同コース種別かつ距離帯(±200m)内の複勝率で補正されること", () => {
    // 今回 芝1600。芝1600(1着=圏内)・芝1500(2着=圏内、差100≤200)は対象、
    // 芝2000(差400>200)とダ1600(種別違い)は対象外。→ 率 2/2 = 1.0。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/04/01", courseType: "芝", distance: 1600, finishPosition: rank(1) }),
      makeResult({ date: "2025/03/01", courseType: "芝", distance: 1500, finishPosition: rank(2) }),
      makeResult({ date: "2025/02/01", courseType: "芝", distance: 2000, finishPosition: rank(1) }),
      makeResult({ date: "2025/01/01", courseType: "ダ", distance: 1600, finishPosition: rank(1) }),
    ]);
    const c = computeCourseDistanceScore(
      features,
      { courseType: "芝", distance: 1600 },
      cfg({ neutralPlaceRate: 0.3, distanceBandMeters: 200, weights: { courseDistance: 1 } }),
    );
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1, 10);
    expect(c.correction).toBeCloseTo(1 - 0.3, 10);
  });

  it("同条件が2走未満なら補正なしになること", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/01/01", courseType: "芝", distance: 1600, finishPosition: rank(1) }),
    ]);
    const c = computeCourseDistanceScore(
      features,
      { courseType: "芝", distance: 1600 },
      DEFAULT_SCORER_CONFIG,
    );
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
  });
});

describe("computeJockeyScore(騎手の当該コース複勝率・optional入力)", () => {
  it("騎手データがなければデータなしとして補正なしになること", () => {
    const c = computeJockeyScore(undefined, DEFAULT_SCORER_CONFIG);
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
    expect(c.reason).toContain("データなし");
  });

  it("騎手の複勝率で補正されること", () => {
    const c = computeJockeyScore(
      { starts: 10, placed: 4 },
      cfg({ neutralPlaceRate: 0.3, weights: { jockey: 1 } }),
    );
    expect(c.applied).toBe(true);
    expect(c.targetRate).toBeCloseTo(0.4, 10);
    expect(c.correction).toBeCloseTo(0.4 - 0.3, 10);
  });

  it("騎乗数が最小サンプル未満なら補正なしになること", () => {
    const c = computeJockeyScore({ starts: 1, placed: 1 }, DEFAULT_SCORER_CONFIG);
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
  });
});

describe("computeWeightChangeScore(斤量変化・馬体重増減の小補正)", () => {
  it("斤量増はマイナス方向・上限でクリップされること", () => {
    // 前走54→今回56(+2)。スケール0.01・上限3・重み1 → -2*0.01 = -0.02。馬体重変化なし。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/01/01", kinryo: 54 }),
    ]);
    const c = computeWeightChangeScore(
      features,
      { kinryo: 56, bodyWeightDiff: null },
      cfg({ kinryoScale: 0.01, kinryoCapKg: 3, weights: { weightChange: 1 } }),
    );
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(-0.02, 10);
  });

  it("大幅な馬体重減はマイナス補正になること", () => {
    // 斤量同値(前走55→55)、馬体重-10。減スケール0.004・上限-20 → -10*0.004 = -0.04。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/01/01", kinryo: 55 }),
    ]);
    const c = computeWeightChangeScore(
      features,
      { kinryo: 55, bodyWeightDiff: -10 },
      cfg({
        kinryoScale: 0.01,
        bodyWeightDropScale: 0.004,
        bodyWeightDropCapKg: -20,
        weights: { weightChange: 1 },
      }),
    );
    expect(c.correction).toBeCloseTo(-0.04, 10);
  });

  it("馬体重増(プラス)は補正0(ペナルティなし)になること", () => {
    // 斤量同値(55→55)、馬体重+10。増は罰しない設計 → 馬体重項0。斤量項0 → 補正0(ただし applied)。
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/01/01", kinryo: 55 }),
    ]);
    const c = computeWeightChangeScore(
      features,
      { kinryo: 55, bodyWeightDiff: 10 },
      cfg({
        kinryoScale: 0.01,
        bodyWeightDropScale: 0.004,
        weights: { weightChange: 1 },
      }),
    );
    expect(c.applied).toBe(true);
    expect(c.correction).toBeCloseTo(0, 10);
  });

  it("前走斤量が取れず馬体重変化もなければ補正なしになること", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/01/01", kinryo: null }),
    ]);
    const c = computeWeightChangeScore(
      features,
      { kinryo: 56, bodyWeightDiff: null },
      DEFAULT_SCORER_CONFIG,
    );
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("computeCourseFrameBiasScore(コースレベル枠順バイアス)", () => {
  it("テーブル値×重みが補正になること", () => {
    const c = computeCourseFrameBiasScore(
      { venueName: "中山", courseType: "芝", frameZone: "内" },
      cfg({ weights: { courseFrameBias: 2 } }),
    );
    // 中山芝内はプラス。重み2倍。
    expect(c.applied).toBe(true);
    expect(c.correction).toBeGreaterThan(0);
  });

  it("テーブルにない条件は補正なしになること", () => {
    const c = computeCourseFrameBiasScore(
      { venueName: "東京", courseType: "芝", frameZone: "内" },
      DEFAULT_SCORER_CONFIG,
    );
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("venueKind が nar のときはテーブルに登録があっても補正しないこと", () => {
    // 中山は本来テーブル登録済み(内枠プラス)だが、地方(NAR)レースでは対象外。
    const c = computeCourseFrameBiasScore(
      { venueName: "中山", courseType: "芝", frameZone: "内", venueKind: "nar" },
      cfg({ weights: { courseFrameBias: 2 } }),
    );
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
    expect(c.reason).toContain("NARのため対象外");
  });

  it("venueKind を省略した場合は従来どおり中央として扱われること(既定値は central)", () => {
    const c = computeCourseFrameBiasScore(
      { venueName: "中山", courseType: "芝", frameZone: "内" },
      cfg({ weights: { courseFrameBias: 2 } }),
    );
    expect(c.applied).toBe(true);
    expect(c.reason).not.toContain("NARのため対象外");
  });
});

describe("computeBaseScore(基礎スコア統合)", () => {
  it("6項目すべての寄与度ログを返し、合計が各補正の和になること", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/03/01", courseType: "ダ", distance: 1800, finishPosition: rank(1), last3f: 36, kinryo: 55 }),
      makeResult({ date: "2025/02/01", courseType: "ダ", distance: 1800, finishPosition: rank(2), last3f: 37, kinryo: 55 }),
    ]);
    const r = computeBaseScore(
      features,
      { courseType: "ダ", distance: 1800, venueName: "中山", frameZone: "内", kinryo: 55, bodyWeightDiff: 0 },
      { starts: 10, placed: 3 },
      DEFAULT_SCORER_CONFIG,
    );
    const names = r.contributions.map((c) => c.biasName);
    expect(names).toContain("近走着順");
    expect(names).toContain("上がり3F");
    expect(names).toContain("コース・距離適性");
    expect(names).toContain("騎手当該コース");
    expect(names).toContain("斤量・馬体重");
    expect(names).toContain("コース枠順バイアス");
    expect(r.contributions).toHaveLength(6);
    const sum = r.contributions.reduce((s, c) => s + c.correction, 0);
    expect(r.correctionSum).toBeCloseTo(sum, 10);
  });

  it("venueKind: nar を computeCourseFrameBiasScore にそのまま渡すこと(NARでは対象外)", () => {
    const features = deriveRaceFeatures([
      makeResult({ date: "2025/03/01", courseType: "ダ", distance: 1800, finishPosition: rank(1), last3f: 36, kinryo: 55 }),
    ]);
    const r = computeBaseScore(
      features,
      {
        courseType: "ダ",
        distance: 1800,
        venueName: "中山",
        frameZone: "内",
        kinryo: 55,
        bodyWeightDiff: 0,
        venueKind: "nar",
      },
      undefined,
      cfg({ weights: { courseFrameBias: 2 } }),
    );
    const cf = r.contributions.find((c) => c.biasName === "コース枠順バイアス");
    expect(cf?.applied).toBe(false);
    expect(cf?.reason).toContain("NARのため対象外");
  });
});

describe("computeBaseScore 実フィクスチャ(ウィンターガーデン23走)", () => {
  it("全項目の寄与度ログがそろい合計が有限値になること", () => {
    const winter = parseHorseResults(loadFixture("horse_results_2021105857.json"));
    const features = deriveRaceFeatures(winter);
    const r = computeBaseScore(
      features,
      { courseType: "ダ", distance: 1800, venueName: "中山", frameZone: "内", kinryo: 56, bodyWeightDiff: 2 },
      undefined,
      DEFAULT_SCORER_CONFIG,
    );
    expect(r.contributions).toHaveLength(6);
    expect(Number.isFinite(r.correctionSum)).toBe(true);
    // 騎手データなしはデータなしログになること。
    const jockey = r.contributions.find((c) => c.biasName === "騎手当該コース");
    expect(jockey?.applied).toBe(false);
  });
});
