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
    // ---- Issue #301: new URL() による解析・ホストの完全一致・https・パスが /api/webhooks/ で始まる ----
    {
      url: "https://discord.com.evil.example/api/webhooks/1/x",
      expected: false,
      note: "ホストが discord.com で始まるだけの別ホスト(前方一致では通ってしまった形)は不可",
    },
    {
      url: "https://evil.example/?https://discord.com/api/webhooks/",
      expected: false,
      note: "クエリに正規 URL を埋め込んだ別ホストは不可",
    },
    {
      url: "https://evil.example/#https://discord.com/api/webhooks/1/x",
      expected: false,
      note: "フラグメントに正規 URL を埋め込んだ別ホストは不可",
    },
    {
      url: "https://discord.com@evil.example/api/webhooks/1/x",
      expected: false,
      note: "userinfo 偽装(実際のホストは evil.example)は不可",
    },
    {
      url: "https://evil@discord.com/api/webhooks/1/x",
      expected: false,
      note: "ホストが正規でも userinfo 付きは不可",
    },
    {
      url: "https://:pass@discord.com/api/webhooks/1/x",
      expected: false,
      note: "ユーザー名が空でパスワードだけの userinfo(`:pass@`)も不可(password の検査を固定する)",
    },
    {
      url: "https://discord.com:444/api/webhooks/1/x",
      expected: false,
      note: "明示ポート付きは不可",
    },
    {
      url: "https://discord.com\\@evil.example/api/webhooks/1/x",
      expected: false,
      note: "バックスラッシュ(WHATWG ではパス区切り扱い)で正規ホストに見せる形は不可",
    },
    {
      url: "https://discord.com/api/webhooks",
      expected: false,
      note: "末尾の / が無い(/api/webhooks/ で始まらない)は不可",
    },
    {
      url: "https://discord.com/api/webhooks/../x",
      expected: false,
      note: "ドットセグメントで /api/webhooks/ の外へ出る形は不可(正規化後に判定)",
    },
    {
      url: "https://discord.com/api/%2e%2e/x",
      expected: false,
      note: "パーセントエンコードしたドットセグメントも正規化後に判定して不可",
    },
    {
      url: "https://ptb.discord.com/api/webhooks/1/x",
      expected: false,
      note: "サブドメイン(ptb.)は不可(ホストの完全一致)",
    },
    {
      url: "https://discord.com./api/webhooks/1/x",
      expected: false,
      note: "末尾ドット付きのホストは不可(完全一致)",
    },
    {
      url: "javascript:https://discord.com/api/webhooks/1/x",
      expected: false,
      note: "https: 以外のスキームは不可",
    },
    {
      url: "not a url https://discord.com/api/webhooks/",
      expected: false,
      note: "URL として解析できない文字列は不可(例外を投げず false)",
    },
    {
      url: "HTTPS://DISCORD.COM/api/webhooks/1/x",
      expected: true,
      note: "スキーム・ホストの大文字小文字は URL の解析で正規化されるため許容",
    },
    {
      url: "https://discord.com/api/webhooks/123/abc?wait=true&thread_id=9",
      expected: true,
      note: "クエリ付きの正規 URL は妥当",
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
  it("escape の対(バックスラッシュ + 記号)を割らない: 切り詰めの境界で単独のバックスラッシュが末尾の『…』の前に残らない(Issue #301)", () => {
    // "ab\*cd" は 6 文字。maxLen=4 → 先頭 3 文字 "ab\" + "…" になるところ、孤立した \ を落として "ab…"。
    expect(truncate("ab\\*cd", 4)).toBe("ab…");
    // escape 済みのバックスラッシュ(\\)の対は完結しているので残す。
    expect(truncate("ab\\\\cd", 5)).toBe("ab\\\\…");
    // 境界が通常文字なら今までどおり
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

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
    mark: "◎",
  },
  {
    umaban: 7,
    horseName: "ウマB",
    adjustedProb: 0.312,
    placeOddsMin: 4.2,
    ev: 1.31,
    isPositive: true,
    mark: null,
  },
  {
    umaban: 1,
    horseName: "ウマC",
    adjustedProb: 0.5,
    placeOddsMin: 1.4,
    ev: 0.7,
    isPositive: false,
    mark: null,
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

  it("予想印(mark)が付いた馬は行頭に印を含める(Task#23)", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    const desc = embed.description ?? "";
    // ウマA(mark=◎)は行頭に「◎」が付くこと。
    const lineA = desc.split("\n").find((l) => l.includes("ウマA"))!;
    expect(lineA.trimStart().startsWith("◎")).toBe(true);
    expect(lineA).toContain("◎ 3番");
  });

  it("印なし馬は従来どおり(印の接頭辞を付けない)", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    const desc = embed.description ?? "";
    // ウマB(mark=null)は印の接頭辞が付かず、従来どおり馬番から始まること。
    const lineB = desc.split("\n").find((l) => l.includes("ウマB"))!;
    expect(lineB.trimStart().startsWith("7番")).toBe(true);
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
        mark: null,
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
      mark: null,
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
        mark: null,
      },
    ];
    const desc = buildAnalysisEmbed(raceInfo, withNull).description ?? "";
    expect(desc).toContain("ウマD");
    expect(desc).toContain("-");
  });

  it("推定EV(evEstimated:true)の馬はEV表記の末尾に「(推定)」を付ける(Task#25)", () => {
    const estimatedHorses: readonly EmbedHorse[] = [
      {
        umaban: 5,
        horseName: "ウマE",
        adjustedProb: 0.4,
        placeOddsMin: 1.84,
        ev: 1.4,
        isPositive: true,
        mark: null,
        evEstimated: true,
      },
    ];
    const desc = buildAnalysisEmbed(raceInfo, estimatedHorses).description ?? "";
    const line = desc.split("\n").find((l) => l.includes("ウマE"))!;
    expect(line).toContain("EV1.40(推定)");
  });

  it("確定EV(evEstimated未指定・false)の馬は従来どおり「(推定)」を付けない(回帰確認)", () => {
    const desc = buildAnalysisEmbed(raceInfo, horses).description ?? "";
    const lineA = desc.split("\n").find((l) => l.includes("ウマA"))!;
    expect(lineA).not.toContain("(推定)");
  });

  it("予想印と推定EV表記は共存できる(印は行頭、推定はEV末尾)", () => {
    const markedEstimated: readonly EmbedHorse[] = [
      {
        umaban: 5,
        horseName: "ウマF",
        adjustedProb: 0.4,
        placeOddsMin: 1.84,
        ev: 1.4,
        isPositive: true,
        mark: "◎",
        evEstimated: true,
      },
    ];
    const desc = buildAnalysisEmbed(raceInfo, markedEstimated).description ?? "";
    const line = desc.split("\n").find((l) => l.includes("ウマF"))!;
    expect(line.trimStart().startsWith("◎")).toBe(true);
    expect(line).toContain("EV1.40(推定)");
  });
});

describe("buildAnalysisEmbed(外から来た文字列の無害化。Issue #301)", () => {
  const hostileInfo: EmbedRaceInfo = { ...raceInfo, raceName: "[G1](https://evil.example) *太字*", venueName: "東京" };
  const hostileHorses: readonly EmbedHorse[] = [
    { umaban: 3, horseName: "[押す](https://evil.example/x)", adjustedProb: 0.4, placeOddsMin: 2.5, ev: 1.05, isPositive: true, mark: "◎" },
  ];

  it("レース名(title)・馬名(EV プラスの行)のマスクドリンクと書式記号が escape される", () => {
    const embed = buildAnalysisEmbed(hostileInfo, hostileHorses);
    expect(embed.title).toBe("東京 \\[G1\\](https://evil.example) \\*太字\\*");
    const line = (embed.description ?? "").split("\n").find((l) => l.includes("3番"))!;
    expect(line).toContain("\\[押す\\](https://evil.example/x)");
    // 素の `[` は 1 つも残らない(escape の対を除いて確認)
    expect((embed.description ?? "").replace(/\\\[/g, "")).not.toContain("[");
  });

  it("会場名の記号も escape される: title と、説明のメタ行の両方(production では title は cloud が上書きし、メタ行は cloud のテストが固定するので、core 側でも固定する)", () => {
    const embed = buildAnalysisEmbed({ ...raceInfo, raceName: "テストステークス", venueName: "[東京](https://evil.example) *x*" }, hostileHorses);
    expect(embed.title).toBe("\\[東京\\](https://evil.example) \\*x\\* テストステークス");
    const meta = (embed.description ?? "").split("\n")[0]!;
    expect(meta).toContain("\\[東京\\](https://evil.example) \\*x\\*");
    expect(meta.replace(/\\\[/g, "")).not.toContain("[");
  });

  it("馬名の切り詰め(32 コードポイント)は escape の前: 見える文字数が escape で減らない", () => {
    const name = "*".repeat(40);
    const embed = buildAnalysisEmbed(raceInfo, [{ ...hostileHorses[0]!, horseName: name }]);
    const line = (embed.description ?? "").split("\n").find((l) => l.includes("3番"))!;
    // 32 コードポイントで切る → 31 個の * と省略記号。各 * が \* になる。
    expect(line).toContain(`${"\\*".repeat(31)}…`);
  });

  it("こちらのテンプレートの記号(印・括弧・%・推定)と、普通の馬名・レース名は変わらない", () => {
    const embed = buildAnalysisEmbed(raceInfo, horses);
    expect(embed.title).toBe("東京 テストステークス");
    const line = (embed.description ?? "").split("\n").find((l) => l.includes("ウマA"))!;
    expect(line).toBe("◎ 3番 ウマA AI補正後42.1% 複勝下限2.5 EV1.05");
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
    // Issue #301: 送る本文は payload に allowed_mentions を足した形で、完全一致のまま(キーを足しただけで、payload の内容は保つ)。
    expect(JSON.parse(init.body)).toEqual({ ...payload, allowed_mentions: { parse: [] } });
  });

  it("allowed_mentions: { parse: [] } を常に付ける(メンションで誰にも通知が飛ばない。Issue #301)", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () => makeResponse({ status: 204 }));
    await sendDiscordNotification(validUrl, payload, { fetch: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>;
    expect(body["allowed_mentions"]).toEqual({ parse: [] });
    // content を使う将来の呼び出しでも同じ(@everyone を含む本文でも parse は空)
    await sendDiscordNotification(validUrl, { content: "@everyone <@123>", embeds: [] }, { fetch: fetchMock });
    const body2 = JSON.parse(fetchMock.mock.calls[1]![1].body) as Record<string, unknown>;
    expect(body2["content"]).toBe("@everyone <@123>");
    expect(body2["allowed_mentions"]).toEqual({ parse: [] });
  });

  it("呼び出し側が別の allowed_mentions を渡しても、送るのは { parse: [] } に固定する(上書き)", async () => {
    const fetchMock = vi.fn<DiscordFetchLike>(async () => makeResponse({ status: 204 }));
    const hostile = { ...payload, allowed_mentions: { parse: ["everyone", "users", "roles"] } } as unknown as typeof payload;
    await sendDiscordNotification(validUrl, hostile, { fetch: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>;
    expect(body["allowed_mentions"]).toEqual({ parse: [] });
  });

  it("429 の再送でも allowed_mentions を付けたまま(2 回目の本文も同じ)", async () => {
    const fetchMock = vi
      .fn<DiscordFetchLike>()
      .mockResolvedValueOnce(makeResponse({ status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(makeResponse({ status: 204 }));
    await sendDiscordNotification(validUrl, payload, { fetch: fetchMock, sleep: async () => {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((JSON.parse(call[1].body) as Record<string, unknown>)["allowed_mentions"]).toEqual({ parse: [] });
    }
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

  it("不正な URL のエラー文言は、実際の判定条件(https・ホスト・userinfo/ポート・パス)に合い、URL そのもの(秘密)を含まない(Issue #328)", async () => {
    const expectedMessage =
      "Discord Webhook URL が不正です(https:// で始まり、ホストが discord.com または discordapp.com そのもの(サブドメインは不可)で、ユーザー名・パスワード・ポート番号を含まず、パスが /api/webhooks/ で始まる URL が必要です)";
    // 秘密(トークン)を含みうる不正な URL。形式の違反ごとに、どれでも同じ固定の文言になり、URL の断片が混ざらないこと。
    const secret = "SECRETTOKEN-9f8e7d";
    const badUrls = [
      `http://discord.com/api/webhooks/123/${secret}`,
      `https://example.com/api/webhooks/123/${secret}`,
      `https://ptb.discord.com/api/webhooks/123/${secret}`,
      `https://user:pw@discord.com/api/webhooks/123/${secret}`,
      `https://discord.com:444/api/webhooks/123/${secret}`,
      `https://discord.com/other/123/${secret}`,
      `not a url ${secret}`,
    ];
    for (const url of badUrls) {
      // 前提: 実装が本当にこの URL を不正と判定している(判定と文言の対応を取る)
      expect(isDiscordWebhookUrl(url)).toBe(false);
      const fetchMock = vi.fn<DiscordFetchLike>();
      const error = await sendDiscordNotification(url, payload, { fetch: fetchMock }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DiscordNotifyError);
      const message = (error as DiscordNotifyError).message;
      expect(message).toBe(expectedMessage);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(url);
      expect(fetchMock).not.toHaveBeenCalled();
    }
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
