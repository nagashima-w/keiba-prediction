/**
 * 期間バッチのUI入力検証ゲート(純関数)のテスト(タスクC2)。
 *
 * core の validatePeriodInput をそのまま再利用し(二重実装しない)、
 * 「NGなら collectPeriodBatch(phase1)を呼ばせない」ゲート判定を1つの述語に薄くまとめる。
 * 境界値は core 側(validate-period-input.test.ts)で網羅済みのため、ここでは
 * 「ゲートとして正しく機能するか」の代表ケースのみを固定する。
 */

import { describe, expect, it } from "vitest";

import { canCollectPeriodBatch } from "../src/renderer/period-batch-gate.js";

describe("canCollectPeriodBatch(期間バッチの入力検証ゲート)", () => {
  it("正常な期間はtrue(collect呼出可)であること", () => {
    expect(canCollectPeriodBatch("20260710", "20260711")).toBe(true);
  });

  it("fromがtoより後ろの日付はfalse(collect呼出不可)であること", () => {
    expect(canCollectPeriodBatch("20260711", "20260710")).toBe(false);
  });

  it("包含181日はtrue、182日はfalseであること(境界値、enumerateDatesへの委譲を確認)", () => {
    expect(canCollectPeriodBatch("20260101", "20260630")).toBe(true);
    expect(canCollectPeriodBatch("20260101", "20260701")).toBe(false);
  });

  it("不正フォーマットの日付文字列はfalseであること", () => {
    expect(canCollectPeriodBatch("not-a-date", "20260710")).toBe(false);
  });
});
