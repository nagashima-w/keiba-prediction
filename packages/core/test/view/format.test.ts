import { describe, expect, it } from "vitest";

import {
  formatEstimatedEvSuffix,
  formatEv,
  formatMarkRepair,
  MARK_ORIGIN_VALUES,
  MARK_REPAIRED_BADGE,
  formatOdds,
  formatPercent,
  LABEL_ADJUSTED_PROB,
  LABEL_CONCERNS,
  LABEL_HIGHLIGHTS,
  LABEL_PRIOR,
  analysisModelText,
  MARK_LEGEND,
  oddsStatusNote,
} from "../../src/view/format.js";
import { PREDICTION_MARKS } from "../../src/analyzer/parse-response.js";

describe("表示ラベル(prior→3着内率 / 補正後→AI補正後 の統一)", () => {
  it("prior 列のラベルは「3着内率」", () => {
    expect(LABEL_PRIOR).toBe("3着内率");
  });
  it("補正後 列のラベルは「AI補正後」", () => {
    expect(LABEL_ADJUSTED_PROB).toBe("AI補正後");
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

describe("analysisModelText(分析結果の「分析モデル」表示文言・Issue #157)", () => {
  const cases: ReadonlyArray<{
    label: string;
    input: { llmUsed: boolean; model?: string | null };
    expected: string | null;
  }> = [
    {
      label: "LLM実行・モデルあり: 「分析モデル: <ID>」を返すこと",
      input: { llmUsed: true, model: "claude-sonnet-5-5" },
      expected: "分析モデル: claude-sonnet-5-5",
    },
    {
      label: "自動選択された別モデルもそのまま表示すること",
      input: { llmUsed: true, model: "claude-sonnet-9-9" },
      expected: "分析モデル: claude-sonnet-9-9",
    },
    {
      label: "LLM実行でもモデル不明(null)なら行を出さないこと",
      input: { llmUsed: true, model: null },
      expected: null,
    },
    {
      label: "LLM実行でも model 未設定(旧データ・リテラル)なら行を出さないこと",
      input: { llmUsed: true },
      expected: null,
    },
    {
      label: "LLMスキップ時はモデルが入っていても行を出さないこと(偽値表示の防止)",
      input: { llmUsed: false, model: "claude-sonnet-5-5" },
      expected: null,
    },
    {
      label: "空文字のモデルは行を出さないこと",
      input: { llmUsed: true, model: "" },
      expected: null,
    },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(analysisModelText(input)).toBe(expected);
  });
});

describe("強調材料・懸念事項のラベル(Issue #199。cloud と共有する定数)", () => {
  it("強調材料・懸念事項の文言は、cloud の画面と同じ「強調材料」「懸念事項」", () => {
    expect(LABEL_HIGHLIGHTS).toBe("強調材料");
    expect(LABEL_CONCERNS).toBe("懸念事項");
  });
});

describe("formatMarkRepair(印の補修の表示「元の印→今の印」。Issue #317)", () => {
  it.each([
    ["◎", "〇", "◎→〇"],
    ["▲", "〇", "▲→〇"],
    ["☆", null, "☆→印なし"],
    ["なし", "◎", "印なし→◎"],
    ["不明", null, "不明な印→印なし"],
    ["不明", "◎", "不明な印→◎"],
  ] as const)("%s → %s は「%s」", (from, to, expected) => {
    expect(formatMarkRepair(from, to)).toBe(expected);
  });

  it("目印の文字は「直」", () => {
    expect(MARK_REPAIRED_BADGE).toBe("直");
  });

  it("補修前の印の語彙は、既知の6種 + 「なし」+「不明」の8つ(core の PREDICTION_MARKS と一致する6種を含む)", () => {
    expect(MARK_ORIGIN_VALUES).toEqual(["◎", "〇", "▲", "△", "☆", "注", "なし", "不明"]);
    expect(MARK_ORIGIN_VALUES.slice(0, 6)).toEqual([...PREDICTION_MARKS]);
  });
});
