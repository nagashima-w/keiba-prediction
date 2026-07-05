import { afterEach, describe, expect, it, vi } from "vitest";
import iconv from "iconv-lite";
import {
  DEFAULT_USER_AGENT,
  HttpClient,
  HttpError,
  type FetchLike,
  type FetchResponse,
} from "../../src/scraper/http-client.js";

/**
 * テスト用の疑似レスポンスを生成するヘルパ。
 * body には文字列(UTF-8としてエンコード)または生のBufferを渡せる。
 */
function makeResponse(
  status: number,
  body: string | Buffer = "",
  contentType = "text/html",
): FetchResponse {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  const u8 = new Uint8Array(buf);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    arrayBuffer: async () => u8.buffer,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HttpClient", () => {
  describe("レート制限(リクエスト間隔)", () => {
    it("連続する2リクエストの発火間隔が最低1500ms空くこと", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const callTimes: number[] = [];
      const fetch: FetchLike = vi.fn(async () => {
        callTimes.push(Date.now());
        return makeResponse(200, "ok");
      });

      const client = new HttpClient({ fetch, minIntervalMs: 1500 });
      const p1 = client.fetchText("https://example.test/1");
      const p2 = client.fetchText("https://example.test/2");

      await vi.advanceTimersByTimeAsync(1600);
      await Promise.all([p1, p2]);

      expect(callTimes).toHaveLength(2);
      expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(1500);
    });

    it("並行に3リクエストを投げても各発火間隔が1500ms以上保たれること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const callTimes: number[] = [];
      const fetch: FetchLike = vi.fn(async () => {
        callTimes.push(Date.now());
        return makeResponse(200, "ok");
      });

      const client = new HttpClient({ fetch, minIntervalMs: 1500 });
      const ps = [
        client.fetchText("https://example.test/a"),
        client.fetchText("https://example.test/b"),
        client.fetchText("https://example.test/c"),
      ];

      await vi.advanceTimersByTimeAsync(5000);
      await Promise.all(ps);

      expect(callTimes).toHaveLength(3);
      expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(1500);
      expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(1500);
    });

    it("最初のリクエストは待たされずに即発火すること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const callTimes: number[] = [];
      const fetch: FetchLike = vi.fn(async () => {
        callTimes.push(Date.now());
        return makeResponse(200, "ok");
      });

      const client = new HttpClient({ fetch, minIntervalMs: 1500 });
      const p = client.fetchText("https://example.test/first");
      await vi.advanceTimersByTimeAsync(0);
      await p;

      expect(callTimes[0]).toBe(0);
    });
  });

  describe("User-Agent", () => {
    it("指定したUser-Agentがリクエストヘッダに付与されること", async () => {
      const fetch = vi.fn<FetchLike>(async () => makeResponse(200, "ok"));
      const client = new HttpClient({
        fetch,
        minIntervalMs: 0,
        userAgent: "MyUA/1.0",
      });

      await client.fetchText("https://example.test/x");

      expect(fetch).toHaveBeenCalledWith(
        "https://example.test/x",
        expect.objectContaining({
          headers: expect.objectContaining({ "User-Agent": "MyUA/1.0" }),
        }),
      );
    });

    it("未指定時はデフォルトの明示的なUser-Agentが使われること", async () => {
      const fetch = vi.fn<FetchLike>(async () => makeResponse(200, "ok"));
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await client.fetchText("https://example.test/x");

      expect(DEFAULT_USER_AGENT.length).toBeGreaterThan(0);
      const init = fetch.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    });
  });

  describe("エラー時の堅牢性", () => {
    it("4xxエラーはリトライせず即座にHttpErrorを投げ、statusを保持すること", async () => {
      const fetch = vi.fn<FetchLike>(async () => makeResponse(404, "not found"));
      const client = new HttpClient({ fetch, minIntervalMs: 0, maxRetries: 2 });

      await expect(
        client.fetchText("https://example.test/missing"),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        client.fetchText("https://example.test/missing"),
      ).rejects.toBeInstanceOf(HttpError);
      // 2回のテスト呼び出し分だけ(各1回=リトライなし)
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("5xxエラーはリトライし、上限到達で最終的に例外を投げること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetch = vi.fn<FetchLike>(async () => makeResponse(503, "busy"));
      const client = new HttpClient({ fetch, minIntervalMs: 0, maxRetries: 2 });

      const p = client.fetchText("https://example.test/flaky");
      const assertion = expect(p).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;

      // 初回1回 + リトライ2回 = 合計3回
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("一時的な5xxの後に成功すればテキストを返すこと(リトライ成功)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let n = 0;
      const fetch = vi.fn<FetchLike>(async () => {
        n += 1;
        return n < 2 ? makeResponse(503, "busy") : makeResponse(200, "recovered");
      });
      const client = new HttpClient({ fetch, minIntervalMs: 0, maxRetries: 2 });

      const p = client.fetchText("https://example.test/recover");
      await vi.advanceTimersByTimeAsync(10000);

      await expect(p).resolves.toBe("recovered");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("リトライ間もレート制限間隔(minIntervalMs)以上空けて再発火すること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const callTimes: number[] = [];
      let n = 0;
      const fetch = vi.fn<FetchLike>(async () => {
        callTimes.push(Date.now());
        n += 1;
        // 1回目は5xx、2回目で成功
        return n < 2 ? makeResponse(503, "busy") : makeResponse(200, "ok");
      });
      const client = new HttpClient({ fetch, minIntervalMs: 1500, maxRetries: 2 });

      const p = client.fetchText("https://example.test/retry-interval");
      await vi.advanceTimersByTimeAsync(5000);

      await expect(p).resolves.toBe("ok");
      expect(callTimes).toHaveLength(2);
      // リトライの再発火も minIntervalMs 以上空いていること
      expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(1500);
    });

    it("ネットワークエラー(fetchのreject)もリトライ対象となり、上限到達で例外を投げること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetch = vi.fn<FetchLike>(async () => {
        throw new Error("ECONNRESET");
      });
      const client = new HttpClient({ fetch, minIntervalMs: 0, maxRetries: 1 });

      const p = client.fetchText("https://example.test/down");
      const assertion = expect(p).rejects.toBeInstanceOf(HttpError);
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;

      // 初回1回 + リトライ1回 = 合計2回
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("リクエストタイムアウト", () => {
    it("応答が返らない場合はtimeoutMsで打ち切り、一時的エラーとしてリトライし上限で例外を投げること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      // 永遠に解決しないfetch(ボディ受信ハングを模倣)
      const fetch = vi.fn<FetchLike>(
        () => new Promise<FetchResponse>(() => {}),
      );
      const client = new HttpClient({
        fetch,
        minIntervalMs: 0,
        maxRetries: 1,
        timeoutMs: 30000,
      });

      const p = client.fetchBuffer("https://example.test/hang");
      const assertion = expect(p).rejects.toMatchObject({
        name: "HttpError",
      });
      // 初回タイムアウト(30s) + リトライのタイムアウト(30s)を消化
      await vi.advanceTimersByTimeAsync(70000);
      await assertion;
      await expect(p).rejects.toThrow(/タイムアウト/);

      // 初回1回 + リトライ1回 = 合計2回発火
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("タイムアウトの後に成功すればリトライ成功として値を返すこと", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let n = 0;
      const fetch = vi.fn<FetchLike>(() => {
        n += 1;
        // 1回目はハングさせタイムアウトを誘発、2回目は即成功
        return n < 2
          ? new Promise<FetchResponse>(() => {})
          : Promise.resolve(makeResponse(200, "recovered"));
      });
      const client = new HttpClient({
        fetch,
        minIntervalMs: 0,
        maxRetries: 1,
        timeoutMs: 30000,
      });

      const p = client.fetchText("https://example.test/slow");
      await vi.advanceTimersByTimeAsync(70000);

      await expect(p).resolves.toBe("recovered");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("タイムアウト打ち切り時にfetchへ渡したAbortSignalがabortされること", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let capturedSignal: AbortSignal | undefined;
      const fetch = vi.fn<FetchLike>((_url, init) => {
        capturedSignal = init?.signal;
        return new Promise<FetchResponse>(() => {});
      });
      const client = new HttpClient({
        fetch,
        minIntervalMs: 0,
        maxRetries: 0,
        timeoutMs: 30000,
      });

      const p = client.fetchBuffer("https://example.test/hang2");
      const assertion = expect(p).rejects.toThrow(/タイムアウト/);
      await vi.advanceTimersByTimeAsync(31000);
      await assertion;

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(true);
    });
  });

  describe("文字コードのデコード", () => {
    it("Content-Typeのcharset=euc-jpに従ってEUC-JPをデコードできること", async () => {
      const text = "テスト馬 東京優駿";
      const eucBytes = iconv.encode(text, "euc-jp");
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, eucBytes, "text/html; charset=euc-jp"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await expect(client.fetchText("https://db.netkeiba.test/horse")).resolves.toBe(
        text,
      );
    });

    it("Content-Typeのcharset=EUC-JP(大文字)も正しく処理できること", async () => {
      const text = "天皇賞 春";
      const eucBytes = iconv.encode(text, "euc-jp");
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, eucBytes, "text/html; charset=EUC-JP"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await expect(
        client.fetchText("https://db.netkeiba.test/upper"),
      ).resolves.toBe(text);
    });

    it("呼び出し側が指定したエンコーディングがContent-Typeより優先されること", async () => {
      const text = "菊花賞";
      const eucBytes = iconv.encode(text, "euc-jp");
      // Content-Typeはutf-8と偽っているが、呼び出し側指定のeuc-jpを優先する
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, eucBytes, "text/html; charset=utf-8"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await expect(
        client.fetchText("https://db.netkeiba.test/horse", { encoding: "euc-jp" }),
      ).resolves.toBe(text);
    });

    it("サポート外のcharset(shift_jis)検出時はconsole.warnで警告しつつUTF-8にフォールバックすること", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const text = "有馬記念";
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, text, "text/html; charset=shift_jis"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      // 挙動はUTF-8フォールバックのまま(bodyはUTF-8なので同じ文字列が返る)
      await expect(client.fetchText("https://example.test/sjis")).resolves.toBe(
        text,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("shift_jis");
    });

    it("charset未指定(フォールバック)では警告を出さないこと", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const text = "宝塚記念";
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, text, "text/html"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await expect(client.fetchText("https://example.test/nocs")).resolves.toBe(
        text,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("charset指定がない場合はUTF-8としてデコードすること", async () => {
      const text = "有馬記念";
      const fetch = vi.fn<FetchLike>(async () =>
        makeResponse(200, text, "text/html"),
      );
      const client = new HttpClient({ fetch, minIntervalMs: 0 });

      await expect(client.fetchText("https://example.test/utf8")).resolves.toBe(
        text,
      );
    });
  });

  describe("公開API(index.tsからの再エクスポート)", () => {
    it("HttpClientとHttpErrorがindexから再エクスポートされていること", async () => {
      const mod = await import("../../src/index.js");
      expect(mod.HttpClient).toBe(HttpClient);
      expect(mod.HttpError).toBe(HttpError);
    });
  });
});
