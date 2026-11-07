import { describe, expect, it, vi } from "vitest";
import type { AnalysisRecord } from "../../src/index.js";
import { runAnalysis } from "../../src/analysis/analysis-pipeline.js";
import { ALL_BETS_SETTINGS, FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace } from "../golden/pipeline-golden-scenarios.js";

/** Issue #649: 影の計算が throw しても、分析(保存・戻り値)は成功のまま続き、通知に渡る。 */
vi.mock("../../src/analysis/shadow-record.js", () => ({
  buildShadowRecord: () => {
    throw new Error("影の計算の失敗(テスト)");
  },
}));

describe("影の計算の失敗", () => {
  it("分析は成功し、記録に shadow は無く、onShadowError に raceId と文面が渡る", async () => {
    const race = await scrapeFixtureRace();
    const saved: AnalysisRecord[] = [];
    const errors: Array<{ raceId: string; message: string }> = [];
    const result = await runAnalysis(RACE_ID, KAISAI_DATE, {
      scrape: async () => ({ ...race, odds: { ...race.odds, oddsStatus: "result" as const } }),
      analyze: null,
      saveAnalysis: (r) => void saved.push(r),
      allocationSettings: ALL_BETS_SETTINGS,
      now: FIXED_NOW,
      shadow: true,
      onShadowError: (e) => void errors.push(e),
    });
    expect(saved).toHaveLength(1);
    expect("shadow" in saved[0]!).toBe(false);
    expect(saved[0]!.allocation?.bets.length ?? 0).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(errors).toEqual([{ raceId: RACE_ID, message: "影の計算の失敗(テスト)" }]);
  });
  it("onShadowError が無くても落ちない", async () => {
    const race = await scrapeFixtureRace();
    const saved: AnalysisRecord[] = [];
    await runAnalysis(RACE_ID, KAISAI_DATE, { scrape: async () => ({ ...race, odds: { ...race.odds, oddsStatus: "result" as const } }), analyze: null, saveAnalysis: (r) => void saved.push(r), allocationSettings: null, now: FIXED_NOW, shadow: true });
    expect(saved).toHaveLength(1);
  });
});
