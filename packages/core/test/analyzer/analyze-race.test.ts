/**
 * analyzer 本体(プロンプト構築→LLM呼び出し→パース→補正確率)のテスト。
 *
 * 仕様「3. analyzer」:
 *  - 1レース1リクエスト。LLMクライアントは注入(モックのみ、実APIは呼ばない)。
 *  - フェイルセーフ: JSONパース失敗時は1回だけ同一プロンプトでリトライ、再失敗で prior をそのまま採用し
 *    fallback:true と理由を返す。LLM呼び出し自体の例外も同様。
 *  - 出力: 馬ごと {umaban, prior, adjustedProb, reason, clipped} + メタ(fallback有無・リトライ回数)。
 */

import { describe, expect, it, vi } from "vitest";
import { analyzeRace } from "../../src/analyzer/analyze-race.js";
import type { LlmClient } from "../../src/analyzer/analyze-race.js";
import type { BuildPromptInput } from "../../src/analyzer/build-prompt.js";

function input(): BuildPromptInput {
  return {
    race: { courseType: "芝", distance: 1600, weather: "曇", trackCondition: "良" },
    horses: [
      { umaban: 1, horseName: "アルファ", prior: 0.4, runs: [{ passing: [1], fieldSize: 16 }] },
      { umaban: 2, horseName: "ブラボー", prior: 0.2, runs: [{ passing: [8], fieldSize: 16 }] },
    ],
  };
}

/** 決められた文字列を返す固定LLM。 */
function fixedLlm(...responses: string[]): LlmClient {
  const queue = [...responses];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("応答が尽きた");
      return next;
    }),
  };
}

const okBody = JSON.stringify({
  horses: [
    { number: 1, place_prob: 0.45, reason: "調教良化" },
    { number: 2, place_prob: 0.15, reason: "展開不利" },
  ],
});

describe("analyzeRace(1レース分の分析)", () => {
  it("初回成功: fallbackなし・リトライ0・補正後確率を返すこと", async () => {
    const llm = fixedLlm(okBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(0);
    expect(r.fallbackReason).toBeNull();
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 10);
    expect(h1.prior).toBeCloseTo(0.4, 10);
    expect(h1.reason).toBe("調教良化");
    // 1レース1リクエスト。
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("LLMには構築済みプロンプト(馬名を含む)を渡すこと", async () => {
    const llm = fixedLlm(okBody);
    await analyzeRace(input(), { llm });
    const prompt = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(prompt).toContain("アルファ");
    expect(prompt).toContain("place_prob");
  });

  it("パース失敗→リトライで成功: リトライ1・fallbackなし", async () => {
    const llm = fixedLlm("壊れています", okBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(r.horses.find((h) => h.umaban === 1)!.adjustedProb).toBeCloseTo(0.45, 10);
  });

  it("パース2回失敗: prior をそのまま採用し fallback:true・理由を返すこと", async () => {
    const llm = fixedLlm("こわれ1", "こわれ2");
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(r.fallbackReason).not.toBeNull();
    expect(llm.complete).toHaveBeenCalledTimes(2);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.4, 10); // prior
    expect(h1.usedPrior).toBe(true);
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.2, 10);
  });

  it("LLM例外→リトライで成功: リトライ1・fallbackなし", async () => {
    const llm: LlmClient = {
      complete: vi
        .fn<(p: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error("ネットワーク断"))
        .mockResolvedValueOnce(okBody),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it("LLM例外2回: fallback:true で prior を採用すること", async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("常に失敗");
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(r.horses.find((h) => h.umaban === 1)!.adjustedProb).toBeCloseTo(0.4, 10);
  });

  it("±10%逸脱はクリップされ clipped が伝播すること", async () => {
    // 馬番1(prior0.40)に0.99を返す → 0.50へクリップ。
    const clipBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.99, reason: "過大" },
        { number: 2, place_prob: 0.2, reason: "据置" },
      ],
    });
    const r = await analyzeRace(input(), { llm: fixedLlm(clipBody) });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.clipped).toBe(true);
    expect(h1.adjustedProb).toBeCloseTo(0.5, 9);
  });

  it("空の horses(有効な補正0件)はリトライ後フォールバックすること", async () => {
    const empty = JSON.stringify({ horses: [] });
    const llm = fixedLlm(empty, empty);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(r.horses.every((h) => h.usedPrior)).toBe(true);
  });

  it("空の horses→リトライで有効応答なら成功すること", async () => {
    const empty = JSON.stringify({ horses: [] });
    const llm = fixedLlm(empty, okBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(1);
  });

  it("maxAdjust を deps 経由で渡すとクリップ幅に反映されること", async () => {
    // prior=0.40 に 0.48、maxAdjust=0.05 → 0.45 へクリップ。
    const bodyText = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.48, reason: "x" },
        { number: 2, place_prob: 0.2, reason: "y" },
      ],
    });
    const r = await analyzeRace(input(), { llm: fixedLlm(bodyText), maxAdjust: 0.05 });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 9);
    expect(h1.clipped).toBe(true);
  });
});
