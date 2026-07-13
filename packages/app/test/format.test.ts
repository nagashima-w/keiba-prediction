import { describe, expect, it } from "vitest";

import {
  formatEv,
  formatMark,
  formatOdds,
  formatOpportunityScore,
  formatPercent,
  formatReason,
  isHighlightRow,
  LABEL_ADJUSTED_PROB,
  LABEL_PRIOR,
  MARK_LEGEND,
  oddsStatusNote,
} from "../src/renderer/format.js";
import type { AnalysisRow } from "../src/shared/analysis-types.js";

describe("表示ラベル(prior→3着内率 / 補正後→AI補正後 の統一)", () => {
  it("prior 列のラベルは「3着内率」", () => {
    expect(LABEL_PRIOR).toBe("3着内率");
  });
  it("補正後 列のラベルは「AI補正後」", () => {
    expect(LABEL_ADJUSTED_PROB).toBe("AI補正後");
  });
});

describe("formatOpportunityScore(妙味スコアの表示)", () => {
  it("スコアを小数第2位まで表示する", () => {
    expect(formatOpportunityScore(0.5)).toBe("0.50");
    expect(formatOpportunityScore(0.123)).toBe("0.12");
  });
  it("スコアが null(対象外)のときは「-」", () => {
    expect(formatOpportunityScore(null)).toBe("-");
  });
});

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
    careerRunCount: 10,
    mark: null,
  });

  it("isPositive の行のみハイライト対象", () => {
    expect(isHighlightRow(row(true))).toBe(true);
    expect(isHighlightRow(row(false))).toBe(false);
  });
});

describe("formatMark(予想印の表示・Task#23)", () => {
  it("印があればそのまま表示し、無ければ(null)空欄にすること", () => {
    expect(formatMark("◎")).toBe("◎");
    expect(formatMark("〇")).toBe("〇");
    expect(formatMark("▲")).toBe("▲");
    expect(formatMark("△")).toBe("△");
    expect(formatMark("☆")).toBe("☆");
    expect(formatMark("注")).toBe("注");
    expect(formatMark(null)).toBe("");
  });
});

describe("MARK_LEGEND(予想印の凡例文言・Task#23)", () => {
  it("各印の意味を短文で説明していること", () => {
    expect(MARK_LEGEND).toContain("◎本命");
    expect(MARK_LEGEND).toContain("〇対抗");
    expect(MARK_LEGEND).toContain("▲単穴");
    expect(MARK_LEGEND).toContain("△連下");
    expect(MARK_LEGEND).toContain("☆");
    expect(MARK_LEGEND).toContain("注");
  });
});

describe("oddsStatusNote(オッズ発売状態の注記)", () => {
  it("確定(result)は注記なし(null)", () => {
    expect(oddsStatusNote("result")).toBeNull();
  });

  it("発売中(middle)は暫定である旨を返す", () => {
    expect(oddsStatusNote("middle")).toBe("オッズは発売中(暫定)");
  });

  it("予想オッズ(yoso)は複勝未発売でEV計算不可+再分析の案内を返す", () => {
    expect(oddsStatusNote("yoso")).toBe(
      "複勝オッズ未発売(予想オッズのみ)のためEV計算不可。複勝発売開始後に再分析してください",
    );
  });
});
