import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  certsUrlOf,
  extractTokens,
  issuerOf,
  normalizeEmail,
  parseAccessConfig,
  remoteKeys,
  verifyAccessJwt,
  type AccessConfig,
} from "../src/access-jwt";
import { AUD, EMAIL, GOOD_ENV, ISSUER, localKeys, makeKey, NOW, NOW_SEC, signToken, TEAM } from "./helpers";

const CONFIG: AccessConfig = { teamName: TEAM, aud: AUD, allowedEmail: EMAIL };

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

describe("parseAccessConfig(設定は3項目そろって正しいときだけ有効。欠落・不正はフェイルクローズ)", () => {
  it("3項目がそろっていれば有効で、メールは小文字化・前後の空白除去される", () => {
    const result = parseAccessConfig({ ...GOOD_ENV, ACCESS_ALLOWED_EMAIL: "  Owner@Example.COM " });
    expect(result).toEqual({ ok: true, config: { teamName: TEAM, aud: AUD, allowedEmail: "owner@example.com" } });
  });

  // 前提: 上の正常系が有効になる入力から、1項目だけを変えた表(1項目ずつ変えるので、欠落が原因だと特定できる)
  it.each([
    ["ACCESS_TEAM_NAME が未設定", { ACCESS_TEAM_NAME: undefined }, "config-missing"],
    ["ACCESS_TEAM_NAME が空文字", { ACCESS_TEAM_NAME: "" }, "config-missing"],
    ["ACCESS_TEAM_NAME が空白だけ", { ACCESS_TEAM_NAME: "   " }, "config-missing"],
    ["ACCESS_AUD が未設定", { ACCESS_AUD: undefined }, "config-missing"],
    ["ACCESS_AUD が空文字", { ACCESS_AUD: "" }, "config-missing"],
    ["ACCESS_ALLOWED_EMAIL が未設定", { ACCESS_ALLOWED_EMAIL: undefined }, "config-missing"],
    ["ACCESS_ALLOWED_EMAIL が空文字", { ACCESS_ALLOWED_EMAIL: "" }, "config-missing"],
    ["ACCESS_ALLOWED_EMAIL に @ が無い", { ACCESS_ALLOWED_EMAIL: "owner" }, "config-invalid"],
    ["ACCESS_TEAM_NAME が URL の形(.cloudflareaccess.com 付き)", { ACCESS_TEAM_NAME: "example-team.cloudflareaccess.com" }, "config-invalid"],
    ["ACCESS_TEAM_NAME に / を含む(別ホストへ誘導する形)", { ACCESS_TEAM_NAME: "evil.example/x" }, "config-invalid"],
    ["ACCESS_TEAM_NAME に大文字を含む", { ACCESS_TEAM_NAME: "Example-Team" }, "config-invalid"],
    ["ACCESS_TEAM_NAME が文字列でない", { ACCESS_TEAM_NAME: 123 as unknown as string }, "config-invalid"],
  ])("%s → 無効(%s)", (_name, override, reason) => {
    expect(parseAccessConfig({ ...GOOD_ENV })).toMatchObject({ ok: true });
    expect(parseAccessConfig({ ...GOOD_ENV, ...override })).toEqual({ ok: false, reason });
  });
});

describe("issuerOf / certsUrlOf(チーム名から組み立てる。URL を設定に持たせない)", () => {
  it("issuer は https://<team>.cloudflareaccess.com、鍵の URL はその /cdn-cgi/access/certs", () => {
    expect(issuerOf("example-team")).toBe("https://example-team.cloudflareaccess.com");
    expect(certsUrlOf("example-team")).toBe("https://example-team.cloudflareaccess.com/cdn-cgi/access/certs");
  });
});

describe("normalizeEmail", () => {
  it("小文字化と前後の空白除去。文字列でなければ null", () => {
    expect(normalizeEmail("  A@Example.Com ")).toBe("a@example.com");
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("extractTokens(JWT の取得元はヘッダ → クッキーの順)", () => {
  const url = "https://x.invalid/";
  it("ヘッダだけ・クッキーだけ・両方・どちらもない", () => {
    expect(extractTokens(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "H" } }))).toEqual([
      { source: "header", token: "H" },
    ]);
    expect(extractTokens(new Request(url, { headers: { cookie: "a=1; CF_Authorization=C; b=2" } }))).toEqual([
      { source: "cookie", token: "C" },
    ]);
    expect(
      extractTokens(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "H", cookie: "CF_Authorization=C" } })),
    ).toEqual([
      { source: "header", token: "H" },
      { source: "cookie", token: "C" },
    ]);
    expect(extractTokens(new Request(url))).toEqual([]);
  });

  it("空のヘッダ・空のクッキー値・名前が似ているだけのクッキーは取得元にならない", () => {
    expect(extractTokens(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "  " } }))).toEqual([]);
    expect(extractTokens(new Request(url, { headers: { cookie: "CF_Authorization=" } }))).toEqual([]);
    expect(extractTokens(new Request(url, { headers: { cookie: "XCF_Authorization=Z; CF_Authorization_x=Y" } }))).toEqual([]);
  });
});

describe("verifyAccessJwt(署名・iss・aud・exp・nbf・メールの一致)", () => {
  it("正常な JWT は通り、メールを返す(以降の否定テストの前提)", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key);
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: true, email: EMAIL });
  });

  it("aud が配列の複数要素で、その1つが一致すれば通る(Access の aud は配列)", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { aud: ["other-app", AUD] });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: true, email: EMAIL });
  });

  it("鍵が複数あっても kid で引ける(鍵のローテーション中)", async () => {
    const oldKey = await makeKey("old");
    const newKey = await makeKey("new");
    const token = await signToken(newKey);
    expect(await verifyAccessJwt(token, CONFIG, localKeys(oldKey, newKey), NOW)).toEqual({ ok: true, email: EMAIL });
  });

  it("メールは大文字小文字・前後の空白を無視して一致を見る", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { email: "OWNER@Example.com" });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: true, email: EMAIL });
  });

  // 前提(正常系が通ること)は上で固定済み。以下は1項目だけ変えた拒否の表。
  it("別の鍵で署名された JWT は bad-signature", async () => {
    const real = await makeKey("k1");
    const attacker = await makeKey("k1"); // kid を偽装した別の鍵
    expect(await verifyAccessJwt(await signToken(real), CONFIG, localKeys(real), NOW)).toMatchObject({ ok: true });
    const forged = await signToken(attacker);
    expect(await verifyAccessJwt(forged, CONFIG, localKeys(real), NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("鍵一覧に無い kid は unknown-key", async () => {
    const key = await makeKey("k1");
    const other = await makeKey("k2");
    const token = await signToken(other);
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("aud が一致しない JWT は aud-mismatch", async () => {
    const key = await makeKey("k1");
    expect(await verifyAccessJwt(await signToken(key), CONFIG, localKeys(key), NOW)).toMatchObject({ ok: true });
    const token = await signToken(key, { aud: ["another-app-aud"] });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "aud-mismatch" });
  });

  it("iss が一致しない JWT は iss-mismatch", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { iss: "https://other-team.cloudflareaccess.com" });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "iss-mismatch" });
  });

  it("期限切れの JWT は expired(exp は現在時刻ちょうどでも切れとみなす)", async () => {
    const key = await makeKey("k1");
    expect(await verifyAccessJwt(await signToken(key), CONFIG, localKeys(key), NOW)).toMatchObject({ ok: true });
    const expired = await signToken(key, { exp: NOW_SEC - 1 });
    expect(await verifyAccessJwt(expired, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "expired" });
    const atExp = await signToken(key, { exp: NOW_SEC });
    expect(await verifyAccessJwt(atExp, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("exp の無い JWT は claim-missing(無期限のトークンを通さない)", async () => {
    const key = await makeKey("k1");
    expect(await verifyAccessJwt(await signToken(key), CONFIG, localKeys(key), NOW)).toMatchObject({ ok: true });
    const token = await signToken(key, { exp: null });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "claim-missing" });
  });

  it("nbf が未来の JWT は not-yet-valid", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { nbf: NOW_SEC + 600 });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("許可していないメールの JWT は email-mismatch(署名・aud が正しくても通さない)", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { email: "stranger@example.com" });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "email-mismatch" });
  });

  it("email クレームの無い JWT(サービストークン等)は email-missing", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { email: null });
    expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "email-missing" });
  });

  it("alg=none の JWT は拒否される(署名なしで通らない)", async () => {
    const key = await makeKey("k1");
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(
      JSON.stringify({ iss: ISSUER, aud: [AUD], email: EMAIL, exp: NOW_SEC + 3600 }),
    )}.`;
    const result = await verifyAccessJwt(none, CONFIG, localKeys(key), NOW);
    expect(result.ok).toBe(false);
  });

  it("HS256(共通鍵)で署名された JWT は alg-not-allowed(RS256 に固定。alg 差し替え攻撃の防止)", async () => {
    const key = await makeKey("k1");
    const hs = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience([AUD])
      .setExpirationTime(NOW_SEC + 3600)
      .sign(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
    expect(await verifyAccessJwt(hs, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "alg-not-allowed" });
  });

  it.each([["空文字", ""], ["ドットなし", "abc"], ["3部だが壊れている", "a.b.c"]])(
    "壊れたトークン(%s)は malformed",
    async (_name, token) => {
      const key = await makeKey("k1");
      expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "malformed" });
    },
  );

  it("鍵の取得が例外になったら keys-unavailable で拒否する(通さない)", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key);
    const failing = async () => {
      throw new Error("network down");
    };
    expect(await verifyAccessJwt(token, CONFIG, failing as never, NOW)).toEqual({ ok: false, reason: "keys-unavailable" });
  });
});

describe("remoteKeys(Access の鍵 URL からの取得。チームごとにキャッシュ)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("チーム名から組み立てた certs URL を取得し、取得した鍵で検証できる", async () => {
    const key = await makeKey("remote-k");
    const team = "remote-ok-team";
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const token = await signToken(key, { iss: issuerOf(team) });
    const config: AccessConfig = { teamName: team, aud: AUD, allowedEmail: EMAIL };
    const result = await verifyAccessJwt(token, config, remoteKeys(team), NOW);
    expect(result).toEqual({ ok: true, email: EMAIL });
    expect(requested).toEqual([`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`]);
  });

  it("取得が 500 のとき拒否される(keys-unavailable)", async () => {
    const key = await makeKey("remote-k");
    const team = "remote-500-team";
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    const token = await signToken(key, { iss: issuerOf(team) });
    const config: AccessConfig = { teamName: team, aud: AUD, allowedEmail: EMAIL };
    expect(await verifyAccessJwt(token, config, remoteKeys(team), NOW)).toEqual({ ok: false, reason: "keys-unavailable" });
  });

  it("同じチーム名には同じ取得関数を返し(キャッシュを共有)、別のチーム名には別の関数を返す", () => {
    expect(remoteKeys("cache-team-a")).toBe(remoteKeys("cache-team-a"));
    expect(remoteKeys("cache-team-a")).not.toBe(remoteKeys("cache-team-b"));
  });
});
