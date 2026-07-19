import { describe, expect, it } from "vitest";

import {
  formatEstimatedEvSuffix,
  formatEv,
  formatMark,
  formatOdds,
  formatOpportunityScore,
  formatPercent,
  formatReason,
  isHighlightRow,
  LABEL_ADJUSTED_PROB,
  LABEL_PRIOR,
  llmCorrectionStatusText,
  llmCorrectionTooltip,
  MARK_LEGEND,
  oddsStatusNote,
  raceHeading,
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
    evEstimated: false,
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

  it("予想オッズ(yoso)は発売前推定EVである旨+再分析の案内を返す(Task#25)", () => {
    expect(oddsStatusNote("yoso")).toBe(
      "発売前のため予想単勝オッズからの推定EV(発売後に再分析推奨)",
    );
  });
});

describe("formatEstimatedEvSuffix(推定EVの表記・Task#25)", () => {
  it("推定EV(evEstimated=true)のときは「(推定)」を返す", () => {
    expect(formatEstimatedEvSuffix(true)).toBe("(推定)");
  });

  it("確定EV(evEstimated=false)のときは空文字を返す", () => {
    expect(formatEstimatedEvSuffix(false)).toBe("");
  });
});

describe("raceHeading(レース見出しの組み立て・Task#29)", () => {
  it("会場名+レース番号+レース名を「会場名 NR レース名」の形式で組み立てること", () => {
    expect(
      raceHeading({
        venueName: "浦和",
        raceNumber: 11,
        raceName: "ランチタイム(C3)",
      }),
    ).toBe("浦和 11R ランチタイム(C3)");
  });

  it("レース名が空文字のときは会場名+レース番号だけになり、それでもレースを識別できること", () => {
    expect(
      raceHeading({ venueName: "浦和", raceNumber: 11, raceName: "" }),
    ).toBe("浦和 11R");
  });

  it("レース番号1桁でも「NR」の形式は変わらないこと", () => {
    expect(
      raceHeading({ venueName: "東京", raceNumber: 1, raceName: "3歳未勝利" }),
    ).toBe("東京 1R 3歳未勝利");
  });

  it("レース名が空白のみのときも会場名+レース番号だけになること(空文字と同様に扱う)", () => {
    expect(
      raceHeading({ venueName: "浦和", raceNumber: 11, raceName: "   " }),
    ).toBe("浦和 11R");
  });
});

describe("llmCorrectionStatusText(LLM補正状態の表示文言・A: フォールバック分離2026-07-19合意)", () => {
  // fallback(確率補正そのものをpriorに戻す)と marksDropped(確率補正は有効なまま印だけを
  // 諦める)は意味が異なるため、組み合わせごとに文言が区別されることをテーブル駆動で固定する。
  const cases: ReadonlyArray<{
    label: string;
    input: {
      llmUsed: boolean;
      llmSkippedReason: string | null;
      fallback: boolean;
      marksDropped?: boolean;
    };
    expected: string;
  }> = [
    {
      label: "LLMスキップ時はスキップ理由を表示すること",
      input: {
        llmUsed: false,
        llmSkippedReason: "APIキー未設定",
        fallback: false,
      },
      expected: "スキップ(APIキー未設定)",
    },
    {
      label: "LLMスキップ理由が無いときは「理由不明」と表示すること",
      input: { llmUsed: false, llmSkippedReason: null, fallback: false },
      expected: "スキップ(理由不明)",
    },
    {
      label: "実行・fallbackなし・marksDroppedなしは「実行」のみ",
      input: {
        llmUsed: true,
        llmSkippedReason: null,
        fallback: false,
        marksDropped: false,
      },
      expected: "実行",
    },
    {
      label: "実行・marksDropped未指定(optional省略)も「実行」のみ扱いにすること",
      input: { llmUsed: true, llmSkippedReason: null, fallback: false },
      expected: "実行",
    },
    {
      label: "実行・fallback:trueは「フェイルセーフで3着内率に復帰」",
      input: {
        llmUsed: true,
        llmSkippedReason: null,
        fallback: true,
        marksDropped: false,
      },
      expected: "実行(フェイルセーフで3着内率に復帰)",
    },
    {
      label:
        "実行・fallback:false かつ marksDropped:true は印だけ非表示である旨(fallbackとは別文言)",
      input: {
        llmUsed: true,
        llmSkippedReason: null,
        fallback: false,
        marksDropped: true,
      },
      expected: "実行(印: 制約不成立のため非表示。確率補正は有効)",
    },
    {
      label:
        "fallback:true が marksDropped:true より優先されること(fallbackは確率補正自体が無効なためより重大)",
      input: {
        llmUsed: true,
        llmSkippedReason: null,
        fallback: true,
        marksDropped: true,
      },
      expected: "実行(フェイルセーフで3着内率に復帰)",
    },
  ];
  it.each(cases)("$label", ({ input, expected }) => {
    expect(llmCorrectionStatusText(input)).toBe(expected);
  });
});

describe("llmCorrectionTooltip(「LLM補正:」行tooltipの理由文言・論点C: fallbackReasonのUI伝播)", () => {
  // fallback:true(確率補正自体が無効)を marksDropped:true(印だけ非表示)より優先する点は
  // llmCorrectionStatusText と同じ優先順位。理由が無ければ title 属性を付けない(undefined)。
  const cases: ReadonlyArray<{
    label: string;
    input: {
      fallback: boolean;
      fallbackReason: string | null;
      marksDropped?: boolean;
      marksDroppedReason?: string | null;
    };
    expected: string | undefined;
  }> = [
    {
      label: "fallback:true・fallbackReasonありならその理由を返すこと",
      input: {
        fallback: true,
        fallbackReason: "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました",
      },
      expected: "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました",
    },
    {
      label: "fallback:false・marksDropped:true・marksDroppedReasonありならその理由を返すこと(従来どおり)",
      input: {
        fallback: false,
        fallbackReason: null,
        marksDropped: true,
        marksDroppedReason: "印関連の制約違反のため確率補正のみ採用",
      },
      expected: "印関連の制約違反のため確率補正のみ採用",
    },
    {
      label: "fallback:true が marksDropped:true より優先されること(fallbackの理由を優先表示)",
      input: {
        fallback: true,
        fallbackReason: "LLM呼び出しに失敗したため、3着内率をそのまま採用しました",
        marksDropped: true,
        marksDroppedReason: "印関連の制約違反のため確率補正のみ採用",
      },
      expected: "LLM呼び出しに失敗したため、3着内率をそのまま採用しました",
    },
    {
      label: "fallback:false・marksDropped:falseなら理由なし(title属性を付けない)",
      input: { fallback: false, fallbackReason: null, marksDropped: false },
      expected: undefined,
    },
    {
      label: "fallback:false・marksDropped未指定(optional省略)も理由なし",
      input: { fallback: false, fallbackReason: null },
      expected: undefined,
    },
  ];
  it.each(cases)("$label", ({ input, expected }) => {
    expect(llmCorrectionTooltip(input)).toBe(expected);
  });
});
