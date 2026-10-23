import { describe, expect, it } from "vitest";
import { allocationSettingsOf } from "../src/race-day-support";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";

/** 設定のスナップショットのうち配分に使う項目(`allocationSettingsOf`)。分析と締切直前の再計算が同じ関数で作る。 */
describe("allocationSettingsOf(Issue #470: 的中確率の下限 minHitProb を運ぶ)", () => {
  it("設定の minHitProb がそのまま配分の設定に入る(既定と別の値・0 のどちらでも。定数の直書きを検出する)", () => {
    expect(allocationSettingsOf({ ...DEFAULT_CLOUD_SETTINGS, minHitProb: 0.17 }).minHitProb).toBe(0.17);
    expect(allocationSettingsOf({ ...DEFAULT_CLOUD_SETTINGS, minHitProb: 0 }).minHitProb).toBe(0);
    expect(allocationSettingsOf(DEFAULT_CLOUD_SETTINGS).minHitProb).toBe(0.05);
  });

  it("配分に使う11項目(総資金・上限・ケリー係数・下限・組合せオッズ・6券種)を、過不足なく持つ", () => {
    expect(Object.keys(allocationSettingsOf(DEFAULT_CLOUD_SETTINGS)).sort()).toEqual(
      [
        "bankroll",
        "perRaceCap",
        "kellyFraction",
        "minHitProb",
        "includeComboOdds",
        "includeWideInAllocation",
        "includeTrioInAllocation",
        "includeQuinellaInAllocation",
        "includeExactaInAllocation",
        "includeTrifectaInAllocation",
        "includeBracketQuinellaInAllocation",
      ].sort(),
    );
  });
});
