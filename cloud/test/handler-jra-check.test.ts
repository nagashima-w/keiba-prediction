import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { handle, type Env } from "../src/handler";
import { JRA_ACCESS_URL, JRA_CHECK_GAP_MS, JRA_CUSHION_URL } from "../src/jra-check";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { installFetchTrap } from "./fetch-trap";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #488(#477-A1): 管理者の確認口 `GET /api/jra/check`(Worker から JRA のページに届くかを、管理者が開いたときだけ取って要約を返す)。
 * **実サイトには出ない**: 偽の fetch(`deps.jraFetch`)と偽の待ち(`deps.jraWait`)を注入し、グローバルの `fetch` は呼ばれたら落ちるスタブにする。
 * 裏側(D1・DO・R2)は 1 つも渡さない(触れたら落ちる)。
 */

installFetchTrap();

const ORIGIN = "https://cloud.invalid";
const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);
const CUSHION = new Uint8Array(readFileSync(`${FIXTURES}jra_baba_cushion_20261025.html`));
const ACCESS = new Uint8Array(readFileSync(`${FIXTURES}jra_access_j_20261025.json`));

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function env(): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
    DB: { prepare: NOT_CALLED, batch: NOT_CALLED } as unknown as Env["DB"],
  };
}

interface Harness {
  readonly events: string[];
  readonly deps: Parameters<typeof handle>[3] & object;
}

async function setup(respond?: (url: string) => Response): Promise<{ h: Harness; token: string }> {
  const key = await makeKey("k1");
  const events: string[] = [];
  const deps = {
    keys: () => localKeys(key),
    now: () => NOW,
    log: () => {},
    jraFetch: async (url: string, init: RequestInit) => {
      events.push(`fetch ${init.method ?? "GET"} ${url}`);
      return respond === undefined ? defaultRespond(url) : respond(url);
    },
    jraWait: async (ms: number) => {
      events.push(`wait ${ms}`);
    },
  };
  return { h: { events, deps }, token: await signToken(key) };
}

const defaultRespond = (url: string): Response =>
  url === JRA_CUSHION_URL
    ? new Response(CUSHION, { status: 200, headers: { "content-type": "text/html" } })
    : new Response(ACCESS, { status: 200, headers: { "content-type": "text/html" } });

const get = (token: string | undefined, query = "", method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/jra/check${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/jra/check: 管理者の確認口", () => {
  it("管理者が開くと 200。取得 2 本(GET→待ち→POST)の要約を許可リストの形で返す。本文は返さない。キャッシュさせない", async () => {
    const { h, token } = await setup();
    const res = await handle(get(token), env(), {}, h.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.events).toEqual([`fetch GET ${JRA_CUSHION_URL}`, `wait ${JRA_CHECK_GAP_MS}`, `fetch POST ${JRA_ACCESS_URL}`]);
    const text = await res.text();
    const body = JSON.parse(text) as { ok: boolean; cushion: Record<string, unknown>; access: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["access", "cushion", "ok"]);
    expect(body.ok).toBe(true);
    expect(body.cushion).toMatchObject({ status: 200, ok: true, bytes: CUSHION.byteLength, contentType: "text/html", firstTime: "10月25日（日曜）7時00分" });
    expect(body.cushion.venues).toEqual(expect.arrayContaining(["東京", "京都", "新潟"]));
    expect(body.access).toMatchObject({ status: 200, ok: true, bytes: ACCESS.byteLength, parsedJson: true });
    expect(text).not.toContain("cushion_data_list");
    expect(text).not.toContain("decided_link_para");
  });

  it("弾かれた(403)ときも、HTTP は 200 で結果(status 403・ok: false)を返す。この確認口自体の成功と、取得の成功は別", async () => {
    const { h, token } = await setup(() => new Response("blocked", { status: 403 }));
    const res = await handle(get(token), env(), {}, h.deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cushion: { status: number; ok: boolean }; access: { status: number; ok: boolean } };
    expect(body.ok).toBe(true);
    expect(body.cushion).toMatchObject({ status: 403, ok: false });
    expect(body.access).toMatchObject({ status: 403, ok: false });
  });

  it("閲覧者は 403 admin-only で、JRA に取りに行かない", async () => {
    const { h } = await setup();
    const key = await makeKey("k1");
    const token = await signToken(key, { email: "friend@example.com" });
    const res = await handle(get(token), env(), {}, { ...h.deps, keys: () => localKeys(key) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: { type: "admin-only" } });
    expect(h.events).toEqual([]);
  });

  it("認証が無ければ 403 で、JRA に取りに行かない", async () => {
    const { h } = await setup();
    expect((await handle(get(undefined), env(), {}, h.deps)).status).toBe(403);
    expect(h.events).toEqual([]);
  });

  it("クエリは受け付けない: 何を付けても 400(JRA に取りに行かない)", async () => {
    const { h, token } = await setup();
    for (const query of ["?x=1", "?kaisai_date=20261025", "?=1", "?url=https://example.invalid/"]) {
      const res = await handle(get(token, query), env(), {}, h.deps);
      expect(res.status, query).toBe(400);
    }
    expect(h.events).toEqual([]);
  });

  it("別サイトからの要求(Sec-Fetch-Site: cross-site・same-site)は 403 origin-mismatch で、JRA に取りに行かない。アドレスバー(none)・同じオリジン・ヘッダなしは通る", async () => {
    const { h, token } = await setup();
    for (const site of ["cross-site", "same-site"]) {
      const res = await handle(get(token, "", "GET", { "sec-fetch-site": site }), env(), {}, h.deps);
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    }
    expect(h.events).toEqual([]);
    for (const site of ["none", "same-origin"]) {
      expect((await handle(get(token, "", "GET", { "sec-fetch-site": site }), env(), {}, h.deps)).status, site).toBe(200);
    }
  });

  it("GET 以外(管理者の POST・PUT・DELETE)は 405 で、JRA に取りに行かない", async () => {
    const { h, token } = await setup();
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await handle(get(token, "", method), env(), {}, h.deps)).status, method).toBe(405);
    }
    expect(h.events).toEqual([]);
  });

  it("HEAD は このルートの 405(Allow: GET)で、JRA に取りに行かない(HEAD で取得を起こさない)", async () => {
    const { h, token } = await setup();
    const res = await handle(get(token, "", "HEAD"), env(), {}, h.deps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(h.events).toEqual([]);
  });
});
