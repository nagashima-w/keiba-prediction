import { describe, expect, it } from "vitest";
import {
  buildPreviousDiff,
  DIFF_PROB_MIN_POINTS,
  DIFF_PROB_ROW_LIMIT,
  NO_CHANGE_LINE,
  type DiffCurrent,
  type DiffPrevious,
} from "../src/analysis-diff-view";
import type { AnalysisViewAllocation } from "../src/analysis-view";

/** Issue #583: 前の分析との差(サーバで日本語の行まで組み立てる純関数)。 */

type H = DiffCurrent["horses"][number];

const horse = (umaban: number, over: Partial<H> = {}): H => ({ umaban, name: `馬${umaban}`, mark: null, prior: 0.3, adjustedProb: 0.3, ...over });

const alloc = (bets: AnalysisViewAllocation["bets"], over: Partial<AnalysisViewAllocation> = {}): AnalysisViewAllocation => ({
  route: "ok",
  skipReasonCode: null,
  unavailableReason: null,
  fallbackReason: null,
  betUnit: 100,
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.1,
  includeComboOdds: false,
  includeWide: true,
  includeTrio: true,
  includeQuinella: true,
  includeExacta: true,
  includeTrifecta: true,
  includeBracketQuinella: true,
  maxWinBets: null,
  maxPlaceBets: null,
  oddsStatus: "result",
  bets,
  ...over,
});

const bet = (betType: string, comboKey: string, stake: number) => ({ betType, comboKey, stake, odds: 2, ev: 1.2 });

const AI = { model: "claude-x", llmNote: null };
const NOAI = { model: null, llmNote: null };

const cur = (over: Partial<DiffCurrent> = {}): DiffCurrent => ({ ...AI, horses: [horse(1), horse(2)], allocation: alloc([bet("place", "01", 500)]), ...over });
const prev = (over: Partial<DiffPrevious> = {}): DiffPrevious => ({
  id: 7,
  analyzedAt: "2026-11-09T01:30:00.000Z", // JST 10:30
  ...AI,
  horses: [horse(1), horse(2)],
  allocation: alloc([bet("place", "01", 500)]),
  ...over,
});

describe("buildPreviousDiff: 見出しとリンク", () => {
  it("前の分析の id と、JST の日時つきの見出しを返す", () => {
    const d = buildPreviousDiff(cur(), prev());
    expect(d.previousId).toBe(7);
    expect(d.title).toBe("前の分析(11/9 10:30)との差");
  });
});

describe("buildPreviousDiff: 何も変わらないとき", () => {
  it("「変わったところはありません」だけを返す", () => {
    expect(buildPreviousDiff(cur(), prev()).lines).toEqual([NO_CHANGE_LINE]);
    expect(NO_CHANGE_LINE).toBe("変わったところはありません");
  });
});

describe("buildPreviousDiff: 印", () => {
  it("印が変わった馬だけを馬番順に出す(馬名つき)。変わらない馬は出さない", () => {
    const c = cur({ horses: [horse(1, { mark: "◎" }), horse(2, { mark: "○" }), horse(3, { mark: "▲" })] });
    const p = prev({ horses: [horse(1, { mark: "○" }), horse(2, { mark: "○" }), horse(3, { mark: null })] });
    const lines = buildPreviousDiff(c, p).lines;
    expect(lines).toEqual(["印 1番 馬1: ○ → ◎", "印 3番 馬3: なし → ▲"]);
  });

  it("馬名が無い(詳細なし)ときは馬番だけ", () => {
    const c = cur({ horses: [horse(1, { name: null, mark: "◎" })] });
    const p = prev({ horses: [horse(1, { mark: null })] });
    expect(buildPreviousDiff(c, p).lines).toEqual(["印 1番: なし → ◎"]);
  });
});

describe("buildPreviousDiff: 買い目と金額", () => {
  it("追加・削除・金額の変化の点数と、主な行を出す", () => {
    const p = prev({ allocation: alloc([bet("place", "01", 500), bet("place", "02", 300), bet("win", "03", 200)]) });
    const c = cur({ allocation: alloc([bet("place", "01", 800), bet("win", "03", 200), bet("place", "04", 100)]) });
    const lines = buildPreviousDiff(c, p).lines;
    // 前提: 3 種の変化がそれぞれ 1 点ずつあること
    expect(lines[0]).toContain("追加 1点・削除 1点・金額の変化 1点");
    expect(lines.filter((l) => l.startsWith("　")).length).toBe(3);
    expect(lines.some((l) => l.includes("追加") && l.includes("100円"))).toBe(true);
    expect(lines.some((l) => l.includes("削除") && l.includes("300円"))).toBe(true);
    expect(lines.some((l) => l.includes("変化") && l.includes("500円→800円"))).toBe(true);
  });

  it("賭け金が同じでオッズ・期待値だけが違う買い目は、変化に数えない", () => {
    const p = prev({ allocation: alloc([{ betType: "place", comboKey: "01", stake: 500, odds: 2, ev: 1.2 }]) });
    const c = cur({ allocation: alloc([{ betType: "place", comboKey: "01", stake: 500, odds: 3.5, ev: 1.9 }]) });
    expect(buildPreviousDiff(c, p).lines).toEqual([NO_CHANGE_LINE]);
  });

  it("前の分析に配分の記録が無いときは、全部を「追加」とせず、記録が無い旨を出す", () => {
    const c = cur({ allocation: alloc([bet("place", "01", 500), bet("win", "02", 200)]) });
    const lines = buildPreviousDiff(c, prev({ allocation: null })).lines;
    expect(lines).toContain("買い目 前の分析には配分の記録がありません");
    expect(lines.some((l) => l.includes("追加"))).toBe(false);
  });

  it("今回の分析に配分の記録が無いときは、全部を「削除」とせず、記録が無い旨を出す", () => {
    const p = prev({ allocation: alloc([bet("place", "01", 500)]) });
    const lines = buildPreviousDiff(cur({ allocation: null }), p).lines;
    expect(lines).toContain("買い目 今回の分析には配分の記録がありません");
    expect(lines.some((l) => l.includes("削除"))).toBe(false);
  });

  it("両方とも配分の記録が無いときは、買い目の行を出さない", () => {
    expect(buildPreviousDiff(cur({ allocation: null }), prev({ allocation: null })).lines).toEqual([NO_CHANGE_LINE]);
  });

  it("前も今回も買い目 0 点(記録はある)なら、買い目の行を出さない", () => {
    expect(buildPreviousDiff(cur({ allocation: alloc([]) }), prev({ allocation: alloc([]) })).lines).toEqual([NO_CHANGE_LINE]);
  });
});

describe("buildPreviousDiff: 設定の違い", () => {
  const settingCases: ReadonlyArray<readonly [string, Partial<AnalysisViewAllocation>]> = [
    ["bankroll", { bankroll: 20000 }],
    ["perRaceCap", { perRaceCap: 5000 }],
    ["evThreshold", { evThreshold: 1.3 }],
    ["includeComboOdds", { includeComboOdds: true }],
    ["includeWide", { includeWide: false }],
    ["includeTrio", { includeTrio: false }],
    ["includeQuinella", { includeQuinella: false }],
    ["includeExacta", { includeExacta: false }],
    ["includeTrifecta", { includeTrifecta: false }],
    ["includeBracketQuinella", { includeBracketQuinella: false }],
  ];
  it.each(settingCases)("%s が違うと「設定が前の分析と違います」を出す", (_name, over) => {
    const c = cur({ allocation: alloc([bet("place", "01", 500)], over) });
    // 前提: 設定以外(買い目)は同じなので、他の行は変化なしだけ
    expect(buildPreviousDiff(c, prev()).lines).toEqual([NO_CHANGE_LINE, "設定が前の分析と違います"]);
  });

  it("設定が同じなら出さない", () => {
    expect(buildPreviousDiff(cur(), prev()).lines).not.toContain("設定が前の分析と違います");
  });
});

describe("buildPreviousDiff: 3着内率", () => {
  it("閾値の定数は 1.0 ポイント・最大 5 頭", () => {
    expect(DIFF_PROB_MIN_POINTS).toBe(1.0);
    expect(DIFF_PROB_ROW_LIMIT).toBe(5);
  });

  it("補正後が閾値以上動いた馬だけを、動きの大きい順に出す。統計モデルも添える", () => {
    const c = cur({ horses: [horse(1, { adjustedProb: 0.355, prior: 0.33 }), horse(2, { adjustedProb: 0.4, prior: 0.2 }), horse(3, { adjustedProb: 0.2005, prior: 0.2 })] });
    const p = prev({ horses: [horse(1, { adjustedProb: 0.28, prior: 0.312 }), horse(2, { adjustedProb: 0.395, prior: 0.2 }), horse(3, { adjustedProb: 0.2, prior: 0.2 })] });
    const lines = buildPreviousDiff(c, p).lines;
    // 馬2 は +0.5pt、馬3 は +0.05pt なので出ない。馬1 だけ(+7.5pt)
    expect(lines).toEqual(["3着内率 1番 馬1: 補正後 28.0% → 35.5%(+7.5)・統計 31.2% → 33.0%(+1.8)"]);
  });

  it("ちょうど 1.0 ポイントは出す(浮動小数点の誤差で落とさない)。0.9 は出さない", () => {
    const c = cur({ horses: [horse(1, { adjustedProb: 0.29 }), horse(2, { adjustedProb: 0.309 })] });
    const p = prev({ horses: [horse(1, { adjustedProb: 0.28 }), horse(2, { adjustedProb: 0.3 })] });
    const lines = buildPreviousDiff(c, p).lines;
    expect(lines.filter((l) => l.startsWith("3着内率")).length).toBe(1);
    expect(lines.some((l) => l.includes("1番") && l.includes("(+1.0)"))).toBe(true);
  });

  it("下がった馬は負の符号つきで出す", () => {
    const c = cur({ horses: [horse(1, { adjustedProb: 0.2 })] });
    const p = prev({ horses: [horse(1, { adjustedProb: 0.3 })] });
    expect(buildPreviousDiff(c, p).lines[0]).toContain("(-10.0)");
  });

  it("5 頭を超えたぶんは「ほか N頭」にまとめる", () => {
    const nums = [1, 2, 3, 4, 5, 6, 7];
    const c = cur({ horses: nums.map((n) => horse(n, { adjustedProb: 0.3 + n * 0.01 })) });
    const p = prev({ horses: nums.map((n) => horse(n, { adjustedProb: 0.3 })) });
    const rows = buildPreviousDiff(c, p).lines.filter((l) => l.startsWith("3着内率"));
    // 前提: 動いたのは 7 頭(各 +1.0〜+7.0)。出す行は 5 頭+「ほか 2頭」
    expect(rows.length).toBe(DIFF_PROB_ROW_LIMIT + 1);
    expect(rows[0]).toContain("7番");
    expect(rows[4]).toContain("3番");
    expect(rows[5]).toBe("3着内率 ほか 2頭");
  });

  it("どちらかが AI なしなら、補正後は出さず注記を 1 行。統計モデルの動きは出す", () => {
    const c = cur({ ...NOAI, horses: [horse(1, { prior: 0.35, adjustedProb: 0.35 })] });
    const p = prev({ horses: [horse(1, { prior: 0.3, adjustedProb: 0.5 })] });
    const lines = buildPreviousDiff(c, p).lines;
    expect(lines).toContain("3着内率 1番 馬1: 統計 30.0% → 35.0%(+5.0)");
    expect(lines.some((l) => l.includes("補正後 "))).toBe(false);
    expect(lines).toContain("AI を使っていない分析(今回の分析)があるため、補正後の比較は省きます");
  });

  it("AI なしの比較では、統計モデルの動きで馬を選ぶ(補正後だけが動いた馬は出さず、統計モデルが動いた馬は出す)", () => {
    const c = cur({ ...NOAI, horses: [horse(1, { prior: 0.3, adjustedProb: 0.5 }), horse(2, { prior: 0.4, adjustedProb: 0.3 })] });
    const p = prev({ horses: [horse(1, { prior: 0.3, adjustedProb: 0.3 }), horse(2, { prior: 0.3, adjustedProb: 0.3 })] });
    const rows = buildPreviousDiff(c, p).lines.filter((l) => l.startsWith("3着内率"));
    // 前提: 馬1 は補正後だけが +20pt 動き、馬2 は統計モデルだけが +10pt 動いている
    expect(rows).toEqual(["3着内率 2番 馬2: 統計 30.0% → 40.0%(+10.0)"]);
  });

  it("前の分析が AI なし(llmNote あり)でも同様。両方なら両方を名指しする", () => {
    const p = prev({ model: "claude-x", llmNote: "キー未登録", horses: [horse(1)] });
    expect(buildPreviousDiff(cur({ ...NOAI }), p).lines).toContain("AI を使っていない分析(前の分析・今回の分析)があるため、補正後の比較は省きます");
    expect(buildPreviousDiff(cur(), p).lines).toContain("AI を使っていない分析(前の分析)があるため、補正後の比較は省きます");
  });
});

describe("buildPreviousDiff: 馬の集合が違うとき", () => {
  it("両方にいる馬だけ比べ、片方にだけいる馬の数を 1 行で出す", () => {
    const c = cur({ horses: [horse(1, { mark: "◎" }), horse(2), horse(9, { mark: "▲", adjustedProb: 0.9 })] });
    const p = prev({ horses: [horse(1, { mark: "○" }), horse(2), horse(3, { mark: "◎" }), horse(4)] });
    const lines = buildPreviousDiff(c, p).lines;
    expect(lines).toContain("前にだけ 2頭・今回にだけ 1頭(両方にいる馬だけ比べます)");
    // 片方にだけいる馬(3・4・9)は印・確率の行に出ない
    expect(lines.filter((l) => /^(印|3着内率)/.test(l))).toEqual(["印 1番 馬1: ○ → ◎"]);
  });
});
