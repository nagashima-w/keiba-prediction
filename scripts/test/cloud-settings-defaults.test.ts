import { describe, expect, it } from "vitest";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "../../cloud/src/pre-race-time.js";
import { DEFAULT_CLOUD_SETTINGS } from "../../cloud/src/settings.js";
import { DEFAULT_APP_SETTINGS } from "../../packages/app/src/main/settings-store.js";

/**
 * Issue #178(#164-c): クラウド版の設定の既定値は、exe の現在の既定値(`DEFAULT_APP_SETTINGS`)と一致する(メインの判断: 既定値は exe に揃える)。
 * cloud は exe の設定ストア(node:fs を使う)を import できないので、値を写して、ここで一致を固定する。exe の既定値を変えたら、このテストが落ちる。
 */
/**
 * exe に無い、cloud 専用の項目(Issue #189)。exe の設定は PC 上で手動の分析を行うので、「発走何分前に自動評価するか」を持たない。
 * 新しい cloud 専用の項目を足すときは、ここに明示する(足し忘れると、下の「項目集合」の検査が落ちる)。
 */
const CLOUD_ONLY_KEYS = ["analysisModel", "preRaceOffsetMinutes"] as const;

describe("クラウド版の設定の既定値が exe の既定値と一致する", () => {
  it("cloud の項目 = exe と共有する13項目 + cloud 専用の項目(CLOUD_ONLY_KEYS)。共有の13項目は、exe に同名の項目があり、既定値が同じ(項目の取りこぼし・意図しない追加もない)", () => {
    const keys = Object.keys(DEFAULT_CLOUD_SETTINGS);
    const shared = keys.filter((k) => !(CLOUD_ONLY_KEYS as readonly string[]).includes(k));
    expect(shared.length).toBe(13);
    expect(keys.length).toBe(shared.length + CLOUD_ONLY_KEYS.length);
    expect([...keys].sort()).toEqual([...shared, ...CLOUD_ONLY_KEYS].sort());
    for (const key of shared) {
      expect(key in DEFAULT_APP_SETTINGS, `exe に ${key} がある`).toBe(true);
      expect((DEFAULT_CLOUD_SETTINGS as unknown as Record<string, unknown>)[key], key).toEqual((DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>)[key]);
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
