import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHttp1Request } from "../cloudflare-spike/http1.js";
import { judgeReachability } from "../cloudflare-spike/reachability.js";
import { probeNetkeiba } from "../../spikes/cloudflare/src/netkeiba-probe.js";
import {
  createSocketFetch,
  SOCKET_MAX_BYTES,
  SOCKET_TIMEOUT_MS,
  type ConnectFn,
  type SocketLike,
} from "../../spikes/cloudflare/src/socket-probe.js";

/**
 * #160 E3: Worker のソケット(`connect()`)で HTTP/1.1 を話す `createSocketFetch`
 * (`spikes/cloudflare/src/socket-probe.ts`)。`connect` を注入できるので、偽ソケット(Node の Web Streams)で
 * 読み取りループ・EOF・サイズ上限・タイムアウト・後始末を検証できる。実ネットワークには出ない。
 */

const iconv = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "core", "package.json"),
)("iconv-lite") as { encode(text: string, encoding: string): Buffer };

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const readFixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const split = (data: Uint8Array, size: number): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    out.push(data.subarray(i, i + size));
  }
  return out;
};
const response = (head: string, body: Uint8Array = new Uint8Array(0)): Uint8Array =>
  concat(bytes(`${head.replace(/\n/g, "\r\n")}\r\n\r\n`), body);
const chunkedBody = (body: Uint8Array, size: number): Uint8Array =>
  concat(...split(body, size).flatMap((c) => [bytes(`${c.length.toString(16)}\r\n`), c, bytes("\r\n")]), bytes("0\r\n\r\n"));

interface FakeState {
  written: Uint8Array[];
  closeCalls: number;
  cancelled: boolean;
  pulls: number;
}
interface FakeOptions {
  chunks?: Uint8Array[];
  neverEnd?: boolean;
  opened?: Promise<unknown>;
  readError?: Error;
  writeError?: Error;
}
function fakeSocket(o: FakeOptions): { socket: SocketLike; state: FakeState } {
  const state: FakeState = { written: [], closeCalls: 0, cancelled: false, pulls: 0 };
  const chunks = [...(o.chunks ?? [])];
  const socket: SocketLike = {
    opened: o.opened ?? Promise.resolve({}),
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        if (o.readError !== undefined && chunks.length === 0) {
          controller.error(o.readError);
          return;
        }
        const next = chunks.shift();
        if (next !== undefined) {
          controller.enqueue(next);
        } else if (o.neverEnd) {
          return new Promise<void>(() => {});
        } else {
          controller.close();
        }
      },
      cancel() {
        state.cancelled = true;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        if (o.writeError !== undefined) {
          throw o.writeError;
        }
        state.written.push(chunk);
      },
    }),
    close: async () => {
      state.closeCalls += 1;
    },
  };
  return { socket, state };
}

interface Connected {
  connect: ConnectFn;
  calls: { address: { hostname: string; port: number }; options: { secureTransport: string; allowHalfOpen: boolean } }[];
  sockets: { socket: SocketLike; state: FakeState }[];
}
function connector(make: () => FakeOptions): Connected {
  const calls: Connected["calls"] = [];
  const sockets: Connected["sockets"] = [];
  return {
    calls,
    sockets,
    connect: (address, options) => {
      calls.push({ address, options });
      const s = fakeSocket(make());
      sockets.push(s);
      return s.socket;
    },
  };
}

const HEADERS = [
  { name: "User-Agent", value: "ua" },
  { name: "accept", value: "*/*" },
];
const URL_RACE = "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211";
const writtenText = (s: FakeState): string => new TextDecoder().decode(concat(...s.written));

describe("createSocketFetch: リクエスト", () => {
  it("443 番へ TLS(secureTransport: on)・allowHalfOpen: false で接続し、組み立てた HTTP/1.1 の GET を書き込む", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 2", bytes("ok"))] }));
    const f = createSocketFetch(c.connect, { headers: HEADERS });
    await f(URL_RACE, {});
    expect(c.calls).toEqual([{ address: { hostname: "race.netkeiba.com", port: 443 }, options: { secureTransport: "on", allowHalfOpen: false } }]);
    expect(writtenText(c.sockets[0]!.state)).toBe(
      buildHttp1Request({ host: "race.netkeiba.com", path: "/race/shutuba.html?race_id=202603020211", headers: HEADERS }),
    );
    expect(writtenText(c.sockets[0]!.state)).toContain("Connection: close");
    expect(writtenText(c.sockets[0]!.state).toLowerCase()).not.toContain("accept-encoding");
  });

  it("fetch の init のヘッダ(HttpClient が付ける User-Agent)は、同名なら options.headers を優先し、別名なら末尾に足す", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 0")] }));
    const f = createSocketFetch(c.connect, { headers: HEADERS });
    await f(URL_RACE, { headers: { "user-agent": "ua-from-init", "x-extra": "1" } });
    const text = writtenText(c.sockets[0]!.state);
    expect(text).toContain("User-Agent: ua\r\n");
    expect(text).not.toContain("ua-from-init");
    expect(text.toLowerCase().match(/user-agent:/g)).toHaveLength(1);
    expect(text.indexOf("x-extra: 1")).toBeGreaterThan(text.indexOf("accept: */*"));
  });

  it.each([
    ["http(TLS でない)", "http://race.netkeiba.com/"],
    ["443 以外のポート", "https://race.netkeiba.com:8443/"],
    ["URL でない", "not a url"],
  ])("%s の URL では接続しない", async (_name, url) => {
    const c = connector(() => ({}));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(url, {})).rejects.toThrow();
    expect(c.calls).toHaveLength(0);
  });

  it("禁止ヘッダ(init 側から Accept-Encoding を足そうとしても)は、接続の前に拒否する", async () => {
    const c = connector(() => ({}));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, { headers: { "Accept-Encoding": "gzip" } })).rejects.toThrow(/Accept-Encoding/i);
    expect(c.calls).toHaveLength(0);
  });
});

describe("createSocketFetch: 応答の読み取り", () => {
  it("Content-Length の応答を、ステータス・ヘッダ・本文つきの Response にする", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Type: text/html; charset=UTF-8\nContent-Length: 5", bytes("hello"))] }));
    const r = await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {});
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await r.text()).toBe("hello");
  });

  it("本文が1バイトずつ届いても(境界が分割されても)、一括で届いたときと同じ本文になる", async () => {
    const full = response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked", chunkedBody(bytes("競馬 abcdef"), 4));
    const one = connector(() => ({ chunks: split(full, 1) }));
    const all = connector(() => ({ chunks: [full] }));
    const a = await createSocketFetch(one.connect, { headers: HEADERS })(URL_RACE, {});
    const b = await createSocketFetch(all.connect, { headers: HEADERS })(URL_RACE, {});
    expect(await a.text()).toBe("競馬 abcdef");
    expect(await b.text()).toBe("競馬 abcdef");
  });

  it("本文0バイトの 400(CloudFront の拒否の形)は、拒否として読める(例外にしない)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 400 Bad Request\nServer: CloudFront\nX-Cache: Error from cloudfront\nContent-Length: 0")] }));
    const r = await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {});
    expect(r.status).toBe(400);
    expect(r.headers.get("x-cache")).toBe("Error from cloudfront");
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  it("204 / 304 は本文なしの Response になる(Response の制約で例外にならない)", async () => {
    for (const status of [204, 304]) {
      const c = connector(() => ({ chunks: [response(`HTTP/1.1 ${status} X\nContent-Length: 0`)] }));
      const r = await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {});
      expect(r.status).toBe(status);
    }
  });

  it("リダイレクト(301)には従わない: Response として返し、接続は1回だけ", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 301 Moved\nLocation: https://example.com/\nContent-Length: 0")] }));
    const r = await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://example.com/");
    expect(c.calls).toHaveLength(1);
  });

  it("不正な値のヘッダを含む応答でも、そのヘッダを飛ばして Response を作る(全体を失敗にしない)", async () => {
    // X-Bad の値に NUL(Headers が受け付けない)を入れる。X-Ok は残り、全体は失敗にならない。
    const raw = concat(bytes("HTTP/1.1 200 OK\r\nX-Bad: a\u0000b\r\nX-Ok: 1\r\nContent-Length: 0\r\n\r\n"));
    const c = connector(() => ({ chunks: [raw] }));
    const r = await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {});
    expect(r.headers.get("x-ok")).toBe("1");
    expect(r.headers.get("x-bad")).toBeNull();
  });

  it.each([
    ["EOF が本文の途中(Content-Length より短い)", response("HTTP/1.1 200 OK\nContent-Length: 10", bytes("abc")), /途中で切断/],
    ["EOF が chunked の途中", response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked", bytes("5\r\nhel")), /途中で切断/],
    ["ヘッダの途中で EOF", bytes("HTTP/1.1 200 OK\r\nContent-Le"), /ヘッダ.*切断/],
    ["何も返さず EOF", new Uint8Array(0), /切断/],
    ["HTTP でない応答", bytes("SSH-2.0-OpenSSH_9\r\n\r\n"), /ステータス行/],
  ])("%s は例外にする(途中までを成功として扱わない)", async (_name, data, pattern) => {
    const c = connector(() => ({ chunks: data.length === 0 ? [] : [data] }));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(pattern);
  });

  it("Accept-Encoding を送っていないのに content-encoding が付いて返ったら、デコードせず未対応として例外にする", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Encoding: gzip\nContent-Length: 3", bytes("abc"))] }));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(/content-encoding: gzip/i);
  });

  it("content-encoding: identity は受け入れる", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Encoding: identity\nContent-Length: 2", bytes("ok"))] }));
    expect((await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).status).toBe(200);
  });
});

describe("createSocketFetch: サイズ上限とタイムアウト", () => {
  it("上限は既定で 2 MiB、タイムアウトは既定で 20 秒", () => {
    expect(SOCKET_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SOCKET_TIMEOUT_MS).toBe(20_000);
  });

  it("受信が上限を超えたら読むのをやめて打ち切り、受信済みのステータスを添えた例外にする(ソケットを閉じる)", async () => {
    const head = response("HTTP/1.1 200 OK\nContent-Type: text/html");
    const filler = split(new Uint8Array(10_000).fill(65), 100);
    const c = connector(() => ({ chunks: [head, ...filler] }));
    const f = createSocketFetch(c.connect, { headers: HEADERS, maxBytes: 1000 });
    await expect(f(URL_RACE, {})).rejects.toThrow(/サイズ上限.*1000.*HTTP 200/);
    const s = c.sockets[0]!.state;
    expect(s.cancelled).toBe(true);
    expect(s.closeCalls).toBe(1);
    // 全部は読んでいない(100 個の filler のうち、上限の 1000 バイト分 + 1 つ程度で止まる)
    expect(s.pulls).toBeLessThan(30);
  });

  it("上限ちょうどの応答は受け入れる(上限は『超えたら』打ち切り)", async () => {
    const data = response("HTTP/1.1 200 OK\nContent-Length: 4", bytes("abcd"));
    const c = connector(() => ({ chunks: [data] }));
    const r = await createSocketFetch(c.connect, { headers: HEADERS, maxBytes: data.length })(URL_RACE, {});
    expect(await r.text()).toBe("abcd");
  });

  it("終わらない接続は、タイムアウトで打ち切り、受信済みのステータスを添える(ソケットを閉じる)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 100", bytes("abc"))], neverEnd: true }));
    const f = createSocketFetch(c.connect, { headers: HEADERS, timeoutMs: 50 });
    await expect(f(URL_RACE, {})).rejects.toThrow(/タイムアウト.*50.*HTTP 200/);
    expect(c.sockets[0]!.state.cancelled).toBe(true);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("接続が開かないまま(opened が解決しない)でも、タイムアウトで打ち切る", async () => {
    const c = connector(() => ({ opened: new Promise(() => {}) }));
    const f = createSocketFetch(c.connect, { headers: HEADERS, timeoutMs: 50 });
    await expect(f(URL_RACE, {})).rejects.toThrow(/タイムアウト/);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("呼び出し側の signal(HttpClient のタイムアウト)が中止されたら、打ち切る", async () => {
    const c = connector(() => ({ neverEnd: true }));
    const controller = new AbortController();
    const f = createSocketFetch(c.connect, { headers: HEADERS });
    const p = f(URL_RACE, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(p).rejects.toThrow(/中止|abort/i);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("すでに中止済みの signal では、接続しない", async () => {
    const c = connector(() => ({}));
    const controller = new AbortController();
    controller.abort();
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, { signal: controller.signal })).rejects.toThrow();
    expect(c.calls).toHaveLength(0);
  });
});

describe("createSocketFetch: 失敗時の後始末と記録", () => {
  it("ソケットを開けない(opened が拒否される。Free で未対応など)と、その理由を例外のメッセージに残し、ソケットを閉じる", async () => {
    const c = connector(() => ({ opened: Promise.reject(new Error("TCP sockets are not supported on this plan")) }));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(/not supported on this plan/);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("connect() 自体が同期的に例外を投げても、理由を残す(接続は1回だけ)", async () => {
    let calls = 0;
    const connect: ConnectFn = () => {
      calls += 1;
      throw new Error("connect is unavailable");
    };
    await expect(createSocketFetch(connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(/connect is unavailable/);
    expect(calls).toBe(1);
  });

  it("読み取り中の通信エラーは例外にし、ソケットを閉じる", async () => {
    const c = connector(() => ({ chunks: [bytes("HTTP/1.1 200 OK\r\nContent")], readError: new Error("connection reset") }));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(/connection reset/);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("書き込みの失敗は例外にし、ソケットを閉じる", async () => {
    const c = connector(() => ({ writeError: new Error("write failed") }));
    await expect(createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {})).rejects.toThrow(/write failed/);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("成功したときも、ソケットを閉じる", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 0")] }));
    await createSocketFetch(c.connect, { headers: HEADERS })(URL_RACE, {});
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("close() が失敗しても、結果(成功・失敗)を隠さない", async () => {
    const connect: ConnectFn = () => {
      const s = fakeSocket({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 2", bytes("ok"))] }).socket;
      return { ...s, close: async () => { throw new Error("close failed"); } };
    };
    const r = await createSocketFetch(connect, { headers: HEADERS })(URL_RACE, {});
    expect(await r.text()).toBe("ok");
  });
});

describe("probeNetkeiba に差し込んだときの記録(既存の記録の形に揃う)", () => {
  const raceRequest = { targetId: "central-shutuba", url: URL_RACE, kind: "shutuba" as const, encoding: "utf-8" as const };

  it("出馬表(UTF-8・chunked・4KB ずつ到着)は、パース件数16・置換文字0・判定 ok の記録になる", async () => {
    const html = readFixture("shutuba_202603020211.html");
    const full = response("HTTP/1.1 200 OK\nContent-Type: text/html; charset=UTF-8\nTransfer-Encoding: chunked\nServer: Apache", chunkedBody(new Uint8Array(html), 8192));
    const c = connector(() => ({ chunks: split(full, 4096) }));
    const rec = await probeNetkeiba(raceRequest, createSocketFetch(c.connect, { headers: HEADERS }));
    expect(rec.status).toBe(200);
    expect(rec.bodyLength).toBe(html.length);
    expect(rec.charset).toBe("UTF-8");
    expect(rec.parsedCount).toBe(16);
    expect(rec.replacementChars).toBe(0);
    expect(rec.error).toBeNull();
    expect(rec.headers["server"]).toBe("Apache");
    expect(judgeReachability(rec).verdict).toBe("ok");
    expect(c.calls).toHaveLength(1);
  });

  it("馬ページ(EUC-JP・Content-Length)を読める: 馬名が取れて文字化け0", async () => {
    const eucBytes = new Uint8Array(iconv.encode(readFixture("horse_2021105857.html").toString("utf-8"), "euc-jp"));
    const full = response(`HTTP/1.1 200 OK\nContent-Type: text/html\nContent-Length: ${eucBytes.length}`, eucBytes);
    const c = connector(() => ({ chunks: split(full, 5000) }));
    const rec = await probeNetkeiba(
      { targetId: "db-horse-page", url: "https://db.netkeiba.com/horse/2021105857/", kind: "horse-page", encoding: "euc-jp" },
      createSocketFetch(c.connect, { headers: HEADERS }),
    );
    expect(rec.bodyLength).toBe(eucBytes.length);
    expect(rec.parsedCount).toBe(1);
    expect(rec.replacementChars).toBe(0);
    expect(judgeReachability(rec).verdict).toBe("ok");
    expect(writtenText(c.sockets[0]!.state)).toContain("Host: db.netkeiba.com\r\n");
  });

  it("本文0バイトの 400 は、拒否(blocked)の記録になる。再試行しない(接続は1回)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 400 Bad Request\nX-Cache: Error from cloudfront\nContent-Length: 0")] }));
    const rec = await probeNetkeiba(raceRequest, createSocketFetch(c.connect, { headers: HEADERS }));
    expect(rec.status).toBe(400);
    expect(rec.bodyLength).toBe(0);
    expect(rec.headers["x-cache"]).toBe("Error from cloudfront");
    expect(judgeReachability(rec).verdict).toBe("blocked");
    expect(c.calls).toHaveLength(1);
  });

  it("5xx でも再試行しない(接続は1回。1本は1本)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 503 Service Unavailable\nContent-Length: 0")] }));
    const rec = await probeNetkeiba(raceRequest, createSocketFetch(c.connect, { headers: HEADERS }));
    expect(rec.status).toBe(503);
    expect(c.calls).toHaveLength(1);
  });

  it("ソケットを開けなかった場合は、status=null で理由が error に残り、network-error と判定される", async () => {
    const c = connector(() => ({ opened: Promise.reject(new Error("sockets disabled")) }));
    const rec = await probeNetkeiba(raceRequest, createSocketFetch(c.connect, { headers: HEADERS }));
    expect(rec.status).toBeNull();
    expect(rec.error).toMatch(/sockets disabled/);
    expect(judgeReachability(rec).verdict).toBe("network-error");
    expect(c.calls).toHaveLength(1);
  });

  it("サイズ上限を超えた打ち切りも、理由つきの記録になる(判定不能。拒否とは数えない)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK"), ...split(new Uint8Array(5000).fill(65), 500)] }));
    const rec = await probeNetkeiba(raceRequest, createSocketFetch(c.connect, { headers: HEADERS, maxBytes: 1000 }));
    expect(rec.status).toBeNull();
    expect(rec.error).toMatch(/サイズ上限/);
    expect(judgeReachability(rec).verdict).toBe("network-error");
  });
});
