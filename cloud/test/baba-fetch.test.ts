import { describe, expect, it } from "vitest";

import { BabaFetchError } from "../src/baba-conditions";
import { BABA_MAX_BODY_BYTES, BABA_TIMEOUT_MS, babaUrlStatus, createBabaFetcher, type BabaFetchLike } from "../src/baba-fetch";

import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: 馬場の API を取りに行く部品(Worker の secret `BABA_API_URL` の検証と、1 回の GET)。
 * **実際の API には一切アクセスしない**: すべて注入した偽の fetch で確かめ、グローバルの `fetch` は呼ばれたら落ちるスタブにする。
 * 使う URL は架空のもの(`.invalid` は予約された存在しないドメイン)。
 */

const URL_OK = "https://baba.test.invalid/latest-sample";
installFetchTrap();

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fake(respond: (call: Call) => Promise<Response> | Response): { fetch: BabaFetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond({ url, init });
    },
  };
}

describe("secret の検証(babaUrlStatus)", () => {
  const cases: { name: string; raw: string | undefined; status: "absent" | "invalid" | "valid" }[] = [
    { name: "未登録", raw: undefined, status: "absent" },
    { name: "空文字", raw: "", status: "absent" },
    { name: "空白だけ", raw: "  \n", status: "absent" },
    { name: "https の URL", raw: URL_OK, status: "valid" },
    { name: "前後の空白・改行は取り除いて有効(貼り付けで付く)", raw: `  ${URL_OK}\n`, status: "valid" },
    { name: "クエリつきも有効", raw: `${URL_OK}?format=json`, status: "valid" },
    { name: "http は無効", raw: "http://baba.test.invalid/x", status: "invalid" },
    { name: "URL として読めない", raw: "baba latest", status: "invalid" },
    { name: "認証情報つきは無効", raw: `https://user:pw${"@"}baba.test.invalid/x`, status: "invalid" },
    { name: "ホストが無い", raw: "https://", status: "invalid" },
  ];
  for (const c of cases) {
    it(`${c.name} → ${c.status}`, () => {
      expect(babaUrlStatus(c.raw)).toBe(c.status);
    });
  }

  it("有効でなければ取得口を作らない(機能全体を止める)。有効なら作る", () => {
    expect(createBabaFetcher(undefined)).toBeUndefined();
    expect(createBabaFetcher("  ")).toBeUndefined();
    expect(createBabaFetcher("http://baba.test.invalid/x")).toBeUndefined();
    expect(createBabaFetcher(URL_OK)).toBeTypeOf("function");
  });
});

describe("1 回の GET", () => {
  it("成功: 渡された URL に GET を 1 回だけ送り、本文を返す。リダイレクトは追わない設定・タイムアウトの信号つき", async () => {
    const f = fake(() => new Response('{"ok":true}', { status: 200 }));
    const fetcher = createBabaFetcher(`  ${URL_OK}\n`, { fetch: f.fetch })!;
    expect(await fetcher()).toBe('{"ok":true}');
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(URL_OK);
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(call.init.headers)).toContain("application/json");
    expect(fetch).not.toHaveBeenCalled(); // グローバルの fetch(落ちるスタブ)は呼ばれていない
  });

  it("タイムアウトの既定は 10 秒、本文の上限は 256KB", () => {
    expect(BABA_TIMEOUT_MS).toBe(10_000);
    expect(BABA_MAX_BODY_BYTES).toBe(256 * 1024);
  });

  const statuses: { status: number; result: string }[] = [
    { status: 301, result: "redirect" },
    { status: 302, result: "redirect" },
    { status: 307, result: "redirect" },
    { status: 399, result: "redirect" },
    { status: 400, result: "http-400" },
    { status: 404, result: "http-404" },
    { status: 429, result: "http-429" },
    { status: 500, result: "http-500" },
    { status: 503, result: "http-503" },
  ];
  for (const c of statuses) {
    it(`HTTP ${c.status} → ${c.result}(再送しない: fetch は 1 回)`, async () => {
      const f = fake(() => new Response("body", { status: c.status, headers: c.status >= 300 && c.status < 400 ? { location: "https://elsewhere.test.invalid/" } : {} }));
      const fetcher = createBabaFetcher(URL_OK, { fetch: f.fetch })!;
      const error = await fetcher().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BabaFetchError);
      expect((error as BabaFetchError).result).toBe(c.result);
      expect(f.calls).toHaveLength(1);
    });
  }

  it("通信の失敗 → network。例外の文面(URL を含みうる)はエラーに残さない", async () => {
    const f = fake(() => {
      throw new TypeError(`fetch failed: ${URL_OK}`);
    });
    const error = (await createBabaFetcher(URL_OK, { fetch: f.fetch })!().catch((e: unknown) => e)) as BabaFetchError;
    expect(error).toBeInstanceOf(BabaFetchError);
    expect(error.result).toBe("network");
    expect(error.message).not.toContain("baba.test.invalid");
    expect(String(error.stack ?? "")).not.toContain("baba.test.invalid");
    expect(error.cause).toBeUndefined();
  });

  it("TimeoutError・AbortError → timeout", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const f = fake(() => {
        throw new DOMException("x", name);
      });
      const error = (await createBabaFetcher(URL_OK, { fetch: f.fetch })!().catch((e: unknown) => e)) as BabaFetchError;
      expect(error.result, name).toBe("timeout");
    }
  });

  it("応答が返らなければ、タイムアウトの信号で打ち切って timeout(1 回だけ)", async () => {
    const f = fake(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const fetcher = createBabaFetcher(URL_OK, { fetch: f.fetch, timeoutMs: 20 })!;
    const error = (await fetcher().catch((e: unknown) => e)) as BabaFetchError;
    expect(error).toBeInstanceOf(BabaFetchError);
    expect(error.result).toBe("timeout");
    expect(f.calls).toHaveLength(1);
  });

  it("本文の途中で止まっても、打ち切って timeout", async () => {
    const f = fake(({ init }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const fetcher = createBabaFetcher(URL_OK, { fetch: f.fetch, timeoutMs: 20 })!;
    const error = (await fetcher().catch((e: unknown) => e)) as BabaFetchError;
    expect(error.result).toBe("timeout");
  });

  it("本文の読み出しが失敗 → network", async () => {
    const f = fake(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("接続が切れた"));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const error = (await createBabaFetcher(URL_OK, { fetch: f.fetch })!().catch((e: unknown) => e)) as BabaFetchError;
    expect(error.result).toBe("network");
  });

  it("本文の上限: ちょうど上限は読める。1 バイトでも超えれば too-large(Content-Length が無くても、読みながら打ち切る)", async () => {
    const exact = "a".repeat(BABA_MAX_BODY_BYTES);
    const okFetcher = createBabaFetcher(URL_OK, { fetch: fake(() => new Response(exact, { status: 200 })).fetch })!;
    expect(await okFetcher()).toHaveLength(BABA_MAX_BODY_BYTES);

    const over = "a".repeat(BABA_MAX_BODY_BYTES + 1);
    const streamed = fake(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(over));
        controller.close();
      },
    }), { status: 200 }));
    const error = (await createBabaFetcher(URL_OK, { fetch: streamed.fetch })!().catch((e: unknown) => e)) as BabaFetchError;
    expect(error.result).toBe("too-large");
  });

  it("Content-Length が上限を超えていれば、本文を読まずに打ち切って too-large", async () => {
    let cancelled = false;
    const f = fake(() => {
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(BABA_MAX_BODY_BYTES + 1) } });
    });
    const error = (await createBabaFetcher(URL_OK, { fetch: f.fetch })!().catch((e: unknown) => e)) as BabaFetchError;
    expect(error.result).toBe("too-large");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
});

describe("BabaFetchError", () => {
  it("メッセージは固定の語(分類)だけで、元の例外・URL を持たない", () => {
    const e = new BabaFetchError("http-503");
    expect(e.result).toBe("http-503");
    expect(e.message).toContain("http-503");
    expect(e.name).toBe("BabaFetchError");
  });
});
