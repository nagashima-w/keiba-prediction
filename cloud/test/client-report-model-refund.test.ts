import { describe, expect, it } from "vitest";
import type { ReportDetail, ReportPeriod, ReportTemplateStat } from "../client/api-report";
import { buildReportModel, type ReportModelInput } from "../client/report-model";
import { formatTemplateStat } from "../src/whatif-format";

/** Issue #278: 日報の画面での返還(取消・除外の馬への買い目)。項目を持つ前の日報は、何も添えない(0 点とも書かない)。 */

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    date: "20261010", createdAt: "2026-10-10T11:12:00.000Z", model: "claude-sonnet-5-5", raceCount: 1, totalStake: 1000, totalReturn: 1300, summary: "総括",
    stats: {
      raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, betRaceCount: 1, llmUsedRaceCount: 1, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
      refundedBetCount: 2, refundedStake: 300,
      byBetType: { win: { betCount: 3, hitCount: 1, stake: 700, payout: 1100, refundCount: 1 }, wide: { betCount: 1, hitCount: 0, stake: 300, payout: 200, refundCount: 1 } },
      byMark: [],
    },
    races: [
      { raceId: "202605030801", analysisId: 1, title: "東京1R", llmUsed: true, hasResult: true, top3: [], marks: [], totalStake: 1000, totalReturn: 1300, judgedBetCount: 4, hitCount: 1, refundedBetCount: 2, unjudgedBetCount: 0, allocationNote: null, comment: null },
    ],
    narrative: null, narrativeRaw: null, note: null,
    ...over,
  };
}
const input = (r: ReportDetail): ReportModelInput => ({ today: "20261010", shownDate: "20261010", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: r, job: null }, run: { kind: "idle" }, pollStopped: false });
const body = (r: ReportDetail) => buildReportModel(input(r)).body!;

/** 項目を持つ前の日報(返還の項目をすべて取り除く)。 */
function legacy(): ReportDetail {
  const base = report();
  const { refundedBetCount: _c, refundedStake: _s, ...stats } = base.stats;
  return {
    ...base,
    stats: { ...stats, byBetType: { win: { betCount: 3, hitCount: 1, stake: 700, payout: 1100 }, wide: { betCount: 1, hitCount: 0, stake: 300, payout: 200 } } },
    races: base.races.map(({ refundedBetCount: _r, ...r }) => r),
  };
}

describe("日報の画面の返還(Issue #278)", () => {
  it("『的中』タイル: 『N 点中 M 点(うち返還 K 点)』。返還は的中に含めない", () => {
    expect(body(report()).tiles.find((t) => t.label === "的中")!.value).toBe("4 点中 1 点(うち返還 2 点)");
  });

  it("券種別の行: 返還のある券種だけ『(うち返還 K 点)』を添える", () => {
    const rows = body(report()).typeRows;
    expect(rows.find((r) => r.label === "単勝")!.value).toBe("3 点中 1 点的中(うち返還 1 点)・賭け金 700円・払戻 1,100円");
    expect(rows.find((r) => r.label === "ワイド")!.value).toBe("1 点中 0 点的中(うち返還 1 点)・賭け金 300円・払戻 200円");
  });

  it("券種別の行: 返還が 0 点の券種は何も添えない", () => {
    const base = report();
    const rows = body({ ...base, stats: { ...base.stats, byBetType: { win: { betCount: 3, hitCount: 1, stake: 700, payout: 1100, refundCount: 0 } } } }).typeRows;
    expect(rows[0]!.value).toBe("3 点中 1 点的中・賭け金 700円・払戻 1,100円");
  });

  it("レースごとの行: 『N 点中 M 点的中(うち返還 K 点)・賭け金…・払戻…』", () => {
    expect(body(report()).races[0]!.bets).toBe("買い目: 4 点中 1 点的中(うち返還 2 点)・賭け金 1,000円・払戻 1,300円");
  });

  it("直近 28 日の累計のタイルにも返還を出す", () => {
    const base = report();
    const total: ReportPeriod = { ...base.stats, fromDate: "20260913", toDate: "20261010", dayCount: 7, judgedBetCount: 300, hitBetCount: 24, refundedBetCount: 9, refundedStake: 2000 };
    const rolling = body({ ...base, rolling: { windowDays: 28, prior: total, total } }).rolling!;
    expect(rolling.tiles.find((t) => t.label === "的中")!.value).toBe("300 点中 24 点(うち返還 9 点)");
  });

  it("項目を持つ前の日報(返還の項目が無い)・返還が 0 点の日報は、何も添えない(0 点とも書かない)", () => {
    const old = body(legacy());
    expect(old.tiles.find((t) => t.label === "的中")!.value).toBe("4 点中 1 点");
    expect(old.typeRows.find((r) => r.label === "単勝")!.value).toBe("3 点中 1 点的中・賭け金 700円・払戻 1,100円");
    expect(old.races[0]!.bets).toBe("買い目: 4 点中 1 点的中・賭け金 1,000円・払戻 1,300円");
    const base = report();
    const zero = body({ ...base, stats: { ...base.stats, refundedBetCount: 0, refundedStake: 0 } });
    expect(zero.tiles.find((t) => t.label === "的中")!.value).toBe("4 点中 1 点");
  });
});

describe("「もしも」の返還(Issue #278)", () => {
  const tpl = (over: Partial<ReportTemplateStat> = {}): ReportTemplateStat => ({ betCount: 10, hitCount: 2, stake: 1000, payout: 1500, unjudgedCount: 0, inapplicableCount: 0, ...over });

  it("型の成績の文: 返還があれば『N レース中 M 的中(うち返還 K レース)』。無い・0 なら添えない", () => {
    const yen = (n: number): string => `${n}円`;
    expect(formatTemplateStat(tpl({ refundCount: 3 }), yen)).toBe("判定できた 10 レース中 2 的中(うち返還 3 レース)・賭け金 1000円・払戻 1500円・回収率 150.0%");
    expect(formatTemplateStat(tpl({ refundCount: 0 }), yen)).toBe("判定できた 10 レース中 2 的中・賭け金 1000円・払戻 1500円・回収率 150.0%");
    expect(formatTemplateStat(tpl(), yen)).toBe("判定できた 10 レース中 2 的中・賭け金 1000円・払戻 1500円・回収率 150.0%");
  });

  it("画面の注記に、返還の扱い(賭け金と払戻に含める)を書く", () => {
    const base = report();
    const w = body({ ...base, stats: { ...base.stats, whatIf: { win: tpl({ refundCount: 1 }) } } }).whatIf!;
    expect(w.note).toContain("返還");
    expect(w.groups[0]!.rows[0]!.value).toContain("うち返還 1 レース");
  });
});
