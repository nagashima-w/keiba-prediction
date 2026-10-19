import { describe, expect, it } from "vitest";
import { parseLimitOverride } from "../src/limit-override";

/** Issue #394: `migration-core.test.ts` にあった parseLimitOverride の検査を、そのまま移した(定数は値に置き換えた: D1 の Free の日次の書き込み 100,000 行・1 回のクエリ 50)。 */
const D1_FREE_DAILY_WRITE_ROWS = 100_000;
const FREE_QUERIES_PER_INVOCATION = 50;

describe("parseLimitOverride(環境変数による上限の上書き)", () => {
  it.each([
    ["1", 100, 1],
    ["40", 50, 40],
    [" 50 ", 50, 50],
    ["100000", D1_FREE_DAILY_WRITE_ROWS, 100000],
  ])("%j(上限 %d)→ %d", (value, max, expected) => {
    expect(parseLimitOverride(value, max)).toBe(expected);
  });
  it.each([undefined, "", "0", "-1", "1.5", "abc", "1e3", "51", "０５"])("%j → 無視(null)", (value) => {
    expect(parseLimitOverride(value, FREE_QUERIES_PER_INVOCATION)).toBeNull();
  });
  it("Free の枠を超える値は受け付けない(日次 100,001 は null)", () => {
    expect(parseLimitOverride("100001", D1_FREE_DAILY_WRITE_ROWS)).toBeNull();
  });
});
