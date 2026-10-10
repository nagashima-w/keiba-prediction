import { describe, expect, it } from "vitest";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  directionLabel,
  exclusionRows,
  formatAdjustment,
  formatBinRange,
  formatPayoutBreakdown,
  formatRate,
  formatUnknownBetTypeNotice,
  formatYen,
  markLabel,
  overconfidenceLabel,
  promptVersionCalibrationHeading,
  promptVersionLabel,
  venueLabel,
} from "../../cloud/client/verify-format.js";
import {
  additionalInstructionsFullText as exeAdditionalInstructionsFullText,
  additionalInstructionsSummary as exeAdditionalInstructionsSummary,
  calibrationBarWidthPercent as exeCalibrationBarWidthPercent,
  directionLabel as exeDirectionLabel,
  formatAdjustment as exeFormatAdjustment,
  formatBinRange as exeFormatBinRange,
  markLabel as exeMarkLabel,
  overconfidenceLabel as exeOverconfidenceLabel,
  promptVersionCalibrationHeading as exePromptVersionCalibrationHeading,
  promptVersionLabel as exePromptVersionLabel,
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

/**
 * Issue #220: 補正方向×結果・キャリブレーション・印別的中率・プロンプト版別比較の整形も、exe の関数と同じ出力になる。
 * 値は境界(符号・0・ちょうど 0 になる差・丸めの境目・null・30 文字の境目・空配列)を含む表駆動。
 */
describe("補正方向・補正幅・過信バイアス・印の整形は exe と同じ", () => {
  it.each(["raised", "lowered", "unchanged"] as const)("directionLabel(%s)", (d) => {
    expect(directionLabel(d)).toBe(exeDirectionLabel(d));
  });
  it.each([null, 0, -0, 0.052, -0.031, 0.0004, -0.0004, 0.00049, 0.0005, 0.005, -0.005, 0.1234, 1, -1])("formatAdjustment(%s)", (v) => {
    expect(formatAdjustment(v)).toBe(exeFormatAdjustment(v));
  });
  it.each([null, 0, -0, 0.0001, -0.0001, 0.2, -0.2])("overconfidenceLabel(%s)", (v) => {
    expect(overconfidenceLabel(v)).toBe(exeOverconfidenceLabel(v));
  });
  it.each(["◎", "〇", "▲", "△", "☆", "注", null] as const)("markLabel(%s)", (m) => {
    expect(markLabel(m)).toBe(exeMarkLabel(m));
  });
  it("前提(空振り防止): 整形が値によって実際に変わる", () => {
    expect(formatAdjustment(0.052)).toBe("+5.2pt");
    expect(formatAdjustment(-0.031)).toBe("-3.1pt");
    expect(overconfidenceLabel(0.2)).toBe("過信");
    expect(overconfidenceLabel(-0.2)).toBe("過小評価");
    expect(overconfidenceLabel(0)).toBe("一致");
    expect(markLabel(null)).toBe("印なし");
    expect(directionLabel("raised")).not.toBe(directionLabel("lowered"));
  });
});

describe("キャリブレーションの帯の整形は exe と同じ", () => {
  const bins = Array.from({ length: 20 }, (_, i) => ({ lowerBound: i / 20, upperBound: (i + 1) / 20, predictedCount: 0, placedCount: 0, actualPlaceRate: null }));
  it("20 帯すべての帯ラベル", () => {
    expect(bins).toHaveLength(20);
    for (const bin of bins) {
      expect(formatBinRange(bin)).toBe(exeFormatBinRange(bin));
    }
    expect(formatBinRange(bins[0]!)).toBe("0〜5%");
    expect(formatBinRange(bins[19]!)).toBe("95〜100%");
    expect(new Set(bins.map(formatBinRange)).size).toBe(20);
  });
  it.each([null, 0, 0.0001, 0.417, 0.5, 1])("帯グラフの幅(%s)", (rate) => {
    expect(calibrationBarWidthPercent(rate)).toBe(exeCalibrationBarWidthPercent(rate));
  });
});

describe("プロンプト版の整形は exe と同じ", () => {
  const long30 = "あ".repeat(30);
  const long31 = "あ".repeat(31);
  const lists: ReadonlyArray<readonly (string | null)[]> = [[], [null], ["指示A"], [long30], [long31], ["b指示", null], ["a", "b", "c"], [null, "x".repeat(2000)]];
  it.each([null, "2026-10-09.2", "2026-10-09.2-clip015", ""])("promptVersionLabel(%s)", (v) => {
    expect(promptVersionLabel(v)).toBe(exePromptVersionLabel(v));
  });
  it.each(lists.map((l) => [JSON.stringify(l).slice(0, 40), l] as const))("追加指示の要約・全文・見出し %s", (_name, list) => {
    expect(additionalInstructionsSummary(list)).toBe(exeAdditionalInstructionsSummary(list));
    expect(additionalInstructionsFullText(list)).toBe(exeAdditionalInstructionsFullText(list));
    for (const v of [null, "2026-10-09.2"]) {
      expect(promptVersionCalibrationHeading(v, list)).toBe(exePromptVersionCalibrationHeading(v, list));
    }
  });
  it("前提(空振り防止): 30 文字は切らず 31 文字は切る・null は『なし』・空配列も『なし』", () => {
    expect(additionalInstructionsSummary([long30])).toBe(long30);
    expect(additionalInstructionsSummary([long31])).toBe(`${long30}…`);
    expect(additionalInstructionsSummary([null])).toBe("なし");
    expect(additionalInstructionsSummary([])).toBe("なし");
    expect(additionalInstructionsFullText(["a", null])).toBe("a / なし");
    expect(promptVersionLabel(null)).toBe("版不明");
  });
});
