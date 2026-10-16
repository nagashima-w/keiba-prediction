import { describe, expect, it } from "vitest";
import { buildCloudScorerConfig } from "../../cloud/src/scorer-config.js";
import { DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS, type CloudSettings } from "../../cloud/src/settings.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../packages/core/src/scorer/config.js";

/**
 * Issue #218: クラウド版の `buildCloudScorerConfig`(設定 → core の `ScorerConfig`)の出力を、期待値のリテラルで固定する。
 *
 * Issue #287(#285 の段階B)で、比べる相手を変えた。以前は exe の `buildScorerConfig`(`packages/app/src/main/settings-store.ts`。
 * `{ ...DEFAULT_SCORER_CONFIG, weights: 重み7項目, baseScore: { ...DEFAULT_SCORER_CONFIG.baseScore, weights: 重み6項目 } }` を返す)と
 * 同じ出力になることを検査していた。exe を削除したため、**重み13項目に具体的な数値を渡し、期待する `ScorerConfig` をリテラルで書いて**比べる。
 * 重み以外の項目(prior・minSampleForBias など)は、core の `DEFAULT_SCORER_CONFIG` のままであることを期待する(exe と同じ出力、の中身)。
 * ここ(ルートの scripts/test/)に置く理由は従来どおり: cloud/test から core のバレルを import できない配置のため。
 */

/** 13項目すべてを既定値とは別の値にした設定(取り違え・欠落を検出できる)。 */
const CHANGED: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  biasWeightTrackCondition: 0.5,
  biasWeightVenue: 0.6,
  biasWeightSeason: 0.7,
  biasWeightFrame: 0.8,
  biasWeightSummerFatigue: 0.9,
  biasWeightTransport: 1.1,
  biasWeightRotation: 1.2,
  baseScoreWeightRecentForm: 0.25,
  baseScoreWeightLast3f: 0.35,
  baseScoreWeightCourseDistance: 0.45,
  baseScoreWeightJockey: 0.55,
  baseScoreWeightWeightChange: 0.65,
  baseScoreWeightCourseFrameBias: 0.75,
};

/** CHANGED が渡す重みから期待する `ScorerConfig`(リテラル)。重み以外は core の既定のまま。 */
const EXPECTED_CHANGED: ScorerConfig = {
  ...DEFAULT_SCORER_CONFIG,
  weights: {
    trackCondition: 0.5,
    venue: 0.6,
    season: 0.7,
    frame: 0.8,
    summerFatigue: 0.9,
    transport: 1.1,
    rotation: 1.2,
  },
  baseScore: {
    ...DEFAULT_SCORER_CONFIG.baseScore,
    weights: {
      recentForm: 0.25,
      last3f: 0.35,
      courseDistance: 0.45,
      jockey: 0.55,
      weightChange: 0.65,
      courseFrameBias: 0.75,
    },
  },
};

/** 既定値の設定から期待する `ScorerConfig`(リテラル。cloud-settings-defaults.test.ts が固定する既定値と同じ数値)。 */
const EXPECTED_DEFAULT: ScorerConfig = {
  ...DEFAULT_SCORER_CONFIG,
  weights: {
    trackCondition: 1,
    venue: 1,
    season: 1,
    frame: 1,
    summerFatigue: 1,
    transport: 1,
    rotation: 1,
  },
  baseScore: {
    ...DEFAULT_SCORER_CONFIG.baseScore,
    weights: {
      recentForm: 0.7,
      last3f: 0.15,
      courseDistance: 0.3,
      jockey: 0.15,
      weightChange: 1,
      courseFrameBias: 1,
    },
  },
};

describe("buildCloudScorerConfig は期待する ScorerConfig(リテラル)と同じ出力", () => {
  it("既定値・13項目すべてを変えた値の両方で、期待値のリテラルと深く等しい", () => {
    expect(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)).toEqual(EXPECTED_DEFAULT);
    expect(buildCloudScorerConfig(CHANGED)).toEqual(EXPECTED_CHANGED);
  });

  it("前提: 13項目すべてが既定値と別の値で、変えた設定の出力は既定値の出力と違う(比較が自明に成り立たない)。重み以外の項目は core の既定のまま", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      expect(CHANGED[f.field], `前提: ${f.field}`).not.toBe(DEFAULT_CLOUD_SETTINGS[f.field]);
    }
    expect(buildCloudScorerConfig(CHANGED)).not.toEqual(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS));
    const { weights: _w, baseScore: _b, ...restChanged } = buildCloudScorerConfig(CHANGED);
    const { weights: _w0, baseScore: _b0, ...restDefault } = DEFAULT_SCORER_CONFIG;
    expect(restChanged).toEqual(restDefault);
  });

  it("1項目だけ変えた設定でも、13項目それぞれで、その1項目だけが期待値(リテラル)に反映される", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      const settings = { ...DEFAULT_CLOUD_SETTINGS, [f.field]: 7.5 };
      const expected: ScorerConfig =
        f.group === "bias"
          ? { ...EXPECTED_DEFAULT, weights: { ...EXPECTED_DEFAULT.weights, [f.exeKey]: 7.5 } }
          : { ...EXPECTED_DEFAULT, baseScore: { ...EXPECTED_DEFAULT.baseScore, weights: { ...EXPECTED_DEFAULT.baseScore.weights, [f.exeKey]: 7.5 } } };
      expect(buildCloudScorerConfig(settings), f.field).toEqual(expected);
    }
  });
});
