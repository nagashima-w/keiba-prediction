import { describe, expect, it } from "vitest";
import { authenticate, type AccessContextLike } from "../src/authenticate";
import { AUD, EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken, TEAM } from "./helpers";

const URL_ = "https://x.invalid/";

async function setup() {
  const key = await makeKey("k1");
  return { key, keys: () => localKeys(key) };
}

function access(identity: Record<string, unknown> | undefined, aud = AUD): AccessContextLike {
  return { aud, getIdentity: async () => identity };
}

describe("authenticate(取得元の順: ヘッダ → クッキー → ctx.access。どれか1つが通れば通る)", () => {
  it("ヘッダの JWT で通り、経路は header", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": await signToken(key) } });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "header" });
  });

  it("ヘッダが無く、クッキーの JWT で通り、経路は cookie", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, { headers: { cookie: `CF_Authorization=${await signToken(key)}` } });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "cookie" });
  });

  it("ヘッダが不正でもクッキーが正しければ通る(経路は cookie)。ヘッダの失敗理由は記録に残らない", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, {
      headers: { "Cf-Access-Jwt-Assertion": "a.b.c", cookie: `CF_Authorization=${await signToken(key)}` },
    });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "cookie" });
  });

  it("JWT が無く ctx.access だけがあるとき、aud とメールが一致すれば通る(経路は ctx-access)", async () => {
    const { keys } = await setup();
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: EMAIL }) }, { keys, now: NOW });
    expect(result).toEqual({ ok: true, email: EMAIL, via: "ctx-access" });
  });

  it("ctx.access でも、メールは大文字小文字・空白を無視して照合する", async () => {
    const { keys } = await setup();
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: " OWNER@example.com " }) }, { keys, now: NOW });
    expect(result).toMatchObject({ ok: true, via: "ctx-access" });
  });

  // 前提: 上の ctx-access の正常系が通る。以下は1項目だけ変えた拒否。
  it.each([
    ["aud が ACCESS_AUD と違う", access({ email: EMAIL }, "another-aud"), "ctx-access:aud-mismatch"],
    ["メールが許可した1件と違う", access({ email: "stranger@example.com" }), "ctx-access:email-mismatch"],
    ["identity にメールが無い", access({ name: "x" }), "ctx-access:email-missing"],
    ["identity が undefined", access(undefined), "ctx-access:email-missing"],
    [
      "getIdentity が例外",
      {
        aud: AUD,
        getIdentity: async () => {
          throw new Error("boom");
        },
      } satisfies AccessContextLike,
      "ctx-access:identity-error",
    ],
  ])("ctx.access: %s → 拒否", async (_name, ctxAccess, reason) => {
    const { keys } = await setup();
    const ok = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: EMAIL }) }, { keys, now: NOW });
    expect(ok.ok).toBe(true);
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: ctxAccess }, { keys, now: NOW });
    expect(result).toEqual({ ok: false, reason });
  });

  it("どの取得元も無ければ no-credentials で拒否する", async () => {
    const { keys } = await setup();
    expect(await authenticate(new Request(URL_), GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: false, reason: "no-credentials" });
  });

  it("ヘッダ・クッキー・ctx.access のすべてが不正なとき、経路ごとの理由が並ぶ(値は含まない)", async () => {
    const { key, keys } = await setup();
    const expired = await signToken(key, { exp: 1 });
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": expired, cookie: "CF_Authorization=a.b.c" } });
    const result = await authenticate(request, GOOD_ENV, { access: access({ email: "stranger@example.com" }) }, { keys, now: NOW });
    expect(result).toEqual({ ok: false, reason: "header:expired,cookie:malformed,ctx-access:email-mismatch" });
  });

  // 設定の欠落は、どの取得元が有効でも通さない(JWT も ctx.access も検証しない)
  it.each([
    ["ACCESS_TEAM_NAME", { ACCESS_TEAM_NAME: undefined }],
    ["ACCESS_AUD", { ACCESS_AUD: undefined }],
    ["ACCESS_ALLOWED_EMAIL", { ACCESS_ALLOWED_EMAIL: undefined }],
  ])("%s が欠けていれば、有効な JWT と有効な ctx.access があっても拒否する", async (_name, override) => {
    const { key, keys } = await setup();
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": await signToken(key) } });
    const ctx = { access: access({ email: EMAIL }) };
    expect(await authenticate(request, GOOD_ENV, ctx, { keys, now: NOW })).toMatchObject({ ok: true });
    expect(await authenticate(request, { ...GOOD_ENV, ...override }, ctx, { keys, now: NOW })).toEqual({
      ok: false,
      reason: "config-missing",
    });
  });

  it("チーム名が不正な形式なら config-invalid で拒否する", async () => {
    const { keys } = await setup();
    const result = await authenticate(
      new Request(URL_),
      { ...GOOD_ENV, ACCESS_TEAM_NAME: `${TEAM}.cloudflareaccess.com` },
      { access: access({ email: EMAIL }) },
      { keys, now: NOW },
    );
    expect(result).toEqual({ ok: false, reason: "config-invalid" });
  });

  it("鍵の取得関数が同期的に例外を投げても拒否に落ちる(例外を外へ出さない)", async () => {
    const { key } = await setup();
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": await signToken(key) } });
    const result = await authenticate(request, GOOD_ENV, {}, {
      keys: () => {
        throw new Error("boom");
      },
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "header:keys-unavailable" });
  });
});
