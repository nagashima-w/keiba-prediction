import { describe, expect, it } from "vitest";
import { inputToYmd, isRealYmd, todayJst, ymdToInput, formatJstDateTime } from "../client/date";

/** Issue #184: スマホ画面の日付の純関数。開催日は JST の日付で、`<input type="date">` は YYYY-MM-DD。 */

describe("todayJst(JST の今日。UTC+9)", () => {
  const cases: readonly [string, string][] = [
    ["2026-10-06T14:59:59Z", "20261006"], // JST 23:59:59
    ["2026-10-06T15:00:00Z", "20261007"], // JST 翌日 00:00:00
    ["2026-10-07T00:00:00Z", "20261007"],
    ["2026-12-31T15:00:00Z", "20270101"], // 年の境界
    ["2028-02-28T15:00:00Z", "20280229"], // うるう日
    ["2026-01-01T00:00:00Z", "20260101"],
  ];
  for (const [utc, expected] of cases) {
    it(`${utc} → ${expected}`, () => {
      expect(todayJst(new Date(utc))).toBe(expected);
    });
  }
});

describe("isRealYmd", () => {
  const cases: readonly [string, boolean][] = [
    ["20261003", true],
    ["20280229", true],
    ["20270229", false],
    ["20261301", false],
    ["20260631", false],
    ["20261000", false],
    ["2026100", false],
    ["202610033", false],
    ["2026-10-03", false],
    ["", false],
    ["abcdefgh", false],
  ];
  for (const [value, expected] of cases) {
    it(`${JSON.stringify(value)} は ${expected}`, () => {
      expect(isRealYmd(value)).toBe(expected);
    });
  }
});

describe("ymdToInput / inputToYmd", () => {
  it("YYYYMMDD → YYYY-MM-DD", () => {
    expect(ymdToInput("20261003")).toBe("2026-10-03");
  });
  it("YYYY-MM-DD → YYYYMMDD。不正・実在しない日付・空は null", () => {
    expect(inputToYmd("2026-10-03")).toBe("20261003");
    for (const bad of ["", "2026-13-01", "2026-02-30", "20261003", "2026-1-3", "abc"]) {
      expect(inputToYmd(bad), bad).toBeNull();
    }
  });
});

describe("formatJstDateTime(Issue #185。分析時刻は JST の固定表示。ブラウザのタイムゾーンに依存しない)", () => {
  const cases: readonly [string, string][] = [
    ["2026-06-28T05:00:00.000Z", "2026-06-28 14:00"],
    ["2026-06-28T14:59:59.000Z", "2026-06-28 23:59"], // UTC 14:59 はまだ JST の同じ日
    ["2026-06-28T15:00:00.000Z", "2026-06-29 00:00"], // UTC 15:00 から JST の翌日
    ["2026-12-31T15:30:00.000Z", "2027-01-01 00:30"], // 年またぎ
    ["2026-06-28T05:07:09Z", "2026-06-28 14:07"], // ゼロ埋め・秒は出さない
  ];
  for (const [iso, expected] of cases) {
    it(`${iso} → ${expected}`, () => {
      expect(formatJstDateTime(iso)).toBe(expected);
    });
  }
  it("解釈できない文字列は「日時不明」(例外にしない。元の文字列を出さない)", () => {
    expect(formatJstDateTime("")).toBe("日時不明");
    expect(formatJstDateTime("昨日")).toBe("日時不明");
  });
});
