import { describe, expect, it } from "vitest";
import type {
  AnalysisHistoryItem,
  CalibrationBinView,
  PromptVersionVerifyReportView,
  VerifyBetView,
  VerifyReportView,
} from "../src/shared/analysis-types.js";
import type { RaceBreakdownView } from "../src/shared/analysis-types.js";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  deleteUnknownPromptVersionConfirmMessage,
  deleteUnknownPromptVersionResultMessage,
  directionLabel,
  formatAdjustment,
  formatBinRange,
  formatFinishPosition,
  formatKaisaiDate,
  formatPayoutBreakdown,
  formatRate,
  formatYen,
  hasUnknownPromptVersionGroup,
  importButtonLabel,
  isRowImportDisabled,
  markLabel,
  needsImport,
  overconfidenceLabel,
  payoutSourceLabel,
  placedLabel,
  promptVersionLabel,
  raceBreakdownHeading,
  unknownPromptVersionAnalysisCount,
  venueFilterLabel,
} from "../src/renderer/verify-format.js";

/** テスト用の検証レポートを最小構成で組み立てる。 */
function verifyReport(over: Partial<VerifyReportView> = {}): VerifyReportView {
  return {
    includedAnalysisCount: 0,
    excludedAnalysisCount: 0,
    supersededAnalysisCount: 0,
    excludedEstimatedCount: 0,
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
    ...over,
  };
}

/** テスト用の版別レポート1件を最小構成で組み立てる。 */
function promptVersionReport(
  over: Partial<PromptVersionVerifyReportView> = {},
): PromptVersionVerifyReportView {
  return {
    promptVersion: null,
    report: verifyReport(),
    additionalInstructions: [],
    ...over,
  };
}

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

  describe("isRowImportDisabled(行単位の取込ボタンの無効化判定、Task#31 code-reviewer提案対応)", () => {
    it("その行が取込中なら無効化すること", () => {
      expect(isRowImportDisabled(true, false)).toBe(true);
    });
    it("一括取込が実行中なら、その行が取込中でなくても無効化すること", () => {
      expect(isRowImportDisabled(false, true)).toBe(true);
    });
    it("行取込中かつ一括取込中でも無効化すること", () => {
      expect(isRowImportDisabled(true, true)).toBe(true);
    });
    it("どちらでもなければ無効化しないこと", () => {
      expect(isRowImportDisabled(false, false)).toBe(false);
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

  describe("formatKaisaiDate(開催日の表示整形、Task#34)", () => {
    it("YYYYMMDDをYYYY/MM/DDに整形すること", () => {
      expect(formatKaisaiDate("20260708")).toBe("2026/07/08");
    });
    it("null(日付不明)は「日付不明」にすること", () => {
      expect(formatKaisaiDate(null)).toBe("日付不明");
    });
    it("YYYYMMDD形式でない不正値は素通しで表示すること(防御的フォールバック)", () => {
      expect(formatKaisaiDate("不正な値")).toBe("不正な値");
    });
  });

  describe("raceBreakdownHeading(レース別予実の見出し、Task#34)", () => {
    const base: Pick<RaceBreakdownView, "venueName" | "raceNumber" | "kaisaiDate"> = {
      venueName: "東京",
      raceNumber: 11,
      kaisaiDate: "20260708",
    };
    it("会場名・R番号・開催日の3点を含む見出しにすること", () => {
      expect(raceBreakdownHeading(base)).toBe("東京 11R (2026/07/08)");
    });
    it("開催日不明(null)は「日付不明」を含めること", () => {
      expect(raceBreakdownHeading({ ...base, kaisaiDate: null })).toBe(
        "東京 11R (日付不明)",
      );
    });
  });

  describe("formatFinishPosition(実着順の表示整形、Task#34)", () => {
    it("数値はそのまま「N着」にすること", () => {
      expect(formatFinishPosition(1)).toBe("1着");
      expect(formatFinishPosition(12)).toBe("12着");
    });
    it("null(着順不明・中止/除外)は「不明」にすること", () => {
      expect(formatFinishPosition(null)).toBe("不明");
    });
  });

  describe("placedLabel(複勝的中の表示整形、Task#34)", () => {
    it("trueは「的中」、falseは「不的中」にすること", () => {
      expect(placedLabel(true)).toBe("的中");
      expect(placedLabel(false)).toBe("不的中");
    });
    it("null(着順不明で判定不能)は「-」にすること", () => {
      expect(placedLabel(null)).toBe("-");
    });
  });

  describe("payoutSourceLabel(払戻算出根拠の表示整形、Task#34)", () => {
    it("actualは「実配当」、approximateは「近似」にすること", () => {
      expect(payoutSourceLabel("actual")).toBe("実配当");
      expect(payoutSourceLabel("approximate")).toBe("近似");
    });
    it("null(賭けていない・不的中)は「-」にすること", () => {
      expect(payoutSourceLabel(null)).toBe("-");
    });
  });

  describe("hasUnknownPromptVersionGroup(版不明グループの有無判定、Task#33)", () => {
    it("promptVersion=nullのグループが含まれていればtrueにすること", () => {
      const reports = [
        promptVersionReport({ promptVersion: "2026-07-14.1" }),
        promptVersionReport({ promptVersion: null }),
      ];
      expect(hasUnknownPromptVersionGroup(reports)).toBe(true);
    });

    it("版不明グループが無ければfalseにすること", () => {
      const reports = [promptVersionReport({ promptVersion: "2026-07-14.1" })];
      expect(hasUnknownPromptVersionGroup(reports)).toBe(false);
    });

    it("空配列(未取得・集計対象なし)はfalseにすること", () => {
      expect(hasUnknownPromptVersionGroup([])).toBe(false);
    });
  });

  describe("unknownPromptVersionAnalysisCount(版不明グループの分析件数、Task#33)", () => {
    it("版不明グループの4つの内訳(集計・結果未取込除外・旧分析除外・推定EV除外)の合計を返すこと", () => {
      const reports = [
        promptVersionReport({
          promptVersion: null,
          report: verifyReport({
            includedAnalysisCount: 3,
            excludedAnalysisCount: 2,
            supersededAnalysisCount: 1,
            excludedEstimatedCount: 4,
          }),
        }),
      ];
      // 3+2+1+4=10件がprompt_version=nullのanalyses総数(削除対象件数)と一致する。
      expect(unknownPromptVersionAnalysisCount(reports)).toBe(10);
    });

    it("版不明グループが無ければ0を返すこと", () => {
      const reports = [
        promptVersionReport({
          promptVersion: "2026-07-14.1",
          report: verifyReport({ includedAnalysisCount: 5 }),
        }),
      ];
      expect(unknownPromptVersionAnalysisCount(reports)).toBe(0);
    });

    it("空配列は0を返すこと", () => {
      expect(unknownPromptVersionAnalysisCount([])).toBe(0);
    });
  });

  describe("deleteUnknownPromptVersionConfirmMessage(削除確認メッセージ、Task#33 code-reviewer指摘対応)", () => {
    it("取り消せない旨・削除対象の内訳(旧データ+LLM未使用分析)・件数が概算表示である旨・件数を含むメッセージにすること", () => {
      expect(deleteUnknownPromptVersionConfirmMessage(5)).toBe(
        "取り消せません。版不明(版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析)" +
          "5件(画面表示時点)と関連馬データを削除します。よろしいですか?",
      );
    });

    it("0件でも同じ形式でメッセージを組み立てること", () => {
      expect(deleteUnknownPromptVersionConfirmMessage(0)).toBe(
        "取り消せません。版不明(版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析)" +
          "0件(画面表示時点)と関連馬データを削除します。よろしいですか?",
      );
    });
  });

  describe("deleteUnknownPromptVersionResultMessage(削除完了フィードバック、Task#33 code-reviewer指摘対応)", () => {
    it("削除対象の内訳(旧データ+LLM未使用分析)と削除件数を含む完了メッセージにすること", () => {
      expect(deleteUnknownPromptVersionResultMessage(3)).toBe(
        "版不明(版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析)3件を削除しました。",
      );
    });

    it("0件でも同じ形式でメッセージを組み立てること", () => {
      expect(deleteUnknownPromptVersionResultMessage(0)).toBe(
        "版不明(版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析)0件を削除しました。",
      );
    });
  });
});
