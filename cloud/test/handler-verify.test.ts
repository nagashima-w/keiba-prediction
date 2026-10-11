import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { ViewerVerifyResponse, VerifyResponse } from "../src/verify-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #219: 検証 `GET /api/verify?venue=all|central|nar[&refresh=1]`。読み取り専用(検証の DO の集計を読むだけ。netkeiba にも LLM にも出ない)。GET だけ。
 * Worker は D1・R2 に触れない(Workers Free の CPU 10ms のため、集計は DO)。DO は偽物(呼び出しを記録する)。
 */
const ORIGIN = "https://cloud.invalid";

const READY: VerifyResponse = {
  status: "ready",
  venue: "all",
  report: { includedAnalysisCount: 3 } as never,
  promptVersions: [],
  computedAt: "2026-10-10T03:00:00.000Z",
  stale: false,
  staleReason: null,
  nextRecomputeAt: null,
  diag: { rowsRead: 10, counts: {}, readMs: 1, computeMs: 2, promptVersionsMs: 1, startTimeGaps: { lost: 0, affecting: 0 } },
};

const VIEWER_READY: ViewerVerifyResponse = {
  status: "ready",
  venue: "all",
  report: { includedAnalysisCount: 3 } as never,
  promptVersions: [],
  computedAt: "2026-10-10T03:00:00.000Z",
  stale: false,
  staleReason: null,
  nextRecomputeAt: null,
  diag: { startTimeGaps: { lost: 0, affecting: 0 } },
};

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  readonly names: string[];
  readonly calls: Array<{ venue: string; refresh: boolean | undefined }>;
  /** 閲覧者の要求(Issue #263)で呼ばれた DO の getViewerReport。 */
  readonly viewerCalls: Array<{ venue: string; args: unknown[] }>;
  response: VerifyResponse;
  viewerResponse: ViewerVerifyResponse;
  fails: boolean;
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    names: [],
    calls: [],
    viewerCalls: [],
    response: READY,
    viewerResponse: VIEWER_READY,
    fails: false,
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {} as unknown as Env["DB"],
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            VERIFY_REPORT: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                getReport: async (venue: string, options?: { refresh?: boolean }) => {
                  h.calls.push({ venue, refresh: options?.refresh });
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return h.response;
                },
                getViewerReport: async (venue: string, ...args: unknown[]) => {
                  h.viewerCalls.push({ venue, args });
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return h.viewerResponse;
                },
              }),
            },
          }
        : {}),
    }),
  };
  return h;
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  return { deps, token };
}

const get = (token?: string, query = "", method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/verify${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/verify: 検証の集計", () => {
  it("検証の DO(単一インスタンス main)の集計をそのまま返す。区分の既定は all、refresh は指定しなければ渡さない(false)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...READY });
    expect(h.names).toEqual(["main"]);
    expect(h.calls).toEqual([{ venue: "all", refresh: false }]);
  });

  it.each(["all", "central", "nar"])("venue=%s はそのまま DO に渡る", async (venue) => {
    const { deps, token } = await setup();
    const h = harness();
    await handle(get(token, `?venue=${venue}`), h.env(), {}, deps);
    expect(h.calls).toEqual([{ venue, refresh: false }]);
  });

  it("refresh=1 だけが再計算の要求。refresh=0 は false", async () => {
    const { deps, token } = await setup();
    const h = harness();
    await handle(get(token, "?venue=nar&refresh=1"), h.env(), {}, deps);
    await handle(get(token, "?venue=nar&refresh=0"), h.env(), {}, deps);
    expect(h.calls).toEqual([{ venue: "nar", refresh: true }, { venue: "nar", refresh: false }]);
  });

  it("preparing・throttled の応答もそのまま返す(status で区別する)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.response = { status: "preparing", remaining: 12, blocked: null, resumeAt: null };
    expect(await (await handle(get(token), h.env(), {}, deps)).json()).toEqual({ ok: true, status: "preparing", remaining: 12, blocked: null, resumeAt: null });
    h.response = { status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" };
    expect(await (await handle(get(token), h.env(), {}, deps)).json()).toEqual({ ok: true, status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" });
  });

  it.each([
    ["不正な区分", "?venue=both"],
    ["区分が空", "?venue="],
    ["区分の重複", "?venue=all&venue=nar"],
    ["未知のパラメータ", "?venue=all&x=1"],
    ["refresh の値が不正", "?refresh=yes"],
    ["refresh の重複", "?refresh=1&refresh=1"],
  ])("%s は 400(DO に触れない)", async (_name, query) => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token, query), h.env(), {}, deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("bad-request");
    expect(h.names).toEqual([]);
  });

  it("別サイトからの要求(Sec-Fetch-Site: cross-site)は 403 で DO に触れない(再計算を外から起こされない)。same-origin・none は通す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const cross = await handle(get(token, "?refresh=1", "GET", { "Sec-Fetch-Site": "cross-site" }), h.env(), {}, deps);
    expect(cross.status).toBe(403);
    expect(h.names).toEqual([]);
    for (const site of ["same-origin", "none"]) {
      expect((await handle(get(token, "", "GET", { "Sec-Fetch-Site": site }), h.env(), {}, deps)).status).toBe(200);
    }
  });

  it("認証が無ければ 403 で DO に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(get(), h.env(), {}, deps)).status).toBe(403);
    expect(h.names).toEqual([]);
  });

  it("DO の失敗は 503(固定の種類名だけ。例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "verify-error" } });
    expect(text).not.toContain("SECRET-DO");
  });

  it("binding が無い構成も 503(例外で落とさない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(false), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: { type: "verify-error" } });
  });

  it("メソッドは GET だけ: POST・PUT・DELETE・HEAD は 405(DO に触れない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await handle(get(token, "", method, { Origin: ORIGIN }), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
    }
    expect(h.names).toEqual([]);
  });
});

describe("Issue #263: 閲覧者の GET /api/verify(集計のやり直しを起こさない)", () => {
  async function setupRoles() {
    const key = await makeKey("k1");
    const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
    return { deps, admin: await signToken(key), viewer: await signToken(key, { email: "friend@example.com" }) };
  }

  it("管理者は従来どおり getReport(refresh を渡す)。閲覧者用の getViewerReport は呼ばない", async () => {
    const { deps, admin } = await setupRoles();
    const h = harness();
    const res = await handle(get(admin, "?venue=nar&refresh=1"), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([{ venue: "nar", refresh: true }]);
    expect(h.viewerCalls).toEqual([]);
  });

  it.each(["all", "central", "nar"])("閲覧者(venue=%s)は getViewerReport(区分だけ)を呼ぶ。getReport(集計のやり直しを起こしうる経路)は呼ばない", async (venue) => {
    const { deps, viewer } = await setupRoles();
    const h = harness();
    const res = await handle(get(viewer, `?venue=${venue}`), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...VIEWER_READY });
    expect(h.names).toEqual(["main"]);
    expect(h.viewerCalls).toEqual([{ venue, args: [] }]); // 区分だけを渡す(refresh の指定は DO に渡らない)
    expect(h.calls).toEqual([]);
  });

  it.each(["?refresh=1", "?venue=central&refresh=1", "?refresh=0"])("閲覧者の refresh は無視する(%s)。getReport は呼ばれず、getViewerReport に refresh は渡らない。応答は 200", async (query) => {
    const { deps, viewer } = await setupRoles();
    const h = harness();
    const res = await handle(get(viewer, query), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.viewerCalls).toHaveLength(1);
    expect(h.viewerCalls[0]!.args).toEqual([]);
  });

  it("閲覧者でも入力の検証は同じ(不正な区分・refresh の値・未知のパラメータ・重複は 400。DO に触れない)。役割をクエリで名乗れない(role=admin は未知のパラメータで 400)", async () => {
    const { deps, viewer } = await setupRoles();
    for (const query of ["?venue=both", "?refresh=yes", "?venue=all&x=1", "?refresh=1&refresh=1", "?role=admin", "?admin=1"]) {
      const h = harness();
      const res = await handle(get(viewer, query), h.env(), {}, deps);
      expect(res.status, query).toBe(400);
      expect(h.names, query).toEqual([]);
    }
  });

  it("集計がまだ無い(not-computed)も、そのまま返す(status で区別する)", async () => {
    const { deps, viewer } = await setupRoles();
    const h = harness();
    h.viewerResponse = { status: "not-computed" };
    const res = await handle(get(viewer), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "not-computed" });
  });

  it("別サイトからの要求は 403(DO に触れない)・DO の失敗と binding なしは 503(固定の種類名だけ)・GET 以外の method は管理者専用の 403(DO に触れない)", async () => {
    const { deps, viewer } = await setupRoles();
    const cross = harness();
    expect((await handle(get(viewer, "", "GET", { "Sec-Fetch-Site": "cross-site" }), cross.env(), {}, deps)).status).toBe(403);
    expect(cross.names).toEqual([]);

    const failing = harness();
    failing.fails = true;
    const failed = await handle(get(viewer), failing.env(), {}, deps);
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "verify-error" } });
    expect(text).not.toContain("SECRET-DO");

    const noBinding = await handle(get(viewer), harness().env(false), {}, deps);
    expect(noBinding.status).toBe(503);

    const methods = harness();
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      const res = await handle(get(viewer, "", method, { Origin: ORIGIN }), methods.env(), {}, deps);
      expect(res.status, method).toBe(403);
      expect(await res.text(), method).toBe(JSON.stringify({ ok: false, error: { type: "admin-only" } }));
    }
    expect(methods.names).toEqual([]);
  });

  it("役割は認証の結果だけで決まる: 管理者が登録されていて(ADMIN_USER)そこに載らないアカウントも、閲覧者として getViewerReport を通る", async () => {
    const { deps, admin } = await setupRoles();
    const h = harness();
    const env = { ...h.env(), ADMIN_USER: "someone-else@example.com" } as Env;
    const res = await handle(get(admin, "?refresh=1"), env, {}, deps); // admin のトークン(EMAIL)は ADMIN_USER に無い → 閲覧者
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.viewerCalls).toHaveLength(1);
  });
});
