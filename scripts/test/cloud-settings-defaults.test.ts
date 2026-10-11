import { describe, expect, it } from "vitest";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "../../cloud/src/pre-race-time.js";
import { CLOUD_SETTINGS_RULES, DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS } from "../../cloud/src/settings.js";
import { coerceSettings, DEFAULT_APP_SETTINGS } from "../../packages/app/src/main/settings-store.js";
import { BASE_SCORE_WEIGHT_KEYS, BIAS_WEIGHT_KEYS } from "../../packages/app/src/shared/settings.js";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config.js";

/**
 * Issue #178(#164-c): クラウド版の設定の既定値は、exe の現在の既定値(`DEFAULT_APP_SETTINGS`)と一致する(メインの判断: 既定値は exe に揃える)。
 * cloud は exe の設定ストア(node:fs を使う)を import できないので、値を写して、ここで一致を固定する。exe の既定値を変えたら、このテストが落ちる。
 */
/**
 * exe に無い、cloud 専用の項目(Issue #189)。exe の設定は PC 上で手動の分析を行うので、「発走何分前に自動評価するか」を持たない。
 * 新しい cloud 専用の項目を足すときは、ここに明示する(足し忘れると、下の「項目集合」の検査が落ちる)。
 */
const CLOUD_ONLY_KEYS = ["analysisModel", "preRaceOffsetMinutes"] as const;

/** スコアリングの重み13項目(Issue #218)。exe では `biasWeights`・`baseScoreWeights` の入れ子、cloud では平坦な接頭辞つきのキー。対応表は cloud/src/settings.ts の SCORING_WEIGHT_FIELDS。 */
const WEIGHT_FIELDS: readonly string[] = SCORING_WEIGHT_FIELDS.map((f) => f.field);

describe("クラウド版の設定の既定値が exe の既定値と一致する", () => {
  it("cloud の項目 = exe と同名で共有する項目(配分・EV・クリップ幅など13項目)+ スコアリングの重み13項目(exe では入れ子)+ cloud 専用の項目(CLOUD_ONLY_KEYS)。共有の13項目は、exe に同名の項目があり、既定値が同じ(項目の取りこぼし・意図しない追加もない)", () => {
    const keys = Object.keys(DEFAULT_CLOUD_SETTINGS);
    const sameNamed = keys.filter((k) => !(CLOUD_ONLY_KEYS as readonly string[]).includes(k) && !WEIGHT_FIELDS.includes(k));
    expect(sameNamed.length).toBe(13);
    expect(WEIGHT_FIELDS.length).toBe(13);
    expect(keys.length).toBe(sameNamed.length + WEIGHT_FIELDS.length + CLOUD_ONLY_KEYS.length);
    expect([...keys].sort()).toEqual([...sameNamed, ...WEIGHT_FIELDS, ...CLOUD_ONLY_KEYS].sort());
    for (const key of sameNamed) {
      expect(key in DEFAULT_APP_SETTINGS, `exe に ${key} がある`).toBe(true);
      expect((DEFAULT_CLOUD_SETTINGS as unknown as Record<string, unknown>)[key], key).toEqual((DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>)[key]);
    }
  });

  it("Issue #218: スコアリングの重み13項目 — 対応表は exe のキー(BIAS_WEIGHT_KEYS 7・BASE_SCORE_WEIGHT_KEYS 6)と過不足なく対応し、cloud の既定値は exe の DEFAULT_APP_SETTINGS・core の DEFAULT_SCORER_CONFIG のどちらとも、13項目すべて同じ", () => {
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "bias").map((f) => f.exeKey)).toEqual([...BIAS_WEIGHT_KEYS]);
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "base").map((f) => f.exeKey)).toEqual([...BASE_SCORE_WEIGHT_KEYS]);
    expect(SCORING_WEIGHT_FIELDS.length).toBe(BIAS_WEIGHT_KEYS.length + BASE_SCORE_WEIGHT_KEYS.length);
    for (const f of SCORING_WEIGHT_FIELDS) {
      const exeSettings = f.group === "bias" ? (DEFAULT_APP_SETTINGS.biasWeights as unknown as Record<string, number>) : (DEFAULT_APP_SETTINGS.baseScoreWeights as unknown as Record<string, number>);
      const core = f.group === "bias" ? (DEFAULT_SCORER_CONFIG.weights as unknown as Record<string, number>) : (DEFAULT_SCORER_CONFIG.baseScore.weights as unknown as Record<string, number>);
      expect(typeof core[f.exeKey], `core に ${f.exeKey} がある`).toBe("number");
      expect(DEFAULT_CLOUD_SETTINGS[f.field], `${f.field} = exe の ${f.group}.${f.exeKey}`).toBe(exeSettings[f.exeKey]);
      expect(DEFAULT_CLOUD_SETTINGS[f.field], `${f.field} = core の ${f.group}.${f.exeKey}`).toBe(core[f.exeKey]);
    }
  });

  it("Issue #218: スコアリングの重みの検証は exe と一致する — 同じ値を、exe の coerceSettings(永続化層)と cloud の読む側・書く側の述語に通すと、13項目すべてで採用・不採用が同じ", () => {
    const values: readonly unknown[] = [0, 0.05, 1, 3, 100, 1e300, -0.0001, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", "", null, undefined, true, [1], {}];
    // 前提: 採用される値と不採用の値の両方がある(空振りでない)
    expect(values.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0).length).toBeGreaterThan(3);
    expect(values.filter((v) => !(typeof v === "number" && Number.isFinite(v) && v >= 0)).length).toBeGreaterThan(3);
    for (const f of SCORING_WEIGHT_FIELDS) {
      const group = f.group === "bias" ? "biasWeights" : "baseScoreWeights";
      const rule = CLOUD_SETTINGS_RULES[f.field];
      for (const v of values) {
        const exe = coerceSettings({ [group]: { [f.exeKey]: v } })[group] as unknown as Record<string, number>;
        // 不正な値は既定値(有効な数)に戻るので、結果が入力と同じ(Object.is)なら採用されている。既定値と同じ値を入れた場合は、有効なので採用扱いで食い違わない。
        const exeAdopted = Object.is(exe[f.exeKey], v);
        expect(rule.isReadable(v), `${f.field} 読む側 ${String(v)}`).toBe(exeAdopted);
        expect(rule.isWritable(v), `${f.field} 書く側 ${String(v)}`).toBe(exeAdopted);
      }
    }
  });

  it("cloud 専用の項目は、exe の設定に無い(exe に同名の項目が増えたら、このテストが落ちて、既定値を揃えるか決め直す)。既定値は pre-race-time.ts の定数(45)", () => {
    for (const key of CLOUD_ONLY_KEYS) {
      expect(key in DEFAULT_APP_SETTINGS, `exe に ${key} が無い`).toBe(false);
    }
    expect(DEFAULT_CLOUD_SETTINGS.preRaceOffsetMinutes).toBe(DEFAULT_PRE_RACE_OFFSET_MINUTES);
    expect(DEFAULT_PRE_RACE_OFFSET_MINUTES).toBe(45);
  });

  it("exe の配分・取得に関わる項目(bankroll・perRaceCap・kellyFraction・includeComboOdds・各 include)は、すべて cloud にある", () => {
    const relevant = Object.keys(DEFAULT_APP_SETTINGS).filter((k) => /^(bankroll|perRaceCap|kellyFraction|includeComboOdds|include.*InAllocation|evThreshold|clipVariant|additionalInstruction)$/.test(k));
    expect(relevant.length).toBe(13);
    for (const key of relevant) {
      expect(key in DEFAULT_CLOUD_SETTINGS, `cloud に ${key} がある`).toBe(true);
    }
  });
});
