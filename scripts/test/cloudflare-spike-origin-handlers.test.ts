import { describe, expect, it } from "vitest";
import { fetchEcho } from "../../spikes/cloudflare/src/echo-fetch.js";
import { handleEcho, handleNetkeibaSocket } from "../../spikes/cloudflare/src/origin-handlers.js";
import { probeNetkeiba, type ProbeFetch } from "../../spikes/cloudflare/src/netkeiba-probe.js";
import type { ConnectFn, SocketLike } from "../../spikes/cloudflare/src/socket-probe.js";
import { DEFAULT_USER_AGENT } from "../../packages/core/src/scraper/http-client.js";

/**
 * #160 Worker の `/echo`・`/netkeiba-socket` の処理(`spikes/cloudflare/src/origin-handlers.ts`)と、
 * エコー取得(`echo-fetch.ts`)。fetch・connect を注入できるので、実ネットワークには出ない。
 * 不正な入力では、fetch も connect も呼ばれないこと(外へ出ないこと)を確かめる。
 */

const enc = new TextEncoder();
const post = (body: unknown): Request =>
  new Request("https://worker.invalid/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

function recordingFetch(status: number, body: string, headers: Record<string, string> = {}): { fetch: ProbeFetch; calls: { url: string; init: Parameters<ProbeFetch>[1] }[] } {
  const calls: { url: string; init: Parameters<ProbeFetch>[1] }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(body, { status, headers });
    },
  };
}

describe("fetchEcho(エコーの取得。ランナーと Worker の両方が同じ関数を使う)", () => {
  it("固定表の URL へ、netkeiba と同じ経路(HttpClient)で、User-Agent だけのヘッダで取りに行く(共有秘密などは付けない)", async () => {
    const f = recordingFetch(200, '{"x":1}', { server: "TrackMe.peet.ws" });
    await fetchEcho("peet", f.fetch);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://tls.peet.ws/api/all");
    expect(f.calls[0]!.init.headers).toEqual({ "User-Agent": DEFAULT_USER_AGENT });
    expect(f.calls[0]!.init.redirect).toBe("manual");
  });

  it("netkeiba の取得(probeNetkeiba)と、fetch に渡る init が同じ(ヘッダ・redirect・メソッド)", async () => {
    const echo = recordingFetch(200, "{}");
    const probe = recordingFetch(200, "<html></html>");
    await fetchEcho("httpbin", echo.fetch);
    await probeNetkeiba({ targetId: "t", url: "https://race.netkeiba.com/x", kind: "shutuba", encoding: "utf-8" }, probe.fetch);
    const strip = (i: Parameters<ProbeFetch>[1]) => ({ headers: i.headers, redirect: i.redirect, method: i.method, hasSignal: i.signal !== undefined });
    expect(strip(echo.calls[0]!.init)).toEqual(strip(probe.calls[0]!.init));
  });

  it("200 は、ステータス・本文・選んだ応答ヘッダ(server / cf-ray / via)を返す。ほかのヘッダは返さない", async () => {
    const f = recordingFetch(200, '{"a":1}', { server: "gunicorn", "cf-ray": "r-IAD", via: "1.1 x", "set-cookie": "s=1" });
    const r = await fetchEcho("httpbin", f.fetch);
    expect(r).toEqual({ status: 200, bodyText: '{"a":1}', responseHeaders: { server: "gunicorn", "cf-ray": "r-IAD", via: "1.1 x" }, error: null });
  });

  it("非 2xx(403)でも、ステータスと本文を残す(HttpClient が例外にしても情報を捨てない)", async () => {
    const r = await fetchEcho("peet", recordingFetch(403, "forbidden").fetch);
    expect(r.status).toBe(403);
    expect(r.bodyText).toBe("forbidden");
  });

  it("fetch が例外なら status=null で、理由を error に残す", async () => {
    const r = await fetchEcho("peet", async () => {
      throw new Error("boom");
    });
    expect(r.status).toBeNull();
    expect(r.bodyText).toBeNull();
    expect(r.error).toMatch(/boom/);
  });

  it("本文は 64KB までに切る(巨大な応答を結果に載せない)", async () => {
    const r = await fetchEcho("peet", recordingFetch(200, "a".repeat(100_000)).fetch);
    expect(r.bodyText!.length).toBe(64 * 1024);
  });
});

describe("handleEcho(POST /echo)", () => {
  it("正しい入力: 固定表の URL を1回だけ取得し、{ok, result} を返す", async () => {
    const f = recordingFetch(200, '{"headers":{"A":"1"}}');
    const res = await handleEcho(post({ service: "httpbin" }), f.fetch);
    expect(res.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual(["https://httpbin.org/headers"]);
    const json = (await res.json()) as { ok: boolean; result: { status: number; bodyText: string } };
    expect(json.ok).toBe(true);
    expect(json.result.status).toBe(200);
    expect(json.result.bodyText).toBe('{"headers":{"A":"1"}}');
  });

  it("エコーが 403 でも、Worker の応答は 200(エコーの結果として運ぶ。Worker 自体の失敗と区別する)", async () => {
    const res = await handleEcho(post({ service: "peet" }), recordingFetch(403, "no").fetch);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { status: number } }).result.status).toBe(403);
  });

  it.each([
    ["JSON でない本文", "not json"],
    ["固定表以外の service", { service: "postman" }],
    ["url で任意の宛先を指定", { service: "peet", url: "https://evil.example/" }],
    ["service が無い", {}],
  ])("%s は 400 で、fetch は1回も呼ばれない(外へ出ない)", async (_name, body) => {
    const f = recordingFetch(200, "{}");
    const res = await handleEcho(post(body), f.fetch);
    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
});

/** 指定の応答を返す偽ソケットを作る。 */
function socketReturning(data: Uint8Array): { connect: ConnectFn; calls: { hostname: string; port: number }[]; written: Uint8Array[] } {
  const calls: { hostname: string; port: number }[] = [];
  const written: Uint8Array[] = [];
  return {
    calls,
    written,
    connect: (address): SocketLike => {
      calls.push(address);
      let sent = false;
      return {
        opened: Promise.resolve({}),
        readable: new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent) {
              c.close();
            } else {
              sent = true;
              c.enqueue(data);
            }
          },
        }),
        writable: new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk) }),
        close: async () => {},
      };
    },
  };
}

const socketBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetId: "central-shutuba",
  url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
  kind: "shutuba",
  encoding: "utf-8",
  headers: [{ name: "User-Agent", value: "ua-from-driver" }],
  ...over,
});

describe("handleNetkeibaSocket(POST /netkeiba-socket)", () => {
  const rejected = enc.encode("HTTP/1.1 400 Bad Request\r\nX-Cache: Error from cloudfront\r\nContent-Length: 0\r\n\r\n");

  it("正しい入力: 443 へ1回だけ接続し、ドライバが渡したヘッダで GET し、記録を {ok, record} で返す", async () => {
    const s = socketReturning(rejected);
    const res = await handleNetkeibaSocket(post(socketBody()), s.connect);
    expect(res.status).toBe(200);
    expect(s.calls).toEqual([{ hostname: "race.netkeiba.com", port: 443 }]);
    const sent = new TextDecoder().decode(s.written[0]!);
    expect(sent).toContain("GET /race/shutuba.html?race_id=202603020211 HTTP/1.1\r\n");
    expect(sent).toContain("Host: race.netkeiba.com\r\n");
    expect(sent).toContain("User-Agent: ua-from-driver\r\n");
    expect(sent).toContain("Connection: close\r\n");
    const json = (await res.json()) as { ok: boolean; record: { status: number; headers: Record<string, string>; targetId: string } };
    expect(json.ok).toBe(true);
    expect(json.record.status).toBe(400);
    expect(json.record.headers["x-cache"]).toBe("Error from cloudfront");
    expect(json.record.targetId).toBe("central-shutuba");
  });

  it("ソケットを開けなくても、Worker の応答は 200 で、記録は status=null と理由(利用不可の事実を記録する)", async () => {
    const connect: ConnectFn = () => {
      throw new Error("TCP sockets unavailable");
    };
    const res = await handleNetkeibaSocket(post(socketBody()), connect);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; record: { status: number | null; error: string } };
    expect(json.ok).toBe(true);
    expect(json.record.status).toBeNull();
    expect(json.record.error).toMatch(/TCP sockets unavailable/);
  });

  it.each([
    ["JSON でない本文", "not json"],
    ["許可ホスト以外", socketBody({ url: "https://example.com/" })],
    ["許可ホストの偽装", socketBody({ url: "https://race.netkeiba.com.evil.example/" })],
    ["http", socketBody({ url: "http://race.netkeiba.com/" })],
    ["禁止ヘッダ(Host)", socketBody({ headers: [{ name: "Host", value: "evil.example" }] })],
    ["禁止ヘッダ(Accept-Encoding)", socketBody({ headers: [{ name: "Accept-Encoding", value: "gzip" }] })],
    ["禁止ヘッダ(Transfer-Encoding)", socketBody({ headers: [{ name: "Transfer-Encoding", value: "chunked" }] })],
    ["ヘッダ値の CRLF", socketBody({ headers: [{ name: "x-a", value: "1\r\nHost: evil" }] })],
    ["未知の kind", socketBody({ kind: "evil" })],
  ])("%s は 400 で、connect は1回も呼ばれない(外へ出ない)", async (_name, body) => {
    const s = socketReturning(rejected);
    const res = await handleNetkeibaSocket(post(body), s.connect);
    expect(res.status).toBe(400);
    expect(s.calls).toHaveLength(0);
    expect(s.written).toHaveLength(0);
  });
});
