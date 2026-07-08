/**
 * Anthropic 実装(LlmClient)のテスト。
 *
 * 仕様「3. analyzer」/ タスク指示:
 *  - モデルは config で指定可能。デフォルトは claude-sonnet-4-6。
 *  - APIキー未設定でもインスタンス化はエラーにしない(呼び出し時にエラー)。
 *  - SDK呼び出しはこのファイルに閉じ込め、単体テストは「SDKに渡すパラメータの組み立て」と
 *    「レスポンスからのテキスト抽出」を検証する(SDKクライアントは注入/モック)。
 * 実APIは一切呼ばない。
 */

import { describe, expect, it, vi } from "vitest";
import {
  AnthropicLlmClient,
  buildRequestParams,
  DEFAULT_ANALYZER_CONFIG,
  extractText,
  type AnthropicMessageResponse,
  type AnthropicRequestParams,
} from "../../src/analyzer/anthropic-client.js";

describe("buildRequestParams(SDKへ渡すパラメータの組み立て)", () => {
  it("デフォルトモデルは claude-sonnet-4-6 であること", () => {
    expect(DEFAULT_ANALYZER_CONFIG.model).toBe("claude-sonnet-4-6");
    const p = buildRequestParams("PROMPT");
    expect(p.model).toBe("claude-sonnet-4-6");
  });

  it("クリップ幅 maxAdjust のデフォルトは絶対値0.10であること", () => {
    expect(DEFAULT_ANALYZER_CONFIG.maxAdjust).toBe(0.1);
  });

  it("プロンプトを user ロールのメッセージに載せること", () => {
    const p = buildRequestParams("PROMPT");
    expect(p.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  });

  it("max_tokens・temperature がデフォルト値で入ること", () => {
    const p = buildRequestParams("PROMPT");
    expect(p.max_tokens).toBe(DEFAULT_ANALYZER_CONFIG.maxTokens);
    expect(p.temperature).toBe(DEFAULT_ANALYZER_CONFIG.temperature);
  });

  it("config で model・max_tokens・temperature を上書きできること", () => {
    const p = buildRequestParams("PROMPT", {
      model: "claude-opus-4-8",
      maxTokens: 512,
      temperature: 0.3,
    });
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.max_tokens).toBe(512);
    expect(p.temperature).toBe(0.3);
  });
});

describe("extractText(レスポンスからのテキスト抽出)", () => {
  it("text ブロックを連結すること", () => {
    const res: AnthropicMessageResponse = {
      content: [
        { type: "text", text: "こんにちは" },
        { type: "text", text: "世界" },
      ],
    };
    expect(extractText(res)).toBe("こんにちは世界");
  });

  it("text 以外のブロックは無視すること", () => {
    const res: AnthropicMessageResponse = {
      content: [
        { type: "thinking" },
        { type: "text", text: "本文" },
      ],
    };
    expect(extractText(res)).toBe("本文");
  });
});

describe("AnthropicLlmClient", () => {
  it("APIキー未設定でもインスタンス化はエラーにならないこと", () => {
    expect(() => new AnthropicLlmClient()).not.toThrow();
  });

  it("complete: 組み立てたパラメータで sender を呼び、抽出テキストを返すこと", async () => {
    const sender = vi.fn<(params: AnthropicRequestParams) => Promise<AnthropicMessageResponse>>(
      async () => ({
        content: [{ type: "text", text: "応答本文" }],
      }),
    );
    const client = new AnthropicLlmClient(
      { model: "claude-sonnet-4-6", maxTokens: 777 },
      { sender },
    );
    const out = await client.complete("プロンプト本体");
    expect(out).toBe("応答本文");
    expect(sender).toHaveBeenCalledTimes(1);
    const params = sender.mock.calls[0]![0];
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.max_tokens).toBe(777);
    expect(params.messages[0]).toEqual({ role: "user", content: "プロンプト本体" });
  });
});
