import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../packages/core/src/scraper/http-client.js";
import { parseHorseResults } from "../../packages/core/src/scraper/parse-horse-results.js";
import { parseRaceId } from "../../packages/core/src/scraper/ids.js";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba.js";
import { shutubaUrl } from "../../packages/core/src/scraper/urls.js";
import { fetchGradeWinnerEntries } from "../../packages/core/src/scraper/fetch-grade-winner.js";
import { gradeWinnerApiUrl, gradeWinnerOriginUrl, gradeWinnerRefererUrl } from "../../packages/core/src/scraper/urls.js";
import { createGateFetch, createGateHttpClient, GateRefusedError, type GateLike } from "../src/gate-fetch";
import type { GatePostRequest } from "../src/gate-core";
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

  it("GET に本文は付けられず、GET・POST 以外のメソッドも、ゲートを呼ばずに拒否する(POST は許可リストに合うものだけ。下の describe)", async () => {
    const gate = fakeGate(() => response(new Uint8Array()));
    const fetchLike = createGateFetch(gate);
    await expect(fetchLike("https://race.netkeiba.com/x", { body: "a=b" })).rejects.toThrow(/GET/);
    await expect(fetchLike("https://race.netkeiba.com/x", { method: "GET", body: "a=b" })).rejects.toThrow(/GET/);
    await expect(fetchLike("https://race.netkeiba.com/x", { method: "PUT", body: "a=b" })).rejects.toThrow(/メソッド/);
    await expect(fetchLike("https://race.netkeiba.com/x", { method: "DELETE" })).rejects.toThrow(/メソッド/);
    // 許可リストに合わない POST(宛先・ヘッダ・本文の形が違う)も、ゲートを呼ばない。
    await expect(fetchLike("https://race.netkeiba.com/x", { method: "POST", body: "a=b" })).rejects.toThrow(/POST/);
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

describe("createGateFetch の POST(Issue #181。重賞の過去10年傾向の API)", () => {
  const RACE_ID = parseRaceId("202603020211");
  const NAR_ID = parseRaceId("202644070111");
  const POST_URL = gradeWinnerApiUrl(RACE_ID);
  const BODY = "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202603020211";
  const HEADERS = {
    "User-Agent": "keiba-ev-tool/0.1",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: gradeWinnerRefererUrl(RACE_ID),
    Origin: gradeWinnerOriginUrl(RACE_ID),
  };

  function postGate(handler: (request: GatePostRequest, call: number) => GateResult = () => response(new Uint8Array([111, 107]))) {
    const requests: GatePostRequest[] = [];
    const urls: string[] = [];
    const gate: GateLike = {
      fetchRaw: async (url) => {
        urls.push(url);
        return response(new Uint8Array());
      },
      postRaw: async (request) => {
        requests.push(request);
        return handler(request, requests.length);
      },
    };
    return { gate, requests, urls };
  }

  it("前提: core が組み立てる URL・Referer・Origin(中央)は、ここで使う文字列と同じ", () => {
    expect(POST_URL).toBe("https://race.netkeiba.com/race_api/");
    expect(HEADERS.Referer).toBe("https://race.netkeiba.com/race/past10.html?race_id=202603020211");
    expect(HEADERS.Origin).toBe("https://race.netkeiba.com");
  });

  it("許可リストに合う POST は postRaw へ渡す: 宛先・Referer・Origin・本文だけ(User-Agent などのヘッダは渡さない)。応答は FetchResponse にする", async () => {
    const { gate, requests, urls } = postGate();
    const r = await createGateFetch(gate)(POST_URL, { method: "POST", headers: HEADERS, body: BODY });
    expect(requests).toEqual([{ url: POST_URL, referer: HEADERS.Referer, origin: HEADERS.Origin, body: BODY }]);
    expect(urls).toHaveLength(0); // GET の口は使わない
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([111, 107]);
  });

  it("ヘッダ名の大文字小文字は区別しない。User-Agent は付けても付けなくてもよい", async () => {
    const { gate, requests } = postGate();
    const lower = { "content-type": HEADERS["Content-Type"], "x-requested-with": HEADERS["X-Requested-With"], referer: HEADERS.Referer, origin: HEADERS.Origin };
    await createGateFetch(gate)(POST_URL, { method: "POST", headers: lower, body: BODY });
    expect(requests).toHaveLength(1);
  });

  it("地方(nar.netkeiba.com。past5.html)の POST も通す", async () => {
    const { gate, requests } = postGate();
    const narBody = BODY.replace("202603020211", "202644070111");
    await createGateFetch(gate)(gradeWinnerApiUrl(NAR_ID), {
      method: "POST",
      headers: { ...HEADERS, Referer: gradeWinnerRefererUrl(NAR_ID), Origin: gradeWinnerOriginUrl(NAR_ID) },
      body: narBody,
    });
    expect(requests.map((r) => r.url)).toEqual(["https://nar.netkeiba.com/race_api/"]);
    expect(requests[0]!.referer).toBe("https://nar.netkeiba.com/race/past5.html?race_id=202644070111");
  });

  it.each<[string, Record<string, string>, string | undefined, string]>([
    ["Origin が無い", { "Content-Type": HEADERS["Content-Type"], "X-Requested-With": HEADERS["X-Requested-With"], Referer: HEADERS.Referer }, BODY, "Origin"],
    ["Referer が無い", { "Content-Type": HEADERS["Content-Type"], "X-Requested-With": HEADERS["X-Requested-With"], Origin: HEADERS.Origin }, BODY, "Referer"],
    ["Content-Type が無い", { "X-Requested-With": HEADERS["X-Requested-With"], Referer: HEADERS.Referer, Origin: HEADERS.Origin }, BODY, "Content-Type"],
    ["X-Requested-With が無い", { "Content-Type": HEADERS["Content-Type"], Referer: HEADERS.Referer, Origin: HEADERS.Origin }, BODY, "X-Requested-With"],
    ["余計なヘッダ(X-Evil)", { ...HEADERS, "X-Evil": "1" }, BODY, "X-Evil"],
    ["Cookie を足す", { ...HEADERS, Cookie: "a=b" }, BODY, "Cookie"],
    ["Content-Length を足す(組み立て側が付ける)", { ...HEADERS, "Content-Length": "87" }, BODY, "Content-Length"],
    ["Content-Type の値が違う", { ...HEADERS, "Content-Type": "application/json" }, BODY, "Content-Type"],
    ["X-Requested-With の値が違う", { ...HEADERS, "X-Requested-With": "fetch" }, BODY, "X-Requested-With"],
    ["同じヘッダが大文字小文字違いで2つ", { ...HEADERS, "content-type": HEADERS["Content-Type"] }, BODY, "重複"],
    ["本文が無い", HEADERS, undefined, "本文"],
    ["本文の形が違う", HEADERS, "a=b", "本文"],
    ["Referer が別ホスト", { ...HEADERS, Referer: "https://example.com/race/past10.html?race_id=202603020211" }, BODY, "Referer"],
    ["Origin が別ホスト", { ...HEADERS, Origin: "https://nar.netkeiba.com" }, BODY, "Origin"],
  ])("ゲートを呼ばずに拒否する: %s", async (_label, headers, body, mention) => {
    const { gate, requests, urls } = postGate();
    const init = body === undefined ? { method: "POST", headers } : { method: "POST", headers, body };
    const error = await createGateFetch(gate)(POST_URL, init).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(mention);
    expect(requests).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });

  it("宛先が許可リスト外(db ホスト・別パス)の POST は、ヘッダが揃っていても、ゲートを呼ばずに拒否する", async () => {
    const { gate, requests } = postGate();
    const fetchLike = createGateFetch(gate);
    await expect(fetchLike("https://db.netkeiba.com/race_api/", { method: "POST", headers: HEADERS, body: BODY })).rejects.toThrow(/POST/);
    await expect(fetchLike("https://race.netkeiba.com/race_api/x", { method: "POST", headers: HEADERS, body: BODY })).rejects.toThrow(/POST/);
    expect(requests).toHaveLength(0);
  });

  it("postRaw を持たないゲートへの POST は、未対応として拒否する(GET の口へ流さない)", async () => {
    const urls: string[] = [];
    const gate: GateLike = { fetchRaw: async (url) => (urls.push(url), response(new Uint8Array())) };
    await expect(createGateFetch(gate)(POST_URL, { method: "POST", headers: HEADERS, body: BODY })).rejects.toThrow(/POST に対応していません/);
    expect(urls).toHaveLength(0);
  });

  it("ゲートの拒否(POST のブレーカー)は GateRefusedError(理由 post-blocked・解除時刻つき)になる", async () => {
    const { gate } = postGate(() => ({ kind: "refused", reason: "post-blocked", message: "止めています", blockedUntil: 999, retryAfterMs: 5 }));
    const error = await createGateFetch(gate)(POST_URL, { method: "POST", headers: HEADERS, body: BODY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateRefusedError);
    expect((error as GateRefusedError).reason).toBe("post-blocked");
    expect((error as GateRefusedError).blockedUntil).toBe(999);
  });
});

describe("fetchGradeWinnerEntries + createGateHttpClient(Issue #181。core の取得処理をそのまま通す)", () => {
  it("中央の重賞(fixture: grade_winner_202603020211)を POST で取得し、過去回を読める。ゲートに渡る指定は core が組み立てたもの", async () => {
    const json = fixtureText("grade_winner_202603020211.json");
    const requests: GatePostRequest[] = [];
    const gate: GateLike = {
      fetchRaw: async () => {
        throw new Error("GET は使わない");
      },
      postRaw: async (request) => {
        requests.push(request);
        return response(new TextEncoder().encode(json), { contentType: "text/html; charset=UTF-8" });
      },
    };
    const entries = await fetchGradeWinnerEntries(parseRaceId("202603020211"), { fetcher: createGateHttpClient(gate) });
    expect(requests).toEqual([
      {
        url: "https://race.netkeiba.com/race_api/",
        referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211",
        origin: "https://race.netkeiba.com",
        body: "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202603020211",
      },
    ]);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(10);
  });

  it("地方の重賞(fixture: grade_winner_nar_202644070111)は nar ホストへ POST する", async () => {
    const json = fixtureText("grade_winner_nar_202644070111.json");
    const requests: GatePostRequest[] = [];
    const gate: GateLike = {
      fetchRaw: async () => {
        throw new Error("GET は使わない");
      },
      postRaw: async (request) => {
        requests.push(request);
        return response(new TextEncoder().encode(json));
      },
    };
    const entries = await fetchGradeWinnerEntries(parseRaceId("202644070111"), { fetcher: createGateHttpClient(gate) });
    expect(requests.map((r) => r.url)).toEqual(["https://nar.netkeiba.com/race_api/"]);
    expect(entries).not.toBeNull();
  });

  it("対象データなし(fixture: grade_winner_ng_202602010607。status:NG)は null", async () => {
    const json = fixtureText("grade_winner_ng_202602010607.json");
    const gate: GateLike = { fetchRaw: async () => response(new Uint8Array()), postRaw: async () => response(new TextEncoder().encode(json)) };
    expect(await fetchGradeWinnerEntries(parseRaceId("202602010607"), { fetcher: createGateHttpClient(gate) })).toBeNull();
  });

  it("POST が 403 で拒否されたら HttpError(status 403)。再試行しない(ゲートへの呼び出しは 1 回)", async () => {
    let calls = 0;
    const gate: GateLike = {
      fetchRaw: async () => response(new Uint8Array()),
      postRaw: async () => (calls += 1, response(new Uint8Array(), { status: 403 })),
    };
    const error = await fetchGradeWinnerEntries(parseRaceId("202603020211"), { fetcher: createGateHttpClient(gate) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect(calls).toBe(1);
  });
});
