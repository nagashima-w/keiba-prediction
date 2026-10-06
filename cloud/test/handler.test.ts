import { describe, expect, it } from "vitest";
import { handle, type Env, type GateNamespaceLike } from "../src/handler";
import { renderPage } from "../src/page";
import { AUD, EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken, TEAM } from "./helpers";

function gate(ping: () => Promise<{ sqlite: boolean }>): GateNamespaceLike {
  return { idFromName: (name: string) => name, get: () => ({ ping }) };
}

const HEALTHY = gate(async () => ({ sqlite: true }));

function envOf(overrides: Partial<Env> = {}): Env {
  return { ...GOOD_ENV, NETKEIBA_GATE: HEALTHY, ...overrides };
}

async function setup() {
  const key = await makeKey("k1");
  const lines: string[] = [];
  const deps = { keys: () => localKeys(key), now: () => NOW, log: (line: string) => void lines.push(line) };
  const token = await signToken(key);
  return { key, deps, lines, token };
}

function req(path: string, init: RequestInit & { token?: string } = {}): Request {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }
  return new Request(`https://cloud.invalid${path}`, { ...rest, headers });
}

async function snapshot(response: Response) {
  return { status: response.status, body: await response.text(), headers: [...response.headers].sort() };
}

describe("認証の関門(すべてのルートの前。認証できなければ何もせず 403)", () => {
  it("正しい JWT なら通る(以降の否定テストの前提)", async () => {
    const { deps, token } = await setup();
    expect((await handle(req("/", { token }), envOf(), {}, deps)).status).toBe(200);
  });

  it.each([["GET", "/"], ["GET", "/api/health"], ["GET", "/no-such-path"], ["POST", "/"], ["GET", "/cdn-cgi/anything"]])(
    "JWT なしの %s %s は 403(404・405 にならない。ルートの存在を教えない)",
    async (method, path) => {
      const { deps } = await setup();
      const response = await handle(req(path, { method }), envOf(), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
    },
  );

  it("拒否の原因が違っても、応答(ステータス・本文・ヘッダ)は完全に同じで、設定の有無や理由は一切含まれない", async () => {
    const { key, deps, token } = await setup();
    const stranger = await signToken(key, { email: "stranger@example.com" });
    const expired = await signToken(key, { exp: 1 });
    const cases: Array<[string, Request, Env]> = [
      ["JWT なし", req("/"), envOf()],
      ["壊れた JWT", req("/", { token: "a.b.c" }), envOf()],
      ["期限切れ", req("/", { token: expired }), envOf()],
      ["別のメール", req("/", { token: stranger }), envOf()],
      ["チーム名が未設定", req("/", { token }), envOf({ ACCESS_TEAM_NAME: undefined })],
      ["AUD が未設定", req("/", { token }), envOf({ ACCESS_AUD: undefined })],
      ["許可メールが未設定", req("/", { token }), envOf({ ACCESS_ALLOWED_EMAIL: undefined })],
      ["チーム名が不正", req("/", { token }), envOf({ ACCESS_TEAM_NAME: "A/B" })],
    ];
    // 前提: 正常な JWT と完全な設定なら 200 になる(拒否が設定・JWT の差で起きていることの確認)
    expect((await handle(req("/", { token }), envOf(), {}, deps)).status).toBe(200);
    const snapshots = [];
    for (const [, request, env] of cases) {
      snapshots.push(await snapshot(await handle(request, env, {}, deps)));
    }
    expect(snapshots).toHaveLength(8);
    for (const s of snapshots) {
      expect(s.status).toBe(403);
      expect(s.body).toBe("forbidden");
      expect(s).toEqual(snapshots[0]);
    }
    const text = JSON.stringify(snapshots[0]);
    for (const secret of [TEAM, AUD, EMAIL, "config", "aud", "email", "expired", "token"]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("鍵の取得が例外になっても 403(例外を外へ出さない)", async () => {
    const { deps, token } = await setup();
    const failing = {
      ...deps,
      keys: () => async () => {
        throw new Error("network down");
      },
    };
    const response = await handle(req("/", { token }), envOf(), {}, failing as never);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("認証の処理で想定外の例外が出ても 403(フェイルクローズ)", async () => {
    const { deps, token } = await setup();
    const exploding = {
      ...deps,
      keys: () => {
        throw new Error("boom");
      },
    };
    expect((await handle(req("/", { token }), envOf(), {}, exploding)).status).toBe(403);
  });

  it("クッキーの JWT でも通る", async () => {
    const { deps, token } = await setup();
    const request = req("/", { headers: { cookie: `CF_Authorization=${token}` } });
    expect((await handle(request, envOf(), {}, deps)).status).toBe(200);
  });

  it("JWT が無くても、ctx.access が aud・メールとも一致すれば通る。一致しなければ 403", async () => {
    const { deps } = await setup();
    const good = { access: { aud: AUD, getIdentity: async () => ({ email: EMAIL }) } };
    const badAud = { access: { aud: "other", getIdentity: async () => ({ email: EMAIL }) } };
    const badEmail = { access: { aud: AUD, getIdentity: async () => ({ email: "stranger@example.com" }) } };
    expect((await handle(req("/"), envOf(), good, deps)).status).toBe(200);
    expect((await handle(req("/"), envOf(), badAud, deps)).status).toBe(403);
    expect((await handle(req("/"), envOf(), badEmail, deps)).status).toBe(403);
    // 設定が欠けていれば ctx.access が正しくても 403
    expect((await handle(req("/"), envOf({ ACCESS_AUD: undefined }), good, deps)).status).toBe(403);
  });
});

describe("ルート(認証後)", () => {
  it("GET / はログイン中のメールを表示する HTML を返す(スマホ幅の viewport・キャッシュ禁止)", async () => {
    const { deps, token } = await setup();
    const response = await handle(req("/", { token }), envOf(), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain(EMAIL);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<html lang="ja">');
  });

  it("HEAD / は本文なしの 200", async () => {
    const { deps, token } = await setup();
    const response = await handle(req("/", { token, method: "HEAD" }), envOf(), {}, deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("GET /api/health は DO の SQLite が動いていることを返す", async () => {
    const { deps, token } = await setup();
    const response = await handle(req("/api/health", { token }), envOf(), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, durableObject: { sqlite: true } });
  });

  it("DO が sqlite=false を返したら 503(ok:false)。DO が例外でも 503 で、例外の中身は返さない", async () => {
    const { deps, token } = await setup();
    const down = await handle(req("/api/health", { token }), envOf({ NETKEIBA_GATE: gate(async () => ({ sqlite: false })) }), {}, deps);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, durableObject: { sqlite: false } });
    const throwing = gate(async () => {
      throw new Error("internal detail");
    });
    const failed = await handle(req("/api/health", { token }), envOf({ NETKEIBA_GATE: throwing }), {}, deps);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("internal detail");
  });

  it("未知のパスは 404、GET/HEAD 以外は 405(Allow 付き)", async () => {
    const { deps, token } = await setup();
    expect((await handle(req("/nope", { token }), envOf(), {}, deps)).status).toBe(404);
    const post = await handle(req("/", { token, method: "POST" }), envOf(), {}, deps);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("renderPage(メールの HTML エスケープ)", () => {
  it("特殊文字をエスケープする", () => {
    const html = renderPage(`"><script>alert(1)</script>&'@example.com`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
  });
});

describe("ログ(経路名と理由コードだけ。値は出さない)", () => {
  it("成功時は経路名(header / cookie / ctx-access)だけが出る", async () => {
    const { deps, lines, token } = await setup();
    await handle(req("/", { token }), envOf(), {}, deps);
    await handle(req("/", { headers: { cookie: `CF_Authorization=${token}` } }), envOf(), {}, deps);
    await handle(req("/"), envOf(), { access: { aud: AUD, getIdentity: async () => ({ email: EMAIL }) } }, deps);
    expect(lines).toEqual(["access: ok via=header", "access: ok via=cookie", "access: ok via=ctx-access"]);
  });

  it("拒否時は理由コードだけが出る。トークン・メール・チーム名・AUD は出ない", async () => {
    const { key, deps, lines, token } = await setup();
    const stranger = await signToken(key, { email: "stranger@example.com" });
    await handle(req("/", { token: stranger }), envOf(), {}, deps);
    await handle(req("/", { token }), envOf({ ACCESS_AUD: undefined }), {}, deps);
    await handle(req("/"), envOf(), {}, deps);
    expect(lines).toEqual([
      "access: denied reason=header:email-mismatch",
      "access: denied reason=config-missing",
      "access: denied reason=no-credentials",
    ]);
    const all = lines.join("\n");
    for (const secret of [token, stranger, EMAIL, "stranger@example.com", TEAM, AUD]) {
      expect(all).not.toContain(secret);
    }
  });
});
