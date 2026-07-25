/**
 * analyzer 本体(プロンプト構築→LLM呼び出し→パース→補正確率)のテスト。
 *
 * 仕様「3. analyzer」:
 *  - 1レース1リクエスト。LLMクライアントは注入(モックのみ、実APIは呼ばない)。
 *  - フェイルセーフ: JSONパース失敗時は1回だけ同一プロンプトでリトライ、再失敗で prior をそのまま採用し
 *    fallback:true と理由を返す。LLM呼び出し自体の例外も同様。
 *  - 出力: 馬ごと {umaban, prior, adjustedProb, reason, clipped, mark} + メタ(fallback有無・リトライ回数)。
 *
 * Task#22(予想印): 成功時はLLM応答のmarkを反映し、フォールバック時は全馬mark=nullで返すことを検証する。
 *
 * A(フォールバック分離・2026-07-19合意): 印関連の違反(頭数・優先順位・未知の印文字)は
 * リトライしてもなお印関連違反なら、その応答の確率補正(adjustedProb/clipped/reason)を採用したまま
 * 全馬 mark=null で返し、fallback:false・marksDropped:true とする(prior には戻さない)。
 * fallback は「通常時は false」の不変条件を保つため fallbackReason は null のままとし、
 * 印救済の理由は専用フィールド marksDroppedReason に入れる。
 * 印と無関係な失敗(JSON破損・horses配列なし・有効な補正0件)は従来どおり全馬 prior・fallback:true・
 * marksDropped:false とする。
 */

import { describe, expect, it, vi } from "vitest";
import {
  analyzeRace,
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_TRUNCATED,
} from "../../src/analyzer/analyze-race.js";
import type { LlmClient } from "../../src/analyzer/analyze-race.js";
import type { BuildPromptInput } from "../../src/analyzer/build-prompt.js";
import { AnalyzerTruncationError } from "../../src/analyzer/parse-response.js";

function input(): BuildPromptInput {
  return {
    race: { courseType: "芝", distance: 1600, weather: "曇", trackCondition: "良" },
    horses: [
      { umaban: 1, horseName: "アルファ", prior: 0.4, runs: [{ passing: [1], fieldSize: 16 }] },
      { umaban: 2, horseName: "ブラボー", prior: 0.2, runs: [{ passing: [8], fieldSize: 16 }] },
      // 予想印の頭数制約(◎〇▲△を最低1頭ずつ)を満たすための埋め合わせ馬(3〜6番)。
      { umaban: 3, horseName: "チャーリー", prior: 0.3, runs: [] },
      { umaban: 4, horseName: "デルタ", prior: 0.3, runs: [] },
      { umaban: 5, horseName: "エコー", prior: 0.3, runs: [] },
      { umaban: 6, horseName: "フォックス", prior: 0.3, runs: [] },
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

/** 予想印の頭数制約(◎〇▲△を1頭ずつ)を満たすための埋め合わせ馬(3〜6番)のJSON片。 */
function fillerMarkHorses(): unknown[] {
  return [
    { number: 3, place_prob: 0.3, reason: "filler", mark: "◎" },
    { number: 4, place_prob: 0.3, reason: "filler", mark: "〇" },
    { number: 5, place_prob: 0.3, reason: "filler", mark: "▲" },
    { number: 6, place_prob: 0.3, reason: "filler", mark: "△" },
  ];
}

const okBody = JSON.stringify({
  horses: [
    { number: 1, place_prob: 0.45, reason: "調教良化" },
    { number: 2, place_prob: 0.15, reason: "展開不利" },
    ...fillerMarkHorses(),
  ],
});

describe("analyzeRace(1レース分の分析)", () => {
  it("初回成功: fallbackなし・リトライ0・補正後確率を返すこと", async () => {
    const llm = fixedLlm(okBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(0);
    expect(r.fallbackReason).toBeNull();
    expect(r.marksDropped).toBe(false);
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
    // 固定分類文言(UI/DBに秘密が混入しない設計)の厳密表明。
    expect(r.fallbackReason).toBe(FALLBACK_REASON_PARSE_ERROR);
    // 診断用の生詳細(UI/DB非公開・ログ専用)は非空文字列で残ること。
    expect(typeof r.diagnosticMessage).toBe("string");
    expect(r.diagnosticMessage!.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
    expect(r.stopReason ?? null).toBeNull();
    expect(r.marksDropped).toBe(false); // 印と無関係な失敗(JSON破損)は従来どおりの全馬prior。
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
    expect(r.marksDropped).toBe(false); // 印と無関係な失敗(LLM例外)は従来どおりの全馬prior。
    expect(r.horses.find((h) => h.umaban === 1)!.adjustedProb).toBeCloseTo(0.4, 10);
    // 固定分類文言(UI/DBに秘密が混入しない設計)の厳密表明。
    expect(r.fallbackReason).toBe(FALLBACK_REASON_INVOCATION_ERROR);
    expect(r.truncated).toBe(false);
    expect(r.stopReason ?? null).toBeNull();
    // 診断用の生詳細(UI/DB非公開・ログ専用)には元の例外メッセージがそのまま残ること。
    expect(r.diagnosticMessage).toBe("常に失敗");
  });

  it("秘密混入テスト: LLM呼び出し例外のメッセージに秘密様の文字列が含まれても fallbackReason(UI/DB向け)には混入しないこと", async () => {
    const secretLike = "sk-ant-FAKESECRET-do-not-leak-1234567890";
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error(`認証エラー: ${secretLike}`);
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    // UI/DB向けの fallbackReason は固定分類文言のみで、秘密様文字列を含まないこと。
    expect(r.fallbackReason).toBe(FALLBACK_REASON_INVOCATION_ERROR);
    expect(r.fallbackReason).not.toContain(secretLike);
    // 診断用の生詳細(ログ専用・マスキングは main/logger.ts 側で行う)には残ってよい。
    expect(r.diagnosticMessage).toContain(secretLike);
  });

  it("秘密混入テスト: JSONパース失敗時も fallbackReason(UI/DB向け)は固定分類文言のみであること", async () => {
    // パースエラーメッセージ自体に秘密が混入することは通常無いが、固定文言であることを構造的に保証する。
    const llm = fixedLlm("こわれ1", "こわれ2");
    const r = await analyzeRace(input(), { llm });
    expect(r.fallbackReason).toBe(FALLBACK_REASON_PARSE_ERROR);
  });

  it("±10%逸脱はクリップされ clipped が伝播すること", async () => {
    // 馬番1(prior0.40)に0.99を返す → 0.50へクリップ。
    const clipBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.99, reason: "過大" },
        { number: 2, place_prob: 0.2, reason: "据置" },
        ...fillerMarkHorses(),
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
    expect(r.marksDropped).toBe(false); // 有効な補正0件(印と無関係)は従来どおりの全馬prior。
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
        ...fillerMarkHorses(),
      ],
    });
    const r = await analyzeRace(input(), { llm: fixedLlm(bodyText), maxAdjust: 0.05 });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 9);
    expect(h1.clipped).toBe(true);
  });
});

describe("analyzeRace(rawResponseの伝播。Issue#10 分析データのエクスポート)", () => {
  it("初回成功時、LLMの生応答テキストがrawResponseにそのまま載ること", async () => {
    const r = await analyzeRace(input(), { llm: fixedLlm(okBody) });
    expect(r.fallback).toBe(false);
    expect(r.rawResponse).toBe(okBody);
  });

  it("リトライで成功した場合、成功した回(2回目)の応答テキストがrawResponseに載ること", async () => {
    const r = await analyzeRace(input(), { llm: fixedLlm("壊れています", okBody) });
    expect(r.fallback).toBe(false);
    expect(r.rawResponse).toBe(okBody);
  });

  it("印関連違反によるA救済(marksDropped:true)でも、最終試行の応答テキストがrawResponseに載ること", async () => {
    const badMarkBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.45, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.15, reason: "y", mark: "◎" },
        ...fillerMarkHorses(),
      ],
    });
    const r = await analyzeRace(input(), { llm: fixedLlm(badMarkBody, badMarkBody) });
    expect(r.marksDropped).toBe(true);
    expect(r.rawResponse).toBe(badMarkBody);
  });

  it("パース2回失敗(prior採用のフォールバック)ではrawResponseがnullになること(text未取得の失敗時はnull)", async () => {
    const r = await analyzeRace(input(), { llm: fixedLlm("こわれ1", "こわれ2") });
    expect(r.fallback).toBe(true);
    expect(r.rawResponse).toBeNull();
  });

  it("LLM呼び出し例外2回(prior採用のフォールバック)ではrawResponseがnullになること", async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("常に失敗");
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.rawResponse).toBeNull();
  });

  it("切り詰め(truncated)によるフォールバックではrawResponseがnullになること", async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new AnalyzerTruncationError("応答がmax_tokensで切り詰められました", "max_tokens");
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.rawResponse).toBeNull();
  });
});

describe("analyzeRace(応答の切り詰め検出・小倉記念18頭切り詰め事故の再発防止)", () => {
  it("切り詰め(AnalyzerTruncationError)2回: fallback:true・固定分類文言・truncated:true・stopReason='max_tokens' で prior を採用すること", async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new AnalyzerTruncationError("応答がmax_tokensで切り詰められました", "max_tokens");
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(r.fallbackReason).toBe(FALLBACK_REASON_TRUNCATED);
    expect(r.truncated).toBe(true);
    expect(r.stopReason).toBe("max_tokens");
    expect(r.marksDropped).toBe(false);
    expect(r.horses.every((h) => h.usedPrior)).toBe(true);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
  });

  it("切り詰め後のリトライで成功すれば通常成功として扱うこと(fallback:false)", async () => {
    const llm: LlmClient = {
      complete: vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(
          new AnalyzerTruncationError("応答がmax_tokensで切り詰められました", "max_tokens"),
        )
        .mockResolvedValueOnce(okBody),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.retryCount).toBe(1);
    expect(r.fallbackReason).toBeNull();
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it("切り詰めは汎用のJSON解析失敗文言(FALLBACK_REASON_PARSE_ERROR)に埋もれないこと(先に判定)", () => {
    // 切り詰め専用文言と汎用パース失敗文言が異なる(=判定順序の取り違えを防ぐ)ことを固定する。
    expect(FALLBACK_REASON_TRUNCATED).not.toBe(FALLBACK_REASON_PARSE_ERROR);
  });
});

describe("analyzeRace(予想印 mark の統合・Task#22)", () => {
  it("初回成功: LLM応答の mark が各馬に反映されること", async () => {
    const r = await analyzeRace(input(), { llm: fixedLlm(okBody) });
    expect(r.fallback).toBe(false);
    expect(r.horses.find((h) => h.umaban === 3)!.mark).toBe("◎");
    expect(r.horses.find((h) => h.umaban === 4)!.mark).toBe("〇");
    expect(r.horses.find((h) => h.umaban === 5)!.mark).toBe("▲");
    expect(r.horses.find((h) => h.umaban === 6)!.mark).toBe("△");
    // 馬番1・2はokBodyでmark未指定 → 印なし(null)。
    expect(r.horses.find((h) => h.umaban === 1)!.mark).toBeNull();
    expect(r.horses.find((h) => h.umaban === 2)!.mark).toBeNull();
  });

  it("フォールバック時(LLM例外2回)は全馬 mark=null で返すこと(印と無関係な失敗)", async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("常に失敗");
      }),
    };
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.marksDropped).toBe(false);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
  });

  it("フォールバック時(パース2回失敗)も全馬 mark=null で返すこと(印と無関係な失敗)", async () => {
    const llm = fixedLlm("こわれ1", "こわれ2");
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(true);
    expect(r.marksDropped).toBe(false);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
  });
});

describe("analyzeRace(A: 印関連違反時のフォールバック分離・確率補正のレスキュー・2026-07-19合意)", () => {
  it("頭数違反(◎が2頭)はA救済: fallback:false・fallbackReason:null・marksDropped:true・確率補正保持・全馬mark=null", async () => {
    const badMarkBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.45, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.15, reason: "y", mark: "◎" }, // ◎が2頭で頭数違反。
        ...fillerMarkHorses(),
      ],
    });
    const llm = fixedLlm(badMarkBody, badMarkBody);
    const r = await analyzeRace(input(), { llm });
    // fallback は「通常時は false」の不変条件を保つため、印救済でも fallbackReason は null のまま。
    expect(r.fallback).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.marksDropped).toBe(true);
    expect(r.marksDroppedReason).not.toBeNull();
    expect(r.retryCount).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
    // prior に戻さず、クリップ済みの補正値・reason をそのまま保持すること。
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 10);
    expect(h1.usedPrior).toBe(false);
    expect(h1.reason).toBe("x");
  });

  it("優先順位違反(〇を飛ばして▲のみ)はA救済: fallback:false・marksDropped:true・確率補正保持", async () => {
    const badPriorityBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.45, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.18, reason: "y", mark: "▲" }, // 〇を飛ばして▲→優先順位違反。
        { number: 3, place_prob: 0.3, reason: "z", mark: null },
        { number: 4, place_prob: 0.3, reason: "w", mark: null },
        { number: 5, place_prob: 0.3, reason: "v", mark: null },
        { number: 6, place_prob: 0.3, reason: "u", mark: null },
      ],
    });
    const llm = fixedLlm(badPriorityBody, badPriorityBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.marksDropped).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.18, 10);
    expect(h2.usedPrior).toBe(false);
  });

  it("未知の印文字はA救済: fallback:false・marksDropped:true・確率補正保持", async () => {
    const badUnknownMarkBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.45, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.18, reason: "y", mark: "◇" }, // 未知の印文字。
        { number: 3, place_prob: 0.3, reason: "z", mark: "〇" },
        { number: 4, place_prob: 0.3, reason: "w", mark: "▲" },
        { number: 5, place_prob: 0.3, reason: "v", mark: "△" },
        { number: 6, place_prob: 0.3, reason: "u", mark: null },
      ],
    });
    const llm = fixedLlm(badUnknownMarkBody, badUnknownMarkBody);
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.marksDropped).toBe(true);
    expect(r.retryCount).toBe(1);
    expect(r.horses.every((h) => h.mark === null)).toBe(true);
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.18, 10);
    expect(h2.usedPrior).toBe(false);
  });

  it("印関連違反が初回のみでリトライが成功すれば通常成功として扱うこと(marksDropped:falseでmark反映)", async () => {
    const badMarkBody = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.45, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.15, reason: "y", mark: "◎" }, // ◎が2頭で頭数違反(初回のみ)。
        ...fillerMarkHorses(),
      ],
    });
    const llm = fixedLlm(badMarkBody, okBody); // リトライ(2回目)は正常応答。
    const r = await analyzeRace(input(), { llm });
    expect(r.fallback).toBe(false);
    expect(r.marksDropped).toBe(false);
    expect(r.retryCount).toBe(1);
    expect(r.horses.find((h) => h.umaban === 3)!.mark).toBe("◎");
  });
});
