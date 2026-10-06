import { describe, expect, it } from "vitest";
import { DEFAULT_CLOUD_SETTINGS } from "../../cloud/src/settings.js";
import { DEFAULT_APP_SETTINGS } from "../../packages/app/src/main/settings-store.js";

/**
 * Issue #178(#164-c): クラウド版の設定の既定値は、exe の現在の既定値(`DEFAULT_APP_SETTINGS`)と一致する(メインの判断: 既定値は exe に揃える)。
 * cloud は exe の設定ストア(node:fs を使う)を import できないので、値を写して、ここで一致を固定する。exe の既定値を変えたら、このテストが落ちる。
 */
describe("クラウド版の設定の既定値が exe の既定値と一致する", () => {
  it("cloud の全項目が exe の既定値と同じ(項目の取りこぼしもない: cloud の項目は、exe の項目の部分集合で、配分・取得・EV・クリップの13項目)", () => {
    const keys = Object.keys(DEFAULT_CLOUD_SETTINGS);
    expect(keys.length).toBe(13);
    for (const key of keys) {
      expect(key in DEFAULT_APP_SETTINGS, `exe に ${key} がある`).toBe(true);
      expect((DEFAULT_CLOUD_SETTINGS as unknown as Record<string, unknown>)[key], key).toEqual((DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>)[key]);
    }
  });

  it("exe の配分・取得に関わる項目(bankroll・perRaceCap・kellyFraction・includeComboOdds・各 include)は、すべて cloud にある", () => {
    const relevant = Object.keys(DEFAULT_APP_SETTINGS).filter((k) => /^(bankroll|perRaceCap|kellyFraction|includeComboOdds|include.*InAllocation|evThreshold|clipVariant|additionalInstruction)$/.test(k));
    expect(relevant.length).toBe(13);
    for (const key of relevant) {
      expect(key in DEFAULT_CLOUD_SETTINGS, `cloud に ${key} がある`).toBe(true);
    }
  });
});
