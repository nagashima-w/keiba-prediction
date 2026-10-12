import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchReport } from "../client/api-report";

/** Issue #278: 日報の返還(取消・除外の馬への買い目)の項目を読む。項目を持つ前の日報は、そのまま読める(欠けた項目を 0 にしない)。 */

const reply = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });

const STATS = {
  raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 2, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
  byBetType: { win: { betCount: 2, hitCount: 1, stake: 600, payout: 1300 } },
  byMark: [{ mark: "◎", count: 2, win: 1, top3: 1 }],
};
const REFUND = { refundedBetCount: 2, refundedStake: 300 };
const withRefund = { ...STATS, ...REFUND, byBetType: { win: { ...STATS.byBetType.win, refundCount: 1 } } };
const tpl = (over: Record<string, number> = {}) => ({ betCount: 10, hitCount: 2, stake: 1000, payout: 1500, unjudgedCount: 1, inapplicableCount: 3, ...over });
const RACE = {
  raceId: "202605030801", analysisId: 1, title: "東京1R", llmUsed: true, hasResult: true, top3: [], marks: [], totalStake: 300, totalReturn: 300, judgedBetCount: 2, hitCount: 0, unjudgedBetCount: 0, allocationNote: null, comment: null,
};
const detail = (stats: unknown, races: unknown[] = []) => ({
  date: "20261010", created_at: "2026-10-10T11:00:00.000Z", model: null, race_count: 2, total_stake: 1000, total_return: 1300, summary: null,
  body: { format: 1, kaisaiDate: "20261010", stats, races, narrative: null, narrativeRaw: null, note: null },
});
const fetchWith = (report: unknown) => fetchReport(reply(200, { ok: true, report, job: null, job_status: "ok" }), "20261010");
const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };

describe("fetchReport: 返還の項目(Issue #278)", () => {
  it("統計の返還(点数・賭け金)・券種別の返還・型の返還・レース行の返還を、サーバが書いた値のまま読む", async () => {
    const stats = { ...withRefund, whatIf: { win: tpl({ refundCount: 1 }) } };
    const got = await fetchWith(detail(stats, [{ ...RACE, refundedBetCount: 2 }]));
    if (!got.ok || got.report === null) throw new Error("読めませんでした");
    expect(got.report.stats).toStrictEqual(stats);
    expect(got.report.races[0]!.refundedBetCount).toBe(2);
    // 前提(空振り防止): 値が実際に入っている
    expect(got.report.stats.refundedStake).toBe(300);
    expect(got.report.stats.byBetType["win"]!.refundCount).toBe(1);
    expect(got.report.stats.whatIf!["win"]!.refundCount).toBe(1);
  });

  it("この項目を持つ前の日報は、そのまま読める。キーを足さない(0 にしない)", async () => {
    const got = await fetchWith(detail({ ...STATS, whatIf: { win: tpl() } }, [RACE]));
    if (!got.ok || got.report === null) throw new Error("読めませんでした");
    expect("refundedBetCount" in got.report.stats).toBe(false);
    expect("refundedStake" in got.report.stats).toBe(false);
    expect("refundCount" in got.report.stats.byBetType["win"]!).toBe(false);
    expect("refundCount" in got.report.stats.whatIf!["win"]!).toBe(false);
    expect("refundedBetCount" in got.report.races[0]!).toBe(false);
  });

  it.each([
    ["統計の返還が点数だけ(賭け金が無い)", { ...STATS, refundedBetCount: 1 }],
    ["統計の返還の点数が負", { ...STATS, refundedBetCount: -1, refundedStake: 0 }],
    ["統計の返還の賭け金が文字列", { ...STATS, refundedBetCount: 1, refundedStake: "100" }],
    ["券種別の返還が小数", { ...STATS, byBetType: { win: { ...STATS.byBetType.win, refundCount: 1.5 } } }],
    ["券種別の返還が負", { ...STATS, byBetType: { win: { ...STATS.byBetType.win, refundCount: -1 } } }],
    ["型の返還が文字列", { ...STATS, whatIf: { win: tpl({ refundCount: "1" as unknown as number }) } }],
    ["型の返還が負", { ...STATS, whatIf: { win: tpl({ refundCount: -1 }) } }],
  ])("想定外の形は一部だけ採用せず unexpected: %s", async (_n, stats) => {
    expect(await fetchWith(detail(stats))).toStrictEqual(unexpected);
  });

  it("レース行の返還が負・小数なら unexpected", async () => {
    expect(await fetchWith(detail(STATS, [{ ...RACE, refundedBetCount: -1 }]))).toStrictEqual(unexpected);
    expect(await fetchWith(detail(STATS, [{ ...RACE, refundedBetCount: 0.5 }]))).toStrictEqual(unexpected);
  });
});
