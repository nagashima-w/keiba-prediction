/**
 * Anthropic 実装(LlmClient)のテスト。
 *
 * 仕様「3. analyzer」/ Issue #157(claude-sonnet-5-5 への移行):
 *  - 既定(固定)モデルは claude-sonnet-5-5。config で指定可能。
 *  - temperature は送らない(Sonnet 5.5 は既定値以外を 400 で拒否する)。
 *    代わりに output_config.effort(既定 "low")を送る。thinking は送らない。
 *  - max_tokens は 16000(非ストリーミングのまま。SDK 0.70.1 は 21333 超で例外を投げる)。
 *  - APIキー未設定でもインスタンス化はエラーにしない(呼び出し時にエラー)。
 *  - stop_reason==="refusal" は AnalyzerRefusalError、"max_tokens" は AnalyzerTruncationError。
 *  - モデルの自動選択(ModelSelector)を注入すると、最新 Sonnet を使い、400/403/404 のときだけ
 *    固定モデルで1回やり直す。降格は selector が覚える。
 *  - 実際に使ったモデル(レスポンスの model を優先)を completeDetailed が返す。
 * SDK呼び出しはこのファイルに閉じ込め、単体テストは「SDKに渡すパラメータの組み立て」と
 * 「レスポンスからのテキスト抽出」「切り替え制御」を検証する。実APIは一切呼ばない
 * (SDK 既定 sender の検証は fetch を差し替えて、ネットワークに出ずにリクエスト本文を捕捉する)。
 *
 * 旧テスト(Issue #157 以前)との対応表(契約変更で書き換えたものの「何を保証していたか」):
 *  - 「デフォルトモデルは claude-sonnet-4-6」→ 値のみ変更。固定モデルが DEFAULT_ANALYZER_CONFIG と
 *    buildRequestParams の両方に反映される保証は維持(「既定モデルは claude-sonnet-5-5」)
 *  - 「デフォルトの maxTokens は8192」→ 値のみ変更(16000)。config と params の両方で確認する保証は維持
 *  - 「maxAdjust のデフォルトは0.10」→ 無変更
 *  - 「プロンプトを user ロールのメッセージに載せる」→ 無変更
 *  - 「max_tokens・temperature がデフォルト値で入る」→ max_tokens の保証は維持。temperature の保証は
 *    「params に temperature キー自体が無い」に反転(Sonnet 5.5 の仕様)。effort の保証を追加
 *  - 「config で model・max_tokens・temperature を上書きできる」→ model・max_tokens の保証は維持。
 *    temperature は「config に渡しても(型の外から)params に載らない」へ反転。effort の上書きを追加
 *  - extractText・APIキー未設定・complete の送信/抽出・max_tokens の切り詰め・stop_reason 各値は無変更
 */

import { describe, expect, it, vi } from "vitest";
import {
  AnalyzerRefusalError,
  AnalyzerTruncationError,
} from "../../src/analyzer/parse-response.js";
import {
  AnthropicLlmClient,
  buildRequestParams,
  createSdkMessageSender,
  DEFAULT_ANALYZER_CONFIG,
  extractText,
  type AnalyzerConfig,
  type AnthropicMessageResponse,
  type AnthropicRequestParams,
} from "../../src/analyzer/anthropic-client.js";
import {
  createModelSelector,
  createSdkModelLister,
  type ModelInfoLite,
} from "../../src/analyzer/model-selection.js";

type SenderFn = (params: AnthropicRequestParams) => Promise<AnthropicMessageResponse>;

/** HTTP ステータスを持つ SDK 風エラー(Anthropic.APIError は status を持つ)。 */
function statusError(status: number | undefined): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

describe("buildRequestParams(SDKへ渡すパラメータの組み立て)", () => {
  it("既定モデルは claude-sonnet-5-5 であること", () => {
    expect(DEFAULT_ANALYZER_CONFIG.model).toBe("claude-sonnet-5-5");
    const p = buildRequestParams("PROMPT");
    expect(p.model).toBe("claude-sonnet-5-5");
  });

  it("既定の maxTokens は16000であること(非ストリーミングのまま。SDK 0.70.1 の上限21333未満)", () => {
    expect(DEFAULT_ANALYZER_CONFIG.maxTokens).toBe(16000);
    expect(DEFAULT_ANALYZER_CONFIG.maxTokens).toBeLessThanOrEqual(21333);
    const p = buildRequestParams("PROMPT");
    expect(p.max_tokens).toBe(16000);
  });

  it("クリップ幅 maxAdjust のデフォルトは絶対値0.10であること", () => {
    expect(DEFAULT_ANALYZER_CONFIG.maxAdjust).toBe(0.1);
  });

  it("プロンプトを user ロールのメッセージに載せること", () => {
    const p = buildRequestParams("PROMPT");
    expect(p.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  });

  it("max_tokens が既定値で入り、temperature は送らず、output_config.effort は 'low' であること", () => {
    const p = buildRequestParams("PROMPT");
    expect(p.max_tokens).toBe(DEFAULT_ANALYZER_CONFIG.maxTokens);
    expect("temperature" in p).toBe(false);
    expect(DEFAULT_ANALYZER_CONFIG.effort).toBe("low");
    expect(p.output_config).toEqual({ effort: "low" });
  });

  it("thinking は送らないこと(既定の adaptive に任せる)", () => {
    const p = buildRequestParams("PROMPT");
    expect("thinking" in p).toBe(false);
  });

  it("AnalyzerConfig に temperature は無いこと(既定設定のキー列で固定)", () => {
    expect(Object.keys(DEFAULT_ANALYZER_CONFIG).sort()).toEqual(
      ["effort", "maxAdjust", "maxTokens", "model"].sort(),
    );
  });

  it("config で model・max_tokens・effort を上書きできること", () => {
    const p = buildRequestParams("PROMPT", {
      model: "claude-opus-4-8",
      maxTokens: 512,
      effort: "high",
    });
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.max_tokens).toBe(512);
    expect(p.output_config).toEqual({ effort: "high" });
  });

  it("旧 temperature を(型の外から)config に渡しても params に載らないこと", () => {
    const legacy = { temperature: 0.3 } as unknown as Partial<AnalyzerConfig>;
    const p = buildRequestParams("PROMPT", legacy);
    expect("temperature" in p).toBe(false);
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
      content: [{ type: "thinking" }, { type: "text", text: "本文" }],
    };
    expect(extractText(res)).toBe("本文");
  });
});

describe("AnthropicLlmClient(モデル自動選択なし)", () => {
  it("APIキー未設定でもインスタンス化はエラーにならないこと", () => {
    expect(() => new AnthropicLlmClient()).not.toThrow();
  });

  it("complete: 組み立てたパラメータで sender を呼び、抽出テキストを返すこと", async () => {
    const sender = vi.fn<SenderFn>(async () => ({
      content: [{ type: "text", text: "応答本文" }],
    }));
    const client = new AnthropicLlmClient(
      { model: "claude-sonnet-5-5", maxTokens: 777 },
      { sender },
    );
    const out = await client.complete("プロンプト本体");
    expect(out).toBe("応答本文");
    expect(sender).toHaveBeenCalledTimes(1);
    const params = sender.mock.calls[0]![0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(777);
    expect(params.output_config).toEqual({ effort: "low" });
    expect("temperature" in params).toBe(false);
    expect(params.messages[0]).toEqual({ role: "user", content: "プロンプト本体" });
  });

  it("complete: stop_reason='max_tokens' のとき text を返さず AnalyzerTruncationError を投げること", async () => {
    const sender = vi.fn<SenderFn>(async () => ({
      content: [{ type: "text", text: "切り詰められた途中まで" }],
      stop_reason: "max_tokens",
    }));
    const client = new AnthropicLlmClient({}, { sender });
    await expect(client.complete("プロンプト")).rejects.toThrow(AnalyzerTruncationError);
  });

  it("complete: stop_reason='max_tokens' で投げる AnalyzerTruncationError が生の stop_reason を保持すること", async () => {
    const sender = vi.fn<SenderFn>(async () => ({
      content: [{ type: "text", text: "切り詰められた途中まで" }],
      stop_reason: "max_tokens",
    }));
    const client = new AnthropicLlmClient({}, { sender });
    try {
      await client.complete("プロンプト");
      throw new Error("AnalyzerTruncationError が投げられませんでした");
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerTruncationError);
      expect((e as AnalyzerTruncationError).stopReason).toBe("max_tokens");
    }
  });

  it("complete: stop_reason='refusal' のとき text(空でも)を返さず AnalyzerRefusalError を投げ、生の stop_reason を保持すること", async () => {
    const sender = vi.fn<SenderFn>(async () => ({
      content: [],
      stop_reason: "refusal",
    }));
    const client = new AnthropicLlmClient({}, { sender });
    try {
      await client.complete("プロンプト");
      throw new Error("AnalyzerRefusalError が投げられませんでした");
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerRefusalError);
      // 切り詰めとは別のクラスであること(analyzeRace が別の固定文言に振り分けるため)
      expect(e).not.toBeInstanceOf(AnalyzerTruncationError);
      expect((e as AnalyzerRefusalError).stopReason).toBe("refusal");
    }
  });

  it.each([
    { stop: "refusal", cls: AnalyzerRefusalError },
    { stop: "max_tokens", cls: AnalyzerTruncationError },
  ] as const)(
    "complete: stop_reason='$stop' で投げるエラーが、応答したモデル(レスポンスの model 優先・無ければリクエストしたID)を保持すること",
    async ({ stop, cls }) => {
      // 前提: 応答したモデルとリクエストしたモデルが異なる(でなければ優先順位を検出できない)
      const requested = "claude-requested";
      const served = "claude-sonnet-9-9";
      expect(served).not.toBe(requested);

      const withModel = vi.fn<SenderFn>(async () => ({
        content: [],
        stop_reason: stop,
        model: served,
      }));
      await expect(
        new AnthropicLlmClient({ model: requested }, { sender: withModel }).complete("p"),
      ).rejects.toSatisfy((e: unknown) => e instanceof cls && e.model === served);

      const noModel = vi.fn<SenderFn>(async () => ({ content: [], stop_reason: stop }));
      await expect(
        new AnthropicLlmClient({ model: requested }, { sender: noModel }).complete("p"),
      ).rejects.toSatisfy((e: unknown) => e instanceof cls && e.model === requested);
    },
  );

  it.each(["end_turn", "tool_use", "stop_sequence", undefined, null] as const)(
    "complete: stop_reason=%s では切り詰め・拒否扱いにせずテキストを返すこと",
    async (stopReason) => {
      const sender = vi.fn<SenderFn>(async () => ({
        content: [{ type: "text", text: "通常応答" }],
        stop_reason: stopReason ?? undefined,
      }));
      const client = new AnthropicLlmClient({}, { sender });
      await expect(client.complete("プロンプト")).resolves.toBe("通常応答");
    },
  );

  it("completeDetailed: レスポンスの model を優先して返し、無ければリクエストしたモデルIDを返すこと", async () => {
    const withModel = vi.fn<SenderFn>(async () => ({
      content: [{ type: "text", text: "A" }],
      model: "claude-sonnet-5-5-served",
    }));
    const a = await new AnthropicLlmClient({ model: "claude-requested" }, { sender: withModel })
      .completeDetailed("p");
    expect(a).toEqual({ text: "A", model: "claude-sonnet-5-5-served" });

    const noModel = vi.fn<SenderFn>(async () => ({ content: [{ type: "text", text: "B" }] }));
    const b = await new AnthropicLlmClient({ model: "claude-requested" }, { sender: noModel })
      .completeDetailed("p");
    expect(b).toEqual({ text: "B", model: "claude-requested" });
  });
});

describe("AnthropicLlmClient(モデル自動選択あり・固定モデルへの切り替え)", () => {
  const FIXED = DEFAULT_ANALYZER_CONFIG.model;
  const AUTO = "claude-sonnet-9-9";
  const MODELS: ModelInfoLite[] = [
    { id: "claude-sonnet-4-6", created_at: "2026-02-01T00:00:00Z" },
    { id: AUTO, created_at: "2027-01-01T00:00:00Z" },
    { id: FIXED, created_at: "2026-09-01T00:00:00Z" },
  ];

  function setup(sender: SenderFn, models: ModelInfoLite[] = MODELS) {
    const onWarn = vi.fn<(m: string) => void>();
    const selector = createModelSelector({
      lister: async () => models,
      fixedModel: FIXED,
      onWarn,
    });
    const client = new AnthropicLlmClient({}, { sender, modelSelector: selector, onWarn });
    return { client, selector, onWarn };
  }

  it("前提: 自動選択されるモデルは固定モデルと異なること", async () => {
    const { selector } = setup(async () => ({ content: [] }));
    const auto = await selector.resolve();
    expect(auto).toBe(AUTO);
    expect(auto).not.toBe(FIXED);
  });

  it("最初のリクエストは自動選択モデルで送ること", async () => {
    const sender = vi.fn<SenderFn>(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const { client } = setup(sender);
    await client.complete("p");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]![0].model).toBe(AUTO);
  });

  it.each([400, 403, 404])(
    "自動選択モデルが HTTP %i を返したら固定モデルで1回やり直し、成功すれば固定モデルを使用モデルとして返すこと",
    async (status) => {
      const sender = vi.fn<SenderFn>(async (params) => {
        if (params.model === AUTO) throw statusError(status);
        return { content: [{ type: "text", text: "固定で成功" }] };
      });
      const { client } = setup(sender);
      const out = await client.completeDetailed("p");
      expect(out).toEqual({ text: "固定で成功", model: FIXED });
      expect(sender).toHaveBeenCalledTimes(2);
      expect(sender.mock.calls.map((c) => c[0].model)).toEqual([AUTO, FIXED]);
    },
  );

  it("降格は覚えること: 切り替え後の次回リクエストは最初から固定モデルで、自動選択モデルを再試行しないこと", async () => {
    const sender = vi.fn<SenderFn>(async (params) => {
      if (params.model === AUTO) throw statusError(400);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const { client } = setup(sender);
    await client.complete("1回目");
    expect(sender.mock.calls.map((c) => c[0].model)).toEqual([AUTO, FIXED]);
    await client.complete("2回目");
    expect(sender.mock.calls.map((c) => c[0].model)).toEqual([AUTO, FIXED, FIXED]);
  });

  it("降格は別の AnthropicLlmClient インスタンス(1レースごとに new される)にも引き継がれること(selector が覚える)", async () => {
    const sender = vi.fn<SenderFn>(async (params) => {
      if (params.model === AUTO) throw statusError(403);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const onWarn = vi.fn<(m: string) => void>();
    const selector = createModelSelector({ lister: async () => MODELS, fixedModel: FIXED, onWarn });
    await new AnthropicLlmClient({}, { sender, modelSelector: selector }).complete("レース1");
    await new AnthropicLlmClient({}, { sender, modelSelector: selector }).complete("レース2");
    expect(sender.mock.calls.map((c) => c[0].model)).toEqual([AUTO, FIXED, FIXED]);
  });

  it("切り替えが起きたことを onWarn に残すこと(自動選択モデルと固定モデルの両方を含む)", async () => {
    const sender = vi.fn<SenderFn>(async (params) => {
      if (params.model === AUTO) throw statusError(404);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const { client, onWarn } = setup(sender);
    await client.complete("p");
    const messages = onWarn.mock.calls.map((c) => c[0]);
    const switched = messages.filter((m) => m.includes(AUTO) && m.includes(FIXED));
    expect(switched).toHaveLength(1);
  });

  it.each([401, 429, 500, 502, 503, 529, undefined])(
    "HTTP %s(認証・レート制限・5xx・ネットワーク)では切り替えず、そのまま投げて1回しか送らないこと",
    async (status) => {
      const sender = vi.fn<SenderFn>(async () => {
        throw statusError(status);
      });
      const { client } = setup(sender);
      await expect(client.complete("p")).rejects.toThrow();
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender.mock.calls[0]![0].model).toBe(AUTO);
      // 降格していないこと(次回も自動選択モデルから始まる)
      await expect(client.complete("p")).rejects.toThrow();
      expect(sender.mock.calls.map((c) => c[0].model)).toEqual([AUTO, AUTO]);
    },
  );

  it("refusal・max_tokens では切り替えず、専用エラーを1回の送信で投げること", async () => {
    const refusal = vi.fn<SenderFn>(async () => ({ content: [], stop_reason: "refusal" }));
    await expect(setup(refusal).client.complete("p")).rejects.toThrow(AnalyzerRefusalError);
    expect(refusal).toHaveBeenCalledTimes(1);

    const truncated = vi.fn<SenderFn>(async () => ({
      content: [{ type: "text", text: "途中" }],
      stop_reason: "max_tokens",
    }));
    await expect(setup(truncated).client.complete("p")).rejects.toThrow(AnalyzerTruncationError);
    expect(truncated).toHaveBeenCalledTimes(1);
  });

  it("自動選択モデルが固定モデルと同じなら、400 でもやり直さないこと", async () => {
    // 前提: 一覧の最新 Sonnet が固定モデルそのもの
    const only: ModelInfoLite[] = [{ id: FIXED, created_at: "2026-09-01T00:00:00Z" }];
    const sender = vi.fn<SenderFn>(async () => {
      throw statusError(400);
    });
    const { client, selector } = setup(sender, only);
    expect(await selector.resolve()).toBe(FIXED);
    await expect(client.complete("p")).rejects.toThrow();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("固定モデルでのやり直しも失敗したらそのエラーを投げること(送信は2回まで)", async () => {
    const sender = vi.fn<SenderFn>(async (params) => {
      throw statusError(params.model === AUTO ? 400 : 500);
    });
    const { client } = setup(sender);
    await expect(client.complete("p")).rejects.toThrow("HTTP 500");
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("一覧取得に失敗した場合は固定モデルで送ること(切り替えは発生しない)", async () => {
    const sender = vi.fn<SenderFn>(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const onWarn = vi.fn<(m: string) => void>();
    const selector = createModelSelector({
      lister: async () => {
        throw new Error("一覧取得失敗");
      },
      fixedModel: FIXED,
      onWarn,
    });
    const client = new AnthropicLlmClient({}, { sender, modelSelector: selector, onWarn });
    await client.complete("p");
    expect(sender.mock.calls.map((c) => c[0].model)).toEqual([FIXED]);
  });
});

describe("createSdkMessageSender(SDK 既定 sender。fetch を差し替えて本文を捕捉・実APIは呼ばない)", () => {
  /** リクエストを捕捉して固定のメッセージ応答を返す fetch。 */
  function fakeFetch() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
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
    return { calls, fetchImpl };
  }

  it("リクエスト本文に output_config.effort と max_tokens を載せ、temperature・thinking は載せないこと", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sender = createSdkMessageSender({
      apiKey: "sk-ant-fake-test-key-not-real",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const client = new AnthropicLlmClient({}, { sender });
    const out = await client.completeDetailed("プロンプト");
    expect(out).toEqual({ text: "応答", model: "claude-sonnet-5-5" });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBe(16000);
    expect(body.output_config).toEqual({ effort: "low" });
    expect("temperature" in body).toBe(false);
    expect("thinking" in body).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "プロンプト" }]);
  });
});

describe("createSdkMessageSender の応答の usage(Issue #197・段2: LLM の使用量〈入力・出力トークン〉の記録の元)", () => {
  /** usage と stop_reason を指定して返す fetch(実 API には出ない)。 */
  function fetchWithUsage(usage: Record<string, unknown>, stopReason: string) {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "応答" }],
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it("SDK の応答の usage(input_tokens・output_tokens)が、型 AnthropicMessageResponse.usage として、そのまま sender の戻り値に載る", async () => {
    const fetchImpl = fetchWithUsage({ input_tokens: 12345, output_tokens: 6789, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "end_turn");
    const sender = createSdkMessageSender({ apiKey: "sk-ant-fake-test-key-not-real", fetch: fetchImpl as unknown as typeof fetch });
    const res: AnthropicMessageResponse = await sender(buildRequestParams("p"));
    expect(res.usage?.input_tokens).toBe(12345);
    expect(res.usage?.output_tokens).toBe(6789);
    expect(res.stop_reason).toBe("end_turn");
  });

  it("max_tokens で切り詰められた応答でも usage は返る(出力トークン数が上限に張り付くことを、切り詰めの診断に使う)", async () => {
    const fetchImpl = fetchWithUsage({ input_tokens: 100, output_tokens: 16000 }, "max_tokens");
    const sender = createSdkMessageSender({ apiKey: "sk-ant-fake-test-key-not-real", fetch: fetchImpl as unknown as typeof fetch });
    const res = await sender(buildRequestParams("p"));
    expect(res.stop_reason).toBe("max_tokens");
    expect(res.usage).toMatchObject({ input_tokens: 100, output_tokens: 16000 });
  });
});

describe("createSdkModelLister(Models API。fetch を差し替え・実APIは呼ばない)", () => {
  it("全ページを辿って id と created_at を返すこと", async () => {
    const pages = [
      {
        data: [
          { type: "model", id: "claude-sonnet-5-5", display_name: "S", created_at: "2026-09-01T00:00:00Z" },
        ],
        has_more: true,
        first_id: "claude-sonnet-5-5",
        last_id: "claude-sonnet-5-5",
      },
      {
        data: [
          { type: "model", id: "claude-sonnet-4-6", display_name: "S4", created_at: "2026-02-01T00:00:00Z" },
        ],
        has_more: false,
        first_id: "claude-sonnet-4-6",
        last_id: "claude-sonnet-4-6",
      },
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      const page = pages[urls.length - 1]!;
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const lister = createSdkModelLister({
      apiKey: "sk-ant-fake-test-key-not-real",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const models = await lister();
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-sonnet-4-6"]);
    expect(models.map((m) => m.created_at)).toEqual(["2026-09-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.includes("/v1/models"))).toBe(true);
  });
});

/**
 * Issue #193(#179-a): `createSdkMessageSender`・`createSdkModelLister` の省略可のオプション `timeout`・`maxRetries`。
 * クラウド版(Worker の DO のアラーム)が、SDK の既定(再試行 2 回・10 分)に任せず、呼び出しの上限を自分で決めるための口。
 * **exe はどちらも渡さない**ので、省略時は SDK の既定のまま(再試行は初回 + 2 回の計3本)であることも固定する。
 * すべて fetch を差し替え、実 API には出ない。待ちは `retry-after-ms: 1`(SDK が従う非標準ヘッダ)で 1ms に縮める。
 */
describe("SDK の timeout・maxRetries の口(Issue #193)", () => {
  const FAKE_KEY = "sk-ant-fake-test-key-not-real";
  const REQUEST: AnthropicRequestParams = {
    model: "claude-sonnet-5-5",
    max_tokens: 10,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "p" }],
  };

  /** 常に 429(再試行の対象)を返し、呼び出し回数を数える fetch。 */
  function alwaysRateLimited() {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    });
    return fetchImpl;
  }

  /** abort されるまで応答しない fetch(タイムアウトの対象)。呼び出し回数を数える。 */
  function hangsUntilAborted() {
    return vi.fn((_url: unknown, init?: { signal?: AbortSignal | null }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
  }

  describe("createSdkMessageSender", () => {
    it("省略時は SDK の既定の再試行(初回 + 2 回 = 3 本)のまま(exe の挙動を変えない)", async () => {
      const fetchImpl = alwaysRateLimited();
      const sender = createSdkMessageSender({ apiKey: FAKE_KEY, fetch: fetchImpl as unknown as typeof fetch });
      await expect(sender(REQUEST)).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it.each([
      [0, 1],
      [1, 2],
    ])("maxRetries=%i なら、429 でも HTTP は %i 本だけ(値がそのまま SDK に渡る。0 だけの特別扱いではない)", async (maxRetries, expectedCalls) => {
      const fetchImpl = alwaysRateLimited();
      const sender = createSdkMessageSender({ apiKey: FAKE_KEY, fetch: fetchImpl as unknown as typeof fetch, maxRetries });
      await expect(sender(REQUEST)).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(expectedCalls);
    });

    it("timeout(ミリ秒)を渡すと、応答が来ないリクエストをその時間で打ち切り、maxRetries=0 なら再送しない", async () => {
      const fetchImpl = hangsUntilAborted();
      const sender = createSdkMessageSender({
        apiKey: FAKE_KEY,
        fetch: fetchImpl as unknown as typeof fetch,
        timeout: 50,
        maxRetries: 0,
      });
      const started = Date.now();
      // 打ち切りは例外になる(メッセージの中身は問わない。SDK の版で変わる)。
      await expect(sender(REQUEST)).rejects.toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(5_000); // 既定の 10 分ではなく、渡した 50ms で切れている
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("createSdkModelLister(Models API。一覧の取得が、アラームの中で際限なく待たないための口)", () => {
    it("省略時は SDK の既定の再試行(3 本)のまま", async () => {
      const fetchImpl = alwaysRateLimited();
      const lister = createSdkModelLister({ apiKey: FAKE_KEY, fetch: fetchImpl as unknown as typeof fetch });
      await expect(lister()).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("maxRetries=0 なら 1 本だけ", async () => {
      const fetchImpl = alwaysRateLimited();
      const lister = createSdkModelLister({ apiKey: FAKE_KEY, fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
      await expect(lister()).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("timeout を渡すと、応答が来ない一覧の取得をその時間で打ち切る", async () => {
      const fetchImpl = hangsUntilAborted();
      const lister = createSdkModelLister({
        apiKey: FAKE_KEY,
        fetch: fetchImpl as unknown as typeof fetch,
        timeout: 50,
        maxRetries: 0,
      });
      const started = Date.now();
      await expect(lister()).rejects.toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
