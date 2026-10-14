import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_JST_HOUR,
  RETRY_RUN_JST_HOUR,
  RETRY_RUN_FROM_JST_HOUR,
  kaisaiDateWeekday,
  planTargetDate,
  scheduledRunKind,
} from "../src/auto-run-plan";

/**
 * Issue #249: 事前分析(旧「朝の準備」)の定時実行の純関数。cron は 21:00 JST(UTC 12:00)と 23:00 JST(UTC 14:00)の 2 本。
 *  - `scheduledRunKind`: scheduledTime の JST の時刻で first(21 時の実行)か retry(23 時の再実行)かを決める。
 *  - `planTargetDate`: 計画する開催日 = scheduledTime の JST の今日 + 1。
 *  - `kaisaiDateWeekday`: 開催日の曜日(通知の見出しに付ける)。
 * 期待値は実装とは別の式(固定の文字列・UTC の暦)で書く。
 */

describe("定数: cron の時刻(JST)", () => {
  it("21 時と 23 時。再実行の判別は 22 時以降", () => {
    expect(FIRST_RUN_JST_HOUR).toBe(21);
    expect(RETRY_RUN_JST_HOUR).toBe(23);
    expect(RETRY_RUN_FROM_JST_HOUR).toBe(22);
  });
});

describe("scheduledRunKind(scheduledTime の JST の時刻で first / retry を決める)", () => {
  it.each([
    ["JST 0:00(UTC 15:00)は first", "2026-06-30T15:00:00.000Z", "first"],
    ["JST 9:00(旧 cron の時刻 = UTC 0:00)は first", "2026-07-01T00:00:00.000Z", "first"],
    ["JST 20:59:59.999(UTC 11:59:59.999)は first", "2026-06-30T11:59:59.999Z", "first"],
    ["JST 21:00:00(UTC 12:00。本番の 1 本目)は first", "2026-06-30T12:00:00.000Z", "first"],
    ["JST 21:59:59.999(UTC 12:59:59.999)は first(境界の 1 ミリ秒前)", "2026-06-30T12:59:59.999Z", "first"],
    ["JST 22:00:00(UTC 13:00)は retry(境界)", "2026-06-30T13:00:00.000Z", "retry"],
    ["JST 23:00:00(UTC 14:00。本番の 2 本目)は retry", "2026-06-30T14:00:00.000Z", "retry"],
    ["JST 23:59:59.999(UTC 14:59:59.999)は retry", "2026-06-30T14:59:59.999Z", "retry"],
    ["JST 翌 0:00:00(UTC 15:00)は first(日付が変わる境界)", "2026-06-30T15:00:00.000Z", "first"],
  ])("%s", (_name, utc, expected) => {
    expect(scheduledRunKind(Date.parse(utc))).toBe(expected);
  });

  it("21 時と 23 時の cron の名目時刻は、別の種類になる(同じ種類なら、再実行の分岐が一度も動かない)", () => {
    const first = scheduledRunKind(Date.parse("2026-06-30T12:00:00Z"));
    const retry = scheduledRunKind(Date.parse("2026-06-30T14:00:00Z"));
    expect(first).toBe("first");
    expect(retry).toBe("retry");
    expect(first).not.toBe(retry);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [-1e20], [1e20]])("無効な時刻 %s は RangeError", (value) => {
    expect(() => scheduledRunKind(value)).toThrow(RangeError);
  });
});

describe("planTargetDate(計画する開催日 = scheduledTime の JST の今日 + 1)", () => {
  it.each([
    ["通常(21 時): JST 6/28 21:00 → 6/29", "2026-06-28T12:00:00.000Z", "20260629"],
    ["通常(23 時): JST 6/28 23:00 → 6/29(21 時と同じ開催日)", "2026-06-28T14:00:00.000Z", "20260629"],
    ["23:59:59.999 でも同じ日の翌日(JST 6/28 → 6/29)", "2026-06-28T14:59:59.999Z", "20260629"],
    ["JST 翌 0:00(UTC 15:00)は、日付が進むので翌々日(JST 6/29 0:00 → 6/30)", "2026-06-28T15:00:00.000Z", "20260630"],
    ["月末(10 月 31 日 21 時 → 11 月 1 日)", "2026-10-31T12:00:00.000Z", "20261101"],
    ["30 日の月末(6 月 30 日 23 時 → 7 月 1 日)", "2026-06-30T14:00:00.000Z", "20260701"],
    ["年末(12 月 31 日 21 時 → 翌年 1 月 1 日)", "2026-12-31T12:00:00.000Z", "20270101"],
    ["年末(12 月 31 日 23 時 → 翌年 1 月 1 日)", "2026-12-31T14:00:00.000Z", "20270101"],
    ["うるう年の 2 月 28 日 → 29 日", "2028-02-28T12:00:00.000Z", "20280229"],
    ["うるう年の 2 月 29 日 → 3 月 1 日", "2028-02-29T14:00:00.000Z", "20280301"],
    ["平年の 2 月 28 日 → 3 月 1 日", "2027-02-28T12:00:00.000Z", "20270301"],
    ["年末の JST 翌 0:00(UTC 12/31 15:00 = JST 1/1 0:00)→ 1 月 2 日", "2026-12-31T15:00:00.000Z", "20270102"],
  ])("%s", (_name, utc, expected) => {
    expect(planTargetDate(Date.parse(utc))).toBe(expected);
  });

  it("UTC の日付そのものに 1 日足す変異と区別できる入力がある: UTC 15:00 以降は UTC の暦日と JST の暦日が違う", () => {
    const utcText = "2026-06-28T15:00:00.000Z";
    const utcPlusOne = "20260629";
    // 前提: この入力では、UTC の暦日 + 1 と、JST の暦日 + 1 が違う(違わないなら、この検査は何も区別しない)
    expect(planTargetDate(Date.parse(utcText))).toBe("20260630");
    expect(planTargetDate(Date.parse(utcText))).not.toBe(utcPlusOne);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [-1e20], [1e20]])("無効な時刻 %s は RangeError", (value) => {
    expect(() => planTargetDate(value)).toThrow(RangeError);
  });

  it("翌日が 4 桁の年に収まらない(9999/12/31 の翌日)なら RangeError(5 桁の年の開催日を返さない)", () => {
    // JST 9999-12-31 21:00 = UTC 9999-12-31 12:00(jstKaisaiDate 自体は通る)
    const ms = Date.UTC(9999, 11, 31, 12, 0, 0);
    expect(() => planTargetDate(ms)).toThrow(RangeError);
  });
});

describe("kaisaiDateWeekday(開催日の曜日)", () => {
  it.each([
    ["20261011", "日"],
    ["20261012", "月"],
    ["20261013", "火"],
    ["20261014", "水"],
    ["20261015", "木"],
    ["20261016", "金"],
    ["20261017", "土"],
    ["20280229", "火"],
    ["20270101", "金"],
  ])("%s は %s 曜日", (date, expected) => {
    expect(kaisaiDateWeekday(date)).toBe(expected);
  });

  it("形が不正な開催日は null", () => {
    expect(kaisaiDateWeekday("2026101")).toBeNull();
    expect(kaisaiDateWeekday("20261301")).toBeNull();
    expect(kaisaiDateWeekday("abcdefgh")).toBeNull();
  });
});
