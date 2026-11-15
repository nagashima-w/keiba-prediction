import { describe, expect, it } from "vitest";
import { initialMarketVersion } from "../src/race-archive-repository";

/**
 * Issue #670: 目録に入れるときの `market_version`。窓(保存する日〈JST〉から 2 年)より古い中央のレースだけ -1。
 * 利用者に見える誤りに直結するのは境界(窓の中のレースを -1 にすると、市場の指標から落ちる)。
 */
describe("initialMarketVersion(窓の境界)", () => {
  // now は UTC。JST の日は +9 時間。
  it.each([
    ["前日は古い", "2026-11-03T03:00:00Z", "2024-11-02", -1],
    ["窓の開始日ちょうどは窓の中", "2026-11-03T03:00:00Z", "2024-11-03", null],
    ["翌日は窓の中", "2026-11-03T03:00:00Z", "2024-11-04", null],
    ["UTC では前日でも JST で日が替わっていれば JST の日で判定(JST 11/03 0:00)", "2026-11-02T15:00:00Z", "2024-11-02", -1],
    ["同じ時刻の窓の開始日は窓の中", "2026-11-02T15:00:00Z", "2024-11-03", null],
    ["閏日: 2028-02-29(JST)の 2 年前は 2026-02-28(2026 年に 2/29 が無い)。前日は古い", "2028-02-29T03:00:00Z", "2026-02-27", -1],
    ["閏日: 2026-02-28 は窓の中", "2028-02-29T03:00:00Z", "2026-02-28", null],
    ["閏日: 2026-03-01 は窓の中", "2028-02-29T03:00:00Z", "2026-03-01", null],
  ] as const)("中央・%s", (_name, now, raceDate, expected) => {
    expect(initialMarketVersion("central", raceDate, new Date(now))).toBe(expected);
  });

  it("地方は、どれだけ古くても NULL", () => {
    expect(initialMarketVersion("nar", "2016-01-05", new Date("2026-11-03T03:00:00Z"))).toBeNull();
  });
});
