import { describe, expect, it } from "vitest";
import type {
  AnalysisHistoryItem,
  CalibrationBinView,
  VerifyBetView,
} from "../src/shared/analysis-types.js";
import {
  calibrationBarWidthPercent,
  formatBinRange,
  formatPayoutBreakdown,
  formatRate,
  formatYen,
  importButtonLabel,
  needsImport,
} from "../src/renderer/verify-format.js";

/** テスト用の履歴項目を最小構成で組み立てる。 */
function historyItem(
  over: Partial<AnalysisHistoryItem> = {},
): AnalysisHistoryItem {
  return {
    analysisId: 1,
    raceId: "R1",
    analyzedAt: "2026-07-01T00:00:00.000Z",
    horseCount: 10,
    positiveCount: 2,
    hasResult: false,
    hasPayout: false,
    ...over,
  };
}

describe("verify画面の表示整形(純関数)", () => {
  describe("formatRate(回収率・複勝率のパーセント表示)", () => {
    it("0〜1の値を小数第1位までのパーセントにすること", () => {
      expect(formatRate(0.823)).toBe("82.3%");
      expect(formatRate(1.156)).toBe("115.6%");
    });
    it("null は '-' にすること", () => {
      expect(formatRate(null)).toBe("-");
    });
  });

  describe("formatYen(金額の桁区切り)", () => {
    it("3桁区切りの円表記にすること", () => {
      expect(formatYen(1060)).toBe("1,060円");
      expect(formatYen(210)).toBe("210円");
      expect(formatYen(0)).toBe("0円");
    });
  });

  describe("calibrationBarWidthPercent(帯グラフの幅)", () => {
    it("複勝率を0〜100の幅(%)に写すこと", () => {
      expect(calibrationBarWidthPercent(0.42)).toBeCloseTo(42, 10);
      expect(calibrationBarWidthPercent(1)).toBeCloseTo(100, 10);
    });
    it("null(予測0件)は幅0にすること", () => {
      expect(calibrationBarWidthPercent(null)).toBe(0);
    });
  });

  describe("formatBinRange(確率帯ラベル)", () => {
    it("下限〜上限のパーセント範囲を返すこと", () => {
      const bin: CalibrationBinView = {
        lowerBound: 0.4,
        upperBound: 0.5,
        predictedCount: 3,
        placedCount: 1,
        actualPlaceRate: 1 / 3,
      };
      expect(formatBinRange(bin)).toBe("40〜50%");
    });
  });

  describe("formatPayoutBreakdown(実配当/近似の内訳注記)", () => {
    it("実配当と近似の件数を注記文にすること", () => {
      const bet: VerifyBetView = {
        betCount: 5,
        totalStake: 500,
        totalReturn: 620,
        recoveryRate: 1.24,
        actualPayoutCount: 3,
        approximatePayoutCount: 1,
      };
      expect(formatPayoutBreakdown(bet)).toBe("実配当 3件 / 近似 1件");
    });
  });

  describe("needsImport(再取込が必要か)", () => {
    it("結果未取込なら true", () => {
      expect(needsImport(historyItem({ hasResult: false }))).toBe(true);
    });
    it("結果取込済みでも払戻が未取込なら true(実配当への更新導線を残す)", () => {
      expect(
        needsImport(historyItem({ hasResult: true, hasPayout: false })),
      ).toBe(true);
    });
    it("結果も払戻も取込済みなら false", () => {
      expect(
        needsImport(historyItem({ hasResult: true, hasPayout: true })),
      ).toBe(false);
    });
  });

  describe("importButtonLabel(取込ボタンの文言)", () => {
    it("未取込は『結果を取り込む』", () => {
      expect(importButtonLabel(historyItem({ hasResult: false }))).toBe(
        "結果を取り込む",
      );
    });
    it("着順は取込済みだが払戻が無い場合は『再取込(払戻待ち)』", () => {
      expect(
        importButtonLabel(historyItem({ hasResult: true, hasPayout: false })),
      ).toBe("再取込(払戻待ち)");
    });
  });
});
