/**
 * ログ整形の純関数(shared/log-formatter.ts)のテスト。Task#35。
 *
 * 目的:
 * - タイムスタンプ・レベル・操作名・コンテキスト(raceId/url)・スタックが一貫した1行JSONに
 *   整形されること(AIにそのまま渡せる形式)。
 * - 秘密情報(APIキー・Webhook URL等)が「絶対に」ログへ出ないこと(最重要)。
 *   (a) 既知の秘密フィールド名(apiKey, webhookUrl等)の値のマスク
 *   (b) メッセージ・スタック文字列に混入した秘密値のマスク(値スキャン)
 *   の両方をテーブル駆動で固定する。
 */

import { describe, expect, it } from "vitest";

import {
  CIRCULAR_REFERENCE_MARKER,
  DEPTH_LIMIT_MARKER,
  extractErrorInfo,
  formatLogEntry,
  maskSecretFields,
  maskSecretValues,
  SECRET_FIELD_NAMES,
} from "../src/shared/log-formatter.js";

describe("maskSecretValues(秘密値のスキャンマスキング)", () => {
  it.each([
    {
      title: "秘密値がテキストに丸ごと含まれていればマスクされる",
      text: "APIキー sk-ant-abc123 は不正です",
      secrets: ["sk-ant-abc123"],
      expected: "APIキー ***MASKED*** は不正です",
    },
    {
      title: "複数の秘密値がそれぞれマスクされる",
      text: "key=sk-ant-abc123 webhook=https://discord.com/api/webhooks/xxx/yyy",
      secrets: ["sk-ant-abc123", "https://discord.com/api/webhooks/xxx/yyy"],
      expected: "key=***MASKED*** webhook=***MASKED***",
    },
    {
      title: "同じ秘密値が複数回出現してもすべてマスクされる",
      text: "secret secret secret",
      secrets: ["secret"],
      expected: "***MASKED*** ***MASKED*** ***MASKED***",
    },
    {
      title: "秘密値が含まれなければ変化しない",
      text: "通常のエラーメッセージです",
      secrets: ["sk-ant-abc123"],
      expected: "通常のエラーメッセージです",
    },
    {
      title: "空文字列の秘密値は無視する(誤って全文字を消さない)",
      text: "通常のエラーメッセージです",
      secrets: [""],
      expected: "通常のエラーメッセージです",
    },
    {
      title: "空白のみの秘密値は無視する",
      text: "通常のエラーメッセージです",
      secrets: ["   "],
      expected: "通常のエラーメッセージです",
    },
    {
      title: "secrets が空配列なら変化しない",
      text: "sk-ant-abc123 を含む文字列",
      secrets: [],
      expected: "sk-ant-abc123 を含む文字列",
    },
    {
      title: "1文字の秘密値はスキャン対象から除外する(誤爆防止)",
      text: "レース番号は 5 です",
      secrets: ["5"],
      expected: "レース番号は 5 です",
    },
    {
      title: "3文字の秘密値はスキャン対象から除外する(誤爆防止)",
      text: "abc という単語を含む文",
      secrets: ["abc"],
      expected: "abc という単語を含む文",
    },
    {
      title: "4文字ちょうどの秘密値はスキャン対象に含める(閾値の境界値)",
      text: "abcd という単語を含む文",
      secrets: ["abcd"],
      expected: "***MASKED*** という単語を含む文",
    },
  ])("$title", ({ text, secrets, expected }) => {
    expect(maskSecretValues(text, secrets)).toBe(expected);
  });
});

describe("maskSecretFields(既知の秘密フィールド名によるマスキング)", () => {
  it("apiKeyフィールドの値をマスクする", () => {
    const result = maskSecretFields({ apiKey: "sk-ant-abc123", raceId: "202601010101" });
    expect(result.apiKey).toBe("***MASKED***");
    expect(result.raceId).toBe("202601010101");
  });

  it("discordWebhookUrlフィールドの値をマスクする", () => {
    const result = maskSecretFields({
      discordWebhookUrl: "https://discord.com/api/webhooks/xxx/yyy",
    });
    expect(result.discordWebhookUrl).toBe("***MASKED***");
  });

  it("webhookUrlフィールドの値をマスクする", () => {
    const result = maskSecretFields({ webhookUrl: "https://discord.com/api/webhooks/xxx/yyy" });
    expect(result.webhookUrl).toBe("***MASKED***");
  });

  it("秘密フィールド名に該当しないキーはそのまま保持する", () => {
    const result = maskSecretFields({ raceId: "202601010101", url: "https://example.com" });
    expect(result).toEqual({ raceId: "202601010101", url: "https://example.com" });
  });

  it("contextがundefinedならundefinedを返す", () => {
    expect(maskSecretFields(undefined)).toBeUndefined();
  });

  it("空文字のapiKeyでもマスクする(値の有無に関わらずキー一致でマスクする設計)", () => {
    const result = maskSecretFields({ apiKey: "" });
    expect(result.apiKey).toBe("***MASKED***");
  });

  it("SECRET_FIELD_NAMES に既知の秘密フィールド名一式が定義されている", () => {
    expect(SECRET_FIELD_NAMES).toContain("apiKey");
    expect(SECRET_FIELD_NAMES).toContain("discordWebhookUrl");
    expect(SECRET_FIELD_NAMES).toContain("webhookUrl");
  });

  it("ネストしたオブジェクト内の秘密フィールド名もマスクされる(code-reviewer指摘: 要修正2)", () => {
    const result = maskSecretFields({ nested: { apiKey: "sk-ant-abc123" } });
    expect(result.nested).toEqual({ apiKey: "***MASKED***" });
  });

  it("配列内のオブジェクトの秘密フィールド名もマスクされる(code-reviewer指摘: 要修正2)", () => {
    const result = maskSecretFields({ list: [{ apiKey: "sk-ant-abc123" }, { raceId: "x" }] });
    expect(result.list).toEqual([{ apiKey: "***MASKED***" }, { raceId: "x" }]);
  });

  it("フィールド名の大文字小文字が違えば意図的にマスクされない(既存の厳密一致方針の固定)", () => {
    // 「APIKEY」「ApiKey」は SECRET_FIELD_NAMES の厳密一致に含まれないため、
    // 既存方針どおりマスクされないことを固定する(仕様変更ではなく確認テスト)。
    const result = maskSecretFields({ APIKEY: "not-a-real-secret-value", ApiKey: "also-not-masked" });
    expect(result.APIKEY).toBe("not-a-real-secret-value");
    expect(result.ApiKey).toBe("also-not-masked");
  });

  it("複数の秘密フィールドがネスト内でも同時にマスクされる", () => {
    const result = maskSecretFields({
      apiKey: "sk-ant-abc123",
      nested: { discordWebhookUrl: "https://discord.com/api/webhooks/xxx/yyy" },
      list: [{ webhookUrl: "https://discord.com/api/webhooks/aaa/bbb" }],
    });
    expect(result.apiKey).toBe("***MASKED***");
    expect(result.nested).toEqual({ discordWebhookUrl: "***MASKED***" });
    expect(result.list).toEqual([{ webhookUrl: "***MASKED***" }]);
  });

  it("深さ上限を超えるネスト構造でも例外を投げず、上限を超えた箇所はプレースホルダに置き換わる", () => {
    // 秘密値をネストの奥深くに仕込み、上限を超えた時点でプレースホルダに置き換わって
    // 秘密値自体が出力に残らないことを確認する(安全側フォールバック)。
    let deep: unknown = { apiKey: "sk-ant-deep-secret" };
    for (let i = 0; i < 20; i += 1) {
      deep = { nested: deep };
    }
    expect(() => maskSecretFields({ top: deep })).not.toThrow();
    const result = maskSecretFields({ top: deep });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-ant-deep-secret");
    expect(serialized).toContain(DEPTH_LIMIT_MARKER);
  });

  it("循環参照を持つcontextを渡してもmaskSecretFieldsは例外を投げない", () => {
    const circular: Record<string, unknown> = { raceId: "202601010101" };
    circular.self = circular;
    expect(() => maskSecretFields(circular)).not.toThrow();
    const result = maskSecretFields(circular);
    expect(result.self).toBe(CIRCULAR_REFERENCE_MARKER);
    expect(result.raceId).toBe("202601010101");
  });
});

describe("extractErrorInfo(エラー情報の抽出)", () => {
  it("Errorインスタンスからname/message/stackを抽出する", () => {
    const error = new TypeError("何かが壊れた");
    const info = extractErrorInfo(error);
    expect(info).not.toBeNull();
    expect(info!.name).toBe("TypeError");
    expect(info!.message).toBe("何かが壊れた");
    expect(info!.stack).toEqual(expect.stringContaining("TypeError"));
  });

  it("プレーンな{message,stack}オブジェクト(renderer由来の再構築エラー)からも抽出する", () => {
    const info = extractErrorInfo({ message: "renderer側のエラー", stack: "at foo (bar.js:1:1)" });
    expect(info).not.toBeNull();
    expect(info!.message).toBe("renderer側のエラー");
    expect(info!.stack).toBe("at foo (bar.js:1:1)");
  });

  it("文字列を渡した場合はmessageとして扱いstackはnull", () => {
    const info = extractErrorInfo("ただの文字列エラー");
    expect(info).toEqual({ name: null, message: "ただの文字列エラー", stack: null });
  });

  it("undefined/nullを渡した場合はnullを返す(エラー情報なし)", () => {
    expect(extractErrorInfo(undefined)).toBeNull();
    expect(extractErrorInfo(null)).toBeNull();
  });

  it("追加の列挙可能プロパティを持つErrorはextraフィールドに含めて抽出する(提案採用2)", () => {
    // DiscordNotifyError(packages/core/src/notify/discord.ts)相当の形状を素のErrorで再現する。
    class FakeDiscordNotifyError extends Error {
      readonly status?: number;
      readonly responseBody?: string;
      constructor(message: string, options: { status?: number; responseBody?: string }) {
        super(message);
        this.name = "FakeDiscordNotifyError";
        this.status = options.status;
        this.responseBody = options.responseBody;
      }
    }
    const error = new FakeDiscordNotifyError("送信に失敗しました", {
      status: 404,
      responseBody: "Not Found",
    });
    const info = extractErrorInfo(error);
    expect(info).not.toBeNull();
    expect(info!.extra).toEqual({ status: 404, responseBody: "Not Found" });
  });

  it("追加プロパティが無い通常のErrorではextraフィールドを含めない(既存挙動の維持)", () => {
    const info = extractErrorInfo(new Error("何かが壊れた"));
    expect(info).not.toBeNull();
    expect(info!.extra).toBeUndefined();
    expect(info).toEqual({
      name: "Error",
      message: "何かが壊れた",
      stack: info!.stack,
    });
  });

  it("文字列を渡した場合の戻り値は従来どおり完全一致する(extra追加による既存挙動破壊が無いことの固定)", () => {
    expect(extractErrorInfo("ただの文字列エラー")).toEqual({
      name: null,
      message: "ただの文字列エラー",
      stack: null,
    });
  });
});

describe("formatLogEntry(ログ1エントリの整形)", () => {
  const fixedDate = new Date("2026-07-16T01:23:45.000Z");

  it("level・operation・message・timestampを含む1行JSONを返す", () => {
    const line = formatLogEntry({
      level: "error",
      operation: "result:import",
      message: "取込に失敗しました",
      timestamp: fixedDate,
    });
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      timestamp: "2026-07-16T01:23:45.000Z",
      level: "error",
      operation: "result:import",
      message: "取込に失敗しました",
    });
  });

  it("timestamp省略時は呼び出し時刻を用いる(ISO8601形式)", () => {
    const line = formatLogEntry({
      level: "info",
      operation: "app:start",
      message: "起動しました",
    });
    const parsed = JSON.parse(line) as { timestamp: string };
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  it("raceId/urlを含むコンテキストが構造化されて出力に含まれる", () => {
    const line = formatLogEntry({
      level: "error",
      operation: "result:import",
      message: "取込に失敗しました",
      context: { raceId: "202601010101", url: "https://db.netkeiba.com/race/202601010101/" },
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as {
      context: { raceId: string; url: string };
    };
    expect(parsed.context).toEqual({
      raceId: "202601010101",
      url: "https://db.netkeiba.com/race/202601010101/",
    });
  });

  it("Errorのスタックがerrorフィールドとして出力に含まれる", () => {
    const error = new Error("ネットワークエラー");
    const line = formatLogEntry({
      level: "error",
      operation: "result:import",
      message: "取込に失敗しました",
      error,
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as {
      error: { name: string; message: string; stack: string | null };
    };
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("ネットワークエラー");
    expect(parsed.error.stack).toEqual(expect.stringContaining("Error: ネットワークエラー"));
  });

  it("errorを渡さない場合はerrorフィールドを出力に含めない", () => {
    const line = formatLogEntry({
      level: "info",
      operation: "app:start",
      message: "起動しました",
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.error).toBeUndefined();
  });

  it("contextを渡さない場合はcontextフィールドを出力に含めない", () => {
    const line = formatLogEntry({
      level: "info",
      operation: "app:start",
      message: "起動しました",
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.context).toBeUndefined();
  });

  it("秘密フィールド名(apiKey)のコンテキスト値はマスクされ、出力に平文が現れない", () => {
    const line = formatLogEntry({
      level: "error",
      operation: "settings:save",
      message: "設定保存に失敗しました",
      context: { apiKey: "sk-ant-abc123" },
      timestamp: fixedDate,
    });
    expect(line).not.toContain("sk-ant-abc123");
    const parsed = JSON.parse(line) as { context: { apiKey: string } };
    expect(parsed.context.apiKey).toBe("***MASKED***");
  });

  it("メッセージに混入した実際の秘密値がマスクされる(secretsでスキャン)", () => {
    const line = formatLogEntry(
      {
        level: "error",
        operation: "notify:discord-batch",
        message: "送信に失敗しました: https://discord.com/api/webhooks/123/abcXYZ",
        timestamp: fixedDate,
      },
      ["https://discord.com/api/webhooks/123/abcXYZ"],
    );
    expect(line).not.toContain("https://discord.com/api/webhooks/123/abcXYZ");
    const parsed = JSON.parse(line) as { message: string };
    expect(parsed.message).toBe("送信に失敗しました: ***MASKED***");
  });

  it("スタック文字列に混入した実際の秘密値がマスクされる(secretsでスキャン)", () => {
    const error = new Error("sk-ant-abc123 を含む例外メッセージ");
    error.stack = "Error: sk-ant-abc123 を含む例外メッセージ\n    at foo (bar.js:1:1)";
    const line = formatLogEntry(
      {
        level: "error",
        operation: "analysis:run-batch",
        message: "分析に失敗しました",
        error,
        timestamp: fixedDate,
      },
      ["sk-ant-abc123"],
    );
    expect(line).not.toContain("sk-ant-abc123");
    const parsed = JSON.parse(line) as { error: { message: string; stack: string } };
    expect(parsed.error.message).not.toContain("sk-ant-abc123");
    expect(parsed.error.stack).not.toContain("sk-ant-abc123");
  });

  it("コンテキストの非秘密フィールド(url)に混入した秘密値もスキャンでマスクされる(二重防御)", () => {
    // apiKeyというキー名でなくても、値そのものが秘密値と一致すればマスクされることを固定する。
    const line = formatLogEntry(
      {
        level: "error",
        operation: "notify:discord-batch",
        message: "送信に失敗しました",
        context: { url: "https://discord.com/api/webhooks/123/abcXYZ" },
        timestamp: fixedDate,
      },
      ["https://discord.com/api/webhooks/123/abcXYZ"],
    );
    expect(line).not.toContain("https://discord.com/api/webhooks/123/abcXYZ");
    const parsed = JSON.parse(line) as { context: { url: string } };
    expect(parsed.context.url).toBe("***MASKED***");
  });

  it("secretsを渡さない(既定の空配列)場合でも既知フィールド名マスクは効く", () => {
    const line = formatLogEntry({
      level: "error",
      operation: "settings:save",
      message: "失敗しました",
      context: { apiKey: "sk-ant-abc123" },
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as { context: { apiKey: string } };
    expect(parsed.context.apiKey).toBe("***MASKED***");
  });

  it("ネスト・配列内に混入した秘密値の文字列も出力に現れない(フィールド名は無関係、要修正2)", () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/abcXYZ";
    const line = formatLogEntry(
      {
        level: "error",
        operation: "notify:discord-batch",
        message: "送信に失敗しました",
        context: {
          nested: { note: `送信先: ${webhookUrl}` },
          list: [{ detail: `URL=${webhookUrl}` }],
        },
        timestamp: fixedDate,
      },
      [webhookUrl],
    );
    expect(line).not.toContain(webhookUrl);
    const parsed = JSON.parse(line) as {
      context: { nested: { note: string }; list: { detail: string }[] };
    };
    expect(parsed.context.nested.note).toBe("送信先: ***MASKED***");
    expect(parsed.context.list[0]!.detail).toBe("URL=***MASKED***");
  });

  it("JSON.stringifyが失敗する値(BigInt等)が混入しても例外を投げず、有効な行を返す(要修正1)", () => {
    // BigIntは再帰マスキングの対象外(オブジェクト・文字列いずれでもない)ため、
    // 最終防御線(formatLogEntry内のtry/catch)まで到達させて安全に処理されることを確認する。
    const context = { weird: 10n as unknown } as unknown as Record<string, unknown>;
    expect(() =>
      formatLogEntry({
        level: "error",
        operation: "test:bigint",
        message: "元のメッセージ",
        context: context as never,
        timestamp: fixedDate,
      }),
    ).not.toThrow();
    const line = formatLogEntry({
      level: "error",
      operation: "test:bigint",
      message: "元のメッセージ",
      context: context as never,
      timestamp: fixedDate,
    });
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
    const parsed = JSON.parse(line) as {
      message: string;
      level: string;
      operation: string;
      timestamp: string;
    };
    expect(parsed.message).toContain("元のメッセージ");
    expect(parsed.level).toBe("error");
    expect(parsed.operation).toBe("test:bigint");
    expect(parsed.timestamp).toBe(fixedDate.toISOString());
  });

  it("フォールバック時もsecretsによるメッセージのマスクは適用される(要修正1)", () => {
    const context = { weird: 10n as unknown } as unknown as Record<string, unknown>;
    const line = formatLogEntry(
      {
        level: "error",
        operation: "test:bigint",
        message: "秘密値 sk-ant-abc123 を含むメッセージ",
        context: context as never,
        timestamp: fixedDate,
      },
      ["sk-ant-abc123"],
    );
    expect(line).not.toContain("sk-ant-abc123");
  });

  it("循環参照を持つcontextを渡してもformatLogEntryは例外を投げず、有効な1行JSONを返す(要修正1・2)", () => {
    const circular: Record<string, unknown> = { raceId: "202601010101" };
    circular.self = circular;
    expect(() =>
      formatLogEntry({
        level: "error",
        operation: "test:circular",
        message: "循環参照テスト",
        context: circular as never,
        timestamp: fixedDate,
      }),
    ).not.toThrow();
    const line = formatLogEntry({
      level: "error",
      operation: "test:circular",
      message: "循環参照テスト",
      context: circular as never,
      timestamp: fixedDate,
    });
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("errorの追加プロパティ(DiscordNotifyError相当)がマスキング適用済みでerrorフィールドに含まれる(提案採用2)", () => {
    class FakeDiscordNotifyError extends Error {
      readonly status?: number;
      readonly responseBody?: string;
      constructor(message: string, options: { status?: number; responseBody?: string }) {
        super(message);
        this.name = "FakeDiscordNotifyError";
        this.status = options.status;
        this.responseBody = options.responseBody;
      }
    }
    const error = new FakeDiscordNotifyError("送信に失敗しました", {
      status: 404,
      responseBody: "Not Found",
    });
    const line = formatLogEntry({
      level: "error",
      operation: "notify:discord-batch",
      message: "送信に失敗しました",
      error,
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as {
      error: { extra?: { status: number; responseBody: string } };
    };
    expect(parsed.error.extra).toEqual({ status: 404, responseBody: "Not Found" });
  });

  it("errorの追加プロパティに秘密値が混入していてもマスクされる(提案採用2・要修正2の再利用確認)", () => {
    class FakeDiscordNotifyError extends Error {
      readonly responseBody?: string;
      constructor(message: string, responseBody: string) {
        super(message);
        this.name = "FakeDiscordNotifyError";
        this.responseBody = responseBody;
      }
    }
    const error = new FakeDiscordNotifyError(
      "送信に失敗しました",
      "webhook=https://discord.com/api/webhooks/123/abcXYZ",
    );
    const line = formatLogEntry(
      {
        level: "error",
        operation: "notify:discord-batch",
        message: "送信に失敗しました",
        error,
        timestamp: fixedDate,
      },
      ["https://discord.com/api/webhooks/123/abcXYZ"],
    );
    expect(line).not.toContain("https://discord.com/api/webhooks/123/abcXYZ");
    const parsed = JSON.parse(line) as { error: { extra: { responseBody: string } } };
    expect(parsed.error.extra.responseBody).toBe("webhook=***MASKED***");
  });

  it("追加プロパティが無い通常のErrorでは出力にextraフィールドが増えない(既存挙動の維持)", () => {
    const line = formatLogEntry({
      level: "error",
      operation: "result:import",
      message: "取込に失敗しました",
      error: new Error("ネットワークエラー"),
      timestamp: fixedDate,
    });
    const parsed = JSON.parse(line) as { error: Record<string, unknown> };
    expect(parsed.error.extra).toBeUndefined();
    expect(Object.keys(parsed.error).sort()).toEqual(["message", "name", "stack"]);
  });
});
