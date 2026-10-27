/**
 * Issue #324: SDK(`@anthropic-ai/sdk`)が実際に送るリクエストと、エラー・応答の扱いの固定(偽 fetch。実 API には出ない)。
 *
 * 目的: SDK を上げたとき(0.70.1 → 0.133.0 → 1.2.0)に、API へ送るもの(URL・メソッド・本文・主要ヘッダ)と、
 * 呼び出し側が頼っている性質(エラーの `.status`・再試行しないこと・タイムアウトの扱い・応答のテキスト抽出)が変わっていないことを、
 * 実 API を使わずに確かめる。0.70.1 → 0.133.0 では、更新の前後で同じテストが通った。1.0.0 では API の版(`anthropic-version`)が 2023-06-01 → 2026-10-21 に、
 * API キーを送るヘッダが `x-api-key` → `Authorization: Bearer` に変わった(SDK のソースの差分と、偽 fetch での実測で確認)ので、その 2 点だけ期待値を書き換えた。
 *
 * 固定しないもの: SDK 内部のヘッダ(`x-stainless-*` の版・ランタイム情報、`user-agent` の版数)。
 * `user-agent` は「Anthropic/JS <版>」の形だけを見る。
 */
import { describe, expect, it, vi } from "vitest";
import { createSdkMessageSender, extractText, type AnthropicRequestParams } from "../../src/analyzer/anthropic-client.js";
import { createSdkModelLister } from "../../src/analyzer/model-selection.js";

const KEY = "sk-ant-fake-test-key-not-real";
const REQUEST: AnthropicRequestParams = {
  model: "claude-sonnet-5-5",
  max_tokens: 16000,
  output_config: { effort: "low" },
  messages: [{ role: "user", content: "プロンプト" }],
};

interface Captured {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/** 受け取った内容を記録し、渡された本文・状態で応答する偽 fetch。 */
function capturingFetch(status: number, responseBody: unknown) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url: String(url),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  });
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

const MESSAGE_OK = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "thinking", thinking: "考え中", signature: "sig" },
    { type: "text", text: "こんにちは" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 4 },
};

describe("messages の送信リクエスト(createSdkMessageSender)", () => {
  it("URL・メソッド・本文・主要ヘッダが固定されている", async () => {
    const { calls, fetchImpl } = capturingFetch(200, MESSAGE_OK);
    await createSdkMessageSender({ apiKey: KEY, fetch: fetchImpl, timeout: 180_000, maxRetries: 0 })(REQUEST);
    // 前提(空振り防止): 偽 fetch は 1 本だけ受け取った
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.method).toBe("POST");
    // 本文は組み立てた 4 項目だけ(temperature・thinking を送らない。キー順も含めて固定)
    expect(c.body).toBe(
      JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 16000,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "プロンプト" }],
      }),
    );
    // SDK 1.0.0(API の版 2026-10-21)から、API キーは `Authorization: Bearer` で送られ、`x-api-key` は付かない(0.135.0 までは逆)
    expect(c.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(c.headers["x-api-key"]).toBeUndefined();
    expect(c.headers["anthropic-version"]).toBe("2026-10-21");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers["accept"]).toBe("application/json");
    expect(c.headers["user-agent"]).toMatch(/^Anthropic\/JS \d+\.\d+\.\d+$/);
    // 再試行しない設定(cloud と同じ)が実際に効いている / 上限時間(秒)が SDK に渡っている
    expect(c.headers["x-stainless-retry-count"]).toBe("0");
    expect(c.headers["x-stainless-timeout"]).toBe("180");
    // 余計なベータのヘッダは付かない(認証のヘッダは上で `authorization` の 1 系統だけを固定した)
    expect(c.headers["anthropic-beta"]).toBeUndefined();
  });

  it("応答(thinking+text)から、text ブロックだけがテキストとして取り出せ、使用量・停止理由・モデルが落ちずに返る", async () => {
    const { fetchImpl } = capturingFetch(200, MESSAGE_OK);
    const res = await createSdkMessageSender({ apiKey: KEY, fetch: fetchImpl, maxRetries: 0 })(REQUEST);
    expect(res.stop_reason).toBe("end_turn");
    expect(res.model).toBe("claude-sonnet-5-5");
    expect(res.usage).toMatchObject({ input_tokens: 3, output_tokens: 4 });
    // 前提: thinking ブロックが実際に含まれている(text だけの応答ではない)
    expect(res.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(extractText(res)).toBe("こんにちは");
  });

  it("stop_reason の refusal・max_tokens が、そのまま呼び出し側へ返る", async () => {
    for (const stop of ["refusal", "max_tokens"]) {
      const { fetchImpl } = capturingFetch(200, { ...MESSAGE_OK, stop_reason: stop });
      const res = await createSdkMessageSender({ apiKey: KEY, fetch: fetchImpl, maxRetries: 0 })(REQUEST);
      expect(res.stop_reason, stop).toBe(stop);
    }
  });
});

describe("Models API の送信リクエスト(createSdkModelLister)", () => {
  it("URL・メソッド・主要ヘッダが固定され、一覧の id・created_at が返る", async () => {
    const { calls, fetchImpl } = capturingFetch(200, {
      data: [{ id: "claude-sonnet-5-5", created_at: "2026-01-01T00:00:00Z", display_name: "S", type: "model" }],
      has_more: false,
      first_id: "claude-sonnet-5-5",
      last_id: "claude-sonnet-5-5",
    });
    const models = await createSdkModelLister({ apiKey: KEY, fetch: fetchImpl, timeout: 30_000, maxRetries: 0 })();
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(c.method).toBe("GET");
    expect(c.body).toBeUndefined();
    expect(c.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(c.headers["x-api-key"]).toBeUndefined();
    expect(c.headers["anthropic-version"]).toBe("2026-10-21");
    expect(c.headers["x-stainless-retry-count"]).toBe("0");
    expect(models).toEqual([{ id: "claude-sonnet-5-5", created_at: "2026-01-01T00:00:00Z" }]);
  });
});

describe("エラーの扱い(model-selection の切り替えが頼る `.status`。maxRetries=0 で再試行しない)", () => {
  const ERROR_BODY = { type: "error", error: { type: "api_error", message: "テスト" } };

  it.each([400, 401, 403, 404, 429, 500, 529])("HTTP %i: 例外の status がその値で、HTTP は 1 本だけ(再試行しない)", async (status) => {
    const { calls, fetchImpl } = capturingFetch(status, ERROR_BODY);
    const err = await createSdkMessageSender({ apiKey: KEY, fetch: fetchImpl, maxRetries: 0 })(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: unknown }).status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it("応答しない fetch は上限時間で打ち切られ、status の無い例外になる(切り替え対象の 400/403/404 に当たらない)", async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const err = await createSdkMessageSender({ apiKey: KEY, fetch: hang, timeout: 200, maxRetries: 0 })(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: unknown }).status).toBeUndefined();
    expect((err as Error).message).toMatch(/timed out/i);
  });

  it("ネットワーク失敗(fetch が投げる)は status の無い例外になる", async () => {
    const fail = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await createSdkMessageSender({ apiKey: KEY, fetch: fail, maxRetries: 0 })(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: unknown }).status).toBeUndefined();
  });
});
