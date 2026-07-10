import { describe, expect, it, vi } from "vitest";

// net-fetch-adapter は electron の net.fetch を参照するためモックする。
// ここでは net.fetch を差し替え可能なスパイにして、アダプタがそれへ委譲することを検証する。
const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
}));

import {
  adaptNetResponse,
  createNetFetchAdapter,
  netFetchAdapter,
  toNetRequestInit,
  type NetFetch,
} from "../src/main/net-fetch-adapter.js";

/**
 * Electron の net.fetch が返す Web 標準 Response を模したフェイク。
 * arrayBuffer / text は this に依存する実装を模し、this 束縛の欠落を検出できるようにする。
 */
function makeFakeResponse(options: {
  status: number;
  contentType?: string;
  body?: string;
}): Response {
  const body = options.body ?? "";
  return {
    status: options.status,
    ok: options.status >= 200 && options.status < 300,
    headers: {
      get(this: unknown, name: string): string | null {
        return name.toLowerCase() === "content-type"
          ? (options.contentType ?? null)
          : null;
      },
    },
    async arrayBuffer(this: { _body: string }): Promise<ArrayBuffer> {
      // this を参照して束縛欠落を検出させる。
      return new TextEncoder().encode(this._body).buffer;
    },
    async text(this: { _body: string }): Promise<string> {
      return this._body;
    },
    _body: body,
  } as unknown as Response;
}

describe("toNetRequestInit(core の init を net.fetch の RequestInit へ変換)", () => {
  it("init 未指定なら空オブジェクトを返す", () => {
    expect(toNetRequestInit(undefined)).toEqual({});
  });

  it("headers / signal(GET系)をそのまま移送する", () => {
    const signal = new AbortController().signal;
    const headers = { "User-Agent": "test-agent" };
    const result = toNetRequestInit({ headers, signal });
    expect(result.headers).toBe(headers);
    expect(result.signal).toBe(signal);
    // 未指定の method / body は付与しない。
    expect(result.method).toBeUndefined();
    expect(result.body).toBeUndefined();
  });

  it("method / body / headers / signal(POST系)をすべて移送する", () => {
    const signal = new AbortController().signal;
    const result = toNetRequestInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
      signal,
    });
    expect(result.method).toBe("POST");
    expect(result.body).toBe('{"a":1}');
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    expect(result.signal).toBe(signal);
  });
});

describe("adaptNetResponse(Electron Response を core のレスポンス形へ適合)", () => {
  it("status / ok / headers.get を移送する", () => {
    const adapted = adaptNetResponse(
      makeFakeResponse({ status: 200, contentType: "text/html; charset=euc-jp" }),
    );
    expect(adapted.status).toBe(200);
    expect(adapted.ok).toBe(true);
    expect(adapted.headers.get("content-type")).toBe(
      "text/html; charset=euc-jp",
    );
    expect(adapted.headers.get("x-missing")).toBeNull();
  });

  it("arrayBuffer は元 Response に this 束縛したまま呼べる(束縛欠落しない)", async () => {
    const adapted = adaptNetResponse(
      makeFakeResponse({ status: 200, body: "あ" }),
    );
    const buf = Buffer.from(await adapted.arrayBuffer());
    expect(buf.toString("utf-8")).toBe("あ");
  });

  it("text は元 Response に this 束縛したまま呼べる(束縛欠落しない)", async () => {
    const adapted = adaptNetResponse(
      makeFakeResponse({ status: 429, body: "rate limited" }),
    );
    expect(adapted.ok).toBe(false);
    expect(await adapted.text()).toBe("rate limited");
  });
});

describe("createNetFetchAdapter(注入した net.fetch へ委譲するアダプタ)", () => {
  it("変換した init で net.fetch を呼び、レスポンスを適合して返す", async () => {
    const fake = makeFakeResponse({
      status: 200,
      contentType: "text/html",
      body: "hello",
    });
    const netFetch = vi.fn<NetFetch>(async () => fake);
    const adapter = createNetFetchAdapter(netFetch);

    const signal = new AbortController().signal;
    const response = await adapter("https://example.test/x", {
      headers: { "User-Agent": "ua" },
      signal,
    });

    expect(netFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = netFetch.mock.calls[0]!;
    expect(calledUrl).toBe("https://example.test/x");
    expect(calledInit).toMatchObject({
      headers: { "User-Agent": "ua" },
      signal,
    });
    expect(response.status).toBe(200);
    // GET系(FetchLike)呼び出しなので arrayBuffer で本文を確認する。
    expect(Buffer.from(await response.arrayBuffer()).toString("utf-8")).toBe(
      "hello",
    );
  });
});

describe("netFetchAdapter(既定エクスポート: electron の net.fetch を利用)", () => {
  it("electron の net.fetch へ委譲する", async () => {
    netFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ status: 204, body: "" }),
    );
    const response = await netFetchAdapter("https://example.test/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(netFetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
  });
});
