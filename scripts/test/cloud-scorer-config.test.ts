import { describe, expect, it } from "vitest";
import { buildCloudScorerConfig } from "../../cloud/src/scorer-config.js";
import { DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS, type CloudSettings } from "../../cloud/src/settings.js";
import { buildScorerConfig, DEFAULT_APP_SETTINGS } from "../../packages/app/src/main/settings-store.js";

/**
 * Issue #218: クラウド版の `buildCloudScorerConfig`(設定 → core の `ScorerConfig`)は、exe の `buildScorerConfig` と同じ出力になる。
 * **ここ(ルートの scripts/test/)に置く理由**: exe の設定ストア(`settings-store.ts`)は core のバレル `@keiba/core` を import する。cloud の CI は cloud だけを install し
 * (workspace の外。`packages/core/node_modules` が無い。cloud の tsconfig の paths もバレルは向けない)ので、cloud/test からは import できず、型検査が落ちる
 * (#218 のコミット 0fc0aa7 で実際に落ちた)。exe と cloud の両方を import できるのは、`cloud-settings-defaults.test.ts` と同じこの場所。
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

describe("buildCloudScorerConfig は exe の buildScorerConfig と同じ出力", () => {
  const exeOf = (s: CloudSettings) =>
    buildScorerConfig({
      ...DEFAULT_APP_SETTINGS,
      biasWeights: Object.fromEntries(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "bias").map((f) => [f.exeKey, s[f.field]])) as unknown as typeof DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: Object.fromEntries(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "base").map((f) => [f.exeKey, s[f.field]])) as unknown as typeof DEFAULT_APP_SETTINGS.baseScoreWeights,
    });

  it("同じ重みの AppSettings を作って比べる: 既定値・13項目すべてを変えた値の両方で深く等しい", () => {
    expect(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)).toEqual(exeOf(DEFAULT_CLOUD_SETTINGS));
    expect(buildCloudScorerConfig(CHANGED)).toEqual(exeOf(CHANGED));
  });

  it("前提: 13項目すべてが既定値と別の値で、変えた設定の出力は既定値の出力と違う(比較が自明に成り立たない)", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      expect(CHANGED[f.field], `前提: ${f.field}`).not.toBe(DEFAULT_CLOUD_SETTINGS[f.field]);
    }
    expect(buildCloudScorerConfig(CHANGED)).not.toEqual(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS));
  });

  it("1項目だけ変えた設定でも、13項目それぞれで exe と同じ出力", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      const settings = { ...DEFAULT_CLOUD_SETTINGS, [f.field]: 7.5 };
      expect(buildCloudScorerConfig(settings), f.field).toEqual(exeOf(settings));
    }
  });
});
