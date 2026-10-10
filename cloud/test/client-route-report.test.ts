import { describe, expect, it } from "vitest";
import { buildReportHash, parseHash, REPORT_HASH, screenOf } from "../client/route";

/** Issue #235: 日報画面のハッシュ。`#report`(最新の日報と日付の一覧)と `#report=YYYYMMDD`(その日)。完全一致だけで、不正な値は通常の解析(一覧)に落ちる。 */

const TODAY = "20261010";

describe("日報画面のハッシュ", () => {
  it("#report は日報画面で、日付は未指定(null)", () => {
    const route = parseHash("#report", TODAY);
    expect(screenOf(route)).toBe("report");
    expect(route.report).toStrictEqual({ date: null });
  });

  it("#report=YYYYMMDD は日報画面で、その日を指す", () => {
    const route = parseHash("#report=20261005", TODAY);
    expect(screenOf(route)).toBe("report");
    expect(route.report).toStrictEqual({ date: "20261005" });
  });

  it.each(["#report=", "#report=2026100", "#report=20261340", "#report=20261005&x=1", "#report=abc", "#reports", "#report=20261005/", "report=20261005"])(
    "完全一致しない・実在しない日付 %s は日報画面にならない(通常の解析に落ちる)",
    (hash) => {
      const route = parseHash(hash, TODAY);
      expect(screenOf(route)).not.toBe("report");
      expect(route.report).toBeUndefined();
    },
  );

  it("buildReportHash は parseHash と往復する。REPORT_HASH は #report", () => {
    expect(REPORT_HASH).toBe("#report");
    expect(buildReportHash("20261005")).toBe("#report=20261005");
    expect(parseHash(buildReportHash("20261005"), TODAY).report).toStrictEqual({ date: "20261005" });
  });

  it("他の画面のハッシュは日報画面にならない(設定・移行・検証・一覧・レース・分析)", () => {
    for (const hash of ["#settings", "#migration", "#verify", "", "#date=20261005&venue=central", "#date=20261005&venue=nar&race=202605030811", "#analysis=5"]) {
      expect(screenOf(parseHash(hash, TODAY)), hash).not.toBe("report");
    }
  });
});
