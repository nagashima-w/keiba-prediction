import { describe, expect, it, vi } from "vitest";

import { DiscordNotifyError, type DiscordFetchLike, type DiscordPayload } from "../../packages/core/src/notify/discord";
import { classifyNotifyError, createDiscordNotifier, MAX_RATE_LIMIT_WAIT_MS, NOTIFY_TIMEOUT_MS, webhookStatus } from "../src/notify-send";

/**
 * Issue #205(#166-D) G-D6・G-D2: Webhook の検証、Worker からの送信(core の `sendDiscordNotification` を、注入した fetch・短いタイムアウト・待機の上限つきで呼ぶ)、エラーの分類。
 * **URL の値は、この層より先(DO の状態・ログ・応答)に出ない**: エラーは分類(`http-<status>`・`timeout`・`rate-limited`・`network`・`other`)だけにする。
 */

// 文書用のダミー(実在しない ID とトークン)。
const URL_OK = "https://discord.com/api/webhooks/123456789012345678/dummy-token-for-tests_ABC";
const PAYLOAD: DiscordPayload = { embeds: [{ title: "t", description: "d" }] };

describe("webhookStatus(未登録・形式不正・有効)", () => {
  it.each([
    ["未登録(undefined)", undefined, "absent"],
    ["空文字", "", "absent"],
    ["空白だけ", "  \n\t ", "absent"],
    ["https://discord.com/api/webhooks/…", URL_OK, "valid"],
    ["discordapp.com の旧ホスト", "https://discordapp.com/api/webhooks/1/abc", "valid"],
    ["前後の空白・末尾の改行は取り除く(貼り付けで付く)", `  ${URL_OK}\n`, "valid"],
    ["http(https でない)", "http://discord.com/api/webhooks/1/abc", "invalid"],
    ["別のホスト", "https://example.com/api/webhooks/1/abc", "invalid"],
    ["プレフィックスが途中", "xhttps://discord.com/api/webhooks/1/abc", "invalid"],
    ["文字列でない値(secret は文字列だが、型の防御)", 123 as unknown as string, "absent"],
  ] as const)("%s → %s", (_name, value, expected) => {
    expect(webhookStatus(value)).toBe(expected);
  });
});

describe("createDiscordNotifier(Worker から送る)", () => {
  function okFetch(): { fetch: DiscordFetchLike; calls: { url: string; body: string; signal: AbortSignal | undefined }[] } {
    const calls: { url: string; body: string; signal: AbortSignal | undefined }[] = [];
    const fetch: DiscordFetchLike = async (url, init) => {
      calls.push({ url, body: init.body, signal: init.signal });
      return { status: 204, ok: true, headers: { get: () => null }, text: async () => "" };
    };
    return { fetch, calls };
  }

  it("未登録・形式不正のときは、通知の仕組みそのもの(notifier)を作らない(undefined)", () => {
    expect(createDiscordNotifier(undefined)).toBeUndefined();
    expect(createDiscordNotifier("   ")).toBeUndefined();
    expect(createDiscordNotifier("https://example.com/x")).toBeUndefined();
  });

  it("有効なら、トリムした URL に embed を POST する。fetch を注入する(既定の undici は Worker で使えない)", async () => {
    const { fetch, calls } = okFetch();
    const notifier = createDiscordNotifier(`${URL_OK}\n`, { fetch })!;
    await notifier.send(PAYLOAD);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_OK);
    expect(JSON.parse(calls[0]!.body)).toEqual(PAYLOAD);
  });

  it("タイムアウトは 5 秒(応答が返らなければ打ち切る)", async () => {
    expect(NOTIFY_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    try {
      const hang: DiscordFetchLike = () => new Promise(() => undefined);
      const notifier = createDiscordNotifier(URL_OK, { fetch: hang })!;
      const settled = notifier.send(PAYLOAD).then(
        () => "ok",
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS + 1);
      const error = await settled;
      expect(error).toBeInstanceOf(DiscordNotifyError);
      expect(classifyNotifyError(error)).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("429: Retry-After が上限(5 秒)以内なら待って 1 回だけ再送する。上限を超えるなら待たずに rate-limited の失敗(再送しない)", async () => {
    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(5000);
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const limited = (retryAfter: string): DiscordFetchLike => async () => {
        attempts += 1;
        return attempts === 1
          ? { status: 429, ok: false, headers: { get: (n: string) => (n === "retry-after" ? retryAfter : null) }, text: async () => "" }
          : { status: 204, ok: true, headers: { get: () => null }, text: async () => "" };
      };
      const within = createDiscordNotifier(URL_OK, { fetch: limited("2") })!.send(PAYLOAD);
      await vi.advanceTimersByTimeAsync(2000);
      await within;
      expect(attempts).toBe(2); // 待って 1 回再送した

      attempts = 0;
      const over = createDiscordNotifier(URL_OK, { fetch: limited("6") })!.send(PAYLOAD).then(
        () => "ok",
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      const error = await over;
      expect(attempts).toBe(1); // 再送していない
      expect(classifyNotifyError(error)).toBe("rate-limited");

      attempts = 0;
      const boundary = createDiscordNotifier(URL_OK, { fetch: limited("5") })!.send(PAYLOAD);
      await vi.advanceTimersByTimeAsync(5000);
      await boundary; // 上限ちょうど(5 秒)は待つ
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classifyNotifyError(エラー → 分類。メッセージ・本文・URL は保存しない)", () => {
  const cases: readonly { name: string; error: unknown; expected: string }[] = [
    { name: "HTTP 404", error: new DiscordNotifyError("Webhook が見つかりません", { status: 404, responseBody: "本文" }), expected: "http-404" },
    { name: "HTTP 429", error: new DiscordNotifyError("レート制限", { status: 429 }), expected: "http-429" },
    { name: "HTTP 500", error: new DiscordNotifyError("Discord サーバでエラー", { status: 500 }), expected: "http-500" },
    { name: "タイムアウト(core の文言)", error: new DiscordNotifyError("Discord への送信がタイムアウトしました(5000ms)"), expected: "timeout" },
    { name: "接続の失敗", error: new TypeError("fetch failed"), expected: "network" },
    { name: "ネットワーク切断", error: new Error("Network connection lost."), expected: "network" },
    { name: "それ以外", error: new Error("想定外"), expected: "other" },
    { name: "Error でない値", error: "文字列", expected: "other" },
  ];
  it.each(cases)("$name → $expected", ({ error, expected }) => {
    expect(classifyNotifyError(error)).toBe(expected);
  });

  it("分類の結果に、URL・トークン・本文は入らない(URL を含むメッセージの例外でも)", () => {
    const leaky = [
      new Error(`fetch failed: ${URL_OK}`),
      new Error(`something ${URL_OK} token dummy-token-for-tests_ABC`),
      new DiscordNotifyError(`x ${URL_OK}`, { status: 400, responseBody: URL_OK }),
    ];
    for (const error of leaky) {
      const cls = classifyNotifyError(error);
      expect(cls).toMatch(/^(http-\d{3}|timeout|rate-limited|network|other)$/);
      expect(cls).not.toContain("dummy-token");
      expect(cls).not.toContain("discord.com");
    }
  });
});
