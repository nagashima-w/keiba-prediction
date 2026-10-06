import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../packages/core/src/scraper/http-client.js";
import { parseHorseResults } from "../../packages/core/src/scraper/parse-horse-results.js";
import { parseRaceId } from "../../packages/core/src/scraper/ids.js";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba.js";
import { shutubaUrl } from "../../packages/core/src/scraper/urls.js";
import { createGateFetch, createGateHttpClient, GateRefusedError, type GateLike } from "../src/gate-fetch";
import type { GateResult } from "../src/gate-core";

/**
 * Issue #162 段階2a: ゲートの `fetchRaw`(RPC)を core の `HttpClient` の fetch 注入口へ繋ぐアダプタ(`createGateFetch`)と、
 * `HttpClient` を正しい設定で作る `createGateHttpClient`。ゲートは偽(fixture のバイト列を返す)。実ネットワークには出ない。
 */

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const fixtureText = (name: string): string => readFileSync(`${FIXTURES}${name}`, "utf-8");
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

function response(body: Uint8Array, init: { status?: number; contentType?: string | null } = {}): GateResult {
  return {
    kind: "response",
    status: init.status ?? 200,
    contentType: init.contentType === undefined ? "text/html; charset=UTF-8" : init.contentType,
    body: toArrayBuffer(body),
    queuedMs: 0,
    elapsedMs: 1,
  };
}

function fakeGate(handler: (url: string, call: number) => GateResult): GateLike & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchRaw: async (url) => {
      urls.push(url);
      return handler(url, urls.length);
    },
  };
}

describe("createGateFetch", () => {
  it("応答を FetchResponse にする: ステータス・ok・content-type(大文字小文字を区別しない)・本文のバイト列", async () => {
    const gate = fakeGate(() => response(new Uint8Array([1, 2, 3]), { status: 200, contentType: "text/html; charset=EUC-JP" }));
    const r = await createGateFetch(gate)("https://race.netkeiba.com/x");
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.headers.get("content-type")).toBe("text/html; charset=EUC-JP");
    expect(r.headers.get("Content-Type")).toBe("text/html; charset=EUC-JP");
    expect(r.headers.get("x-other")).toBeNull();
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it.each([
    [199, false],
    [200, true],
    [299, true],
    [300, false],
    [404, false],
    [500, false],
  ])("ok は 2xx だけ: %i → %s", async (status, ok) => {
    const gate = fakeGate(() => response(new Uint8Array(), { status }));
    expect((await createGateFetch(gate)("https://race.netkeiba.com/x")).ok).toBe(ok);
  });

  it("content-type が無ければ null", async () => {
    const gate = fakeGate(() => response(new Uint8Array(), { contentType: null }));
    expect((await createGateFetch(gate)("https://race.netkeiba.com/x")).headers.get("content-type")).toBeNull();
  });

  it("ゲートの拒否は GateRefusedError(理由・メッセージ・解除時刻を持つ)として投げる", async () => {
    const gate = fakeGate(() => ({ kind: "refused", reason: "blocked", message: "止めています", blockedUntil: 123, retryAfterMs: 45 }));
    const error = await createGateFetch(gate)("https://race.netkeiba.com/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateRefusedError);
    expect((error as GateRefusedError).reason).toBe("blocked");
    expect((error as GateRefusedError).blockedUntil).toBe(123);
    expect((error as Error).message).toContain("止めています");
  });

  it("GET 以外(POST・本文つき)は、ゲートを呼ばずに拒否する", async () => {
    const gate = fakeGate(() => response(new Uint8Array()));
    const fetchLike = createGateFetch(gate);
    await expect(fetchLike("https://race.netkeiba.com/x", { method: "POST", body: "a=b" })).rejects.toThrow(/GET/);
    await expect(fetchLike("https://race.netkeiba.com/x", { body: "a=b" })).rejects.toThrow(/GET/);
    expect(gate.urls).toHaveLength(0);
    await fetchLike("https://race.netkeiba.com/x", { method: "GET" });
    expect(gate.urls).toHaveLength(1);
  });

  it("呼び出し側のヘッダはゲートへ渡さない(ゲートの入力は URL だけ。ヘッダは固定の集合)", async () => {
    const calls: unknown[][] = [];
    const gate: GateLike = {
      fetchRaw: async (...args: unknown[]) => {
        calls.push(args);
        return response(new Uint8Array());
      },
    };
    await createGateFetch(gate)("https://race.netkeiba.com/x", { headers: { "User-Agent": "other", "X-Evil": "1" } });
    expect(calls).toEqual([["https://race.netkeiba.com/x"]]);
  });
});

describe("createGateHttpClient(AC-13。core の HttpClient + ゲート)", () => {
  it("中央の出馬表(UTF-8)を取得し、parseShutuba で 16 頭を読める(fixture: shutuba_202603020211)", async () => {
    const html = fixtureText("shutuba_202603020211.html");
    const gate = fakeGate(() => response(new TextEncoder().encode(html)));
    const client = createGateHttpClient(gate);
    const raceId = parseRaceId("202603020211");
    const text = await client.fetchText(shutubaUrl(raceId));
    expect(gate.urls).toEqual(["https://race.netkeiba.com/race/shutuba.html?race_id=202603020211"]);
    expect(parseShutuba(text).horses).toHaveLength(16);
  });

  it("地方の出馬表(UTF-8)は nar のホストで取得し、12 頭を読める(fixture: nar_shutuba_202654071210)", async () => {
    const html = fixtureText("nar_shutuba_202654071210.html");
    const gate = fakeGate(() => response(new TextEncoder().encode(html)));
    const text = await createGateHttpClient(gate).fetchText(shutubaUrl(parseRaceId("202654071210")));
    expect(gate.urls[0]).toBe("https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210");
    expect(parseShutuba(text).horses).toHaveLength(12);
  });

  it("EUC-JP の本文は、content-type の charset に従って文字化けせずにデコードされる(往復)", async () => {
    const original = "馬名テスト アーモンドアイ";
    const bytes = new Uint8Array(iconv.encode(original, "euc-jp"));
    const gate = fakeGate(() => response(bytes, { contentType: "text/html; charset=EUC-JP" }));
    expect(await createGateHttpClient(gate).fetchText("https://db.netkeiba.com/horse/2021105857/")).toBe(original);
  });

  it("戦績 API の JSON(UTF-8)も、既存のパーサで読める(fixture: horse_results_2021105857)", async () => {
    const json = fixtureText("horse_results_2021105857.json");
    const gate = fakeGate(() => response(new TextEncoder().encode(json), { contentType: "application/json" }));
    const text = await createGateHttpClient(gate).fetchText("https://db.netkeiba.com/api/db_horse_results.html?id=2021105857", { encoding: "utf-8" });
    expect(parseHorseResults(text)).toHaveLength(23);
  });

  it("再試行しない: 5xx でもゲートへの呼び出しは 1 回で、HttpError(status 付き)になる", async () => {
    const gate = fakeGate(() => response(new Uint8Array(), { status: 503 }));
    const error = await createGateHttpClient(gate).fetchText("https://race.netkeiba.com/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(gate.urls).toHaveLength(1);
  });

  it.each([[400], [403], [404], [429]])("%i は HttpError(status 付き)で、ゲートへの呼び出しは 1 回", async (status) => {
    const gate = fakeGate(() => response(new Uint8Array(), { status }));
    const error = await createGateHttpClient(gate).fetchText("https://race.netkeiba.com/x").catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(status);
    expect(gate.urls).toHaveLength(1);
  });

  it("ゲートの拒否(ブレーカー・待ち行列など)は HttpError になり、理由が読める。再試行しない", async () => {
    const gate = fakeGate(() => ({ kind: "refused", reason: "blocked", message: "取得を止めています(あと 1800 秒)" }));
    const error = await createGateHttpClient(gate).fetchText("https://race.netkeiba.com/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as Error).message).toContain("取得を止めています");
    expect(gate.urls).toHaveLength(1);
  });

  it("HttpClient 側では間隔を空けない(間隔制御はゲートだけが行う。二重に待たない)", async () => {
    const gate = fakeGate(() => response(new Uint8Array([97])));
    const client = createGateHttpClient(gate);
    const started = Date.now();
    await client.fetchText("https://race.netkeiba.com/a");
    await client.fetchText("https://race.netkeiba.com/b");
    await client.fetchText("https://race.netkeiba.com/c");
    expect(gate.urls).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
