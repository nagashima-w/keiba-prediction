import { describe, expect, it } from "vitest";
import { jstMsOf } from "../src/monthly-month";
import { monthlyRequestsFor, MONTHLY_START_JST_HOUR } from "../src/monthly-report-plan";

/**
 * Issue #279(#265-A): cron の実行で、どの月の月報を依頼するか。最終日は当月を auto(同日 22:00 JST 開始)、月が明けて 3 日以内の 23:00 の実行は前月を catchup。
 * 新しい cron は足さない(21:00 の実行が 22:00 開始を依頼し、23:00 の実行が保険)。
 */

describe("monthlyRequestsFor(今日の開催日と実行の種類 → 依頼する月報)", () => {
  it("定数: 開始は 22:00 JST", () => {
    expect(MONTHLY_START_JST_HOUR).toBe(22);
  });

  it.each([
    { name: "最終日の 21:00(first)", today: "20261031", kind: "first" as const, expected: [{ month: "202610", mode: "auto", startAt: jstMsOf("20261031", 22) }] },
    { name: "最終日の 23:00(retry。21:00 の依頼が落ちたときの保険。startAt は過去になるが、コアが今すぐに読み替える)", today: "20261031", kind: "retry" as const, expected: [{ month: "202610", mode: "auto", startAt: jstMsOf("20261031", 22) }] },
    { name: "30 日の月の最終日", today: "20260930", kind: "first" as const, expected: [{ month: "202609", mode: "auto", startAt: jstMsOf("20260930", 22) }] },
    { name: "平年の 2 月の最終日", today: "20270228", kind: "first" as const, expected: [{ month: "202702", mode: "auto", startAt: jstMsOf("20270228", 22) }] },
    { name: "うるう年の 2 月 28 日は最終日ではない", today: "20280228", kind: "first" as const, expected: [] },
    { name: "年末の最終日", today: "20261231", kind: "first" as const, expected: [{ month: "202612", mode: "auto", startAt: jstMsOf("20261231", 22) }] },
    { name: "月の途中", today: "20261015", kind: "retry" as const, expected: [] },
    { name: "月初 1 日の 23:00(retry)は前月の補完", today: "20261101", kind: "retry" as const, expected: [{ month: "202610", mode: "catchup" }] },
    { name: "月初 3 日の 23:00(retry)は前月の補完(上限ちょうど)", today: "20261103", kind: "retry" as const, expected: [{ month: "202610", mode: "catchup" }] },
    { name: "月初 4 日は補完しない", today: "20261104", kind: "retry" as const, expected: [] },
    { name: "月初でも 21:00(first)は補完しない(補完は 23:00 の実行だけ)", today: "20261101", kind: "first" as const, expected: [] },
    { name: "年またぎの補完(1 月 2 日の前月は前年 12 月)", today: "20270102", kind: "retry" as const, expected: [{ month: "202612", mode: "catchup" }] },
  ])("$name", ({ today, kind, expected }) => {
    expect(monthlyRequestsFor(today, kind)).toEqual(expected);
  });
});
