import { describe, expect, it } from "vitest";

import {
  formatEv,
  formatOdds,
  formatPercent,
  formatReason,
  isHighlightRow,
} from "../src/renderer/format.js";
import type { AnalysisRow } from "../src/shared/analysis-types.js";

describe("formatPercent(確率のパーセント表示)", () => {
  it("0〜1の確率を小数第1位までのパーセントに整形する", () => {
    expect(formatPercent(0.423)).toBe("42.3%");
    expect(formatPercent(0.4)).toBe("40.0%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("formatOdds(複勝オッズ下限の表示)", () => {
  it("数値は小数第1位まで、null はダッシュ", () => {
    expect(formatOdds(5)).toBe("5.0");
    expect(formatOdds(1.234)).toBe("1.2");
    expect(formatOdds(null)).toBe("-");
  });
});

describe("formatEv(期待値の表示)", () => {
  it("数値は小数第2位まで、null はダッシュ", () => {
    expect(formatEv(2.5)).toBe("2.50");
    expect(formatEv(1.005)).toBe("1.00");
    expect(formatEv(null)).toBe("-");
  });
});

describe("formatReason(根拠の表示)", () => {
  it("根拠が無い(null)場合はダッシュ、あればそのまま", () => {
    expect(formatReason(null)).toBe("-");
    expect(formatReason("調教良化")).toBe("調教良化");
  });
});

describe("isHighlightRow(EVプラス行のハイライト判定)", () => {
  const row = (isPositive: boolean): AnalysisRow => ({
    umaban: 1,
    wakuban: 1,
    horseName: "テスト馬",
    prior: 0.4,
    adjustedProb: 0.4,
    placeOddsMin: 3,
    ev: isPositive ? 1.2 : 0.8,
    isPositive,
    reason: null,
  });

  it("isPositive の行のみハイライト対象", () => {
    expect(isHighlightRow(row(true))).toBe(true);
    expect(isHighlightRow(row(false))).toBe(false);
  });
});
