import { describe, expect, it } from "vitest";
import { formatMonthLabel, isLastDayOfMonth, isValidMonth, jstMsOf, monthOfYmd, monthRange, previousMonth } from "../src/monthly-month";

/**
 * Issue #279(#265-A): 月報の「月」(YYYYMM)の暦の計算。月の範囲(1 日〜最終日)・最終日の判定・前月・JST の時刻 → エポックミリ秒。
 * うるう年・年またぎ・30/31 日の月の境界を表で固定する。
 */

describe("isValidMonth(YYYYMM の 6 桁で、実在する月)", () => {
  it.each([
    { month: "202610", ok: true },
    { month: "202601", ok: true },
    { month: "202612", ok: true },
    { month: "202600", ok: false },
    { month: "202613", ok: false },
    { month: "20261", ok: false },
    { month: "2026100", ok: false },
    { month: "20261001", ok: false },
    { month: "2026-10", ok: false },
    { month: "", ok: false },
    { month: "abcdef", ok: false },
  ])("$month → $ok", ({ month, ok }) => {
    expect(isValidMonth(month)).toBe(ok);
  });
});

describe("monthRange(月初〜月末。両端を含む)", () => {
  it.each([
    { month: "202610", from: "20261001", to: "20261031" }, // 31 日の月
    { month: "202609", from: "20260901", to: "20260930" }, // 30 日の月
    { month: "202602", from: "20260201", to: "20260228" }, // 平年の 2 月
    { month: "202402", from: "20240201", to: "20240229" }, // うるう年の 2 月
    { month: "202612", from: "20261201", to: "20261231" }, // 年末
  ])("$month → $from〜$to", ({ month, from, to }) => {
    expect(monthRange(month)).toEqual({ fromDate: from, toDate: to });
  });
});

describe("monthOfYmd・previousMonth・isLastDayOfMonth", () => {
  it("開催日から月を取り出す", () => {
    expect(monthOfYmd("20261031")).toBe("202610");
    expect(monthOfYmd("20260101")).toBe("202601");
  });

  it.each([
    { month: "202610", prev: "202609" },
    { month: "202601", prev: "202512" }, // 年またぎ
    { month: "202603", prev: "202602" },
  ])("前月: $month → $prev", ({ month, prev }) => {
    expect(previousMonth(month)).toBe(prev);
  });

  it.each([
    { ymd: "20261031", last: true },
    { ymd: "20261030", last: false },
    { ymd: "20260930", last: true },
    { ymd: "20260929", last: false },
    { ymd: "20260228", last: true },
    { ymd: "20240228", last: false }, // うるう年は 29 日が最終日
    { ymd: "20240229", last: true },
    { ymd: "20261231", last: true },
    { ymd: "20261101", last: false },
  ])("最終日か: $ymd → $last", ({ ymd, last }) => {
    expect(isLastDayOfMonth(ymd)).toBe(last);
  });
});

describe("jstMsOf(JST の日付と時刻 → エポックミリ秒)", () => {
  it("2026-10-31 22:00 JST は UTC 13:00", () => {
    expect(jstMsOf("20261031", 22)).toBe(Date.parse("2026-10-31T13:00:00.000Z"));
  });

  it("日付をまたぐ時刻(JST 0:30 は前日の UTC 15:30)", () => {
    expect(jstMsOf("20261101", 0, 30)).toBe(Date.parse("2026-10-31T15:30:00.000Z"));
  });
});

describe("formatMonthLabel(Issue #280: プロンプト・Discord の見出し)", () => {
  it.each([
    { month: "202610", label: "2026年10月" },
    { month: "202601", label: "2026年1月" }, // 月の先頭の 0 は付けない
    { month: "202612", label: "2026年12月" },
  ])("$month → $label", ({ month, label }) => {
    expect(formatMonthLabel(month)).toBe(label);
  });

  it.each(["2026-10", "20261", "20261031", "", "あ"])("月の形でなければそのまま: %s", (text) => {
    expect(formatMonthLabel(text)).toBe(text);
  });
});
