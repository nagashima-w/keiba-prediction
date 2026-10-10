import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { AUD, EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #238: 閲覧者(viewer)と管理者(admin)の役割が、handle() の入口で効くことの固定。
 *  - 閲覧者は読み取りだけ。管理者専用のルート(と、表に無いルート・表の外の method)は 403(本文は固定の `admin-only`)。
 *  - **拒否は裏側に触れる前**: DO・D1・R2・gate・リクエスト本文のどれも読まれない(`env` のアクセスを数える Proxy と `bodyUsed` で固定)。
 *  - 認証に失敗したときは従来どおり 403 `forbidden`(役割は認証に通ってからの話)。
 *  - ルート × 役割の表そのものは route-policy.test.ts(表の手書きの期待値と静的ガード)。ここは handle() を実際に呼んで確かめる。
 */

const VIEWER_EMAIL = "friend@example.com";
const ORIGIN = "https://cloud.invalid";
const ADMIN_ONLY_BODY = JSON.stringify({ ok: false, error: { type: "admin-only" } });

/** 認証の設定の読み取りは数えない(ほかのキー = バインディング・API キーなどの読み取りを「裏側に触れた」と数える)。 */
const AUTH_KEYS = new Set<string | symbol>(["ACCESS_TEAM_NAME", "ACCESS_AUD", "ACCESS_ALLOWED_EMAIL", "ADMIN_USER"]);

function trackedEnv(extra: Record<string, unknown> = {}): { env: Env; touched: () => string[] } {
  const touched: string[] = [];
  const base = { ...GOOD_ENV, ...extra };
  const env = new Proxy(base, {
    get(target, key) {
      if (!AUTH_KEYS.has(key)) {
        touched.push(String(key));
      }
      return (target as Record<string | symbol, unknown>)[key];
    },
  }) as unknown as Env;
  return { env, touched: () => touched };
}

/** 呼ばれたら失敗する裏側(管理者専用のルートに、閲覧者のリクエストが届いていないことの確認)。 */
function throwingBackends(): Record<string, unknown> {
  const boom = (): never => {
    throw new Error("裏側は呼ばれない想定");
  };
  return {
    NETKEIBA_GATE: { idFromName: boom, get: boom },
    RACE_DAY: { idFromName: boom, get: boom },
    CLOUD_MIGRATION: { idFromName: boom, get: boom },
    RESULT_BACKFILL: { idFromName: boom, get: boom },
    VERIFY_REPORT: { idFromName: boom, get: boom },
    DAILY_REPORT: { idFromName: boom, get: boom },
    DB: { prepare: boom, batch: boom },
    ANALYSIS_DETAIL: { get: boom, put: boom },
  };
}

async function setup() {
  const key = await makeKey("k1");
  const lines: string[] = [];
  const deps = { keys: () => localKeys(key), now: () => NOW, log: (line: string) => void lines.push(line) };
  return {
    deps,
    lines,
    adminToken: await signToken(key, { email: EMAIL }),
    viewerToken: await signToken(key, { email: VIEWER_EMAIL }),
    token: (email: string) => signToken(key, { email }),
  };
}

function request(method: string, path: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { ...init, method, headers });
}

/** ルート × method の組(下の表)。サンプルの path と、閲覧者に許す method。route-policy.test.ts の手書きの表と同じ内容を、ここでも別に持つ。 */
const ROUTES: readonly { readonly sample: string; readonly viewer: readonly string[] }[] = [
  { sample: "/", viewer: ["GET", "HEAD"] },
  { sample: "/app.js", viewer: ["GET", "HEAD"] },
  { sample: "/api/races", viewer: ["GET"] },
  { sample: "/api/plan", viewer: ["GET"] },
  { sample: "/api/analyses", viewer: ["GET"] },
  { sample: "/api/analyses/status", viewer: ["GET"] },
  { sample: "/api/analyses/123", viewer: ["GET"] },
  { sample: "/api/reports", viewer: ["GET"] },
  { sample: "/api/reports/20261010", viewer: ["GET"] },
  // アイコン 7 本(Issue #244)。閲覧者にも GET・HEAD を開く
  { sample: "/favicon.ico", viewer: ["GET", "HEAD"] },
  { sample: "/apple-touch-icon.png", viewer: ["GET", "HEAD"] },
  { sample: "/icons/favicon-16.png", viewer: ["GET", "HEAD"] },
  { sample: "/icons/favicon-32.png", viewer: ["GET", "HEAD"] },
  { sample: "/icons/header-32.png", viewer: ["GET", "HEAD"] },
  { sample: "/icons/header-64.png", viewer: ["GET", "HEAD"] },
  { sample: "/icons/header-96.png", viewer: ["GET", "HEAD"] },
  { sample: "/check", viewer: [] },
  { sample: "/api/health", viewer: [] },
  { sample: "/api/netkeiba/check", viewer: [] },
  { sample: "/api/settings", viewer: [] },
  { sample: "/api/analyses/run", viewer: [] },
  { sample: "/api/results/import", viewer: [] },
  { sample: "/api/results/backfill", viewer: [] },
  { sample: "/api/migration", viewer: [] },
  { sample: "/api/migration/upload", viewer: [] },
  { sample: "/api/reports/run", viewer: [] },
  { sample: "/api/verify", viewer: [] },
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const denial = (status: number, body: string): boolean => status === 403 && body === ADMIN_ONLY_BODY;

/** handle() を呼び、応答(または例外)を返す。裏側が throw する偽物なので、管理者・許可された閲覧者では例外になりうる(= 役割の関門は通った)。 */
async function call(env: Env, deps: Parameters<typeof handle>[3], req: Request): Promise<{ kind: "response"; status: number; body: string; headers: Headers } | { kind: "threw" }> {
  try {
    const response = await handle(req, env, {}, deps);
    return { kind: "response", status: response.status, body: await response.text(), headers: response.headers };
  } catch {
    return { kind: "threw" };
  }
}

describe("閲覧者(viewer): 管理者専用の (path, method) は 403 admin-only。裏側にもリクエスト本文にも触れない", () => {
  const cases = ROUTES.flatMap((r) => METHODS.filter((m) => !r.viewer.includes(m)).map((method) => [method, r.sample] as const));

  it("前提: 閲覧者が管理者専用に当たる組は 137 通り(27 ルート × 6 method = 162 から、閲覧者に許す 25 を引く)", () => {
    expect(ROUTES).toHaveLength(27);
    expect(ROUTES.reduce((n, r) => n + r.viewer.filter((m) => (METHODS as readonly string[]).includes(m)).length, 0)).toBe(25);
    expect(cases).toHaveLength(137);
  });

  it.each(cases)("%s %s → 403(本文は admin-only の固定)。バインディングに触れず、本文を読まない", async (method, path) => {
    const { deps, viewerToken } = await setup();
    const { env, touched } = trackedEnv(throwingBackends());
    const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ race_id: "202603020211" });
    const req = request(method, path, viewerToken, { body, headers: body === undefined ? undefined : { origin: ORIGIN, "content-type": "application/json" } });
    const response = await handle(req, env, {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(ADMIN_ONLY_BODY);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(touched()).toEqual([]);
    expect(req.bodyUsed).toBe(false);
  });

  it.each(["/no-such-path", "/api/settings/", "/api/analyses/run/", "//api/plan", "/API/PLAN"])("表に無い path(%s)も、閲覧者には 403 admin-only(管理者には従来どおり 404)", async (path) => {
    const { deps, viewerToken, adminToken } = await setup();
    const viewerEnv = trackedEnv(throwingBackends());
    const viewer = await handle(request("GET", path, viewerToken), viewerEnv.env, {}, deps);
    expect(viewer.status).toBe(403);
    expect(await viewer.text()).toBe(ADMIN_ONLY_BODY);
    expect(viewerEnv.touched()).toEqual([]);
    // 対照: 管理者は関門を通り、従来どおり(未知の path は 404)
    const admin = await handle(request("GET", path, adminToken), trackedEnv(throwingBackends()).env, {}, deps);
    expect(admin.status).toBe(404);
  });
});

describe("閲覧者(viewer): 許された (path, method) は関門を通る(管理者専用の 403 にならない)", () => {
  const allowed = ROUTES.flatMap((r) => r.viewer.map((method) => [method, r.sample] as const));

  it("前提: 閲覧者に許す組は 25 通り(画面と API の 11 + アイコン 7 本の GET・HEAD で 14)", () => {
    expect(allowed).toHaveLength(25);
  });

  it.each(allowed)("%s %s → 管理者専用の 403 ではない", async (method, path) => {
    const { deps, viewerToken } = await setup();
    const { env } = trackedEnv(throwingBackends());
    const result = await call(env, deps, request(method, path, viewerToken));
    expect(result.kind === "response" && denial(result.status, result.body)).toBe(false);
  });

  it("GET / は 200(画面)で、閲覧者向けの印(data-role)がある。「閲覧専用」の文言は出ない(Issue #243)。GET /app.js は 200", async () => {
    const { deps, viewerToken } = await setup();
    const page = await handle(request("GET", "/", viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-role="viewer"');
    expect(html).not.toContain("閲覧専用");
    expect(html).toContain(VIEWER_EMAIL);
    const js = await handle(request("GET", "/app.js", viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
    expect(js.status).toBe(200);
  });

  it("アイコン(Issue #244): 閲覧者の GET は 7 本とも 200 で画像(PNG の署名か ICO のヘッダ)。裏側(バインディング)には触れない。HEAD も 200", async () => {
    const { deps, viewerToken } = await setup();
    const icons = ROUTES.filter((r) => r.sample === "/favicon.ico" || r.sample === "/apple-touch-icon.png" || r.sample.startsWith("/icons/"));
    expect(icons).toHaveLength(7);
    for (const { sample } of icons) {
      const tracked = trackedEnv(throwingBackends());
      const response = await handle(request("GET", sample, viewerToken), tracked.env, {}, deps);
      expect(response.status, sample).toBe(200);
      const head = new Uint8Array(await response.arrayBuffer()).slice(0, 4);
      expect(Array.from(head), sample).toEqual(sample === "/favicon.ico" ? [0, 0, 1, 0] : [0x89, 0x50, 0x4e, 0x47]);
      expect(tracked.touched(), sample).toEqual([]);
      const headResponse = await handle(request("HEAD", sample, viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
      expect(headResponse.status, sample).toBe(200);
    }
  });

  it("入力の検証(400)の応答が返る: 閲覧者の GET /api/races・/api/plan・/api/analyses/status は、日付なしで 400(関門を通って各ハンドラの検証に届いている)", async () => {
    const { deps, viewerToken } = await setup();
    for (const path of ["/api/races", "/api/plan", "/api/analyses/status"]) {
      const response = await handle(request("GET", path, viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
      expect(response.status, path).toBe(400);
    }
  });
});

describe("管理者(admin): すべてのルートが関門を通る(管理者専用の 403 にならない)", () => {
  const cases = ROUTES.flatMap((r) => METHODS.map((method) => [method, r.sample] as const));

  it.each(cases)("%s %s", async (method, path) => {
    const { deps, adminToken } = await setup();
    const { env } = trackedEnv(throwingBackends());
    const body = method === "GET" || method === "HEAD" ? undefined : "{}";
    const result = await call(env, deps, request(method, path, adminToken, { body, headers: body === undefined ? undefined : { origin: ORIGIN, "content-type": "application/json" } }));
    expect(result.kind === "response" && denial(result.status, result.body)).toBe(false);
  });

  it("管理者の GET / は 200 で、管理者向けの印(data-role。閲覧専用の文言なし)", async () => {
    const { deps, adminToken } = await setup();
    const page = await handle(request("GET", "/", adminToken), trackedEnv(throwingBackends()).env, {}, deps);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-role="admin"');
    expect(html).not.toContain("閲覧専用");
  });

  it("管理者専用のルートに管理者が届く: GET /api/settings は D1 を読みに行く(裏側に触れる)・GET /api/health は DO と D1 を確認する", async () => {
    const { deps, adminToken } = await setup();
    const settings = trackedEnv(throwingBackends());
    await call(settings.env, deps, request("GET", "/api/settings", adminToken));
    expect(settings.touched()).toContain("DB");
    const health = trackedEnv(throwingBackends());
    await call(health.env, deps, request("GET", "/api/health", adminToken));
    expect(health.touched()).toContain("NETKEIBA_GATE");
  });
});

describe("ADMIN_USER による管理者の切り替え(handle() の経路)", () => {
  it("ADMIN_USER 未登録 → ACCESS_ALLOWED_EMAIL の人が管理者(移行期間)。ほかの人は閲覧者", async () => {
    const { deps, adminToken, viewerToken } = await setup();
    const admin = await call(trackedEnv(throwingBackends()).env, deps, request("GET", "/api/settings", adminToken));
    expect(admin.kind === "response" && denial(admin.status, admin.body)).toBe(false);
    const viewer = await handle(request("GET", "/api/settings", viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
    expect(viewer.status).toBe(403);
  });

  it("ADMIN_USER を登録すると、管理者は ADMIN_USER の人だけ。ACCESS_ALLOWED_EMAIL の人は(ログインできるが)閲覧者に変わる", async () => {
    const { deps, adminToken, token } = await setup();
    const env = () => trackedEnv({ ...throwingBackends(), ADMIN_USER: "Second.Admin@example.com , other@example.com" }).env;
    const second = await call(env(), deps, request("GET", "/api/settings", await token("second.admin@example.com")));
    expect(second.kind === "response" && denial(second.status, second.body)).toBe(false);
    const owner = await handle(request("GET", "/api/settings", adminToken), env(), {}, deps);
    expect(owner.status).toBe(403);
    expect(await owner.text()).toBe(ADMIN_ONLY_BODY);
    // ログインはできる(閲覧者として画面を見られる)
    expect((await handle(request("GET", "/", adminToken), env(), {}, deps)).status).toBe(200);
  });

  it.each([
    ["カンマだけ", ","],
    ["区切りが不正(セミコロン)", `${EMAIL};other@example.com`],
    ["空白区切り", `${EMAIL} other@example.com`],
  ])("ADMIN_USER が登録済みで有効 0 件(%s) → 管理者なし。ACCESS_ALLOWED_EMAIL の人も閲覧者(フォールバックしない)。サイトの閲覧は止まらない", async (_name, adminUser) => {
    const { deps, adminToken, lines } = await setup();
    const env = () => trackedEnv({ ...throwingBackends(), ADMIN_USER: adminUser }).env;
    expect((await handle(request("GET", "/api/settings", adminToken), env(), {}, deps)).status).toBe(403);
    expect((await handle(request("GET", "/", adminToken), env(), {}, deps)).status).toBe(200);
    expect(lines).toEqual(["access: ok via=header role=viewer admins=none", "access: ok via=header role=viewer admins=none"]);
  });

  it.each([
    ["未登録", undefined],
    ["空文字", ""],
    ["空白だけ", "   "],
  ])("ADMIN_USER が%sなら、ACCESS_ALLOWED_EMAIL の人は管理者(フォールバック)", async (_name, adminUser) => {
    const { deps, adminToken, lines } = await setup();
    const extra = adminUser === undefined ? throwingBackends() : { ...throwingBackends(), ADMIN_USER: adminUser };
    const result = await call(trackedEnv(extra).env, deps, request("GET", "/api/settings", adminToken));
    expect(result.kind === "response" && denial(result.status, result.body)).toBe(false);
    expect(lines).toEqual(["access: ok via=header role=admin admins=fallback"]);
  });
});

describe("ログ(役割と管理者の出どころだけ。アドレス・トークンを出さない)と、認証失敗の扱い", () => {
  it("成功のログは `access: ok via=… role=… admins=…`。閲覧者のアドレスも管理者のアドレスもログに出ない", async () => {
    const { deps, lines, adminToken, viewerToken } = await setup();
    await call(trackedEnv(throwingBackends()).env, deps, request("GET", "/api/plan", adminToken));
    await call(trackedEnv(throwingBackends()).env, deps, request("GET", "/api/plan", viewerToken));
    expect(lines).toEqual(["access: ok via=header role=admin admins=fallback", "access: ok via=header role=viewer admins=fallback"]);
    const all = lines.join("\n");
    for (const secret of [EMAIL, VIEWER_EMAIL, adminToken, viewerToken, AUD, "example.com"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("管理者専用への拒否の応答にも、アドレス・理由コード以外の内部情報・AUD は含まれない", async () => {
    const { deps, viewerToken } = await setup();
    const response = await handle(request("GET", "/api/settings", viewerToken), trackedEnv(throwingBackends()).env, {}, deps);
    const text = await response.text();
    for (const secret of [VIEWER_EMAIL, EMAIL, AUD, "example.com", "ADMIN_USER", "ACCESS"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("認証に失敗したら従来どおり 403 forbidden(閲覧者を受け入れても、JWT の検証は緩めない)", async () => {
    const { deps, lines } = await setup();
    const key = await makeKey("other-key"); // 署名に使った鍵が、検証側の鍵と違う
    const forged = await signToken(key, { email: VIEWER_EMAIL, kid: "k1" });
    const response = await handle(request("GET", "/", forged), trackedEnv(throwingBackends()).env, {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^access: denied reason=header:/);
    // JWT なし
    const none = await handle(new Request(`${ORIGIN}/`), trackedEnv(throwingBackends()).env, {}, deps);
    expect(none.status).toBe(403);
    expect(await none.text()).toBe("forbidden");
  });

  it("別の AUD(同じチームの別アプリ)の JWT は、閲覧者としても受け入れない", async () => {
    const { deps } = await setup();
    const key = await makeKey("k1");
    const wrongAud = await signToken(key, { email: VIEWER_EMAIL, aud: "another-aud-tag" });
    const response = await handle(request("GET", "/", wrongAud), trackedEnv(throwingBackends()).env, {}, { ...deps, keys: () => localKeys(key) });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });
});
