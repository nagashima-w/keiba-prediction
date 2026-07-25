import { describe, expect, it } from "vitest";

import { validatePeriodInput } from "../../src/scraper/validate-period-input.js";

describe("validatePeriodInput(期間バッチの入力検証。タスクB2b-1)", () => {
  it("正常な期間(単日)はokになること", () => {
    expect(validatePeriodInput("20260710", "20260710")).toEqual({ ok: true });
  });

  it("正常な期間(複数日)はokになること", () => {
    expect(validatePeriodInput("20260710", "20260720")).toEqual({ ok: true });
  });

  it("fromがtoより後ろの日付はエラーになること(enumerateDatesへ委譲)", () => {
    const result = validatePeriodInput("20260710", "20260709");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("包含181日はokになること(境界値、enumerateDatesへ委譲)", () => {
    // 20260101から181日目 = 20260630(閏年でない2026年: 31+28+31+30+31+30=181日目が6/30)。
    expect(validatePeriodInput("20260101", "20260630")).toEqual({ ok: true });
  });

  it("包含182日はエラーになること(境界値、enumerateDatesへ委譲)", () => {
    const result = validatePeriodInput("20260101", "20260701");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("181");
    }
  });

  it("不正フォーマット(不正な日付文字列)のfromはエラーになること", () => {
    const result = validatePeriodInput("not-a-date", "20260710");
    expect(result.ok).toBe(false);
  });

  it("不正フォーマット(不正な日付文字列)のtoはエラーになること", () => {
    const result = validatePeriodInput("20260710", "unknown");
    expect(result.ok).toBe(false);
  });

  it("存在しない日付(2月30日)はエラーになること(parseKaisaiDateへ委譲)", () => {
    const result = validatePeriodInput("20260228", "20260230");
    expect(result.ok).toBe(false);
  });
});
