import { describe, expect, it } from "vitest";
import { buildScorerConfig, DEFAULT_APP_SETTINGS } from "../../packages/app/src/main/settings-store";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config";
import { buildCloudScorerConfig } from "../src/scorer-config";
import { DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS, type CloudSettings } from "../src/settings";

/**
 * Issue #218: cloud の設定 → core の `ScorerConfig`。exe の `buildScorerConfig`(設定 → ScorerConfig のディープマージ)と同じ出力になる。
 * 重み13項目だけを上書きし、他の既定項目(prior・minSampleForBias・閾値など)は `DEFAULT_SCORER_CONFIG` のまま。
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

describe("buildCloudScorerConfig", () => {
  it("既定の設定(重みが既定値 = 保存済みの設定に重みが無い今の本番)は、DEFAULT_SCORER_CONFIG と深く等しい(今までと同じ結果)", () => {
    expect(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)).toEqual(DEFAULT_SCORER_CONFIG);
  });

  it("13項目すべてを変えた設定は、バイアス7が weights・基礎6が baseScore.weights に、対応表どおり入る(前提: 13項目すべて既定値と別の値)", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      expect(CHANGED[f.field], `前提: ${f.field}`).not.toBe(DEFAULT_CLOUD_SETTINGS[f.field]);
    }
    const config = buildCloudScorerConfig(CHANGED);
    expect(config.weights).toEqual({ trackCondition: 0.5, venue: 0.6, season: 0.7, frame: 0.8, summerFatigue: 0.9, transport: 1.1, rotation: 1.2 });
    expect(config.baseScore.weights).toEqual({ recentForm: 0.25, last3f: 0.35, courseDistance: 0.45, jockey: 0.55, weightChange: 0.65, courseFrameBias: 0.75 });
  });

  it("重み以外は DEFAULT_SCORER_CONFIG のまま(prior・minSampleForBias・基礎スコアの閾値など)。重みの変更で他の項目が動かない", () => {
    const config = buildCloudScorerConfig(CHANGED);
    expect({ ...config, weights: null, baseScore: { ...config.baseScore, weights: null } }).toEqual({ ...DEFAULT_SCORER_CONFIG, weights: null, baseScore: { ...DEFAULT_SCORER_CONFIG.baseScore, weights: null } });
  });

  it("1項目だけ変えると、その項目だけが変わる(13項目それぞれ。他の12項目は既定値のまま)", () => {
    for (const target of SCORING_WEIGHT_FIELDS) {
      const settings = { ...DEFAULT_CLOUD_SETTINGS, [target.field]: 7.5 };
      const config = buildCloudScorerConfig(settings);
      const bias = config.weights as unknown as Record<string, number>;
      const base = config.baseScore.weights as unknown as Record<string, number>;
      expect((target.group === "bias" ? bias : base)[target.exeKey], target.field).toBe(7.5);
      const changed = [...Object.entries(bias).filter(([k, v]) => v !== (DEFAULT_SCORER_CONFIG.weights as unknown as Record<string, number>)[k]), ...Object.entries(base).filter(([k, v]) => v !== (DEFAULT_SCORER_CONFIG.baseScore.weights as unknown as Record<string, number>)[k])];
      expect(changed.map(([k]) => k), target.field).toEqual([target.exeKey]);
    }
  });

  it("exe の buildScorerConfig と同じ出力: 同じ重みの AppSettings を作って比べる(既定値・13項目すべてを変えた値の両方)", () => {
    const exeOf = (s: CloudSettings) =>
      buildScorerConfig({
        ...DEFAULT_APP_SETTINGS,
        biasWeights: Object.fromEntries(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "bias").map((f) => [f.exeKey, s[f.field]])) as unknown as typeof DEFAULT_APP_SETTINGS.biasWeights,
        baseScoreWeights: Object.fromEntries(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "base").map((f) => [f.exeKey, s[f.field]])) as unknown as typeof DEFAULT_APP_SETTINGS.baseScoreWeights,
      });
    expect(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)).toEqual(exeOf(DEFAULT_CLOUD_SETTINGS));
    expect(buildCloudScorerConfig(CHANGED)).toEqual(exeOf(CHANGED));
    expect(buildCloudScorerConfig(CHANGED)).not.toEqual(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)); // 前提: 比較が自明に成り立たない
  });

  it("DEFAULT_SCORER_CONFIG を書き換えない(新しいオブジェクトを返す。重みのオブジェクトも共有しない)", () => {
    const before = JSON.stringify(DEFAULT_SCORER_CONFIG);
    const config = buildCloudScorerConfig(CHANGED);
    expect(JSON.stringify(DEFAULT_SCORER_CONFIG)).toBe(before);
    expect(config.weights).not.toBe(DEFAULT_SCORER_CONFIG.weights);
    expect(config.baseScore.weights).not.toBe(DEFAULT_SCORER_CONFIG.baseScore.weights);
  });
});
