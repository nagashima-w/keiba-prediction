import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT } from "../../packages/core/src/scraper/http-client.js";
import {
  createSocketFetcher,
  NETKEIBA_REQUEST_HEADERS,
  NETKEIBA_USER_AGENT,
  SOCKET_CLEANUP_TIMEOUT_MS,
  SOCKET_MAX_BYTES,
  SOCKET_TIMEOUT_MS,
  SocketFetchError,
  type ConnectFn,
  type SocketLike,
} from "../src/socket-fetch";

// ユーザー情報つき URL(user:pw と @ の組)をテスト用に組み立てる。リテラルで書くとメールアドレスの形になり、公開リポジトリへの混入検査が反応するため。
const AT = "@";

/**
 * Issue #162 段階2a: ソケット取得クライアント(`createSocketFetcher`)。`connect` を注入できるので、偽ソケット
 * (Node の Web Streams)で、送るバイト列・読み取りループ・EOF・サイズ上限・タイムアウト・後始末を検証する。実ネットワークには出ない。
 */

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

interface FakeState {
  written: Uint8Array[];
  closeCalls: number;
  cancelled: boolean;
}
interface FakeOptions {
  chunks?: Uint8Array[];
  neverEnd?: boolean;
  opened?: Promise<unknown>;
  readError?: Error;
  writeError?: Error;
}
function fakeSocket(o: FakeOptions): { socket: SocketLike; state: FakeState } {
  const state: FakeState = { written: [], closeCalls: 0, cancelled: false };
  const chunks = [...(o.chunks ?? [])];
  const socket: SocketLike = {
    opened: o.opened ?? Promise.resolve({}),
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
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

const URL_RACE = "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211";
const writtenText = (s: FakeState): string => new TextDecoder().decode(concat(...s.written));
const OK_BODY = response("HTTP/1.1 200 OK\nContent-Length: 2", bytes("ok"));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("拒否されるはずが成功した");
}

describe("リクエスト(AC-1・AC-2)", () => {
  it("443 番へ TLS(secureTransport: on)・allowHalfOpen: false で、ホスト名を指定して接続する", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    await createSocketFetcher(c.connect)(URL_RACE);
    expect(c.calls).toEqual([
      { address: { hostname: "race.netkeiba.com", port: 443 }, options: { secureTransport: "on", allowHalfOpen: false } },
    ]);
  });

  it("送るバイト列は、リクエスト行・Host・固定の4ヘッダ(この順)・Connection: close だけで、1バイトも違わない(accept-encoding なし)", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    await createSocketFetcher(c.connect)(URL_RACE);
    // 段階1(#162)で9本とも 200 だった集合と同じ。期待値はリテラルで書く(定数からは導かない)。
    expect(writtenText(c.sockets[0]!.state)).toBe(
      "GET /race/shutuba.html?race_id=202603020211 HTTP/1.1\r\n" +
        "Host: race.netkeiba.com\r\n" +
        "User-Agent: keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)\r\n" +
        "accept: */*\r\n" +
        "accept-language: *\r\n" +
        "sec-fetch-mode: cors\r\n" +
        "Connection: close\r\n\r\n",
    );
  });

  it("ヘッダの集合は4つ(User-Agent・accept・accept-language・sec-fetch-mode)で、accept-encoding を含まない", () => {
    expect(NETKEIBA_REQUEST_HEADERS.map((h) => h.name)).toEqual(["User-Agent", "accept", "accept-language", "sec-fetch-mode"]);
    expect(NETKEIBA_REQUEST_HEADERS.some((h) => h.name.toLowerCase() === "accept-encoding")).toBe(false);
  });

  it("User-Agent は core の HttpClient の既定と同じ(core 側が変わったらここが落ちる。変えるなら意識的に)", () => {
    expect(NETKEIBA_USER_AGENT).toBe(DEFAULT_USER_AGENT);
  });

  it("接続先のホストごとに Host が変わり、クエリ付きのパスが保たれる(db・nar)", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    const fetcher = createSocketFetcher(c.connect);
    await fetcher("https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210");
    await fetcher("https://db.netkeiba.com/horse/2021105857/");
    expect(c.calls.map((x) => x.address.hostname)).toEqual(["nar.netkeiba.com", "db.netkeiba.com"]);
    expect(writtenText(c.sockets[0]!.state)).toContain("GET /race/shutuba.html?race_id=202654071210 HTTP/1.1\r\nHost: nar.netkeiba.com\r\n");
    expect(writtenText(c.sockets[1]!.state)).toContain("GET /horse/2021105857/ HTTP/1.1\r\nHost: db.netkeiba.com\r\n");
  });

  it.each([
    ["http(暗号化なし)", "http://race.netkeiba.com/x"],
    ["ポート指定あり", "https://race.netkeiba.com:8443/x"],
    ["ユーザー情報あり", `https://user:pw${AT}race.netkeiba.com/x`],
    ["URL として読めない", "not a url"],
  ])("接続しない: %s", async (_label, url) => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    const error = await rejection(createSocketFetcher(c.connect)(url));
    expect(error).toBeInstanceOf(SocketFetchError);
    expect((error as SocketFetchError).kind).toBe("malformed");
    expect(c.calls).toHaveLength(0);
  });
});

describe("応答の読み取り(AC-3)", () => {
  it("Content-Length の本文・ステータス・content-type を返す", async () => {
    const c = connector(() => ({
      chunks: [response("HTTP/1.1 200 OK\nContent-Type: text/html; charset=UTF-8\nContent-Length: 5", bytes("hello"))],
    }));
    const r = await createSocketFetcher(c.connect)(URL_RACE);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html; charset=UTF-8");
    expect(new TextDecoder().decode(r.body)).toBe("hello");
  });

  it("content-type が無ければ null", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    expect((await createSocketFetcher(c.connect)(URL_RACE)).contentType).toBeNull();
  });

  it("小さな断片(7バイトずつ)に分かれて届いても、chunked の本文を正しくつなぐ", async () => {
    const body = bytes("abcdefghij".repeat(10));
    const chunked = concat(
      response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked"),
      ...split(body, 30).flatMap((p) => [bytes(`${p.length.toString(16)}\r\n`), p, bytes("\r\n")]),
      bytes("0\r\n\r\n"),
    );
    const c = connector(() => ({ chunks: split(chunked, 7) }));
    const r = await createSocketFetcher(c.connect)(URL_RACE);
    expect(new TextDecoder().decode(r.body)).toBe("abcdefghij".repeat(10));
  });

  it("長さの指定が無ければ EOF までを本文とする", async () => {
    const c = connector(() => ({ chunks: split(response("HTTP/1.1 200 OK", bytes("until close")), 5) }));
    expect(new TextDecoder().decode((await createSocketFetcher(c.connect)(URL_RACE)).body)).toBe("until close");
  });

  it("本文はバイトのまま返す(EUC-JP のバイト列を壊さない)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 2", new Uint8Array([0xa4, 0xa2]))] }));
    expect([...(await createSocketFetcher(c.connect)(URL_RACE)).body]).toEqual([0xa4, 0xa2]);
  });

  it("途中で切断された応答(Content-Length に足りない・chunked が途中・ヘッダが終わらない)は、成功にせず malformed にする", async () => {
    for (const chunks of [
      [response("HTTP/1.1 200 OK\nContent-Length: 10", bytes("hello"))],
      [response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked", bytes("5\r\nhel"))],
      [bytes("HTTP/1.1 200 OK\r\nContent-Le")],
      [],
    ]) {
      const c = connector(() => ({ chunks }));
      const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
      expect((error as SocketFetchError).kind).toBe("malformed");
      expect(c.sockets[0]!.state.closeCalls).toBe(1);
    }
  });

  it("ステータスが 600 以上の応答は malformed にする", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 999 X\nContent-Length: 0")] }));
    expect(((await rejection(createSocketFetcher(c.connect)(URL_RACE))) as SocketFetchError).kind).toBe("malformed");
  });

  it("サイズ上限: ちょうど上限の受信は通り、1バイト超えたら too-large で読むのをやめて打ち切る", async () => {
    const head = response("HTTP/1.1 200 OK\nContent-Length: 100");
    const max = head.length + 100;
    const body = new Uint8Array(100);
    const okC = connector(() => ({ chunks: [head, body] }));
    expect((await createSocketFetcher(okC.connect, { maxBytes: max })(URL_RACE)).body.length).toBe(100);

    const ngC = connector(() => ({ chunks: [head, body, bytes("x")], neverEnd: true }));
    const error = await rejection(createSocketFetcher(ngC.connect, { maxBytes: max })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("too-large");
    expect(ngC.sockets[0]!.state.cancelled).toBe(true);
    expect(ngC.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("既定の上限は 2 MiB、タイムアウトは 20 秒", () => {
    expect(SOCKET_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SOCKET_TIMEOUT_MS).toBe(20_000);
  });

  it("タイムアウト: 終わらない読み取りを打ち切り、timeout にしてソケットを閉じる", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 100", bytes("part"))], neverEnd: true }));
    const error = await rejection(createSocketFetcher(c.connect, { timeoutMs: 30 })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("timeout");
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
    expect(c.sockets[0]!.state.cancelled).toBe(true);
  });

  it("接続が確立しない(opened が決着しない)場合もタイムアウトで打ち切る", async () => {
    const c = connector(() => ({ opened: new Promise(() => {}) }));
    const error = await rejection(createSocketFetcher(c.connect, { timeoutMs: 30 })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("timeout");
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });
});

describe("失敗の分類と後始末", () => {
  it("接続の失敗(opened の拒否)・書き込みの失敗・読み取りの失敗は network にし、いずれもソケットを閉じる", async () => {
    for (const make of [
      (): FakeOptions => ({ opened: Promise.reject(new Error("接続できない")) }),
      (): FakeOptions => ({ writeError: new Error("書けない") }),
      (): FakeOptions => ({ readError: new Error("読めない") }),
    ]) {
      const c = connector(make);
      const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
      expect(error).toBeInstanceOf(SocketFetchError);
      expect((error as SocketFetchError).kind).toBe("network");
      expect(c.sockets[0]!.state.closeCalls).toBe(1);
    }
  });

  it("成功したときもソケットを閉じる", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    await createSocketFetcher(c.connect)(URL_RACE);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("接続が同期的に例外を投げても network にする", async () => {
    const connect: ConnectFn = () => {
      throw new Error("connect が投げた");
    };
    const error = await rejection(createSocketFetcher(connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("network");
  });
});

describe("取らないもの(AC-4)", () => {
  it("リダイレクト(3xx)には従わず、1回の呼び出しで接続は1回。ステータスとそのままの本文を返す", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 302 Found\nLocation: https://evil.example/\nContent-Length: 3", bytes("moo"))] }));
    const r = await createSocketFetcher(c.connect)(URL_RACE);
    expect(r.status).toBe(302);
    expect(c.calls).toHaveLength(1);
  });

  it.each([[500], [502], [503], [429], [403]])("HTTP %i でも再試行しない(接続は1回)", async (status) => {
    const c = connector(() => ({ chunks: [response(`HTTP/1.1 ${status} X\nContent-Length: 0`)] }));
    const r = await createSocketFetcher(c.connect)(URL_RACE);
    expect(r.status).toBe(status);
    expect(c.calls).toHaveLength(1);
  });

  it("失敗(切断・タイムアウト)でも再試行しない(接続は1回)", async () => {
    const c = connector(() => ({ chunks: [] }));
    await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect(c.calls).toHaveLength(1);
  });
});

describe("圧縮された応答(AC-5)", () => {
  it.each([
    [403, "gzip"],
    [429, "br"],
    [200, "gzip"],
  ])("content-encoding が identity 以外なら unsupported-encoding にし、受信済みの status(%i)を持つ(%s)", async (status, coding) => {
    const c = connector(() => ({ chunks: [response(`HTTP/1.1 ${status} X\nContent-Encoding: ${coding}\nContent-Length: 3`, bytes("xyz"))] }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect(error).toBeInstanceOf(SocketFetchError);
    expect((error as SocketFetchError).kind).toBe("unsupported-encoding");
    expect((error as SocketFetchError).status).toBe(status);
    expect(c.sockets[0]!.state.closeCalls).toBe(1);
  });

  it("identity と、空の content-encoding は通す(大文字小文字は区別しない)", async () => {
    for (const value of ["identity", "IDENTITY", ""]) {
      const c = connector(() => ({ chunks: [response(`HTTP/1.1 200 OK\nContent-Encoding: ${value}\nContent-Length: 2`, bytes("ok"))] }));
      expect((await createSocketFetcher(c.connect)(URL_RACE)).status).toBe(200);
    }
  });
});

describe("後始末が決着しなくても詰まらない(段階2b 記録1)", () => {
  /** close()・reader.cancel() が決着しない偽ソケット。 */
  function hangingCleanup(chunks: Uint8Array[], neverEnd = false): Connected {
    return connector(() => ({ chunks, neverEnd }));
  }

  it("socket.close() が決着しなくても、成功した取得の結果は有限時間で返る(直列区間を塞がない)", async () => {
    const c = hangingCleanup([OK_BODY]);
    const original = c.connect;
    const wrapped: ConnectFn = (address, options) => {
      const socket = original(address, options);
      return { ...socket, close: () => new Promise<void>(() => {}) };
    };
    const started = Date.now();
    const r = await createSocketFetcher(wrapped, { cleanupTimeoutMs: 50 })(URL_RACE);
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reader.cancel() が決着しなくても、失敗(タイムアウト)は有限時間で返り、種類は timeout のまま", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 100", bytes("part"))], neverEnd: true }));
    const original = c.connect;
    const wrapped: ConnectFn = (address, options) => {
      const socket = original(address, options);
      const stuck = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(response("HTTP/1.1 200 OK\nContent-Length: 100", bytes("part")));
          return new Promise<void>(() => {});
        },
        cancel: () => new Promise<void>(() => {}),
      });
      return { ...socket, readable: stuck, close: () => new Promise<void>(() => {}) };
    };
    const started = Date.now();
    const error = await rejection(createSocketFetcher(wrapped, { timeoutMs: 30, cleanupTimeoutMs: 50 })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("後始末の上限の既定は数秒(3 秒)", () => {
    expect(SOCKET_CLEANUP_TIMEOUT_MS).toBe(3000);
  });

  it("後始末が失敗(拒否)しても、取得の結果を隠さない", async () => {
    const c = connector(() => ({ chunks: [OK_BODY] }));
    const original = c.connect;
    const wrapped: ConnectFn = (address, options) => ({ ...original(address, options), close: () => Promise.reject(new Error("close 失敗")) });
    expect((await createSocketFetcher(wrapped)(URL_RACE)).status).toBe(200);
  });
});

describe("複数・複合の圧縮指定(段階2b 記録2)", () => {
  it.each([
    ["Content-Encoding が 2 行(identity の後に gzip)", "Content-Encoding: identity\nContent-Encoding: gzip"],
    ["Content-Encoding が 2 行(gzip の後に identity)", "Content-Encoding: gzip\nContent-Encoding: identity"],
    ["Content-Encoding がカンマ区切り(identity, gzip)", "Content-Encoding: identity, gzip"],
    ["Content-Encoding がカンマ区切り(gzip, identity)", "Content-Encoding: gzip, identity"],
  ])("identity 以外が 1 つでもあれば unsupported-encoding(受信済みの status を持つ): %s", async (_label, headers) => {
    const c = connector(() => ({ chunks: [response(`HTTP/1.1 403 X\n${headers}\nContent-Length: 2`, bytes("ok"))] }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("unsupported-encoding");
    expect((error as SocketFetchError).status).toBe(403);
  });

  it("Content-Encoding が identity だけなら、複数行・カンマ区切りでも通る", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Encoding: identity\nContent-Encoding: identity, identity\nContent-Length: 2", bytes("ok"))] }));
    expect((await createSocketFetcher(c.connect)(URL_RACE)).status).toBe(200);
  });

  it.each([
    ["gzip, chunked(chunked は解けるが gzip は解けない)", "gzip, chunked", "2\r\nok\r\n0\r\n\r\n"],
    ["Transfer-Encoding が 2 行(gzip の後に chunked)", "gzip\nTransfer-Encoding: chunked", "2\r\nok\r\n0\r\n\r\n"],
    ["gzip だけ(Content-Length で切り出される)", "gzip", "ok"],
    ["deflate, chunked", "deflate, chunked", "2\r\nok\r\n0\r\n\r\n"],
  ])("Transfer-Encoding に chunked 以外のコーディングがあれば、受信済みの status 付きの unsupported-encoding: %s", async (_label, value, body) => {
    const head = value.includes("\n") ? `HTTP/1.1 429 X\nTransfer-Encoding: ${value}` : `HTTP/1.1 429 X\nTransfer-Encoding: ${value}\nContent-Length: 2`;
    const c = connector(() => ({ chunks: [response(head, bytes(body))] }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("unsupported-encoding");
    expect((error as SocketFetchError).status).toBe(429);
  });

  it("Transfer-Encoding: chunked だけなら通る(対照)", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked", bytes("2\r\nok\r\n0\r\n\r\n"))] }));
    expect((await createSocketFetcher(c.connect)(URL_RACE)).status).toBe(200);
  });
});

describe("本文の扱いで失敗しても、読めたステータスを持たせる(段階2b 記録3)", () => {
  it.each([
    ["Content-Length に足りない(途中で切断)", [response("HTTP/1.1 403 X\nContent-Length: 10", bytes("hello"))], "malformed"],
    ["chunked が途中", [response("HTTP/1.1 403 X\nTransfer-Encoding: chunked", bytes("5\r\nhel"))], "malformed"],
  ])("%s → malformed でも status 403 を持つ", async (_label, chunks, kind) => {
    const c = connector(() => ({ chunks }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe(kind);
    expect((error as SocketFetchError).status).toBe(403);
  });

  it("サイズ上限の超過(ステータス行は受信済み)→ too-large でも status を持つ", async () => {
    const head = response("HTTP/1.1 429 X\nContent-Length: 100");
    const c = connector(() => ({ chunks: [head, new Uint8Array(200)], neverEnd: true }));
    const error = await rejection(createSocketFetcher(c.connect, { maxBytes: head.length + 100 })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("too-large");
    expect((error as SocketFetchError).status).toBe(429);
  });

  it("本文の途中でタイムアウトしても、読めた status を持つ", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 503 X\nContent-Length: 100", bytes("part"))], neverEnd: true }));
    const error = await rejection(createSocketFetcher(c.connect, { timeoutMs: 30 })(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("timeout");
    expect((error as SocketFetchError).status).toBe(503);
  });

  it("本文の途中で読み取りが失敗しても、読めた status を持つ", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 200 OK\nContent-Length: 100", bytes("part"))], readError: new Error("切れた") }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("network");
    expect((error as SocketFetchError).status).toBe(200);
  });

  it("ステータス行が読めるところまで受信していなければ、status は持たない(前提: 上の status は受信から読んだもの)", async () => {
    for (const chunks of [[], [bytes("HTTP/1.1 40")], [bytes("garbage without crlf")]]) {
      const c = connector(() => ({ chunks }));
      const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
      expect((error as SocketFetchError).status).toBeUndefined();
    }
  });

  it("ステータス行が 1xx・不正な値なら、status は持たない", async () => {
    const c = connector(() => ({ chunks: [response("HTTP/1.1 100 Continue\nContent-Length: 0")] }));
    const error = await rejection(createSocketFetcher(c.connect)(URL_RACE));
    expect((error as SocketFetchError).kind).toBe("malformed");
    expect((error as SocketFetchError).status).toBeUndefined();
  });

  it("接続の失敗(受信なし)は status を持たない", async () => {
    const c = connector(() => ({ opened: Promise.reject(new Error("接続できない")) }));
    expect(((await rejection(createSocketFetcher(c.connect)(URL_RACE))) as SocketFetchError).status).toBeUndefined();
  });
});
