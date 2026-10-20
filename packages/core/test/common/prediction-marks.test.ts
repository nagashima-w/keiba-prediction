import { describe, expect, it } from "vitest";
import { markRank, PREDICTION_MARKS } from "../../src/common/prediction-marks.js";
import { PREDICTION_MARKS as PARSE_RESPONSE_MARKS } from "../../src/analyzer/parse-response.js";
import { MARK_ORIGIN_VALUES } from "../../src/view/format.js";

/**
 * Issue #397(R-5): 予想印の並びの共通部品。5 か所に配列で別々に持っていた(parse-response・notify-embeds・client/result・client/api-verify・view/format の 8 要素版)。
 * **コードポイントで固定する**: 「〇」は U+3007(○ U+25CB ではない)。リテラルを打ち間違えても、旧版との一致を見る既存テストは、同じ共通部品を比べるだけになって気づけない。
 */

describe("PREDICTION_MARKS", () => {
  it("並びとコードポイントを固定する(◎ U+25CE・〇 U+3007・▲ U+25B2・△ U+25B3・☆ U+2606・注 U+6CE8)", () => {
    expect(PREDICTION_MARKS.map((m) => m.codePointAt(0)!.toString(16).toUpperCase())).toEqual(["25CE", "3007", "25B2", "25B3", "2606", "6CE8"]);
    expect(PREDICTION_MARKS).toHaveLength(6);
  });

  it("parse-response の PREDICTION_MARKS は同じ配列(再 export)", () => {
    expect(PARSE_RESPONSE_MARKS).toBe(PREDICTION_MARKS);
  });

  it("view/format の MARK_ORIGIN_VALUES は、印 6 種の後ろに「なし」「不明」を足した 8 要素", () => {
    expect([...MARK_ORIGIN_VALUES]).toEqual([...PREDICTION_MARKS, "なし", "不明"]);
    expect(MARK_ORIGIN_VALUES).toHaveLength(8);
  });
});

describe("markRank: 印の順位(既知は添字、未知は末尾)", () => {
  it("既知の印は並びの添字(0〜5)", () => {
    expect(PREDICTION_MARKS.map((m) => markRank(m))).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("未知の印・空文字・別字形の○(U+25CB)は印の数(6)", () => {
    for (const m of ["", "○", "x", "なし", "◎〇"]) {
      expect(markRank(m), JSON.stringify(m)).toBe(6);
    }
  });
});
