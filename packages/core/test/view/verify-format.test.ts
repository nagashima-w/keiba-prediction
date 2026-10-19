import { describe, expect, it } from "vitest";
import type {
  CalibrationBinView,
  VerifyBetView,
  VerifyReportView,
} from "../../src/analysis/analysis-types.js";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  directionLabel,
  formatAdjustment,
  formatBinRange,
  formatExclusionSummary,
  formatPayoutBreakdown,
  formatRate,
  formatUnknownBetTypeNotice,
  formatYen,
  markLabel,
  overconfidenceLabel,
  promptVersionCalibrationHeading,
  promptVersionLabel,
  venueFilterLabel,
} from "../../src/view/verify-format.js";

/** テスト用の検証レポートを最小構成で組み立てる。 */
function verifyReport(over: Partial<VerifyReportView> = {}): VerifyReportView {
  return {
    includedAnalysisCount: 0,
    excludedAnalysisCount: 0,
    supersededAnalysisCount: 0,
    excludedEstimatedCount: 0,
    excludedLookaheadSuspectCount: 0,
    excludedLookaheadUnknownCount: 0,
    bet: {
      betCount: 0,
      totalStake: 0,
      totalReturn: 0,
      recoveryRate: null,
      actualPayoutCount: 0,
      approximatePayoutCount: 0,
    },
    calibration: [],
    trend: { directionGroups: [], calibrationBias: [], markStats: [] },
    proposedBet: {
      population: { allocated: 0, skipped: 0, unreached: 0, noRecord: 0 },
      overall: emptyProposedBetTypeSummary(),
      place: emptyProposedBetTypeSummary(),
      win: emptyProposedBetTypeSummary(),
      wide: emptyProposedBetTypeSummary(),
      trio: emptyProposedBetTypeSummary(),
      quinella: emptyProposedBetTypeSummary(),
      exacta: emptyProposedBetTypeSummary(),
      trifecta: emptyProposedBetTypeSummary(),
      bracketQuinella: emptyProposedBetTypeSummary(),
      unknownBetType: { count: 0, totalStake: 0, betTypes: [] },
    },
    ...over,
  };
}

/** テスト用の空のproposedBet券種別サマリ(Issue #71)。 */
function emptyProposedBetTypeSummary() {
  return { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, unjudgedCount: 0 };
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

  describe("formatUnknownBetTypeNotice(未知の券種コードの注記。Issue #76)", () => {
    it("count===0はnullを返すこと(未知券種行が1件も無い通常時)", () => {
      expect(formatUnknownBetTypeNotice({ count: 0, totalStake: 0, betTypes: [] })).toBeNull();
    });

    it("count>0は点数・賭け金合計・券種コードを含む文字列を返すこと", () => {
      const text = formatUnknownBetTypeNotice({ count: 3, totalStake: 600, betTypes: ["quinella", "win"] });
      expect(text).toBe(
        "未対応の券種コード(quinella、win)の買い目が3点 (賭け金合計600円)あり、回収率の集計から除外しています。",
      );
    });
  });

  describe("directionLabel(補正方向×結果、Task#26)", () => {
    it("raised/lowered/unchangedを日本語ラベルにすること", () => {
      expect(directionLabel("raised")).toBe("上げ");
      expect(directionLabel("lowered")).toBe("下げ");
      expect(directionLabel("unchanged")).toBe("据え置き");
    });
  });

  describe("formatAdjustment(平均補正幅・過信バイアスのpt表示、Task#26)", () => {
    it("正の値は符号付きでポイント表示にすること", () => {
      expect(formatAdjustment(0.052)).toBe("+5.2pt");
    });
    it("負の値も符号付きでポイント表示にすること", () => {
      expect(formatAdjustment(-0.031)).toBe("-3.1pt");
    });
    it("0は+0.0ptにすること", () => {
      expect(formatAdjustment(0)).toBe("+0.0pt");
    });
    it("nullは'-'にすること(件数0の群)", () => {
      expect(formatAdjustment(null)).toBe("-");
    });
  });

  describe("overconfidenceLabel(過信/過小評価のラベル、Task#26)", () => {
    it("正なら『過信』にすること", () => {
      expect(overconfidenceLabel(0.1)).toBe("過信");
    });
    it("負なら『過小評価』にすること", () => {
      expect(overconfidenceLabel(-0.1)).toBe("過小評価");
    });
    it("0なら『一致』にすること", () => {
      expect(overconfidenceLabel(0)).toBe("一致");
    });
    it("nullは'-'にすること(予測0件の帯)", () => {
      expect(overconfidenceLabel(null)).toBe("-");
    });
  });

  describe("markLabel(印別的中率の印表示、Task#26)", () => {
    it("印はそのまま表示すること", () => {
      expect(markLabel("◎")).toBe("◎");
      expect(markLabel("注")).toBe("注");
    });
    it("印なし(null)は『印なし』にすること", () => {
      expect(markLabel(null)).toBe("印なし");
    });
  });

  describe("promptVersionLabel(プロンプト版番号の表示、Task#27)", () => {
    it("版番号はそのまま表示すること", () => {
      expect(promptVersionLabel("2026-07-14.1")).toBe("2026-07-14.1");
    });
    it("版不明(null)は『版不明』にすること", () => {
      expect(promptVersionLabel(null)).toBe("版不明");
    });
  });

  describe(
    "promptVersionCalibrationHeading(版別キャリブレーション表の折りたたみ見出し、D-1)",
    () => {
      it("版番号と追加指示の要約を併記すること", () => {
        expect(
          promptVersionCalibrationHeading("2026-07-14.1", [
            "人気薄の複勝率は慎重に見積もること",
          ]),
        ).toBe("2026-07-14.1 (追加指示: 人気薄の複勝率は慎重に見積もること)");
      });

      it("版不明(null)は『版不明』と表示すること", () => {
        expect(promptVersionCalibrationHeading(null, [])).toBe(
          "版不明 (追加指示: なし)",
        );
      });

      it("追加指示が複数件でもadditionalInstructionsSummaryと同じ形式で連結すること", () => {
        expect(
          promptVersionCalibrationHeading("2026-07-14.1", [
            "指示A",
            "指示B",
            null,
          ]),
        ).toBe("2026-07-14.1 (追加指示: 指示A / 指示B / なし)");
      });
    },
  );

  describe("venueFilterLabel(検証画面の地域フィルタ表示、Task#32)", () => {
    it("all は『全体』にすること", () => {
      expect(venueFilterLabel("all")).toBe("全体");
    });
    it("central は『中央のみ』にすること", () => {
      expect(venueFilterLabel("central")).toBe("中央のみ");
    });
    it("nar は『地方のみ』にすること", () => {
      expect(venueFilterLabel("nar")).toBe("地方のみ");
    });
  });

  describe("additionalInstructionsSummary(版内で使われた追加指示の要約表示、Task#28)", () => {
    it("[null]のみ(追加指示なし)なら『なし』にすること", () => {
      expect(additionalInstructionsSummary([null])).toBe("なし");
    });

    it("空配列でも『なし』にすること(データ無し)", () => {
      expect(additionalInstructionsSummary([])).toBe("なし");
    });

    it("1件の追加指示のみならその全文を表示すること", () => {
      expect(additionalInstructionsSummary(["人気薄の複勝率は慎重に見積もること"])).toBe(
        "人気薄の複勝率は慎重に見積もること",
      );
    });

    it("長い追加指示は30文字を超えたら省略記号(…)を付けて切り詰めること", () => {
      const long = "あ".repeat(40);
      const summary = additionalInstructionsSummary([long]);
      expect(summary.length).toBe(31); // 30文字 + "…"
      expect(summary.endsWith("…")).toBe(true);
      expect(summary.startsWith("あ".repeat(30))).toBe(true);
    });

    it("複数件が混在すれば『/』区切りで並べ、追加指示なし(null)は『なし』として表示すること", () => {
      expect(additionalInstructionsSummary(["指示A", "指示B", null])).toBe(
        "指示A / 指示B / なし",
      );
    });
  });

  describe("additionalInstructionsFullText(title属性用のフルテキスト、Task#28 code-reviewer提案対応)", () => {
    // additionalInstructionsSummary はセル表示用に30文字で省略するが、
    // title属性(ホバー時のツールチップ)は省略なしの全文を表示したい。
    // また join(" / ") を直接使うと null 要素が空文字になり "指示A / "(末尾空)のような
    // 表示不整合が起きるため、null→「なし」変換をこちらにも適用する。

    it("null混在なら『なし』に変換して連結すること(末尾が空文字にならない)", () => {
      expect(additionalInstructionsFullText(["指示A", null])).toBe("指示A / なし");
    });

    it("全てnullなら『なし』のみになること", () => {
      expect(additionalInstructionsFullText([null])).toBe("なし");
    });

    it("空配列でも『なし』になること", () => {
      expect(additionalInstructionsFullText([])).toBe("なし");
    });

    it("非null複数件は省略せず全文を『/』区切りで連結すること(30字省略はしない)", () => {
      const long = "あ".repeat(40);
      expect(additionalInstructionsFullText(["指示A", long])).toBe(
        `指示A / ${long}`,
      );
    });
  });

  describe("formatExclusionSummary(集計の除外内訳、Issue #152 B)", () => {
    const report = verifyReport({
      includedAnalysisCount: 11,
      excludedAnalysisCount: 12,
      supersededAnalysisCount: 13,
      excludedEstimatedCount: 14,
      excludedLookaheadSuspectCount: 15,
      excludedLookaheadUnknownCount: 16,
    });

    it("6つの内訳を、それぞれ自分のラベルで出すこと(件数は全部異なる値で、ラベルの取り違えを検出する)", () => {
      expect(formatExclusionSummary(report)).toBe(
        "集計11件 / 結果未取込で除外12件 / 旧分析除外13件 / 発売前推定のため除外14件" +
          " / リーク疑い(発走後に分析・先読み未遮断)のため除外15件 / 発走前後を判定できず除外16件",
      );
    });

    it("リーク疑いと発走前後判定不可は別のラベル・別の件数であること(入れ替えると別の文になる)", () => {
      const swapped = verifyReport({ excludedLookaheadSuspectCount: 16, excludedLookaheadUnknownCount: 15 });
      expect(formatExclusionSummary(swapped)).toContain("リーク疑い(発走後に分析・先読み未遮断)のため除外16件");
      expect(formatExclusionSummary(swapped)).toContain("発走前後を判定できず除外15件");
      expect(formatExclusionSummary(report)).not.toBe(formatExclusionSummary(swapped));
    });

    it("「判定不能」という語を使わないこと(proposedBet の「判定不能」と混同させない)", () => {
      expect(formatExclusionSummary(report)).not.toContain("判定不能");
    });

    it("除外が0件でも2項目を出すこと(フィルタが有効であることが分かる)", () => {
      const text = formatExclusionSummary(verifyReport());
      expect(text).toContain("リーク疑い(発走後に分析・先読み未遮断)のため除外0件");
      expect(text).toContain("発走前後を判定できず除外0件");
    });
  });

});
