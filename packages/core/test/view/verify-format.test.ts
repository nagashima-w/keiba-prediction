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
  exclusionRows,
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

/**
 * Issue #397(R-3): クラウド版の検証画面(`cloud/client`)の整形を、この core の実装 1 本に統合した。
 * 統合前は `cloud/client/verify-format.ts` に同名・同出力の関数が複製されており、`scripts/test/cloud-verify-format.test.ts` が 2 つの出力の一致を固定していた。
 * 実装が 1 つになれば一致は構造的に保証されるので、そのテストは消した。**そのテストが持っていた境界値の表だけを、ここへ期待値の直書き(golden)にして移した**
 * (「2 つが同じ」ではなく「この入力ならこの文字列」を固定する。統合前の client 版・core 版の両方の出力と一致することを、移す前に確かめた)。
 */
describe("境界値の golden(#397 R-3。旧 cloud-verify-format.test.ts の表を引き継ぐ)", () => {
  it.each([
    [null, "-"],
    [0, "0.0%"],
    [0.0004, "0.0%"],
    [0.05, "5.0%"],
    [0.9603846, "96.0%"],
    [1, "100.0%"],
    [1.0525, "105.3%"],
    [2.25, "225.0%"],
    [12.3456, "1234.6%"],
  ] as const)("formatRate(%s) は %s", (rate, expected) => {
    expect(formatRate(rate)).toBe(expected);
  });

  it.each([
    [0, "0円"],
    [1, "1円"],
    [999, "999円"],
    [1000, "1,000円"],
    [1060, "1,060円"],
    [123456, "123,456円"],
    [1234567, "1,234,567円"],
    [4994.5, "4,994.5円"],
  ] as const)("formatYen(%s) は %s", (amount, expected) => {
    expect(formatYen(amount)).toBe(expected);
  });

  // 符号・0・-0・丸めの境目(0.00049 は +0.0、0.0005 は +0.1)。-0.0004 は「-0.0pt」になる(符号は値の符号で付き、丸めた結果の 0 でも消えない)。
  it.each([
    [null, "-"],
    [0, "+0.0pt"],
    [-0, "+0.0pt"],
    [0.052, "+5.2pt"],
    [-0.031, "-3.1pt"],
    [0.0004, "+0.0pt"],
    [-0.0004, "-0.0pt"],
    [0.00049, "+0.0pt"],
    [0.0005, "+0.1pt"],
    [0.005, "+0.5pt"],
    [-0.005, "-0.5pt"],
    [0.1234, "+12.3pt"],
    [1, "+100.0pt"],
    [-1, "-100.0pt"],
  ] as const)("formatAdjustment(%s) は %s", (value, expected) => {
    expect(formatAdjustment(value)).toBe(expected);
  });

  it.each([
    [null, "-"],
    [0, "一致"],
    [-0, "一致"],
    [0.0001, "過信"],
    [-0.0001, "過小評価"],
    [0.2, "過信"],
    [-0.2, "過小評価"],
  ] as const)("overconfidenceLabel(%s) は %s", (gap, expected) => {
    expect(overconfidenceLabel(gap)).toBe(expected);
  });

  it.each([
    ["◎", "◎"],
    ["〇", "〇"],
    ["▲", "▲"],
    ["△", "△"],
    ["☆", "☆"],
    ["注", "注"],
    [null, "印なし"],
  ] as const)("markLabel(%s) は %s", (mark, expected) => {
    expect(markLabel(mark)).toBe(expected);
  });

  it("directionLabel は 3 方向で互いに異なるラベルになる", () => {
    const labels = (["raised", "lowered", "unchanged"] as const).map((d) => directionLabel(d));
    expect(labels).toEqual(["上げ", "下げ", "据え置き"]);
    expect(new Set(labels).size).toBe(3);
  });

  it("formatBinRange は 20 帯(i/20〜(i+1)/20)すべてで、5% 刻みの別々のラベルになる", () => {
    const bins = Array.from({ length: 20 }, (_, i) => ({ lowerBound: i / 20, upperBound: (i + 1) / 20, predictedCount: 0, placedCount: 0, actualPlaceRate: null }));
    expect(bins).toHaveLength(20);
    const labels = bins.map((bin) => formatBinRange(bin));
    expect(labels).toEqual([
      "0〜5%", "5〜10%", "10〜15%", "15〜20%", "20〜25%", "25〜30%", "30〜35%", "35〜40%", "40〜45%", "45〜50%",
      "50〜55%", "55〜60%", "60〜65%", "65〜70%", "70〜75%", "75〜80%", "80〜85%", "85〜90%", "90〜95%", "95〜100%",
    ]);
    expect(new Set(labels).size).toBe(20);
  });

  it.each([
    [null, 0],
    [0, 0],
    [0.0001, 0.01],
    [0.417, 41.699999999999996],
    [0.5, 50],
    [1, 100],
  ] as const)("calibrationBarWidthPercent(%s) は %s", (rate, expected) => {
    expect(calibrationBarWidthPercent(rate)).toBe(expected);
  });

  it.each([
    [null, "版不明"],
    ["2026-10-09.2", "2026-10-09.2"],
    ["2026-10-09.2-clip015", "2026-10-09.2-clip015"],
    ["", ""],
  ] as const)("promptVersionLabel(%j) は %j", (version, expected) => {
    expect(promptVersionLabel(version)).toBe(expected);
  });

  describe("追加指示の要約・全文・見出し(30 文字の境目・null・空配列・極端に長い文)", () => {
    const long30 = "あ".repeat(30);
    const long31 = "あ".repeat(31);
    const huge = "x".repeat(2000);
    const cases: ReadonlyArray<{ readonly name: string; readonly list: readonly (string | null)[]; readonly summary: string; readonly full: string }> = [
      { name: "空配列", list: [], summary: "なし", full: "なし" },
      { name: "[null]", list: [null], summary: "なし", full: "なし" },
      { name: "短い 1 件", list: ["指示A"], summary: "指示A", full: "指示A" },
      { name: "ちょうど 30 文字は切らない", list: [long30], summary: long30, full: long30 },
      { name: "31 文字は 30 文字+「…」に切る(全文は切らない)", list: [long31], summary: `${long30}…`, full: long31 },
      { name: "指示と null の混在", list: ["b指示", null], summary: "b指示 / なし", full: "b指示 / なし" },
      { name: "3 件", list: ["a", "b", "c"], summary: "a / b / c", full: "a / b / c" },
      { name: "null と 2000 文字", list: [null, huge], summary: `なし / ${"x".repeat(30)}…`, full: `なし / ${huge}` },
    ];
    expect(cases).toHaveLength(8);

    it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(additionalInstructionsSummary(c.list)).toBe(c.summary);
      expect(additionalInstructionsFullText(c.list)).toBe(c.full);
      expect(promptVersionCalibrationHeading(null, c.list)).toBe(`版不明 (追加指示: ${c.summary})`);
      expect(promptVersionCalibrationHeading("2026-10-09.2", c.list)).toBe(`2026-10-09.2 (追加指示: ${c.summary})`);
    });
  });

  it("formatUnknownBetTypeNotice: 券種コードが空配列でも、点数と賭け金合計の文を出す(0 点だけが null)", () => {
    expect(formatUnknownBetTypeNotice({ count: 1, totalStake: 1234567, betTypes: [] })).toBe(
      "未対応の券種コード()の買い目が1点 (賭け金合計1,234,567円)あり、回収率の集計から除外しています。",
    );
  });

  // exclusionRows は #397 R-3 で cloud/client から core へ移した。formatExclusionSummary はこの行を ` / ` で連ねたもの(文言の定義は 1 か所)。
  describe("exclusionRows(集計の内訳の行)", () => {
    const counts = {
      includedAnalysisCount: 11,
      excludedAnalysisCount: 12,
      supersededAnalysisCount: 13,
      excludedEstimatedCount: 14,
      excludedLookaheadSuspectCount: 15,
      excludedLookaheadUnknownCount: 16,
    };

    it("6 項目が、この順序・このラベル・自分の件数で並ぶ(件数は全部異なる値で、ラベルの取り違えを検出する)", () => {
      expect(exclusionRows(counts)).toEqual([
        { label: "集計", value: "11件" },
        { label: "結果未取込で除外", value: "12件" },
        { label: "旧分析除外", value: "13件" },
        { label: "発売前推定のため除外", value: "14件" },
        { label: "リーク疑い(発走後に分析・先読み未遮断)のため除外", value: "15件" },
        { label: "発走前後を判定できず除外", value: "16件" },
      ]);
    });

    it("`label+value` を ` / ` で連ねたものが formatExclusionSummary と一致する(前提: 6 項目・件数が 0 でない)", () => {
      const rows = exclusionRows(counts);
      expect(rows).toHaveLength(6);
      const report = verifyReport(counts);
      const joined = rows.map((r) => `${r.label}${r.value}`).join(" / ");
      expect(joined).toBe(formatExclusionSummary(report));
      expect(joined).toContain("15件");
    });
  });
});
