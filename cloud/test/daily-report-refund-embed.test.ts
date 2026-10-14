import { describe, expect, it } from "vitest";
import { buildDayStats, type DayStats } from "../src/daily-report-digest";
import { buildReportEmbed } from "../src/daily-report-embed";
import type { PeriodStats, RollingSummary } from "../src/period-stats";

/** Issue #278: Discord の日報の要約での返還(取消・除外の馬への買い目)。 */

const STATS: DayStats = {
  ...buildDayStats([]),
  raceCount: 36, resultRaceCount: 34, noResultRaceCount: 2, betRaceCount: 20,
  totalStake: 12000, totalReturn: 15600, recoveryRate: 1.3, judgedBetCount: 60, hitBetCount: 14,
};
const stat = (e: ReturnType<typeof buildReportEmbed>) => e.fields!.find((f) => f.name === "成績")!.value;

describe("buildReportEmbed: 返還(Issue #278)", () => {
  it("返還があれば『N 点中 M 点的中(うち返還 K 点)』と書く。的中数には含めない", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: { ...STATS, refundedBetCount: 5, refundedStake: 1500 }, narrative: null, note: null, link: undefined });
    expect(stat(e)).toContain("60 点中 14 点的中(うち返還 5 点)");
  });

  it("見込みもあるときは、同じ括弧の中に『うち返還 K 点・見込み X 点・実際 Y 点』と並べる", () => {
    const e = buildReportEmbed({
      kaisaiDate: "20261010",
      stats: { ...STATS, refundedBetCount: 5, refundedStake: 1500, expectedBetCount: 55, expectedHits: 12.5, expectedBaseHits: 13 },
      narrative: null, note: null, link: undefined,
    });
    expect(stat(e)).toContain("60 点中 14 点的中(うち返還 5 点・見込み 12.50 点・実際 13 点)");
  });

  it("返還が 0 点・項目が無い(この項目を持つ前の日報の統計)なら、何も添えない(0 点とも書かない)", () => {
    for (const stats of [{ ...STATS, refundedBetCount: 0, refundedStake: 0 }, STATS]) {
      const { refundedBetCount: _c, refundedStake: _s, ...legacy } = stats;
      for (const s of [stats, legacy as DayStats]) {
        const e = buildReportEmbed({ kaisaiDate: "20261010", stats: s, narrative: null, note: null, link: undefined });
        expect(stat(e)).toContain("60 点中 14 点的中");
        expect(stat(e)).not.toContain("返還");
      }
    }
  });

  it("直近 28 日の累計の field にも、累計の返還を書く", () => {
    const p = { ...STATS, refundedBetCount: 12, refundedStake: 3600, fromDate: "20260913", toDate: "20261010", dayCount: 8 } as PeriodStats;
    const rolling: RollingSummary = { windowDays: 28, prior: p, total: p };
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: null, note: null, link: undefined, rolling });
    const f = e.fields!.find((x) => x.name.startsWith("直近 28 日"))!;
    expect(f.value).toContain("60 点中 14 点的中(うち返還 12 点)");
  });
});
