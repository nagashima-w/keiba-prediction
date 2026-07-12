/**
 * Discord Webhook 通知クライアントのテスト。
 *
 * 仕様「技術スタック(通知: Discord Webhook)」「5. ui(Discordに送信/自動送信)」に対応。
 * 純ロジック(URL検証・Retry-After解釈・切り詰め・embed整形)はテーブル駆動で固定し、
 * 送信(sendDiscordNotification)は fetch を注入したモックのみで検証する(実Discordへは送らない)。
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildAnalysisEmbed,
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_TITLE_MAX,
  DiscordNotifyError,
  isDiscordWebhookUrl,
  parseRetryAfterMs,
  sendDiscordNotification,
  truncate,
  type DiscordFetchLike,
  type DiscordFetchResponse,
  type EmbedHorse,
  type EmbedRaceInfo,
} from "../../src/notify/discord.js";

/** テスト用の疑似レスポンスを組み立てる。 */
function makeResponse(init: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}): DiscordFetchResponse {
  const headers = init.headers ?? {};
  return {
    status: init.status,
    ok: init.status >= 200 && init.status <= 299,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => init.body ?? "",
  };
}

describe("isDiscordWebhookUrl(送信前のURL検証)", () => {
  const cases: ReadonlyArray<{ url: string; expected: boolean; note: string }> = [
    {
      url: "https://discord.com/api/webhooks/123/abc",
      expected: true,
      note: "discord.com の webhooks URL は妥当",
    },
    {
      url: "https://discordapp.com/api/webhooks/123/abc",
      expected: true,
      note: "旧ドメイン discordapp.com も妥当",
    },
    {
      url: "http://discord.com/api/webhooks/123/abc",
      expected: false,
      note: "http(非https)は不可",
    },
    {
      url: "https://example.com/api/webhooks/123/abc",
      expected: false,
      note: "別ホストは不可",
    },
    {
      url: "https://discord.com/api/webhook/123/abc",
      expected: false,
      note: "パスが webhooks でない(綴り違い)は不可",
    },
    { url: "", expected: false, note: "空文字は不可" },
    { url: "   ", expected: false, note: "空白のみは不可" },
    {
      url: "https://evil.discord.com.attacker.test/api/webhooks/1/x",
      expected: false,
      note: "サブドメイン偽装は不可(前方一致プレフィックス外)",
    },
  ];

  for (const { url, expected, note } of cases) {
    it(`${note}: ${JSON.stringify(url)} → ${expected}`, () => {
      expect(isDiscordWebhookUrl(url)).toBe(expected);
    });
  }
});

describe("parseRetryAfterMs(429 の待機時間解釈)", () => {
  const cases: ReadonlyArray<{
    header: string | null;
    expected: number;
    note: string;
  }> = [
    { header: "1", expected: 1000, note: "秒(整数)をミリ秒へ" },
    { header: "0.5", expected: 500, note: "秒(小数)をミリ秒へ" },
    { header: null, expected: 1000, note: "ヘッダ欠損は既定1000ms" },
    { header: "abc", expected: 1000, note: "非数値は既定1000ms" },
    { header: "-5", expected: 1000, note: "負値は既定1000ms" },
    { header: "999999", expected: 60000, note: "過大値は上限60000msにクランプ" },
  ];

  for (const { header, expected, note } of cases) {
    it(`${note}: ${JSON.stringify(header)} → ${expected}ms`, () => {
      expect(parseRetryAfterMs(header)).toBe(expected);
    });
  }
});

describe("truncate(文字数制限の切り詰め)", () => {
  it("上限以下はそのまま返す", () => {
    expect(truncate("あいう", 3)).toBe("あいう");
    expect(truncate("あい", 3)).toBe("あい");
  });

  it("上限超過は末尾を省略記号にして上限長ちょうどに収める", () => {
    const out = truncate("あいうえお", 3);
    expect([...out]).toHaveLength(3);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("あい…");
  });

  it("サロゲートペア(絵文字)を分割せずコードポイント単位で切り詰める", () => {
    // "👍" は UTF-16 で2コードユニット。コードユニット単位で切ると孤立サロゲートが残るが、
    // コードポイント単位なら絵文字を割らずに収める。
    const out = truncate("👍👍👍", 2);
    expect([...out]).toHaveLength(2);
    expect(out).toBe("👍…");
    // 孤立サロゲート(U+D800〜U+DFFF)が残っていないこと。
    for (const ch of out) {
      const code = ch.codePointAt(0)!;
      expect(code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });
});

/** テスト用のレース情報。 */
const raceInfo: EmbedRaceInfo = {
  raceName: "テストステークス",
  date: "2026/07/12",
  venueName: "東京",
  courseType: "芝",
  distance: 1600,
  llmUsed: true,
  oddsStatus: "result",
};

/** EVプラス2頭・非該当1頭を含む馬リスト。 */
const horses: readonly EmbedHorse[] = [
  {
    umaban: 3,
    horseName: "ウマA",
    adjustedProb: 0.421,
    placeOddsMin: 2.5,
    ev: 1.05,
    isPositive: true,
  },
  {
    umaban: 7,
    horseName: "ウマB",
    adjustedProb: 0.312,
    placeOddsMin: 4.2,
    ev: 1.31,
    isPositive: true,
  },
  {
    umaban: 1,
    horseName: "ウマC",
    adjustedProb: 0.5,
    placeOddsMin: 1.4,
    ev: 0.7,
    isPositive: false,
  },
];

describe("buildAnalysisEmbed(分析結果→Discord embed 整形)", () => {
  it("タイトルに会場名とレース名を含む", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    expect(embed.title).toContain("東京");
    expect(embed.title).toContain("テストステークス");
  });

  it("説明に日付・会場・コース・距離を含む", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    expect(embed.description).toContain("2026/07/12");
    expect(embed.description).toContain("東京");
    expect(embed.description).toContain("芝1600m");
  });

  it("EVプラス馬のみを馬番・馬名・補正後確率・複勝下限・EVで列挙する", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    const desc = embed.description ?? "";
    // 補正後確率のラベルは「AI補正後」で統一する(ユーザー要望)。
    expect(desc).toContain("AI補正後");
    // EVプラスの2頭は載る
    expect(desc).toContain("ウマA");
    expect(desc).toContain("ウマB");
    expect(desc).toContain("3");
    expect(desc).toContain("42.1%");
    expect(desc).toContain("2.5");
    expect(desc).toContain("1.05");
    expect(desc).toContain("1.31");
    // 非該当の1頭は載らない
    expect(desc).not.toContain("ウマC");
  });

  it("EVプラスが無い場合は「該当なし」を示す", () => {
    const noneHorses: readonly EmbedHorse[] = [
      {
        umaban: 1,
        horseName: "ウマC",
        adjustedProb: 0.5,
        placeOddsMin: 1.4,
        ev: 0.7,
        isPositive: false,
      },
    ];
    const embed = buildAnalysisEmbed(raceInfo, noneHorses);
    expect(embed.description).toContain("該当なし");
  });

  it("LLM使用有無を明記する(実行/スキップ)", () => {
    expect(buildAnalysisEmbed(raceInfo, horses).description).toContain(
      "LLM補正: 実行",
    );
    expect(
      buildAnalysisEmbed({ ...raceInfo, llmUsed: false }, horses).description,
    ).toContain("LLM補正: スキップ");
  });

  it("確定(result)ではオッズ状態の注記を含めない", () => {
    const desc = buildAnalysisEmbed(raceInfo, horses).description ?? "";
    expect(desc).not.toContain("暫定");
    expect(desc).not.toContain("複勝未発売");
  });

  it("発売中(middle)は暫定である旨の注記を含める", () => {
    const desc =
      buildAnalysisEmbed({ ...raceInfo, oddsStatus: "middle" }, horses)
        .description ?? "";
    expect(desc).toContain("※オッズは発売中(暫定)");
  });

  it("予想オッズ(yoso)は複勝未発売でEV計算不可の注記を含める", () => {
    const desc =
      buildAnalysisEmbed({ ...raceInfo, oddsStatus: "yoso" }, horses)
        .description ?? "";
    expect(desc).toContain("※複勝未発売のためEV計算不可");
  });

  it("説明・タイトルは Discord の文字数上限を超えない", () => {
    const longName = "あ".repeat(5000);
    const manyHorses: EmbedHorse[] = Array.from({ length: 30 }, (_, i) => ({
      umaban: i + 1,
      horseName: longName,
      adjustedProb: 0.4,
      placeOddsMin: 2.0,
      ev: 1.2,
      isPositive: true,
    }));
    const embed = buildAnalysisEmbed(
      { ...raceInfo, raceName: longName },
      manyHorses,
    );
    expect((embed.title ?? "").length).toBeLessThanOrEqual(
      DISCORD_EMBED_TITLE_MAX,
    );
    expect((embed.description ?? "").length).toBeLessThanOrEqual(
      DISCORD_EMBED_DESCRIPTION_MAX,
    );
  });

  it("複勝下限・EVが欠損(null)なら「-」で表示する", () => {
    const withNull: readonly EmbedHorse[] = [
      {
        umaban: 5,
        horseName: "ウマD",
        adjustedProb: 0.33,
        placeOddsMin: null,
        ev: null,
        isPositive: true,
      },
    ];
    const desc = buildAnalysisEmbed(raceInfo, withNull).description ?? "";
    expect(desc).toContain("ウマD");
    expect(desc).toContain("-");
  });
});

describe("sendDiscordNotification(Webhook送信)", () => {
  const validUrl = "https://discord.com/api/webhooks/123/abc";
  const payload = { embeds: [{ title: "t", description: "d" }] };

  it("2xx応答なら解決し、embeds を JSON POST する", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () =>
      makeResponse({ status: 204 }),
    );
    await expect(
      sendDiscordNotification(validUrl, payload, { fetch: fetchMock }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(validUrl);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("不正なWebhook URLは fetch せず DiscordNotifyError を投げる", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>();
    await expect(
      sendDiscordNotification("https://example.com/x", payload, {
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(DiscordNotifyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非2xx(4xx)は理由付きの DiscordNotifyError を投げる", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () =>
      makeResponse({ status: 400, body: "bad" }),
    );
    await expect(
      sendDiscordNotification(validUrl, payload, { fetch: fetchMock }),
    ).rejects.toMatchObject({ name: "DiscordNotifyError", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 は Retry-After を尊重して1回だけ待機リトライし、成功すれば解決する", async () => {
    const fetchMock = vi
      .fn<DiscordFetchLike>()
      .mockResolvedValueOnce(
        makeResponse({ status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(makeResponse({ status: 204 }));
    const sleep = vi.fn(async () => {});

    await expect(
      sendDiscordNotification(validUrl, payload, { fetch: fetchMock, sleep }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("429 が連続したらリトライは1回のみで DiscordNotifyError を投げる", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () =>
      makeResponse({ status: 429, headers: { "retry-after": "1" } }),
    );
    const sleep = vi.fn(async () => {});

    await expect(
      sendDiscordNotification(validUrl, payload, { fetch: fetchMock, sleep }),
    ).rejects.toMatchObject({ name: "DiscordNotifyError", status: 429 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("5xx は DiscordNotifyError を投げる", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () =>
      makeResponse({ status: 503 }),
    );
    await expect(
      sendDiscordNotification(validUrl, payload, { fetch: fetchMock }),
    ).rejects.toMatchObject({ name: "DiscordNotifyError", status: 503 });
  });

  it("応答が返らない場合は timeoutMs で打ち切り DiscordNotifyError を投げる(リトライしない)", async () => {
    vi.useFakeTimers();
    try {
      // 永遠に解決しない fetch(ハングを模擬)。abort されても reject しないケース。
      const fetchMock = vi.fn<DiscordFetchLike>(
        () => new Promise<DiscordFetchResponse>(() => {}),
      );
      const promise = sendDiscordNotification(validUrl, payload, {
        fetch: fetchMock,
        timeoutMs: 1000,
      });
      // 未処理拒否を防ぐため先にハンドラを付ける。
      const assertion = expect(promise).rejects.toMatchObject({
        name: "DiscordNotifyError",
      });
      // タイムアウト発火まで時間を進める。
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      // タイムアウトはリトライしない(fetch は1回のみ)。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // タイムアウト時は AbortController.signal を渡していること。
      expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});
