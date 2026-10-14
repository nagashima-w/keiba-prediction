/**
 * 強調材料(highlights)・懸念事項(concerns)の解析の純関数テスト(Issue #197・#196-a)。
 *
 * ゲートの決定(Issue #196 のコメント 2026-10-07):
 *  - 欠落・配列でない値は `[]`。文字列でない要素と空(trim 後)の要素は捨て、trim した値を保存する。
 *  - 4項目以上は、**空を除いたあとに**先頭3つに切る。1項目の長さ(全角30字)は解析では切らない(プロンプトの指示のみ)。
 *  - place_prob が欠落・不正で prior を採用した馬(usedPrior:true)は、reason と同じく `[]`。
 *  - 分析は止めない: clippedCount・missingCount・usedPrior・fallback の判定に影響させない。
 *  - 印の制約違反の救済(AnalyzerMarkViolationError が運ぶ horses)でも、この2つは保持する。
 */

import { describe, expect, it } from "vitest";
import {
  AnalyzerMarkViolationError,
  parseAnalyzerResponse,
  type PriorRef,
} from "../../src/analyzer/parse-response.js";

const priors: PriorRef[] = [
  { umaban: 1, prior: 0.4 },
  { umaban: 2, prior: 0.2 },
  // 印の頭数制約(◎〇▲△)を満たすための埋め合わせ馬。
  { umaban: 3, prior: 0.3 },
  { umaban: 4, prior: 0.3 },
  { umaban: 5, prior: 0.3 },
  { umaban: 6, prior: 0.3 },
];

/** 印制約の埋め合わせ馬(3〜6番)。highlights/concerns は付けない(キー欠落)。 */
function fillers(): unknown[] {
  return [
    { number: 3, place_prob: 0.3, reason: "filler", mark: "◎" },
    { number: 4, place_prob: 0.3, reason: "filler", mark: "〇" },
    { number: 5, place_prob: 0.3, reason: "filler", mark: "▲" },
    { number: 6, place_prob: 0.3, reason: "filler", mark: "△" },
  ];
}

function bodyOf(horses: unknown[]): string {
  return JSON.stringify({ horses });
}

/** 馬1にだけ highlights / concerns の生の値を与えたレスポンスを解析し、馬1の結果を返す。 */
function parseHorse1(extra: Record<string, unknown>): {
  highlights: readonly string[];
  concerns: readonly string[];
} {
  const text = bodyOf([{ number: 1, place_prob: 0.45, reason: "調教良化", ...extra }, ...fillers()]);
  const h = parseAnalyzerResponse(text, priors).horses.find((x) => x.umaban === 1)!;
  return { highlights: h.highlights, concerns: h.concerns };
}

describe("highlights / concerns の解析(正常系)", () => {
  it("配列の文字列要素をそのまま取り込み、reason・確率の解析に影響しないこと", () => {
    const text = bodyOf([
      { number: 1, place_prob: 0.45, reason: "調教良化", highlights: ["追い切り好時計", "内枠有利"], concerns: ["距離延長"] },
      { number: 2, place_prob: 0.15, reason: "展開不利", highlights: [], concerns: [] },
      ...fillers(),
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h1.highlights).toEqual(["追い切り好時計", "内枠有利"]);
    expect(h1.concerns).toEqual(["距離延長"]);
    expect(h1.reason).toBe("調教良化");
    expect(h1.adjustedProb).toBeCloseTo(0.45, 10);
    expect(h2.highlights).toEqual([]);
    expect(h2.concerns).toEqual([]);
  });
});

describe("highlights / concerns の解析(欠落・形違い・整形。表駆動)", () => {
  // 各ケースは highlights に与える生の値。concerns にも同じ値を与えて、両方が同じ規則で解析されることを固定する。
  const cases: ReadonlyArray<{ label: string; raw: unknown; missingKey?: boolean; expected: string[] }> = [
    { label: "キー自体が無い", raw: undefined, missingKey: true, expected: [] },
    { label: "null", raw: null, expected: [] },
    { label: "文字列(配列でない)", raw: "強い", expected: [] },
    { label: "数値(配列でない)", raw: 3, expected: [] },
    { label: "オブジェクト(配列でない)", raw: { a: "b" }, expected: [] },
    { label: "空配列", raw: [], expected: [] },
    { label: "文字列でない要素(数値・null・真偽・オブジェクト・配列)は捨てる", raw: [1, null, true, { a: 1 }, ["x"], "残る"], expected: ["残る"] },
    { label: "空文字・空白だけの要素は捨てる", raw: ["", "   ", "\n\t", "残る"], expected: ["残る"] },
    { label: "前後の空白は trim した値を保存する(全角空白を含む)", raw: ["  内枠有利 ", "　距離延長　"], expected: ["内枠有利", "距離延長"] },
    { label: "ちょうど3項目はそのまま", raw: ["a", "b", "c"], expected: ["a", "b", "c"] },
    { label: "4項目は先頭3つに切る", raw: ["a", "b", "c", "d"], expected: ["a", "b", "c"] },
    { label: "空を除いたあとに切る(先頭の空・非文字列で枠を消費しない)", raw: ["", 5, "a", "  ", "b", "c", "d"], expected: ["a", "b", "c"] },
    { label: "全角30字を超える項目も、解析では切らない", raw: ["あ".repeat(45)], expected: ["あ".repeat(45)] },
  ];

  it.each(cases)("$label", ({ raw, missingKey, expected }) => {
    const extra: Record<string, unknown> = missingKey === true ? {} : { highlights: raw, concerns: raw };
    const r = parseHorse1(extra);
    expect(r.highlights).toEqual(expected);
    expect(r.concerns).toEqual(expected);
  });

  it("highlights だけ・concerns だけが欠けても、もう一方は取り込む(独立に解析する)", () => {
    const onlyH = parseHorse1({ highlights: ["a"] });
    const onlyC = parseHorse1({ concerns: ["b"] });
    expect(onlyH).toEqual({ highlights: ["a"], concerns: [] });
    expect(onlyC).toEqual({ highlights: [], concerns: ["b"] });
  });

  it("highlights と concerns は混ざらない(それぞれ自分のキーを読む)", () => {
    expect(parseHorse1({ highlights: ["強み"], concerns: ["弱み"] })).toEqual({ highlights: ["強み"], concerns: ["弱み"] });
  });
});

describe("highlights / concerns は分析の判定に影響しない", () => {
  it("形が壊れていても、clippedCount・missingCount・usedPrior は項目なしのときと同じ", () => {
    const withoutItems = bodyOf([{ number: 1, place_prob: 0.9, reason: "x" }, { number: 2, place_prob: 0.2, reason: "y" }, ...fillers()]);
    const withBroken = bodyOf([
      { number: 1, place_prob: 0.9, reason: "x", highlights: "壊れ", concerns: { a: 1 } },
      { number: 2, place_prob: 0.2, reason: "y", highlights: [1, null], concerns: [""] },
      ...fillers(),
    ]);
    const a = parseAnalyzerResponse(withoutItems, priors);
    const b = parseAnalyzerResponse(withBroken, priors);
    // 前提: 馬1は +0.10 を超えるのでクリップされている(クリップ判定が実際に走っている)。
    expect(a.clippedCount).toBe(1);
    expect(b.clippedCount).toBe(a.clippedCount);
    expect(b.missingCount).toBe(a.missingCount);
    expect(b.horses.map((h) => [h.umaban, h.adjustedProb, h.clipped, h.usedPrior, h.reason, h.mark])).toEqual(
      a.horses.map((h) => [h.umaban, h.adjustedProb, h.clipped, h.usedPrior, h.reason, h.mark]),
    );
  });
});

describe("usedPrior の馬(place_prob が欠落・不正)の highlights / concerns", () => {
  it("LLM が項目を書いていても `[]` にする(reason が null になるのと同じ扱い)", () => {
    const text = bodyOf([
      { number: 1, place_prob: "たかい", reason: "x", highlights: ["書いた"], concerns: ["書いた"] },
      { number: 2, place_prob: 0.2, reason: "y", highlights: ["残る"], concerns: [] },
      ...fillers(),
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    // 前提: 馬1は prior 採用(usedPrior)、馬2は LLM 値を採用している。
    expect(h1.usedPrior).toBe(true);
    expect(h2.usedPrior).toBe(false);
    expect(h1.reason).toBeNull();
    expect(h1.highlights).toEqual([]);
    expect(h1.concerns).toEqual([]);
    expect(h2.highlights).toEqual(["残る"]);
  });

  it("レスポンスに馬番そのものが無い馬も `[]`", () => {
    const text = bodyOf([{ number: 2, place_prob: 0.2, reason: "y", highlights: ["a"] }, ...fillers()]);
    const h1 = parseAnalyzerResponse(text, priors).horses.find((h) => h.umaban === 1)!;
    expect(h1.usedPrior).toBe(true);
    expect(h1.highlights).toEqual([]);
    expect(h1.concerns).toEqual([]);
  });
});

describe("印の制約違反の救済(AnalyzerMarkViolationError)でも保持する", () => {
  it("全馬 mark=null にした horses が、highlights / concerns を保持している", () => {
    // ◎が0頭 = 頭数制約違反。確率補正は有効なので、救済された horses が運ばれる。
    const text = bodyOf([
      { number: 1, place_prob: 0.45, reason: "a", highlights: ["強み1", "強み2"], concerns: ["弱み1"], mark: null },
      { number: 2, place_prob: 0.2, reason: "b", highlights: [], concerns: ["弱み2"], mark: null },
      { number: 3, place_prob: 0.3, reason: "c", mark: null },
      { number: 4, place_prob: 0.3, reason: "d", mark: null },
      { number: 5, place_prob: 0.3, reason: "e", mark: null },
      { number: 6, place_prob: 0.3, reason: "f", mark: null },
    ]);
    let caught: AnalyzerMarkViolationError | null = null;
    try {
      parseAnalyzerResponse(text, priors);
    } catch (e) {
      if (e instanceof AnalyzerMarkViolationError) caught = e;
    }
    expect(caught).not.toBeNull();
    const horses = caught!.horses;
    const h1 = horses.find((h) => h.umaban === 1)!;
    const h2 = horses.find((h) => h.umaban === 2)!;
    const h3 = horses.find((h) => h.umaban === 3)!;
    expect(horses.every((h) => h.mark === null)).toBe(true);
    expect(h1.highlights).toEqual(["強み1", "強み2"]);
    expect(h1.concerns).toEqual(["弱み1"]);
    expect(h2.concerns).toEqual(["弱み2"]);
    expect(h3.highlights).toEqual([]);
  });
});
