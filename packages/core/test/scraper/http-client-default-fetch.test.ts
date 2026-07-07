import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike, FetchResponse } from "../../src/scraper/http-client.js";

/**
 * undiciモジュールをモックし、fetch未注入時のデフォルト経路の挙動を検証する。
 *
 * 背景(実バグ):
 * undiciの素のfetchは HTTPS_PROXY / NO_PROXY 環境変数を自動では参照しない。
 * プロキシ必須環境では全リクエストが失敗するため、
 * デフォルト経路では EnvHttpProxyAgent を dispatcher として渡す必要がある。
 *
 * 実ネットワークは一切使わず、undiciのfetch/EnvHttpProxyAgentをモックで置き換えて検証する。
 */
const { fetchMock, EnvHttpProxyAgentMock, agentInstances } = vi.hoisted(() => {
  const agentInstances: unknown[] = [];
  class EnvHttpProxyAgentMock {
    constructor() {
      agentInstances.push(this);
    }
  }
  const fetchMock = vi.fn();
  return { fetchMock, EnvHttpProxyAgentMock, agentInstances };
});

vi.mock("undici", () => ({
  fetch: fetchMock,
  EnvHttpProxyAgent: EnvHttpProxyAgentMock,
}));

/** モックのundici fetchが返す最小限の疑似レスポンス。 */
function makeUndiciResponse(): FetchResponse {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

beforeEach(() => {
  // デフォルト経路のシングルトン(undiciモジュール/共有dispatcher)を毎回リセットする。
  vi.resetModules();
  agentInstances.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(makeUndiciResponse());
});

describe("HttpClientのデフォルトfetch経路(プロキシ対応)", () => {
  it("fetch未注入時、undiciのfetchにEnvHttpProxyAgentをdispatcherとして渡すこと", async () => {
    const { HttpClient } = await import("../../src/scraper/http-client.js");
    const client = new HttpClient({ minIntervalMs: 0 });

    await client.fetchText("https://example.test/proxy");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgentMock);
    // EnvHttpProxyAgentが実際に生成されていること
    expect(agentInstances).toHaveLength(1);
  });

  it("複数リクエストでもEnvHttpProxyAgentのインスタンスを1つだけ生成して再利用すること", async () => {
    const { HttpClient } = await import("../../src/scraper/http-client.js");
    const client = new HttpClient({ minIntervalMs: 0 });

    await client.fetchText("https://example.test/1");
    await client.fetchText("https://example.test/2");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // dispatcherはリクエストごとにnewせず、同一インスタンスを使い回すこと
    expect(agentInstances).toHaveLength(1);
    const d1 = (fetchMock.mock.calls[0]![1] as { dispatcher?: unknown }).dispatcher;
    const d2 = (fetchMock.mock.calls[1]![1] as { dispatcher?: unknown }).dispatcher;
    expect(d1).toBe(d2);
  });

  it("別のHttpClientインスタンス間でもdispatcherをプロセス内で共有すること", async () => {
    const { HttpClient } = await import("../../src/scraper/http-client.js");
    const clientA = new HttpClient({ minIntervalMs: 0 });
    const clientB = new HttpClient({ minIntervalMs: 0 });

    await clientA.fetchText("https://example.test/a");
    await clientB.fetchText("https://example.test/b");

    expect(agentInstances).toHaveLength(1);
    const d1 = (fetchMock.mock.calls[0]![1] as { dispatcher?: unknown }).dispatcher;
    const d2 = (fetchMock.mock.calls[1]![1] as { dispatcher?: unknown }).dispatcher;
    expect(d1).toBe(d2);
  });

  it("User-AgentヘッダとAbortSignalはデフォルト経路でもfetchに引き継がれること", async () => {
    const { HttpClient } = await import("../../src/scraper/http-client.js");
    const client = new HttpClient({ minIntervalMs: 0, userAgent: "UA/9.9" });

    await client.fetchText("https://example.test/headers");

    const init = fetchMock.mock.calls[0]![1] as {
      headers?: Record<string, string>;
      signal?: unknown;
    };
    expect(init.headers?.["User-Agent"]).toBe("UA/9.9");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("注入fetch経路はundiciのfetch/EnvHttpProxyAgentを一切使わず、dispatcherにも触れないこと", async () => {
    const { HttpClient } = await import("../../src/scraper/http-client.js");
    const injected = vi.fn<FetchLike>(async () => makeUndiciResponse());
    const client = new HttpClient({ fetch: injected, minIntervalMs: 0 });

    await client.fetchText("https://example.test/injected");

    // 注入fetchが使われ、undiciのfetchは呼ばれない
    expect(injected).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentInstances).toHaveLength(0);
    const init = injected.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });
});
