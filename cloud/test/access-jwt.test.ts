import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  certsUrlOf,
  extractTokens,
  issuerOf,
  normalizeEmail,
  parseAccessConfig,
  parseAdminUsers,
  remoteKeys,
  roleOf,
  verifyAccessJwt,
  type AccessConfig,
} from "../src/access-jwt";
import { AUD, EMAIL, GOOD_ENV, ISSUER, localKeys, makeKey, NOW, NOW_SEC, signToken, TEAM } from "./helpers";

const CONFIG: AccessConfig = { teamName: TEAM, aud: AUD, allowedEmail: EMAIL, adminEmails: [EMAIL], adminSource: "fallback" };

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

describe("parseAccessConfig(設定は3項目そろって正しいときだけ有効。欠落・不正はフェイルクローズ)", () => {
  it("3項目がそろっていれば有効で、メールは小文字化・前後の空白除去される", () => {
    const result = parseAccessConfig({ ...GOOD_ENV, ACCESS_ALLOWED_EMAIL: "  Owner@Example.COM " });
    // ADMIN_USER が未登録なので、管理者は ACCESS_ALLOWED_EMAIL(移行期間のフォールバック)
    expect(result).toEqual({ ok: true, config: { teamName: TEAM, aud: AUD, allowedEmail: "owner@example.com", adminEmails: ["owner@example.com"], adminSource: "fallback" } });
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

// ---- Issue #238: 管理者(ADMIN_USER)の解釈と役割の判定 ----
describe("parseAdminUsers(ADMIN_USER の解釈。未登録のときだけ ACCESS_ALLOWED_EMAIL にフォールバックし、登録済みで有効が 0 件なら管理者なし)", () => {
  const FALLBACK = "owner@example.com";
  const A = "alice@example.com";
  const B = "bob@example.com";

  // 未登録 = undefined、または trim() が空。このときだけフォールバック(移行期間: デプロイ直後にオーナーが締め出されない)
  it.each([
    ["未登録(undefined)", undefined],
    ["空文字", ""],
    ["空白だけ", "   "],
    ["改行・タブだけ", "\n\t \r\n"],
  ])("%s → フォールバック(管理者は ACCESS_ALLOWED_EMAIL の 1 件)", (_name, raw) => {
    expect(parseAdminUsers(raw, FALLBACK)).toEqual({ emails: [FALLBACK], source: "fallback" });
  });

  // 登録済み: カンマで分割し、各項目を normalizeEmail(ASCII だけ小文字化・前後の空白除去)。形が正しい項目だけを管理者にする。重複は 1 件
  it.each([
    ["1 件", A, [A]],
    ["大文字小文字の違いは同じ人(ASCII だけ小文字化)", "Alice@Example.COM", [A]],
    ["前後の空白", `  ${A}\t`, [A]],
    ["複数", `${A},${B}`, [A, B]],
    ["カンマの前後の空白", `${A} , ${B}`, [A, B]],
    ["末尾のカンマ(空の項目は捨てる)", `${A},${B},`, [A, B]],
    ["先頭のカンマと連続したカンマ", `,${A},,${B}`, [A, B]],
    ["重複(大文字小文字違いを含む)は 1 件", `${A},ALICE@example.com,${A}`, [A]],
    ["有効な項目と無効な項目の混在は、有効なものだけ", `${A},bob,@example.com,carol@`, [A]],
    ["ケルビン記号(U+212A)は k に化けず、そのままの別の文字として残る", "\u212Aowner@example.com", ["\u212aowner@example.com"]],
  ])("登録済み: %s → 管理者はその一覧(configured)", (_name, raw, expected) => {
    expect(parseAdminUsers(raw, FALLBACK)).toEqual({ emails: expected, source: "configured" });
  });

  // 登録済み(未登録の定義に当たらない)で有効が 0 件 → 管理者なし(none)。フォールバックしない(fail-closed)
  it.each([
    ["カンマだけ", ","],
    ["カンマと空白だけ", " , ,, "],
    ["セミコロン区切り(1 項目に @ が 2 つ)", `${A};${B}`],
    ["空白区切り", `${A} ${B}`],
    ["改行区切り", `${A}\n${B}`],
    ["@ が無い", "alice"],
    ["@ が重なる", "alice@@example.com"],
    ["ローカル部が空", "@example.com"],
    ["ドメインが空", "alice@"],
    ["文字列でない(数値)", 123],
    ["文字列でない(null)", null],
    ["文字列でない(オブジェクト)", { a: 1 }],
    ["文字列でない(配列)", [A]],
  ])("登録済みで有効が 0 件(%s) → 管理者なし(none)。ACCESS_ALLOWED_EMAIL にフォールバックしない", (_name, raw) => {
    expect(parseAdminUsers(raw, FALLBACK)).toEqual({ emails: [], source: "none" });
  });
});

describe("parseAccessConfig と ADMIN_USER(ADMIN_USER の不備は設定全体を無効にしない。閲覧者に倒すだけ)", () => {
  it("ADMIN_USER 未登録 → adminEmails は ACCESS_ALLOWED_EMAIL(fallback)", () => {
    expect(parseAccessConfig({ ...GOOD_ENV })).toMatchObject({ ok: true, config: { adminEmails: [EMAIL], adminSource: "fallback" } });
  });

  it("ADMIN_USER が登録されたら、管理者は ADMIN_USER のアドレスだけ(ACCESS_ALLOWED_EMAIL は管理者から外れる)", () => {
    const result = parseAccessConfig({ ...GOOD_ENV, ADMIN_USER: "alice@example.com, Bob@example.com" });
    expect(result).toMatchObject({ ok: true, config: { allowedEmail: EMAIL, adminEmails: ["alice@example.com", "bob@example.com"], adminSource: "configured" } });
  });

  it.each([
    ["カンマだけ", ","],
    ["区切りが不正", "alice@example.com;bob@example.com"],
    ["文字列でない", 123 as unknown as string],
  ])("ADMIN_USER が不正(%s)でも設定は有効のまま(閲覧者を締め出さない)。管理者なし(none)", (_name, raw) => {
    expect(parseAccessConfig({ ...GOOD_ENV, ADMIN_USER: raw })).toMatchObject({ ok: true, config: { adminEmails: [], adminSource: "none" } });
  });

  // Q2: ACCESS_ALLOWED_EMAIL は必須のまま。ADMIN_USER が有効でも、ACCESS_ALLOWED_EMAIL の欠落・不正は全拒否(config-missing / config-invalid)
  it.each([
    ["ACCESS_ALLOWED_EMAIL が未設定", { ACCESS_ALLOWED_EMAIL: undefined }, "config-missing"],
    ["ACCESS_ALLOWED_EMAIL が空文字", { ACCESS_ALLOWED_EMAIL: "" }, "config-missing"],
    ["ACCESS_ALLOWED_EMAIL に @ が無い", { ACCESS_ALLOWED_EMAIL: "owner" }, "config-invalid"],
  ])("ADMIN_USER が有効でも、%s なら無効(%s)", (_name, override, reason) => {
    expect(parseAccessConfig({ ...GOOD_ENV, ADMIN_USER: "alice@example.com" })).toMatchObject({ ok: true });
    expect(parseAccessConfig({ ...GOOD_ENV, ADMIN_USER: "alice@example.com", ...override })).toEqual({ ok: false, reason });
  });
});

describe("roleOf(検証済みのメール → 役割。完全一致だけが admin。判定できなければ viewer)", () => {
  const config = (adminEmails: readonly string[]): Pick<AccessConfig, "adminEmails"> => ({ adminEmails });

  // 前提: 同じ表の中に admin になる行がある(全部 viewer になる退化を防ぐ)
  it.each([
    ["完全一致", "alice@example.com", "admin"],
    ["大文字小文字・前後の空白は正規化して一致", "  Alice@Example.COM ", "admin"],
    ["2 人目の管理者", "bob@example.com", "admin"],
    ["管理者でないアカウント", "friend@example.com", "viewer"],
    ["管理者のアドレスに文字が付く", "xalice@example.com", "viewer"],
    ["ドメインが違う", "alice@example.com.evil", "viewer"],
    ["カンマ連結(管理者を含む)は分割しない", "friend@example.com,alice@example.com", "viewer"],
    ["ケルビン記号が k に化けない", "\u212Aalice@example.com", "viewer"],
    ["空文字", "", "viewer"],
    ["空白だけ", "   ", "viewer"],
  ])("管理者 [alice, bob]: %s → %s", (_name, email, role) => {
    expect(roleOf(email, config(["alice@example.com", "bob@example.com"]))).toBe(role);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["数値", 123],
    ["オブジェクト", { toString: () => "alice@example.com" }],
  ])("メールが文字列でない(%s) → viewer", (_name, email) => {
    expect(roleOf(email, config(["alice@example.com"]))).toBe("viewer");
  });

  it("管理者の一覧が空(ADMIN_USER が登録済みで有効 0 件)なら、誰でも viewer", () => {
    expect(roleOf("alice@example.com", config(["alice@example.com"]))).toBe("admin"); // 対照
    expect(roleOf("alice@example.com", config([]))).toBe("viewer");
    expect(roleOf("owner@example.com", config([]))).toBe("viewer");
  });

  it("判定中に例外が起きたら viewer に倒す(管理者にしない)", () => {
    const broken = { get adminEmails(): readonly string[] { throw new Error("boom"); } };
    expect(roleOf("alice@example.com", broken)).toBe("viewer");
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
    // ASCII だけを小文字化する(toLowerCase は Unicode も変える: U+212A KELVIN SIGN → k、U+0130 → i̇)
    expect(normalizeEmail("\u212Aowner@example.com")).toBe("\u212aowner@example.com");
    expect(normalizeEmail("\u0130owner@example.com")).toBe("\u0130owner@example.com");
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

  // Issue #238(契約変更): 誰がログインできるかは Access のポリシーだけで決める。署名・iss・aud・exp が正しい JWT は、メールが管理者でなくても検証を通る
  // (旧: 許可した 1 件と違えば email-mismatch で拒否)。メールの一致は通す・通さないではなく、役割(roleOf)を決めるだけになった。
  it("管理者でないメールの JWT も、署名・iss・aud・exp が正しければ検証を通る(メールは正規化して返す。役割は roleOf が決める)", async () => {
    const key = await makeKey("k1");
    const token = await signToken(key, { email: "Stranger@Example.com" });
    const result = await verifyAccessJwt(token, CONFIG, localKeys(key), NOW);
    expect(result).toEqual({ ok: true, email: "stranger@example.com" });
    expect(roleOf("stranger@example.com", CONFIG)).toBe("viewer");
    // 対照: 管理者のメールの JWT は同じ経路で通り、役割は admin
    const admin = await verifyAccessJwt(await signToken(key), CONFIG, localKeys(key), NOW);
    expect(admin).toEqual({ ok: true, email: EMAIL });
    expect(roleOf(EMAIL, CONFIG)).toBe("admin");
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

  // 前提: RS256 の正常系は上で通っている。RS256 以外の非対称アルゴリズム(鍵も、その alg の正しい鍵)は、署名が正しくても拒否する
  it.each([["RS384"], ["RS512"], ["PS256"], ["ES256"], ["ES384"]])(
    "%s で正しく署名された JWT も alg-not-allowed(RS256 に固定)",
    async (alg) => {
      const rs256 = await makeKey("k-rs256");
      expect(await verifyAccessJwt(await signToken(rs256), CONFIG, localKeys(rs256), NOW)).toMatchObject({ ok: true });
      const key = await makeKey("k-other", alg);
      const token = await signToken(key);
      expect(await verifyAccessJwt(token, CONFIG, localKeys(key), NOW)).toEqual({ ok: false, reason: "alg-not-allowed" });
    },
  );

  // 前提: 完全一致のメールは admin になる。部分一致・連結・別ドメインは(Issue #238 以降)検証は通るが、**管理者にはならない**(viewer)。
  // 旧: これらは email-mismatch で拒否していた。「許可メールに化けない」という保証を、「管理者に化けない」に移した。
  it.each([
    ["先頭に文字が付く", "xowner@example.com"],
    ["末尾にドメインが付く", "owner@example.com.evil"],
    ["ドメインが短い", "owner@example.co"],
    ["ローカル部が短い", "wner@example.com"],
    ["許可メールを含むカンマ区切り(後ろ)", "stranger@example.com,owner@example.com"],
    ["許可メールを含むカンマ区切り(前)", "owner@example.com,stranger@example.com"],
    ["@ が重なる", "owner@@example.com"],
    ["ゼロ幅スペースが混ざる", "owner\u200b@example.com"],
  ])("JWT の email が管理者のメールと部分一致するだけ(%s)なら、検証は通るが viewer(管理者にならない)", async (_name, email) => {
    const key = await makeKey("k1");
    expect(await verifyAccessJwt(await signToken(key), CONFIG, localKeys(key), NOW)).toMatchObject({ ok: true });
    expect(roleOf(EMAIL, CONFIG)).toBe("admin");
    const result = await verifyAccessJwt(await signToken(key, { email }), CONFIG, localKeys(key), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // 型の絞り込み(上の expect が無条件に固定している)
    expect(roleOf(result.email, CONFIG)).toBe("viewer");
  });

  it("メールの小文字化は ASCII だけ: Unicode の大文字(ケルビン記号 U+212A)が k に化けて管理者にならない(viewer)", async () => {
    const key = await makeKey("k1");
    const config: AccessConfig = { teamName: TEAM, aud: AUD, allowedEmail: "kowner@example.com", adminEmails: ["kowner@example.com"], adminSource: "fallback" };
    const same = await verifyAccessJwt(await signToken(key, { email: "kowner@example.com" }), config, localKeys(key), NOW);
    expect(same).toEqual({ ok: true, email: "kowner@example.com" });
    expect(roleOf("kowner@example.com", config)).toBe("admin");
    const token = await signToken(key, { email: "\u212Aowner@example.com" });
    const result = await verifyAccessJwt(token, config, localKeys(key), NOW);
    expect(result).toEqual({ ok: true, email: "\u212aowner@example.com" });
    expect(roleOf("\u212Aowner@example.com", config)).toBe("viewer");
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

describe("remoteKeys(Access の鍵 URL からの取得。リクエストごとに作る)", () => {
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
    const config: AccessConfig = { teamName: team, aud: AUD, allowedEmail: EMAIL, adminEmails: [EMAIL], adminSource: "fallback" };
    const result = await verifyAccessJwt(token, config, remoteKeys(team), NOW);
    expect(result).toEqual({ ok: true, email: EMAIL });
    expect(requested).toEqual([`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`]);
  });

  it("取得が 500 のとき拒否される(keys-unavailable)", async () => {
    const key = await makeKey("remote-k");
    const team = "remote-500-team";
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    const token = await signToken(key, { iss: issuerOf(team) });
    const config: AccessConfig = { teamName: team, aud: AUD, allowedEmail: EMAIL, adminEmails: [EMAIL], adminSource: "fallback" };
    expect(await verifyAccessJwt(token, config, remoteKeys(team), NOW)).toEqual({ ok: false, reason: "keys-unavailable" });
  });

  it("取得関数はリクエストごとに新しく作る(module スコープで共有しない)。呼ぶたびに別の関数で、鍵の取得もそれぞれ行う", async () => {
    // Workers では、あるリクエストが作った取得中の Promise などの I/O を別のリクエストが待つと失敗しうる。
    expect(remoteKeys("fresh-team-a")).not.toBe(remoteKeys("fresh-team-a"));
    const key = await makeKey("remote-k");
    const team = "remote-twice-team";
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const token = await signToken(key, { iss: issuerOf(team) });
    const config: AccessConfig = { teamName: team, aud: AUD, allowedEmail: EMAIL, adminEmails: [EMAIL], adminSource: "fallback" };
    expect(await verifyAccessJwt(token, config, remoteKeys(team), NOW)).toMatchObject({ ok: true });
    expect(await verifyAccessJwt(token, config, remoteKeys(team), NOW)).toMatchObject({ ok: true });
    expect(fetches).toBe(2);
  });
});
