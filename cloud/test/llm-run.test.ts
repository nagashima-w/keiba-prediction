import { describe, expect, it, vi } from "vitest";

import {
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_REFUSED,
  FALLBACK_REASON_TRUNCATED,
  type AnalyzeRaceResult,
  type AnthropicMessageResponse,
  type AnthropicRequestParams,
} from "@keiba/core/llm";
import {
  clampAdditionalInstruction,
  createRecordingSender,
  describeLlmErrorForLog,
  LLM_NOTE_MARKS_DROPPED,
  LLM_NOTE_NO_KEY,
  LLM_NOTE_UNKNOWN_FALLBACK,
  outcomeOf,
  redactSecrets,
  sanitizeLister,
  withErrorLog,
  type LlmResponseStore,
  type StoredLlmResponse,
} from "../src/llm-run";

/**
 * Issue #194(#179-b)の純ロジック: 追加指示の切り詰め・秘密のマスク・応答の記録と再生・結果の理由(固定文言)。
 * LLM の実行そのものは `race-day-llm.test.ts`(RaceDayCore 経由)で確かめる。ここはすべて偽の sender・偽のストアで、実 API には出ない。
 */

const REQUEST: AnthropicRequestParams = {
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  output_config: { effort: "low" },
  messages: [{ role: "user", content: "p" }],
};

/** 孤立したサロゲート(対になっていない上位・下位)があるか。 */
const hasLoneSurrogate = (text: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe("clampAdditionalInstruction(追加指示を 2,000 UTF-16 単位に切る。サロゲートペアを割らない)", () => {
  const EMOJI = "😀"; // 2 単位(U+D83D U+DE00)

  it.each([
    ["空", "", false, 0],
    ["1 文字", "あ", false, 1],
    ["1,999 単位", "a".repeat(1999), false, 1999],
    ["ちょうど 2,000 単位(切らない)", "a".repeat(2000), false, 2000],
    ["2,001 単位(1 単位だけ切る)", "a".repeat(2001), true, 2000],
    ["10,000 単位", "あ".repeat(10_000), true, 2000],
  ])("%s", (_name, input, clamped, length) => {
    const out = clampAdditionalInstruction(input);
    expect(out.clamped).toBe(clamped);
    expect(out.text.length).toBe(length);
    expect(input.startsWith(out.text)).toBe(true); // 先頭から切っただけ(途中を書き換えない)
  });

  it("2,000 単位目がペアの上位サロゲートのとき(2,001 単位。末尾が絵文字)は、そのペアごと落とす(1,999 単位。サロゲートを割らない)", () => {
    const input = `${"a".repeat(1999)}${EMOJI}`; // 1999 + 2 = 2001 単位
    expect(input.length).toBe(2001);
    const out = clampAdditionalInstruction(input);
    expect(out.clamped).toBe(true);
    expect(out.text).toBe("a".repeat(1999));
    expect(hasLoneSurrogate(out.text)).toBe(false);
    // 対照: 単純な slice(0, 2000) は、孤立した上位サロゲートを残す(この検査が、割れた状態を検出できることの確認)
    expect(hasLoneSurrogate(input.slice(0, 2000))).toBe(true);
  });

  it("ペアがちょうど 2,000 単位に収まるとき(1,998 + 絵文字 = 2,000)は、切らない", () => {
    const input = `${"a".repeat(1998)}${EMOJI}`;
    expect(input.length).toBe(2000);
    expect(clampAdditionalInstruction(input)).toEqual({ text: input, clamped: false });
  });

  it("絵文字だけの長い文字列でも、孤立したサロゲートを作らず、2,000 単位以下になる(偶数単位の 2,000)", () => {
    const input = EMOJI.repeat(3000); // 6000 単位
    const out = clampAdditionalInstruction(input);
    expect(out.clamped).toBe(true);
    expect(out.text.length).toBe(2000);
    expect(hasLoneSurrogate(out.text)).toBe(false);
    expect(out.text).toBe(EMOJI.repeat(1000));
  });

  it("上限は引数で変えられる(既定は 2,000)。奇数の上限でも、割らない", () => {
    expect(clampAdditionalInstruction("abcdef", 3)).toEqual({ text: "abc", clamped: true });
    const out = clampAdditionalInstruction(EMOJI.repeat(5), 3); // 3 単位目は上位サロゲート
    expect(out).toEqual({ text: EMOJI, clamped: true });
  });
});

describe("redactSecrets(sk-ant- で始まる鍵らしい文字列を伏せる)", () => {
  it.each([
    ["sk-ant-api03-AbC_123-xyz", "sk-ant-***"],
    ["error: sk-ant-SECRET-BODY failed", "error: sk-ant-*** failed"],
    ["a sk-ant-1 b sk-ant-2 c", "a sk-ant-*** b sk-ant-*** c"],
    ["秘密は sk-ant-あいう ではない", "秘密は sk-ant-***あいう ではない"],
    ["sk-other-123 はそのまま", "sk-other-123 はそのまま"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });
});

describe("describeLlmErrorForLog(ログに出す説明。status と種別だけ。メッセージ・本文は出さない)", () => {
  const withStatus = (status: number): Error => Object.assign(new Error(`${status} {"error":{"message":"sk-ant-SECRET-BODY を含む本文"}}`), { status });

  it.each([[401], [402], [429], [500], [529]])("HTTP %i は status=%i だけを出す", (status) => {
    const text = describeLlmErrorForLog(withStatus(status));
    expect(text).toBe(`status=${status}`);
    expect(text).not.toContain("sk-ant-");
    expect(text).not.toContain("本文");
  });

  it.each([
    [new Error("Request timed out."), "種別=timeout"],
    [new Error("Connection error. sk-ant-SECRET-BODY"), "種別=connection"],
    [new Error("something else sk-ant-SECRET-BODY"), "種別=other"],
    ["文字列が投げられた sk-ant-SECRET-BODY", "種別=other"],
    [undefined, "種別=other"],
  ])("status の無い例外 %j は %s(メッセージは出さない)", (e, expected) => {
    const text = describeLlmErrorForLog(e);
    expect(text).toBe(expected);
    expect(text).not.toContain("sk-ant-");
  });

  it("status が数値でなければ(文字列・NaN)、status としては扱わない", () => {
    expect(describeLlmErrorForLog(Object.assign(new Error("x"), { status: "429" }))).toBe("種別=other");
    expect(describeLlmErrorForLog(Object.assign(new Error("x"), { status: Number.NaN }))).toBe("種別=other");
  });
});

describe("withErrorLog(sender の失敗を、status と種別だけで警告に出して、そのまま投げ直す)", () => {
  it("成功はそのまま返し、警告を出さない", async () => {
    const warn = vi.fn();
    const response: AnthropicMessageResponse = { content: [{ type: "text", text: "ok" }] };
    const sender = withErrorLog(async () => response, warn);
    expect(await sender(REQUEST)).toBe(response);
    expect(warn).not.toHaveBeenCalled();
  });

  it("失敗は、同じ例外のまま投げ直し(上位の判定が status を見られる)、警告には status だけを出す(メッセージの鍵・本文は出ない)", async () => {
    const warn = vi.fn();
    const error = Object.assign(new Error('429 {"message":"sk-ant-SECRET-BODY"}'), { status: 429 });
    const sender = withErrorLog(async () => {
      throw error;
    }, warn);
    await expect(sender(REQUEST)).rejects.toBe(error);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("status=429");
    expect(line).not.toContain("sk-ant-");
    expect(line).not.toContain("SECRET");
  });
});

describe("sanitizeLister(モデル一覧の失敗の例外を、メッセージを捨てた説明に置き換える。core の警告が本文を出さないため)", () => {
  it("成功はそのまま返す", async () => {
    const models = [{ id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" }];
    expect(await sanitizeLister(async () => models)()).toBe(models);
  });

  it("失敗は、status・種別だけの説明の例外にする(元のメッセージ・鍵は含まない)", async () => {
    const lister = sanitizeLister(async () => {
      throw Object.assign(new Error('429 {"message":"sk-ant-SECRET-BODY"}'), { status: 429 });
    });
    const caught = await lister().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("status=429");
  });
});

describe("createRecordingSender(成功した応答を記録し、再実行では再生する。Issue #194 d5)", () => {
  function memoryStore(): LlmResponseStore & { rows: Map<number, StoredLlmResponse> } {
    const rows = new Map<number, StoredLlmResponse>();
    return {
      rows,
      get: (index) => rows.get(index),
      put: (index, response) => {
        rows.set(index, response);
      },
    };
  }
  const reply = (text: string, extra: Partial<AnthropicMessageResponse> = {}): AnthropicMessageResponse => ({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    model: "claude-sonnet-5-5",
    ...extra,
  });

  it("実送信した成功の応答は、返す前に記録する。記録は必要な部分(text ブロックだけ・stop_reason・model)で、thinking など他のブロックは持たない", async () => {
    const store = memoryStore();
    const inner = vi.fn(async () => ({
      ...reply("本文"),
      content: [
        { type: "thinking", text: undefined },
        { type: "text", text: "本文" },
      ],
    }));
    const sender = createRecordingSender(inner, store);
    const res = await sender(REQUEST);
    expect(res.content).toHaveLength(2); // 呼び出し元には、実際の応答をそのまま返す
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(0)).toEqual({ content: [{ type: "text", text: "本文" }], stop_reason: "end_turn", model: "claude-sonnet-5-5" });
  });

  it("再実行(同じストアの新しい sender)は、記録を順に再生し、実送信しない。記録が尽きたら実送信して記録する", async () => {
    const store = memoryStore();
    const first = vi.fn(async () => reply("1回目"));
    const firstRun = createRecordingSender(first, store);
    await firstRun(REQUEST);
    await firstRun(REQUEST);
    expect(first).toHaveBeenCalledTimes(2);

    const second = vi.fn(async () => reply("3回目"));
    const secondRun = createRecordingSender(second, store);
    expect((await secondRun(REQUEST)).content).toEqual([{ type: "text", text: "1回目" }]);
    expect((await secondRun(REQUEST)).content).toEqual([{ type: "text", text: "1回目" }]);
    expect(second).not.toHaveBeenCalled(); // 2回とも再生(同じ内容を2回返したのは、記録が2件とも「1回目」だから)
    expect((await secondRun(REQUEST)).content).toEqual([{ type: "text", text: "3回目" }]);
    expect(second).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(3);
  });

  it("失敗(例外)は記録しない。失敗は番号を進めず、次の成功が先頭の番号に記録される", async () => {
    const store = memoryStore();
    const inner = vi
      .fn<(p: AnthropicRequestParams) => Promise<AnthropicMessageResponse>>()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }))
      .mockResolvedValueOnce(reply("成功"));
    const sender = createRecordingSender(inner, store);
    await expect(sender(REQUEST)).rejects.toMatchObject({ status: 500 });
    expect(store.rows.size).toBe(0);
    await sender(REQUEST);
    expect([...store.rows.keys()]).toEqual([0]);
    // 再実行: 失敗した呼び出しを飛ばし、記録済みの成功を最初の呼び出しで再生する(実送信は0回)
    const again = vi.fn(async () => reply("使われない"));
    expect((await createRecordingSender(again, store)(REQUEST)).content).toEqual([{ type: "text", text: "成功" }]);
    expect(again).not.toHaveBeenCalled();
  });

  it.each([["max_tokens"], ["refusal"]])("stop_reason=%s の応答も、課金されているので記録し、再生で同じ stop_reason を返す(再生が、切り詰め・拒否の判定を変えない)", async (stopReason) => {
    const store = memoryStore();
    await createRecordingSender(async () => reply("途中", { stop_reason: stopReason }), store)(REQUEST);
    expect(store.rows.get(0)?.stop_reason).toBe(stopReason);
    const replayInner = vi.fn(async () => reply("使われない"));
    const replayed = await createRecordingSender(replayInner, store)(REQUEST);
    expect(replayed.stop_reason).toBe(stopReason);
    expect(replayInner).not.toHaveBeenCalled();
  });

  it("記録の書き込み(put)に失敗しても、応答は返す(課金済みの応答を捨てない)。警告を出す", async () => {
    const warn = vi.fn();
    const store: LlmResponseStore = {
      get: () => undefined,
      put: () => {
        throw new Error("DO のストレージの失敗");
      },
    };
    const sender = createRecordingSender(async () => reply("応答"), store, warn);
    expect((await sender(REQUEST)).content).toEqual([{ type: "text", text: "応答" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("記録の読み出し(get)に失敗したら、記録なしとして実送信する(警告を出す)", async () => {
    const warn = vi.fn();
    const store: LlmResponseStore = {
      get: () => {
        throw new Error("DO のストレージの失敗");
      },
      put: () => undefined,
    };
    const inner = vi.fn(async () => reply("応答"));
    await createRecordingSender(inner, store, warn)(REQUEST);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("outcomeOf(analyzeRace の結果から、LLM が効いたか・画面に出す理由〈固定文言〉を決める。Issue #194)", () => {
  const base: AnalyzeRaceResult = {
    horses: [],
    fallback: false,
    retryCount: 0,
    fallbackReason: null,
    marksDropped: false,
    marksDroppedReason: null,
    rawResponse: "x",
    modelUsed: "claude-sonnet-5-5",
  };

  it("null(LLM を呼ばなかった = キー未登録)は、効いていない・理由は『未登録』", () => {
    expect(outcomeOf(null)).toEqual({ effective: false, note: LLM_NOTE_NO_KEY });
    expect(LLM_NOTE_NO_KEY).toContain("API キーが未登録");
  });

  it("成功(fallback:false・印も採用)は、効いている・理由なし", () => {
    expect(outcomeOf(base)).toEqual({ effective: true, note: null });
  });

  it("印の救済(marksDropped:true。確率の補正は採用)は、効いている・理由は固定の短文(core の marksDroppedReason〈例外のメッセージを含む〉は出さない)", () => {
    const outcome = outcomeOf({ ...base, marksDropped: true, marksDroppedReason: "印関連の制約違反のため…: ◎が2頭 sk-ant-LEAK" });
    expect(outcome).toEqual({ effective: true, note: LLM_NOTE_MARKS_DROPPED });
    expect(outcome.note).not.toContain("sk-ant-");
  });

  it.each([
    [FALLBACK_REASON_TRUNCATED],
    [FALLBACK_REASON_PARSE_ERROR],
    [FALLBACK_REASON_INVOCATION_ERROR],
    [FALLBACK_REASON_REFUSED],
  ])("フォールバック(core の固定文言 %s)は、効いていない・理由はその固定文言そのまま", (reason) => {
    expect(outcomeOf({ ...base, fallback: true, fallbackReason: reason })).toEqual({ effective: false, note: reason });
  });

  it("未知の fallbackReason(core が将来文言を足した・壊れた値)は、そのまま出さず、固定の汎用文にする", () => {
    const outcome = outcomeOf({ ...base, fallback: true, fallbackReason: "429 {sk-ant-LEAK}" });
    expect(outcome).toEqual({ effective: false, note: LLM_NOTE_UNKNOWN_FALLBACK });
    expect(outcomeOf({ ...base, fallback: true, fallbackReason: null })).toEqual({ effective: false, note: LLM_NOTE_UNKNOWN_FALLBACK });
  });

  it("固定文言は、互いに違う(画面で区別できる)", () => {
    const notes = [LLM_NOTE_NO_KEY, LLM_NOTE_MARKS_DROPPED, LLM_NOTE_UNKNOWN_FALLBACK, FALLBACK_REASON_TRUNCATED, FALLBACK_REASON_PARSE_ERROR, FALLBACK_REASON_INVOCATION_ERROR, FALLBACK_REASON_REFUSED];
    expect(new Set(notes).size).toBe(notes.length);
  });
});
