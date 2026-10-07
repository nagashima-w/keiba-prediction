import { describe, expect, it, vi } from "vitest";

import type { AnthropicRequestParams } from "@keiba/core/llm";
import { createCloudLlmSender, createCloudModelLister, LLM_LIST_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_SDK_MAX_RETRIES } from "../src/llm-sender";

/**
 * Issue #193(#179-a): クラウド版の LLM の sender・モデル一覧の取得器の組み立て(土台。まだ本番の入口〈worker.ts〉からは呼ばれない。呼び出し元は #194)。
 * クラウド版は、SDK の既定(再試行 2 回・10 分)に任せず、**再試行 0・上限時間あり**で呼ぶ(`analyzeRace` がすでに1回再送する。DO のアラームの中で際限なく待たない)。
 * すべて fetch を差し替え、実 API には出ない。
 */

const REQUEST: AnthropicRequestParams = {
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  output_config: { effort: "low" },
  messages: [{ role: "user", content: "p" }],
};

function rateLimited() {
  return vi.fn(async () => {
    return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  });
}

describe("クラウド版の LLM の呼び出しの設定値(Issue #193)", () => {
  it("sender の上限は 180 秒(ゲートの決定。実 API で測ってから調整する暫定値)・SDK の再試行は 0 回", () => {
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(LLM_SDK_MAX_RETRIES).toBe(0);
    // 最悪(sender 3 回)でも、DO のアラームの壁時計の上限(15 分)に収まる
    expect(3 * LLM_REQUEST_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
  });

  it("モデル一覧の取得の上限は、sender より短い(失敗しても固定モデルに戻るだけなので、長く待たない)", () => {
    expect(LLM_LIST_TIMEOUT_MS).toBe(30_000);
    expect(LLM_LIST_TIMEOUT_MS).toBeLessThan(LLM_REQUEST_TIMEOUT_MS);
  });
});

describe("createCloudLlmSender", () => {
  it("429 でも HTTP は1本だけ(SDK の内部再試行をしない)。例外は status を持つ", async () => {
    const fetchImpl = rateLimited();
    const sender = createCloudLlmSender("sk-ant-fake-test-key-not-real", fetchImpl as unknown as typeof fetch);
    await expect(sender(REQUEST)).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("成功の応答は、そのまま返す(リクエスト本文に model・max_tokens・output_config を載せる)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "応答" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const sender = createCloudLlmSender("sk-ant-fake-test-key-not-real", fetchImpl as unknown as typeof fetch);
    const res = await sender(REQUEST);
    expect(res.content).toEqual([{ type: "text", text: "応答" }]);
    expect(res.stop_reason).toBe("end_turn");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 10, output_config: { effort: "low" } });
  });
});

describe("createCloudModelLister", () => {
  it("429 でも HTTP は1本だけ。成功すれば id と created_at を返す", async () => {
    const limited = rateLimited();
    const failing = createCloudModelLister("sk-ant-fake-test-key-not-real", limited as unknown as typeof fetch);
    await expect(failing()).rejects.toMatchObject({ status: 429 });
    expect(limited).toHaveBeenCalledTimes(1);

    const ok = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ type: "model", id: "claude-sonnet-5-5", display_name: "S", created_at: "2026-09-01T00:00:00Z" }],
          has_more: false,
          first_id: "claude-sonnet-5-5",
          last_id: "claude-sonnet-5-5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const lister = createCloudModelLister("sk-ant-fake-test-key-not-real", ok as unknown as typeof fetch);
    expect(await lister()).toEqual([{ id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" }]);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
