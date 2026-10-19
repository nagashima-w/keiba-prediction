import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchPromptPreview, previewRequestKey } from "../client/api-prompt-preview";
import { handle, type Env } from "../src/handler";
import { buildPreviewText } from "../src/prompt-preview";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #396: 契約テスト。クライアントの `fetchPromptPreview` が送るリクエストを、実際の `handle()` に通し、本物の応答をクライアントの検査に通す。
 * サーバ側のキー名・形(`text`・`clamped`・`promptVersion`・Content-Type・Origin の検査・200/400/403 の形)が変わると、ここで検出する。
 * ブラウザが付けるヘッダ(Origin・Sec-Fetch-Site)は、ブラウザが付ける値を模して付ける。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

async function connect(options: { origin?: string | null; token?: boolean; viewer?: boolean } = {}): Promise<{ fetch: FetchLike; sent: { url: string; init: Parameters<FetchLike>[1] }[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key, options.viewer === true ? { email: "friend@example.com" } : {});
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED, batch: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
  };
  const sent: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const headers = new Headers(init.headers);
    if (options.token !== false) headers.set("Cf-Access-Jwt-Assertion", token);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.set("Origin", origin);
    headers.set("Sec-Fetch-Site", "same-origin");
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers, body: init.body }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return { fetch: fetchLike, sent };
}

describe("fetchPromptPreview × 実際の handle()", () => {
  it("成功: サーバが組み立てた文面・clamped・promptVersion を、そのままの値で受け取る(バイト一致)", async () => {
    const c = await connect();
    const result = await fetchPromptPreview(c.fetch, { additionalInstruction: "慎重に\n二行目", clipVariant: "wide15" });
    expect(result).toEqual({ ok: true, preview: buildPreviewText({ additionalInstruction: "慎重に\n二行目", clipVariant: "wide15" }) });
    expect(result.ok && result.preview.text).toContain("慎重に\n二行目");
    expect(result.ok && result.preview.text).toContain("±15%(絶対値0.15)");
  });

  it("送るリクエストの形: POST /api/settings/prompt-preview・JSON・同一オリジン・参照元ポリシー。本文は 2 キーだけ", async () => {
    const c = await connect();
    await fetchPromptPreview(c.fetch, { additionalInstruction: "x", clipVariant: "default" });
    expect(c.sent).toHaveLength(1);
    const { url, init } = c.sent[0]!;
    expect(url).toBe("/api/settings/prompt-preview");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.referrerPolicy).toBe("same-origin");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ additionalInstruction: "x", clipVariant: "default" });
  });

  it("追加指示は先頭の 2,001 単位だけを送る。サーバの結果(text・clamped)は、元の長文を送ったときと同じ", async () => {
    const c = await connect();
    const long = `${"あ".repeat(1999)}😀${"い".repeat(500)}`;
    const result = await fetchPromptPreview(c.fetch, { additionalInstruction: long, clipVariant: "default" });
    expect(JSON.parse(c.sent[0]!.init.body as string).additionalInstruction).toBe(long.slice(0, 2001));
    expect(JSON.parse(c.sent[0]!.init.body as string).additionalInstruction.length).toBe(2001);
    expect(result).toEqual({ ok: true, preview: buildPreviewText({ additionalInstruction: long, clipVariant: "default" }) });
    expect(result.ok && result.preview.clamped).toBe(true);
  });

  it("失敗は { ok: false }: 閲覧者(403)・Origin の不一致(403)・認証なし(403)", async () => {
    for (const options of [{ viewer: true }, { origin: "https://evil.example" }, { origin: null }, { token: false }]) {
      const c = await connect(options);
      expect(await fetchPromptPreview(c.fetch, { additionalInstruction: "x", clipVariant: "default" }), JSON.stringify(options)).toEqual({ ok: false });
    }
  });
});

describe("fetchPromptPreview: 応答を信用しない(単体)", () => {
  const input = { additionalInstruction: "x", clipVariant: "default" };
  const respond = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
  const GOOD = { ok: true, text: "文面", clamped: false, promptVersion: "pv" };

  it("成功の形だけを採る(対照)", async () => {
    expect(await fetchPromptPreview(respond(200, GOOD), input)).toEqual({ ok: true, preview: { text: "文面", clamped: false, promptVersion: "pv" } });
  });

  it.each([
    ["200 以外", respond(500, GOOD)],
    ["ok が true でない", respond(200, { ...GOOD, ok: false })],
    ["text が文字列でない", respond(200, { ...GOOD, text: 5 })],
    ["text が無い", respond(200, { ok: true, clamped: false, promptVersion: "pv" })],
    ["clamped が真偽でない", respond(200, { ...GOOD, clamped: "false" })],
    ["promptVersion が文字列でない", respond(200, { ...GOOD, promptVersion: null })],
    ["本文が配列", respond(200, [GOOD])],
    ["本文が null", respond(200, null)],
    ["json() が投げる", async () => ({ status: 200, json: async () => { throw new SyntaxError("x"); } })],
    ["fetch が投げる", async () => { throw new TypeError("Failed to fetch"); }],
  ] as [string, FetchLike][])("%s は { ok: false }", async (_name, fetchLike) => {
    expect(await fetchPromptPreview(fetchLike, input)).toEqual({ ok: false });
  });
});

describe("previewRequestKey: 送る形で比べる", () => {
  it("同じ入力は同じ鍵・追加指示かクリップ幅が違えば違う鍵。2,001 単位より後ろの違いは文面に出ないので同じ鍵", () => {
    const base = { additionalInstruction: "a", clipVariant: "default" };
    expect(previewRequestKey(base)).toBe(previewRequestKey({ ...base }));
    expect(previewRequestKey({ ...base, additionalInstruction: "b" })).not.toBe(previewRequestKey(base));
    expect(previewRequestKey({ ...base, clipVariant: "wide15" })).not.toBe(previewRequestKey(base));
    expect(previewRequestKey({ ...base, additionalInstruction: `${"あ".repeat(2001)}A` })).toBe(previewRequestKey({ ...base, additionalInstruction: `${"あ".repeat(2001)}B` }));
    expect(previewRequestKey({ ...base, additionalInstruction: "あ".repeat(2001) })).not.toBe(previewRequestKey({ ...base, additionalInstruction: "あ".repeat(2000) }));
    // 区切りの曖昧さ: 追加指示の末尾と版 ID の境目をずらしても鍵が衝突しない
    expect(previewRequestKey({ additionalInstruction: "ab", clipVariant: "c" })).not.toBe(previewRequestKey({ additionalInstruction: "a", clipVariant: "bc" }));
  });
});
