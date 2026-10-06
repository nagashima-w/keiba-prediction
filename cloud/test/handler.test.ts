import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GateResult, GateStatus } from "../src/gate-core";
import { handle, type Env, type GateNamespaceLike, type GateStubLike } from "../src/handler";
import { validateRaceId } from "../src/netkeiba-check";
import { CHECK_DEFAULT_RACE_ID, renderPage } from "../src/page";
import { AUD, EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken, TEAM } from "./helpers";

const EMPTY_STATUS: GateStatus = { consecutiveRefusals: 0, blockedUntil: null, lastStartAt: null, pending: 0 };

function gate(ping: () => Promise<{ sqlite: boolean }>, extra: Partial<GateStubLike> = {}): GateNamespaceLike {
  const stub: GateStubLike = {
    ping,
    fetchRaw: async () => {
      throw new Error("fetchRaw は呼ばれない想定");
    },
    status: async () => EMPTY_STATUS,
    ...extra,
  };
  return { idFromName: (name: string) => name, get: () => stub };
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

  // 前提(正しい JWT で / は 200)は上のテストで固定済み。未認証なら、メソッド・パスの正規化の癖に関わらず同一の 403
  it.each([
    ["HEAD", "/", "HEAD /"],
    ["OPTIONS", "/", "OPTIONS /"],
    ["GET", "//api/health", "二重スラッシュ"],
    ["GET", "/api/health/", "末尾スラッシュ"],
    ["GET", "/%61pi/health", "パーセントエンコードされた api"],
    ["GET", "/api/health?x=1", "クエリ付き"],
    ["DELETE", "/api/health", "DELETE"],
  ])("JWT なしの %s %s(%s)は、ルートの有無によらず他の拒否と同一の 403(本文とヘッダ)", async (method, path) => {
    const { deps, token } = await setup();
    expect((await handle(req("/", { token }), envOf(), {}, deps)).status).toBe(200);
    const reference = await snapshot(await handle(req("/"), envOf(), {}, deps));
    expect(reference.status).toBe(403);
    expect(reference.body).toBe("forbidden");
    const actual = await snapshot(await handle(req(path, { method }), envOf(), {}, deps));
    expect(actual).toEqual(reference);
  });

  it("handler の catch を通る経路(ctx.access の参照が例外)でも、同一の 403 を返し、ログは reason=error だけ", async () => {
    const { deps, lines } = await setup();
    const reference = await snapshot(await handle(req("/"), envOf(), {}, deps));
    lines.length = 0;
    const exploding = {
      get access(): never {
        throw new Error("boom with secret detail");
      },
    };
    const response = await handle(req("/"), envOf(), exploding, deps);
    expect(await snapshot(response)).toEqual(reference);
    expect(lines).toEqual(["access: denied reason=error"]);
    expect(lines.join("\n")).not.toContain("boom");
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

  it("不正な JWT が付いていれば、ctx.access が正しくても 403(別の経路で救わない)", async () => {
    const { deps, lines } = await setup();
    const good = { access: { aud: AUD, getIdentity: async () => ({ email: EMAIL }) } };
    expect((await handle(req("/"), envOf(), good, deps)).status).toBe(200);
    const response = await handle(req("/", { token: "a.b.c" }), envOf(), good, deps);
    expect(response.status).toBe(403);
    expect(lines.at(-1)).toBe("access: denied reason=header:malformed");
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


const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));

function responseOf(body: Uint8Array, init: { status?: number; queuedMs?: number; elapsedMs?: number } = {}): GateResult {
  const copy = new Uint8Array(body.length);
  copy.set(body);
  return {
    kind: "response",
    status: init.status ?? 200,
    contentType: "text/html; charset=UTF-8",
    body: copy.buffer,
    queuedMs: init.queuedMs ?? 0,
    elapsedMs: init.elapsedMs ?? 1,
  };
}

/** 取得の呼び出しを控える偽のゲート。 */
function checkGate(handler: (url: string) => GateResult | Promise<GateResult>, status: () => Promise<GateStatus> = async () => EMPTY_STATUS) {
  const urls: string[] = [];
  let statusCalls = 0;
  const namespace = gate(async () => ({ sqlite: true }), {
    fetchRaw: async (url) => {
      urls.push(url);
      return handler(url);
    },
    status: async () => {
      statusCalls += 1;
      return status();
    },
  });
  return { namespace, urls, statusCalls: () => statusCalls };
}

const CENTRAL_ID = "202603020211";
const NAR_ID = "202654071210";
const CHECK = (raceId: string): string => `/api/netkeiba/check?race_id=${raceId}`;

describe("GET /api/netkeiba/check(Issue #162 段階2b。AC-14)", () => {
  it("認証の関門のあとに置く: JWT なしは 403(本文は forbidden)で、ゲートを 1 回も呼ばない(HEAD・POST も同じ)", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html")));
    // 前提: 正しい JWT なら同じ要求が通る(拒否が認証によるものだという確認)
    expect((await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps)).status).toBe(200);
    expect(g.urls).toHaveLength(1);
    const before = g.urls.length;
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await handle(req(CHECK(CENTRAL_ID), { method }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
    }
    expect(g.urls).toHaveLength(before);
  });

  it("中央: 出馬表を 1 回取得し、ok・status・頭数(16)・kind・queuedMs・elapsedMs・ゲートの状態を JSON で返す", async () => {
    const { deps, token } = await setup();
    const status: GateStatus = { consecutiveRefusals: 0, blockedUntil: null, lastStartAt: 1234, pending: 0 };
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html"), { queuedMs: 2000, elapsedMs: 431 }), async () => status);
    const response = await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(g.urls).toEqual(["https://race.netkeiba.com/race/shutuba.html?race_id=202603020211"]);
    expect(await response.json()).toEqual({
      ok: true,
      kind: "central",
      raceId: CENTRAL_ID,
      status: 200,
      horses: 16,
      queuedMs: 2000,
      elapsedMs: 431,
      gate: status,
    });
    expect(g.statusCalls()).toBe(1);
  });

  it("地方: nar のホストで取得し、kind=nar・頭数(12)を返す", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("nar_shutuba_202654071210.html")));
    const response = await handle(req(CHECK(NAR_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(g.urls).toEqual(["https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210"]);
    expect(await response.json()).toMatchObject({ ok: true, kind: "nar", horses: 12 });
  });

  it.each([
    ["race_id が無い", "/api/netkeiba/check"],
    ["race_id が空", "/api/netkeiba/check?race_id="],
    ["11 桁", CHECK("20260302021")],
    ["13 桁", CHECK("2026030202111")],
    ["英字", CHECK("abcdefghijkl")],
    ["帯広(場コード 65)", CHECK("202665010101")],
    ["地方で実在しない日付", CHECK("202642023001")],
    ["クエリの注入(エンコードした &)", "/api/netkeiba/check?race_id=202603020211%26x%3D1"],
    ["別名のパラメータだけ", `/api/netkeiba/check?raceid=${CENTRAL_ID}`],
    ["パラメータ名の大文字小文字違い", `/api/netkeiba/check?RACE_ID=${CENTRAL_ID}`],
    ["race_id が 2 つ", `/api/netkeiba/check?race_id=${CENTRAL_ID}&race_id=${CENTRAL_ID}`],
    ["余計なパラメータつき", `/api/netkeiba/check?race_id=${CENTRAL_ID}&url=https://example.com/`],
  ])("無効な入力は 400 で、ゲートを呼ばない: %s", async (_label, path) => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html")));
    const response = await handle(req(path, { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await response.json()) as { ok: boolean; error: { type: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("bad-request");
    expect(body.error.message).toBeTruthy();
    expect(g.urls).toHaveLength(0);
    expect(g.statusCalls()).toBe(0);
  });

  it("パスは厳密(末尾スラッシュ・接頭辞つきは 404。ゲートを呼ばない)", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html")));
    for (const path of [`/api/netkeiba/check/?race_id=${CENTRAL_ID}`, `/api/netkeiba/checkx?race_id=${CENTRAL_ID}`, `/api/netkeiba?race_id=${CENTRAL_ID}`]) {
      expect((await handle(req(path, { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps)).status).toBe(404);
    }
    expect(g.urls).toHaveLength(0);
  });

  it("HEAD は取得を起こさない(405・Allow: GET)。netkeiba へ出る経路は GET だけ", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html")));
    const response = await handle(req(CHECK(CENTRAL_ID), { token, method: "HEAD" }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(g.urls).toHaveLength(0);
  });

  it("ゲートがブレーカーで拒否したら 503(ok:false・gate-refused・reason)で、ゲートの状態も添える", async () => {
    const { deps, token } = await setup();
    const status: GateStatus = { consecutiveRefusals: 2, blockedUntil: 999, lastStartAt: 1, pending: 0 };
    const g = checkGate(() => ({ kind: "refused", reason: "blocked", message: "止めています", blockedUntil: 999, retryAfterMs: 5 }), async () => status);
    const response = await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, kind: "central", error: { type: "gate-refused", reason: "blocked" }, gate: status });
  });

  it("netkeiba が 403 を返したら 502(ok:false・http-error・status 403)", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(new Uint8Array(), { status: 403 }));
    const response = await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, status: 403, error: { type: "http-error" } });
    expect(g.urls).toHaveLength(1); // 再試行しない
  });

  it("ゲートの status() が失敗しても、確認の結果は返す(gate を省く)。例外の中身は返さない", async () => {
    const { deps, token } = await setup();
    const g = checkGate(
      () => responseOf(fixtureBytes("shutuba_202603020211.html")),
      async () => {
        throw new Error("internal detail");
      },
    );
    const response = await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, horses: 16 });
    expect(JSON.parse(text).gate).toBeUndefined();
    expect(text).not.toContain("internal detail");
  });

  it("ゲートの取得そのものが例外になっても、502 の JSON で返し、例外を外へ投げない", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => {
      throw new Error("DO が落ちた");
    });
    const response = await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: { type: "fetch-failed" } });
  });

  it("全取得は DO の単一インスタンス(固定名 gate)を通る: health と check が同じ名前でスタブを取る", async () => {
    const { deps, token } = await setup();
    const names: string[] = [];
    const stub = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html"))).namespace.get(null);
    const namespace: GateNamespaceLike = {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: () => stub,
    };
    await handle(req("/api/health", { token }), envOf({ NETKEIBA_GATE: namespace }), {}, deps);
    await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: namespace }), {}, deps);
    expect(names).toEqual(["gate", "gate"]);
  });

  it("1 回の確認でゲートへ出す取得は 1 回だけ", async () => {
    const { deps, token } = await setup();
    const g = checkGate(() => responseOf(fixtureBytes("shutuba_202603020211.html")));
    await handle(req(CHECK(CENTRAL_ID), { token }), envOf({ NETKEIBA_GATE: g.namespace }), {}, deps);
    expect(g.urls).toHaveLength(1);
  });
});

describe("GET / の確認フォーム(Issue #162 段階2b)", () => {
  it("race_id を入れて GET で /api/netkeiba/check へ送るフォームがあり、初期値は 202603020211", async () => {
    const { deps, token } = await setup();
    const response = await handle(req("/", { token }), envOf(), {}, deps);
    const html = await response.text();
    expect(html).toContain('<form method="get" action="/api/netkeiba/check">');
    expect(html).toContain('name="race_id"');
    expect(html).toContain(`value="${CHECK_DEFAULT_RACE_ID}"`);
    expect(CHECK_DEFAULT_RACE_ID).toBe("202603020211");
    expect(html).toContain('type="submit"');
  });

  it("フォームの初期値は、チェックの検証を通る(中央の実在の race_id)", () => {
    expect(validateRaceId(CHECK_DEFAULT_RACE_ID)).toMatchObject({ ok: true, kind: "central" });
  });

  it("CSP に form-action 'self' が加わる(ほかの指令は変えない)", async () => {
    const { deps, token } = await setup();
    const csp = (await handle(req("/", { token }), envOf(), {}, deps)).headers.get("content-security-policy");
    expect(csp).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  });

  it("確認の使い方(初回は実在の ID で。実在しない ID はブレーカーを開きうる)の注意書きがある", async () => {
    const { deps, token } = await setup();
    const html = await (await handle(req("/", { token }), envOf(), {}, deps)).text();
    expect(html).toContain("実在");
    expect(html).toContain("30 分");
  });
});
