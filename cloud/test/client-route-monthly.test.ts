import { describe, expect, it } from "vitest";
import { buildMonthlyHash, buildReportHash, parseHash, screenOf } from "../client/route";

/**
 * Issue #279(#265-A): 月報のハッシュ。日報と同じ画面の中で `#report=YYYYMM`(6 桁。実在の月)が月報を指す。画面の種類(screenOf)は `report` のまま。
 * 日報のハッシュ(`#report`・`#report=YYYYMMDD`)の解釈は変えない(別のテスト client-route-report.test.ts が固定している)。
 */

const TODAY = "20261010";

describe("月報のハッシュ", () => {
  it("#report=YYYYMM は日報画面(screenOf は report)で、月を指す。日付は null", () => {
    const route = parseHash("#report=202610", TODAY);
    expect(screenOf(route)).toBe("report");
    expect(route.report).toStrictEqual({ date: null, month: "202610" });
  });

  it("日報のハッシュに月は付かない(月報と日報は別の指定)", () => {
    expect(parseHash("#report", TODAY).report).toStrictEqual({ date: null });
    expect(parseHash("#report=20261005", TODAY).report).toStrictEqual({ date: "20261005" });
  });

  it.each(["#report=202613", "#report=202600", "#report=20261", "#report=2026100", "#report=202610&x=1", "#report=202610/", "#report=ab1234", "#report=-20261", "#report= 202610"])(
    "実在しない月・完全一致しない %s は日報画面にならない(通常の解析に落ちる)",
    (hash) => {
      const route = parseHash(hash, TODAY);
      expect(screenOf(route)).not.toBe("report");
      expect(route.report).toBeUndefined();
    },
  );

  it("buildMonthlyHash は parseHash と往復する。日報のハッシュとは区別される", () => {
    expect(buildMonthlyHash("202610")).toBe("#report=202610");
    expect(parseHash(buildMonthlyHash("202610"), TODAY).report).toStrictEqual({ date: null, month: "202610" });
    expect(buildMonthlyHash("202610")).not.toBe(buildReportHash("20261001"));
  });
});
