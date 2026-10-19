import { describe, expect, it } from "vitest";
import { assertClosePayload, closeComboBasis, CLOSE_FAILED_REASONS, CLOSE_SKIPPED_REASONS, isCloseReason, type CloseSavePayload } from "../src/analysis-close";

/**
 * Issue #379: 再計算の理由の語彙(地方を対象にしたので、`nar-unsupported` は新しくは書かないが旧い行のために残す。`combo-missing` を足した)と、組合せの扱い(`closeComboBasis`)。
 */

const base = { round: 1 as const, dueAtMs: 0, firedAtMs: 0, lateMs: 0, oddsOfficialDatetime: null };

describe("理由の語彙(Issue #379)", () => {
  it("combo-missing は failed の理由。skipped の理由としては受理しない", () => {
    expect(CLOSE_FAILED_REASONS).toContain("combo-missing");
    expect(CLOSE_SKIPPED_REASONS).not.toContain("combo-missing");
    expect(isCloseReason("combo-missing")).toBe(true);
    const failed: CloseSavePayload = { ...base, status: "failed", reason: "combo-missing", allocation: null };
    expect(() => assertClosePayload(failed)).not.toThrow();
    expect(() => assertClosePayload({ ...failed, status: "skipped" })).toThrow();
  });

  it("旧 nar-unsupported は、旧い行を読むために語彙に残る(skipped の理由として受理し、isCloseReason も真)。新しい nar-combo-unsupported は作っていない", () => {
    expect(CLOSE_SKIPPED_REASONS).toContain("nar-unsupported");
    expect(isCloseReason("nar-unsupported")).toBe(true);
    expect(() => assertClosePayload({ ...base, status: "skipped", reason: "nar-unsupported", allocation: null })).not.toThrow();
    expect(isCloseReason("nar-combo-unsupported")).toBe(false);
  });
});

describe("closeComboBasis: 場 × 分析時の組合せ設定(テーブル駆動)", () => {
  it.each([
    ["central", true, "refetched"],
    ["central", false, "refetched"],
    ["nar", true, "analysis"],
    ["nar", false, "refetched"],
  ] as const)("%s・組合せ %s → %s", (venue, includeComboOdds, expected) => {
    expect(closeComboBasis(venue, includeComboOdds)).toBe(expected);
  });
});
