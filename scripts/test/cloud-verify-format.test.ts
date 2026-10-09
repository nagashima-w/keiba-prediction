import { describe, expect, it } from "vitest";
import {
  exclusionRows,
  formatPayoutBreakdown,
  formatRate,
  formatUnknownBetTypeNotice,
  formatYen,
  venueLabel,
} from "../../cloud/client/verify-format.js";
import {
  formatExclusionSummary,
  formatPayoutBreakdown as exeFormatPayoutBreakdown,
  formatRate as exeFormatRate,
  formatUnknownBetTypeNotice as exeFormatUnknownBetTypeNotice,
  formatYen as exeFormatYen,
  venueFilterLabel,
} from "../../packages/app/src/renderer/verify-format.js";

/**
 * Issue #219: クラウド版の検証画面の整形(`cloud/client/verify-format.ts`)は、exe の検証画面(`packages/app/src/renderer/verify-format.ts`)と同じ出力になる。
 * **ここ(ルートの scripts/test/)に置く理由**: exe の renderer の整形は app の閉包(型の import 先を含む)で、cloud の CI(cloud だけを install)からは引けない(#218 と同じ)。
 */
describe("率・金額の整形は exe と同じ", () => {
  it.each([null, 0, 0.0004, 0.05, 0.9603846, 1, 1.0525, 2.25, 12.3456])("formatRate(%s)", (rate) => {
    expect(formatRate(rate)).toBe(exeFormatRate(rate));
  });
  it.each([0, 1, 999, 1000, 1060, 123456, 1234567, 4994.5])("formatYen(%s)", (amount) => {
    expect(formatYen(amount)).toBe(exeFormatYen(amount));
  });
  it("前提(空振り防止): 整形が値によって実際に変わる", () => {
    expect(formatRate(0.5)).not.toBe(formatRate(0.6));
    expect(formatYen(1060)).toBe("1,060円");
  });
});

describe("文言は exe と同じ", () => {
  const bet = { actualPayoutCount: 20, approximatePayoutCount: 1 };
  it("払戻内訳", () => {
    expect(formatPayoutBreakdown(bet)).toBe(exeFormatPayoutBreakdown({ ...bet, betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null }));
  });

  it("集計の内訳 6 項目を ` / ` で連ねると、exe の formatExclusionSummary と一致する(順序・文言・件数)", () => {
    const report = {
      includedAnalysisCount: 120, excludedAnalysisCount: 7, supersededAnalysisCount: 30, excludedEstimatedCount: 4, excludedLookaheadSuspectCount: 3, excludedLookaheadUnknownCount: 2,
    };
    const joined = exclusionRows(report as never).map((r) => `${r.label}${r.value}`).join(" / ");
    expect(joined).toBe(formatExclusionSummary(report as never));
    expect(exclusionRows(report as never)).toHaveLength(6);
  });

  it("未知の券種の注記(0 点は null)", () => {
    for (const u of [{ count: 0, totalStake: 0, betTypes: [] }, { count: 2, totalStake: 1500, betTypes: ["abc", "xyz"] }]) {
      expect(formatUnknownBetTypeNotice(u)).toBe(exeFormatUnknownBetTypeNotice(u));
    }
    expect(formatUnknownBetTypeNotice({ count: 2, totalStake: 1500, betTypes: ["abc"] })).not.toBeNull();
  });

  it("区分の名前", () => {
    for (const v of ["all", "central", "nar"] as const) {
      expect(venueLabel(v)).toBe(venueFilterLabel(v));
    }
  });
});
