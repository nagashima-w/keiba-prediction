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

describe("authenticate(取得元の順: ヘッダ → クッキー → ctx.access。どれか1つが通れば通る。ADMIN_USER 未登録のときの管理者は ACCESS_ALLOWED_EMAIL)", () => {
  it("ヘッダの JWT で通り、経路は header", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": await signToken(key) } });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "header", role: "admin", admins: "fallback" });
  });

  it("ヘッダが無く、クッキーの JWT で通り、経路は cookie", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, { headers: { cookie: `CF_Authorization=${await signToken(key)}` } });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "cookie", role: "admin", admins: "fallback" });
  });

  it("ヘッダが不正でもクッキーが正しければ通る(経路は cookie)。ヘッダの失敗理由は記録に残らない", async () => {
    const { key, keys } = await setup();
    const request = new Request(URL_, {
      headers: { "Cf-Access-Jwt-Assertion": "a.b.c", cookie: `CF_Authorization=${await signToken(key)}` },
    });
    expect(await authenticate(request, GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: true, email: EMAIL, via: "cookie", role: "admin", admins: "fallback" });
  });

  it("JWT が無く ctx.access だけがあるとき、aud とメールが一致すれば通る(経路は ctx-access)", async () => {
    const { keys } = await setup();
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: EMAIL }) }, { keys, now: NOW });
    expect(result).toEqual({ ok: true, email: EMAIL, via: "ctx-access", role: "admin", admins: "fallback" });
  });

  it("ctx.access でも、メールは大文字小文字・空白を無視して照合する", async () => {
    const { keys } = await setup();
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: " OWNER@example.com " }) }, { keys, now: NOW });
    expect(result).toMatchObject({ ok: true, via: "ctx-access" });
  });

  // 前提: 上の ctx-access の正常系が通る。以下は1項目だけ変えた拒否。
  it.each([
    ["aud が ACCESS_AUD と違う", access({ email: EMAIL }, "another-aud"), "ctx-access:aud-mismatch"],
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

  // Issue #238(契約変更): 旧「メールが許可した 1 件と違えば ctx-access:email-mismatch で拒否」は、「通るが viewer」に変わった
  it("ctx.access: 管理者でないメールも、aud が正しければ通る(経路は ctx-access、役割は viewer)", async () => {
    const { keys } = await setup();
    const result = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: "Stranger@Example.com" }) }, { keys, now: NOW });
    expect(result).toEqual({ ok: true, email: "stranger@example.com", via: "ctx-access", role: "viewer", admins: "fallback" });
    // 閲覧者でも aud の不一致・メールの欠落は拒否のまま(関門が緩んだのは「メールの一致」だけ)
    const badAud = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ email: "stranger@example.com" }, "another-aud") }, { keys, now: NOW });
    expect(badAud).toEqual({ ok: false, reason: "ctx-access:aud-mismatch" });
    const noEmail = await authenticate(new Request(URL_), GOOD_ENV, { access: access({ name: "x" }) }, { keys, now: NOW });
    expect(noEmail).toEqual({ ok: false, reason: "ctx-access:email-missing" });
  });

  it("どの取得元も無ければ no-credentials で拒否する", async () => {
    const { keys } = await setup();
    expect(await authenticate(new Request(URL_), GOOD_ENV, {}, { keys, now: NOW })).toEqual({ ok: false, reason: "no-credentials" });
  });

  it("ヘッダとクッキーの JWT がともに不正なとき、経路ごとの理由が並ぶ(値は含まない)", async () => {
    const { key, keys } = await setup();
    const expired = await signToken(key, { exp: 1 });
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": expired, cookie: "CF_Authorization=a.b.c" } });
    const result = await authenticate(request, GOOD_ENV, {}, { keys, now: NOW });
    expect(result).toEqual({ ok: false, reason: "header:expired,cookie:malformed" });
  });

  // ゲートの確定: ctx.access を使うのは、ヘッダにもクッキーにも JWT が無いときだけ。
  // 不正な JWT が付いているリクエストは改ざんの疑いがあるので、別の経路(ctx.access)で救わない。
  it("JWT があって不正なら、ctx.access が正しくても拒否する(ctx.access には進まない。理由に ctx-access が出ない)", async () => {
    const { key, keys } = await setup();
    const validCtx = { access: access({ email: EMAIL }) };
    // 前提: JWT が無ければ、この ctx.access で通る(拒否が ctx.access の不備ではなく JWT の存在による確認)
    expect(await authenticate(new Request(URL_), GOOD_ENV, validCtx, { keys, now: NOW })).toMatchObject({ ok: true, via: "ctx-access" });
    const expired = await signToken(key, { exp: 1 });
    const viaHeader = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": expired } });
    expect(await authenticate(viaHeader, GOOD_ENV, validCtx, { keys, now: NOW })).toEqual({ ok: false, reason: "header:expired" });
    const viaCookie = new Request(URL_, { headers: { cookie: "CF_Authorization=a.b.c" } });
    expect(await authenticate(viaCookie, GOOD_ENV, validCtx, { keys, now: NOW })).toEqual({ ok: false, reason: "cookie:malformed" });
  });

  it("JWT があるときは ctx.access を参照すらしない(getIdentity も aud も呼ばれない)", async () => {
    const { keys } = await setup();
    let touched = 0;
    const spy = {
      get access(): AccessContextLike {
        touched += 1;
        return access({ email: EMAIL });
      },
    };
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } });
    expect((await authenticate(request, GOOD_ENV, spy, { keys, now: NOW })).ok).toBe(false);
    expect(touched).toBe(0);
    // 前提: JWT が無ければ参照される(スパイが働いている確認)
    await authenticate(new Request(URL_), GOOD_ENV, spy, { keys, now: NOW });
    expect(touched).toBe(1);
  });

  // 部分一致するだけのメールは、ctx.access の経路でも管理者にならない(前提: 完全一致は admin)。旧: ctx-access:email-mismatch で拒否 → 新: 通るが viewer
  it.each([
    ["先頭に文字が付く", "xowner@example.com"],
    ["末尾にドメインが付く", "owner@example.com.evil"],
    ["ドメインが短い", "owner@example.co"],
    ["カンマ区切りに許可メールを含む", "stranger@example.com,owner@example.com"],
    ["ケルビン記号(Unicode の大文字)が k に化ける形", "\u212Aowner@example.com"],
  ])("ctx.access のメールが部分一致するだけ(%s)なら、通るが管理者にならない(viewer)", async (_name, email) => {
    const { keys } = await setup();
    const config = { ...GOOD_ENV, ACCESS_ALLOWED_EMAIL: email === "\u212Aowner@example.com" ? "kowner@example.com" : EMAIL };
    const adminEmail = email === "\u212Aowner@example.com" ? "kowner@example.com" : EMAIL;
    expect(await authenticate(new Request(URL_), config, { access: access({ email: adminEmail }) }, { keys, now: NOW })).toMatchObject({ ok: true, role: "admin" });
    const result = await authenticate(new Request(URL_), config, { access: access({ email }) }, { keys, now: NOW });
    expect(result).toMatchObject({ ok: true, via: "ctx-access", role: "viewer" });
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

// ---- Issue #238: 役割(admin / viewer)。誰がログインできるかは Access のポリシーだけ。Worker は検証に通ったアカウントをすべて受け入れる ----
describe("authenticate の役割(ヘッダ・クッキー・ctx.access のどの経路でも同じ判定)", () => {
  const VIEWER = "friend@example.com";
  const ADMIN2 = "admin2@example.com";

  async function viaAllRoutes(email: string, env: Parameters<typeof authenticate>[1]) {
    const { key, keys } = await setup();
    const token = await signToken(key, { email });
    const header = await authenticate(new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": token } }), env, {}, { keys, now: NOW });
    const cookie = await authenticate(new Request(URL_, { headers: { cookie: `CF_Authorization=${token}` } }), env, {}, { keys, now: NOW });
    const ctx = await authenticate(new Request(URL_), env, { access: access({ email }) }, { keys, now: NOW });
    return { header, cookie, ctx };
  }

  // 表: [名前, ADMIN_USER, 管理者の想定, 閲覧者の想定, admins]。ADMIN_USER が入る/入らないで、同じ 2 人の役割がどう変わるか
  it.each([
    ["ADMIN_USER 未登録 → ACCESS_ALLOWED_EMAIL が管理者(移行期間)", undefined, EMAIL, "fallback"],
    ["ADMIN_USER が空文字 → フォールバック", "", EMAIL, "fallback"],
    ["ADMIN_USER が空白だけ → フォールバック", "   ", EMAIL, "fallback"],
    ["ADMIN_USER が登録済み → ACCESS_ALLOWED_EMAIL は管理者から外れ、ADMIN_USER の人だけが管理者", ADMIN2, ADMIN2, "configured"],
    ["ADMIN_USER が複数(大文字・空白つき)", ` ${EMAIL.toUpperCase()} , ${ADMIN2}`, ADMIN2, "configured"],
  ])("%s", async (_name, adminUser, adminEmail, admins) => {
    const env = { ...GOOD_ENV, ...(adminUser === undefined ? {} : { ADMIN_USER: adminUser }) };
    const admin = await viaAllRoutes(adminEmail, env);
    for (const result of [admin.header, admin.cookie, admin.ctx]) {
      expect(result).toMatchObject({ ok: true, email: adminEmail.trim().toLowerCase(), role: "admin", admins });
    }
    const viewer = await viaAllRoutes(VIEWER, env);
    for (const result of [viewer.header, viewer.cookie, viewer.ctx]) {
      expect(result).toMatchObject({ ok: true, email: VIEWER, role: "viewer", admins });
    }
  });

  it("ADMIN_USER が登録済みで ACCESS_ALLOWED_EMAIL と別の人なら、ACCESS_ALLOWED_EMAIL の人は(ログインできるが)viewer", async () => {
    const result = await viaAllRoutes(EMAIL, { ...GOOD_ENV, ADMIN_USER: ADMIN2 });
    for (const r of [result.header, result.cookie, result.ctx]) {
      expect(r).toMatchObject({ ok: true, role: "viewer", admins: "configured" });
    }
  });

  it.each([
    ["カンマだけ", ","],
    ["区切りが不正(セミコロン)", `${EMAIL};${ADMIN2}`],
    ["文字列でない", 123 as unknown as string],
  ])("ADMIN_USER が登録済みで有効 0 件(%s) → 管理者なし。ACCESS_ALLOWED_EMAIL の人も viewer(閲覧者に倒す。admins=none)", async (_name, adminUser) => {
    const result = await viaAllRoutes(EMAIL, { ...GOOD_ENV, ADMIN_USER: adminUser });
    for (const r of [result.header, result.cookie, result.ctx]) {
      expect(r).toEqual({ ok: true, email: EMAIL, via: expect.any(String), role: "viewer", admins: "none" });
    }
  });

  it("閲覧者を受け入れても、認証に失敗すれば従来どおりすべて拒否する(役割は認証に通ってからの話)", async () => {
    const { key, keys } = await setup();
    const forged = await signToken(key, { email: VIEWER, aud: "another-aud" });
    const request = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": forged } });
    expect(await authenticate(request, { ...GOOD_ENV, ADMIN_USER: VIEWER }, {}, { keys, now: NOW })).toEqual({ ok: false, reason: "header:aud-mismatch" });
    // 設定が欠けていれば、ADMIN_USER があっても全拒否
    const valid = new Request(URL_, { headers: { "Cf-Access-Jwt-Assertion": await signToken(key, { email: VIEWER }) } });
    expect(await authenticate(valid, { ...GOOD_ENV, ACCESS_ALLOWED_EMAIL: undefined, ADMIN_USER: VIEWER }, {}, { keys, now: NOW })).toEqual({ ok: false, reason: "config-missing" });
  });
});
