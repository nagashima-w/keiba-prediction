/**
 * レスポンス処理(JSON抽出・バリデーション・±10%クリップ・馬番欠け補完)の純関数テスト。
 *
 * 仕様「3. analyzer」:
 *  - LLM出力からJSONを抽出(コードフェンス・前後テキストの揺れに耐性)
 *  - place_prob が prior から ±10%(絶対値0.10)以内か検証し、逸脱は prior±0.10 にクリップ(記録)
 *  - 欠けた馬番は prior をそのまま使用(記録)
 */

import { describe, expect, it } from "vitest";
import {
  AnalyzerResponseParseError,
  extractJsonObject,
  parseAnalyzerResponse,
  type PriorRef,
} from "../../src/analyzer/parse-response.js";

const priors: PriorRef[] = [
  { umaban: 1, prior: 0.4 },
  { umaban: 2, prior: 0.2 },
];

function body(horses: unknown): string {
  return JSON.stringify({ horses });
}

describe("extractJsonObject(JSON抽出の揺れ耐性)", () => {
  const cases: ReadonlyArray<{ label: string; text: string }> = [
    { label: "素のJSON", text: '{"horses":[]}' },
    { label: "```json フェンス付き", text: '```json\n{"horses":[]}\n```' },
    { label: "``` 素フェンス付き", text: '```\n{"horses":[]}\n```' },
    {
      label: "前後に説明文がある",
      text: 'こちらが結果です:\n{"horses":[]}\nよろしくお願いします。',
    },
  ];
  it.each(cases)("$label からオブジェクトを取り出せること", ({ text }) => {
    const obj = extractJsonObject(text) as { horses: unknown[] };
    expect(obj.horses).toEqual([]);
  });

  it("JSONが無ければ AnalyzerResponseParseError を投げること", () => {
    expect(() => extractJsonObject("これはJSONを含みません")).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("壊れたJSONは AnalyzerResponseParseError を投げること", () => {
    expect(() => extractJsonObject('{"horses": [')).toThrow(
      AnalyzerResponseParseError,
    );
  });
});

describe("parseAnalyzerResponse(バリデーション・クリップ)", () => {
  it("正常系: 範囲内はそのまま補正後確率になること", () => {
    const text = body([
      { number: 1, place_prob: 0.45, reason: "調教良化" },
      { number: 2, place_prob: 0.15, reason: "展開不利" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 10);
    expect(h1.clipped).toBe(false);
    expect(h1.usedPrior).toBe(false);
    expect(h1.reason).toBe("調教良化");
    expect(r.clippedCount).toBe(0);
    expect(r.missingCount).toBe(0);
  });

  // クリップ境界: prior=0.40 に対し +0.10 ちょうど(0.50)はOK、+0.101(0.501)はクリップ。
  const clipCases: ReadonlyArray<{
    label: string;
    value: number;
    expected: number;
    clipped: boolean;
  }> = [
    { label: "+0.10ちょうどは非クリップ", value: 0.5, expected: 0.5, clipped: false },
    { label: "+0.101はクリップ", value: 0.501, expected: 0.5, clipped: true },
    { label: "-0.10ちょうどは非クリップ", value: 0.3, expected: 0.3, clipped: false },
    { label: "-0.101はクリップ", value: 0.299, expected: 0.3, clipped: true },
    { label: "大幅超過は上限へ", value: 0.99, expected: 0.5, clipped: true },
    { label: "1超は上限へ(かつ[0,1])", value: 1.5, expected: 0.5, clipped: true },
  ];
  it.each(clipCases)("馬番1(prior=0.40): $label", ({ value, expected, clipped }) => {
    const text = body([{ number: 1, place_prob: value, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(expected, 9);
    expect(h1.clipped).toBe(clipped);
  });

  it("[0,1]下限クリップ: prior=0.20 で負値は0へ", () => {
    // prior 0.20 の下限は max(0, 0.10)=0.10。-0.5 は 0.10 へクリップ。
    const text = body([{ number: 2, place_prob: -0.5, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.1, 9);
    expect(h2.clipped).toBe(true);
  });

  it("馬番欠け: prior をそのまま使い記録すること", () => {
    // 馬番2 のみ回答 → 馬番1 は欠け。
    const text = body([{ number: 2, place_prob: 0.2, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.usedPrior).toBe(true);
    expect(h1.adjustedProb).toBeCloseTo(0.4, 10);
    expect(r.missingCount).toBe(1);
  });

  it("不正な place_prob(数値でない)は prior 採用として記録すること", () => {
    const text = body([
      { number: 1, place_prob: "たかい", reason: "x" },
      { number: 2, place_prob: 0.2, reason: "y" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.usedPrior).toBe(true);
    expect(h1.adjustedProb).toBeCloseTo(0.4, 10);
  });

  it("priors に無い余分な馬番は無視されること", () => {
    const text = body([
      { number: 1, place_prob: 0.4, reason: "x" },
      { number: 2, place_prob: 0.2, reason: "y" },
      { number: 99, place_prob: 0.5, reason: "存在しない" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    expect(r.horses.map((h) => h.umaban).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("空の horses(有効な補正0件)はパース失敗として例外を投げること", () => {
    // スキーマ妥当だが実質失敗(全馬 prior のまま)→ リトライ/フォールバックに回すため例外にする。
    expect(() => parseAnalyzerResponse(body([]), priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("全馬番が余分(有効な補正0件)でもパース失敗として例外を投げること", () => {
    const text = body([{ number: 99, place_prob: 0.5, reason: "存在しない" }]);
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("maxAdjust を config で狭められること(0.05でクリップ幅が縮む)", () => {
    // prior=0.40、maxAdjust=0.05 → 上限0.45。0.48 は 0.45 へクリップ。
    const text = body([{ number: 1, place_prob: 0.48, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors, { maxAdjust: 0.05 });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 9);
    expect(h1.clipped).toBe(true);
  });

  it("JSON抽出不能は AnalyzerResponseParseError を投げること", () => {
    expect(() => parseAnalyzerResponse("no json here", priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });
});
