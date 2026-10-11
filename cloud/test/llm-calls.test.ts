import { describe, expect, it } from "vitest";

import { parseLlmCalls, serializeLlmCalls, type LlmCallRecord } from "../src/llm-calls";

/**
 * Issue #197(#196-a 段2): LLM 呼び出しの記録(`analyses.llm_calls_json`)の符号化と復元(純関数)。
 * 1呼び出し1件の配列。**読む側は、壊れた値・形違いで例外を投げない**(旧い行・手で入れた値でも画面が落ちない)。
 */

const OK: LlmCallRecord = { ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: "claude-sonnet-5-5", replayed: false, error: null };
const FAILED: LlmCallRecord = { ok: false, ms: 180_001, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" };

describe("serializeLlmCalls(保存する JSON 文字列。記録なしは null)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空配列", []],
  ])("%s は null(NULL で保存する。『呼んでいない』と『記録が空』を区別しない)", (_label, input) => {
    expect(serializeLlmCalls(input)).toBeNull();
  });

  it("1件以上は JSON 配列の文字列で、復元すると同じ値になる(キーの並びは固定)", () => {
    const text = serializeLlmCalls([FAILED, OK]);
    expect(text).not.toBeNull();
    expect(Object.keys((JSON.parse(text!) as Array<Record<string, unknown>>)[0]!)).toEqual(["ok", "ms", "inputTokens", "outputTokens", "stopReason", "model", "replayed", "error"]);
    expect(parseLlmCalls(text)).toEqual([FAILED, OK]);
  });
});

describe("保存の大きさ(docs/current-spec.md の容量の記録の根拠。再現できる値)", () => {
  it("代表的な記録の JSON の大きさ(UTF-8 のバイト数): 成功1件 = 146、失敗(タイムアウト)→ 失敗 → 成功の3件(最大の送信回数)= 420", () => {
    expect(Buffer.byteLength(serializeLlmCalls([OK])!, "utf-8")).toBe(146);
    expect(Buffer.byteLength(serializeLlmCalls([FAILED, FAILED, OK])!, "utf-8")).toBe(420);
  });
});

describe("parseLlmCalls(読み出し。例外を投げない)", () => {
  it.each([
    ["NULL", null],
    ["空文字", ""],
    ["壊れた JSON", "[壊れ"],
    ["オブジェクト(配列でない)", '{"ok":true}'],
    ["文字列", '"x"'],
    ["数値", "3"],
    ["空配列", "[]"],
    ["要素がすべてオブジェクトでない", '[1,"a",null,[1]]'],
  ])("%s は null", (_label, raw) => {
    expect(parseLlmCalls(raw)).toBeNull();
  });

  it("オブジェクトでない要素は捨て、残りを返す。欠けた項目・型違いの項目は、安全な値(null・false)にする", () => {
    const parsed = parseLlmCalls(JSON.stringify([null, 5, { ok: true, ms: "x", inputTokens: -1, outputTokens: Number.NaN, stopReason: 3, model: {}, replayed: "yes", error: 1 }, { ok: "true" }, OK]));
    expect(parsed).toEqual([
      { ok: true, ms: null, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: null },
      { ok: false, ms: null, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: null },
      OK,
    ]);
  });

  it("数値の項目は、有限で 0 以上の数だけ(負・NaN・Infinity・文字列は null)。0 は 0 のまま", () => {
    const parsed = parseLlmCalls(JSON.stringify([{ ok: true, ms: 0, inputTokens: 0, outputTokens: 0 }, { ok: true, ms: -5, inputTokens: "7", outputTokens: null }]))!;
    expect(parsed[0]).toMatchObject({ ms: 0, inputTokens: 0, outputTokens: 0 });
    expect(parsed[1]).toMatchObject({ ms: null, inputTokens: null, outputTokens: null });
  });

  it("余分なキーは返さない(許可したキーだけ。API の応答に、保存した文字列の余計な項目を載せない)", () => {
    const parsed = parseLlmCalls(JSON.stringify([{ ...OK, secret: "sk-ant-LEAK", body: "応答の本文" }]))!;
    expect(Object.keys(parsed[0]!)).toEqual(["ok", "ms", "inputTokens", "outputTokens", "stopReason", "model", "replayed", "error"]);
    expect(JSON.stringify(parsed)).not.toContain("LEAK");
  });
});
