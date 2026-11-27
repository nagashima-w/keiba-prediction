import { describe, expect, it } from "vitest";

import { fetchOne, type JraFetchLike } from "../src/jra-http";

/**
 * Issue #804: `fetchOne` の結果に失敗の種類(`failKind`)を載せる。`summary.status`(`JraFailure` の 4 語と HTTP の状態)は変えない。
 * 例外の message・応答の本文・ヘッダは、判定にだけ読み、結果に残さない。
 */
const fetchReturning = (make: () => Response): JraFetchLike => async () => make();
const fetchThrowing = (error: unknown): JraFetchLike => async () => {
  throw error;
};
const run = (fn: JraFetchLike) => fetchOne(fn, "https://example.invalid/", { method: "GET" }, 5000);
const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

describe("fetchOne の failKind: 例外", () => {
  it("名前の解決の失敗(internal error)は dns。status は network のまま", async () => {
    const r = await run(fetchThrowing(named("Error", "internal error; reference = x")));
    expect(r.summary.status).toBe("network");
    expect(r.failKind).toBe("dns");
  });
  it("Network connection lost は reset。status は network のまま", async () => {
    const r = await run(fetchThrowing(named("Error", "Network connection lost.")));
    expect(r.summary.status).toBe("network");
    expect(r.failKind).toBe("reset");
  });
  it("TimeoutError は timeout(status も timeout)", async () => {
    const r = await run(fetchThrowing(named("TimeoutError", "x")));
    expect(r.summary.status).toBe("timeout");
    expect(r.failKind).toBe("timeout");
  });
  it("知らない例外は unknown(status は network のまま)", async () => {
    const r = await run(fetchThrowing(named("Error", "weird")));
    expect(r.summary.status).toBe("network");
    expect(r.failKind).toBe("unknown");
  });
  it("例外の message は結果のどこにも入らない", async () => {
    const r = await run(fetchThrowing(named("Error", "SECRET-https://secret.example/path")));
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("fetchOne の failKind: 応答", () => {
  it("200 は null", async () => {
    const r = await run(fetchReturning(() => new Response("ok", { status: 200 })));
    expect(r.failKind).toBeNull();
  });
  it("404 は http(status は 404 のまま)", async () => {
    const r = await run(fetchReturning(() => new Response("nf", { status: 404 })));
    expect(r.summary.status).toBe(404);
    expect(r.failKind).toBe("http");
  });
  it("403 で server が AkamaiGHost なら blocked", async () => {
    const r = await run(fetchReturning(() => new Response("x", { status: 403, headers: { server: "AkamaiGHost" } })));
    expect(r.summary.status).toBe(403);
    expect(r.failKind).toBe("blocked");
  });
  it("403 で本文に Access Denied と edgesuite があれば blocked", async () => {
    const r = await run(fetchReturning(() => new Response("<TITLE>Access Denied</TITLE> errors.edgesuite.net", { status: 403 })));
    expect(r.failKind).toBe("blocked");
  });
  it("403 でも目印が無ければ http", async () => {
    const r = await run(fetchReturning(() => new Response("Forbidden", { status: 403, headers: { server: "nginx" } })));
    expect(r.failKind).toBe("http");
  });
  it("403 以外で server が Akamai でも blocked にしない(403 のときだけ)", async () => {
    const r = await run(fetchReturning(() => new Response("x", { status: 503, headers: { server: "AkamaiGHost" } })));
    expect(r.failKind).toBe("http");
  });
  it("Cloudflare のエラー応答(530・本文 error code: 1016)は cf-1016", async () => {
    const r = await run(fetchReturning(() => new Response("error code: 1016", { status: 530 })));
    expect(r.summary.status).toBe(530);
    expect(r.failKind).toBe("cf-1016");
  });
  it("3xx は redirect", async () => {
    const r = await run(fetchReturning(() => new Response(null, { status: 302, headers: { location: "https://x/" } })));
    expect(r.summary.status).toBe("redirect");
    expect(r.failKind).toBe("redirect");
  });
  it("本文が上限を超えたら too-large", async () => {
    const r = await fetchOne(fetchReturning(() => new Response(new Uint8Array(100).fill(0x61), { status: 200 })), "https://example.invalid/", { method: "GET" }, 5000, 10);
    expect(r.summary.status).toBe("too-large");
    expect(r.failKind).toBe("too-large");
  });
  it("本文を読む途中の失敗(切断)は reset", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw named("Error", "Network connection lost.");
      },
    });
    const r = await run(fetchReturning(() => new Response(stream, { status: 200 })));
    expect(r.summary.status).toBe("network");
    expect(r.failKind).toBe("reset");
  });
  it("本文の読み出しの時間切れは timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw named("TimeoutError", "x");
      },
    });
    const r = await run(fetchReturning(() => new Response(stream, { status: 200 })));
    expect(r.summary.status).toBe("timeout");
    expect(r.failKind).toBe("timeout");
  });
  it("応答のヘッダ・本文の値は結果の failKind に入らない(語だけ)", async () => {
    const r = await run(fetchReturning(() => new Response("SECRETBODY", { status: 403, headers: { server: "AkamaiGHost-SECRETHDR" } })));
    expect(r.failKind).toBe("blocked");
    expect(JSON.stringify(r.summary)).not.toContain("SECRET");
  });
});
