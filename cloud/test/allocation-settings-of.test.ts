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

  it("Issue #533: 単勝・複勝の点数の上限が、別々にそのまま配分の設定に入る(取り違え・定数の直書きを検出する)", () => {
    const s = allocationSettingsOf({ ...DEFAULT_CLOUD_SETTINGS, maxWinBetsPerRace: 3, maxPlaceBetsPerRace: 5 });
    expect(s.maxWinBets).toBe(3);
    expect(s.maxPlaceBets).toBe(5);
    const zero = allocationSettingsOf({ ...DEFAULT_CLOUD_SETTINGS, maxWinBetsPerRace: 0, maxPlaceBetsPerRace: 0 });
    expect(zero.maxWinBets).toBe(0);
    expect(zero.maxPlaceBets).toBe(0);
    expect(allocationSettingsOf(DEFAULT_CLOUD_SETTINGS).maxWinBets).toBe(2);
    expect(allocationSettingsOf(DEFAULT_CLOUD_SETTINGS).maxPlaceBets).toBe(2);
  });

  it("配分に使う13項目(総資金・上限・ケリー係数・下限・単勝と複勝の点数の上限・組合せオッズ・6券種)を、過不足なく持つ", () => {
    expect(Object.keys(allocationSettingsOf(DEFAULT_CLOUD_SETTINGS)).sort()).toEqual(
      [
        "bankroll",
        "perRaceCap",
        "kellyFraction",
        "minHitProb",
        "maxWinBets",
        "maxPlaceBets",
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
