import { describe, expect, it, vi } from "vitest";

import { COLO_TRACE_URL } from "../src/jra-colo";
import {
  checkProxyTarget,
  createProxyFetch,
  handleProxyRequest,
  isJraFetchViaProxy,
  JRA_FETCH_PROXY_NAME,
  resolveJraFetch,
} from "../src/jra-fetch-proxy-core";
import { JRA_ACCESS_D_URL, JRA_ACCESS_O_URL, JRA_ACCESS_S_URL, JRA_ACCESS_U_URL, JRA_ACCESS_URL, JRA_CUSHION_URL, JRA_MOIST_URL, JRA_TIMEOUT_MS, jraCourseUrl } from "../src/jra-http";

/**
 * Issue #815: JRA への取得を、アジア太平洋に置いた中継の DO(JraFetchProxy)から出す。
 * 外には一切出ない(注入した偽の fetch)。許可リスト・メソッド・リダイレクト・タイムアウトを固定する。
 */

describe("isJraFetchViaProxy(文字列 \"1\" だけが中継を使う)", () => {
  it.each([
    ["1", true],
    [" 1 ", true],
    ["0", false],
    ["", false],
    ["true", false],
    ["11", false],
    [undefined, false],
  ])("%j → %s", (value, expected) => {
    expect(isJraFetchViaProxy(value)).toBe(expected);
  });
});

describe("checkProxyTarget(許可リスト)", () => {
  it("JRA の取得先の定数はすべて許可される(空振り防止に 9 個)", () => {
    const urls = [JRA_CUSHION_URL, JRA_MOIST_URL, JRA_ACCESS_URL, JRA_ACCESS_D_URL, JRA_ACCESS_O_URL, JRA_ACCESS_U_URL, JRA_ACCESS_S_URL, jraCourseUrl(1), jraCourseUrl(3)];
    expect(urls).toHaveLength(9);
    for (const u of urls) {
      expect(checkProxyTarget(u, "GET").ok, u).toBe(true);
      expect(checkProxyTarget(u, "POST").ok, u).toBe(true);
    }
    expect(checkProxyTarget(`${JRA_ACCESS_U_URL}?CNAME=pw01dud10/ab`, "GET").ok).toBe(true);
  });
  it("拠点の確認(cdn-cgi/trace)は許可される", () => {
    expect(checkProxyTarget(COLO_TRACE_URL, "GET").ok).toBe(true);
  });
  it.each([
    ["別ホスト", "https://example.com/keiba/baba/_data_cushion.html"],
    ["JRA に似たホスト(前方一致の穴)", "https://www.jra.go.jp.evil.example/x"],
    ["JRA のサブドメイン", "https://evil.www.jra.go.jp/x"],
    ["JRA の別のサブドメイン", "https://sp.jra.go.jp/x"],
    ["http", "http://www.jra.go.jp/keiba/baba/_data_cushion.html"],
    ["cloudflare の別パス", "https://www.cloudflare.com/"],
    ["cloudflare の cdn-cgi の別パス", "https://www.cloudflare.com/cdn-cgi/rum"],
    ["cloudflare の trace の下", "https://www.cloudflare.com/cdn-cgi/trace/x"],
    ["別の cloudflare のホスト", "https://dash.cloudflare.com/cdn-cgi/trace"],
    ["認証情報つき", (() => { const u = new URL("https://www.jra.go.jp/x"); u.username = "user"; u.password = "pw"; return u.toString(); })()],
    ["ポート指定", "https://www.jra.go.jp:8443/x"],
    ["netkeiba", "https://race.netkeiba.com/x"],
    ["URL でない", "not a url"],
  ])("%s は 403 で断る", (_n, url) => {
    const r = checkProxyTarget(url, "GET");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
    }
  });
  it("cdn-cgi/trace は GET だけ(POST は断る)", () => {
    const r = checkProxyTarget(COLO_TRACE_URL, "POST");
    expect(r.ok).toBe(false);
  });
  it.each(["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])("メソッド %s は 405 で断る", (method) => {
    const r = checkProxyTarget(JRA_ACCESS_URL, method);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(405);
    }
  });
});

describe("handleProxyRequest", () => {
  const record = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response("本文", { status: 200, headers: { "content-type": "text/html", server: "AkamaiGHost" } });
    };
    return { calls, fn };
  };

  it("許可外は外へ出さず 403(fetch は 0 回)", async () => {
    const { calls, fn } = record();
    const res = await handleProxyRequest(new Request("https://example.com/x"), fn);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("許可外のメソッドは外へ出さず 405", async () => {
    const { calls, fn } = record();
    const res = await handleProxyRequest(new Request(JRA_ACCESS_URL, { method: "PUT", body: "x" }), fn);
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
  it("POST は本文・content-type をそのまま渡し、redirect manual・タイムアウトの信号つきで 1 回だけ出す。応答の状態・ヘッダ・本文を変えずに返す", async () => {
    const { calls, fn } = record();
    const res = await handleProxyRequest(new Request(JRA_ACCESS_O_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "ua-x", cookie: "secret=1", authorization: "Bearer x" }, body: "cname=pw15oli00/6D" }), fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(JRA_ACCESS_O_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.body).toBe("cname=pw15oli00/6D");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(h.get("user-agent")).toBe("ua-x");
    expect(h.has("cookie")).toBe(false);
    expect(h.has("authorization")).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("server")).toBe("AkamaiGHost");
    expect(await res.text()).toBe("本文");
  });
  it("GET は本文なしで出す", async () => {
    const { calls, fn } = record();
    await handleProxyRequest(new Request(JRA_CUSHION_URL), fn);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });
  it("応答から content-encoding と content-length を落とす(本文は展開済みの前提)。ほかのヘッダと本文は変えない", async () => {
    const upstream = new Response("本文", { status: 200, headers: { "content-type": "text/html", server: "AkamaiGHost", "content-encoding": "gzip", "content-length": "999" } });
    expect(upstream.headers.get("content-encoding")).toBe("gzip");
    expect(upstream.headers.get("content-length")).toBe("999");
    const res = await handleProxyRequest(new Request(JRA_CUSHION_URL), async () => upstream);
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(res.headers.has("content-length")).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("server")).toBe("AkamaiGHost");
    expect(await res.text()).toBe("本文");
  });
  it.each([403, 404, 500, 302])("上流の状態 %s をそのまま返す(302 も追わず、location も返す)", async (status) => {
    const calls: string[] = [];
    const res = await handleProxyRequest(new Request(JRA_CUSHION_URL), async (url) => {
      calls.push(url);
      return new Response(status === 302 ? null : "x", { status, headers: status === 302 ? { location: "https://www.jra.go.jp/other" } : {} });
    });
    expect(res.status).toBe(status);
    expect(calls).toHaveLength(1);
    if (status === 302) {
      expect(res.headers.get("location")).toBe("https://www.jra.go.jp/other");
    }
  });
  it("上流が例外を投げたら 502(本文に例外のメッセージを出さない)", async () => {
    const res = await handleProxyRequest(new Request(JRA_CUSHION_URL), async () => {
      throw new Error("secret detail");
    });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret");
  });
  it("上限時間(JRA_TIMEOUT_MS)で切る: 信号が中断したら 504。上限は JRA の今の取得と同じ", async () => {
    expect(JRA_TIMEOUT_MS).toBe(10_000);
    const res = await handleProxyRequest(
      new Request(JRA_CUSHION_URL),
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
      20,
    );
    expect(res.status).toBe(504);
  });
  it("既定の上限時間は JRA_TIMEOUT_MS(AbortSignal.timeout に渡す値)", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await handleProxyRequest(new Request(JRA_CUSHION_URL), async () => new Response("x"));
      expect(spy).toHaveBeenCalledWith(JRA_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
  it("本文の読み出しも上限時間で切る(上流の本文が止まったとき、応答の本文がエラーで終わる)", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const res = await handleProxyRequest(new Request(JRA_CUSHION_URL), async () => new Response(stalled, { status: 200 }), 20);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toBeDefined();
  });
});

describe("createProxyFetch(呼ぶ側。stub の fetch に包む)", () => {
  it("url・メソッド・本文・ヘッダを Request にして stub に渡し、応答をそのまま返す", async () => {
    const seen: Request[] = [];
    const stub = {
      fetch: async (r: Request) => {
        seen.push(r);
        return new Response("ok", { status: 403, headers: { server: "AkamaiGHost" } });
      },
    };
    const f = createProxyFetch(stub);
    const res = await f(JRA_ACCESS_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "cname=a", redirect: "manual", signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(403);
    expect(res.headers.get("server")).toBe("AkamaiGHost");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(JRA_ACCESS_URL);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await seen[0]!.text()).toBe("cname=a");
  });
  it("呼ぶ側の信号が中断したら、stub の応答を待たずに中断の理由で投げる", async () => {
    const stub = { fetch: () => new Promise<Response>(() => {}) };
    const f = createProxyFetch(stub);
    const controller = new AbortController();
    const p = f(JRA_CUSHION_URL, { method: "GET", signal: controller.signal });
    controller.abort(new DOMException("timeout", "TimeoutError"));
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("信号が既に中断していれば stub を呼ばずに投げる", async () => {
    let called = 0;
    const f = createProxyFetch({ fetch: async () => (called++, new Response("x")) });
    await expect(f(JRA_CUSHION_URL, { signal: AbortSignal.abort(new DOMException("t", "TimeoutError")) })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(called).toBe(0);
  });
  it("中継の名前は固定(単一インスタンス)", () => {
    expect(JRA_FETCH_PROXY_NAME).toBe("main");
  });
});

describe("resolveJraFetch(var と binding から、開催日の DO が使う fetch を決める)", () => {
  const mk = () => {
    const log = { direct: 0, stubFetch: 0, made: 0, warns: [] as string[] };
    const direct = async (): Promise<Response> => (log.direct++, new Response("d"));
    const ns = { tag: "ns" };
    const makeStub = (n: typeof ns) => {
      expect(n).toBe(ns);
      log.made++;
      return { fetch: async (): Promise<Response> => (log.stubFetch++, new Response("p")) };
    };
    return { log, direct, ns, makeStub };
  };
  it("\"1\" で binding があれば、中継の stub 経由(直接は 0 回)", async () => {
    const { log, direct, ns, makeStub } = mk();
    const r = resolveJraFetch({ viaProxyVar: "1", namespace: ns, makeStub, direct, warn: (m) => log.warns.push(m) });
    expect(r.via).toBe("proxy");
    expect(await (await r.fetch(JRA_CUSHION_URL, {})).text()).toBe("p");
    expect(log).toMatchObject({ direct: 0, stubFetch: 1, made: 1, warns: [] });
  });
  it.each([["0"], [undefined], [""], ["true"]])("var %j は直接(stub は作らない)", async (v) => {
    const { log, direct, ns, makeStub } = mk();
    const r = resolveJraFetch({ viaProxyVar: v, namespace: ns, makeStub, direct, warn: (m) => log.warns.push(m) });
    expect(r.via).toBe("direct");
    expect(await (await r.fetch(JRA_CUSHION_URL, {})).text()).toBe("d");
    expect(log).toMatchObject({ direct: 1, stubFetch: 0, made: 0, warns: [] });
  });
  it("\"1\" でも binding が無ければ直接に戻し、警告を 1 行出す", async () => {
    const { log, direct, makeStub } = mk();
    const r = resolveJraFetch({ viaProxyVar: "1", namespace: undefined, makeStub, direct, warn: (m) => log.warns.push(m) });
    expect(r.via).toBe("direct");
    expect(await (await r.fetch(JRA_CUSHION_URL, {})).text()).toBe("d");
    expect(log.warns).toHaveLength(1);
  });
});
