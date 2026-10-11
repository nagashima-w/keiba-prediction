import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT } from "../../packages/core/src/scraper/http-client.js";
import { ECHO_SERVICES, ECHO_URLS, isEchoService } from "../cloudflare-spike/echo-targets.js";
import {
  computeHeaderDiff,
  deriveSocketHeaders,
  maskHeaderValue,
  maskText,
  parseEchoObservation,
  selectE2Headers,
  STATIC_SOCKET_HEADERS,
  type EchoFetchResult,
  type EchoObservation,
} from "../cloudflare-spike/echo.js";

/**
 * #160 E1(ヘッダの観測)の純ロジック: エコー応答のパース・ヘッダ差分・E2/E3 のヘッダ集合の導出・
 * 公開される記録へのマスク。フィクスチャは実際の tls.peet.ws / httpbin.org の応答(IP は文書用の値に置換済み)。
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cloudflare-spike");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

function fetched(text: string, over: Partial<EchoFetchResult> = {}): EchoFetchResult {
  return { status: 200, bodyText: text, responseHeaders: {}, error: null, ...over };
}

function obs(over: Partial<EchoObservation> = {}): EchoObservation {
  return {
    service: "peet",
    ok: true,
    status: 200,
    httpVersion: "HTTP/1.1",
    tlsJa3Hash: null,
    tlsJa4: null,
    h2Fingerprint: null,
    headers: [],
    cloudflareHosted: false,
    error: null,
    ...over,
  };
}

describe("エコーの宛先(固定表)", () => {
  it("2つだけで、どちらも https の固定 URL(任意の URL へのプロキシにならない)", () => {
    expect([...ECHO_SERVICES].sort()).toEqual(["httpbin", "peet"]);
    expect(ECHO_URLS.peet).toBe("https://tls.peet.ws/api/all");
    expect(ECHO_URLS.httpbin).toBe("https://httpbin.org/headers");
  });

  it("Cloudflare 上のエコー(postman-echo.com)は含めない", () => {
    expect(Object.values(ECHO_URLS).join(" ")).not.toContain("postman-echo");
  });

  it.each([
    ["peet", true],
    ["httpbin", true],
    ["postman", false],
    ["", false],
    [undefined, false],
    [{ toString: (): string => "peet" }, false],
  ])("isEchoService(%j) は %s", (value, expected) => {
    expect(isEchoService(value)).toBe(expected);
  });
});

describe("parseEchoObservation: tls.peet.ws", () => {
  it("HTTP/1.1: ヘッダを順序・大文字小文字のまま取り、TLS の指紋を取る", () => {
    const o = parseEchoObservation("peet", fetched(fixture("echo-peet-h1.json")));
    expect(o.ok).toBe(true);
    expect(o.httpVersion).toBe("HTTP/1.1");
    expect(o.headers).toEqual([
      { name: "Host", value: "tls.peet.ws" },
      { name: "User-Agent", value: "curl/8.5.0" },
      { name: "Accept", value: "*/*" },
    ]);
    expect(o.tlsJa4).toMatch(/^t13d\d+h1_/);
    expect(o.tlsJa3Hash).toMatch(/^[0-9a-f]{32}$/);
    expect(o.h2Fingerprint).toBeNull();
  });

  it("HTTP/2: HEADERS フレームから取り、疑似ヘッダ(:method 等)は除く。Akamai 指紋も取る", () => {
    const o = parseEchoObservation("peet", fetched(fixture("echo-peet-h2.json")));
    expect(o.ok).toBe(true);
    expect(o.httpVersion).toBe("h2");
    expect(o.headers).toEqual([
      { name: "user-agent", value: "curl/8.5.0" },
      { name: "accept", value: "*/*" },
      { name: "accept-encoding", value: "identity" },
    ]);
    expect(o.tlsJa4).toMatch(/^t13d\d+h2_/);
    expect(o.h2Fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("送信元 IP(ip フィールド)は観測に含めない", () => {
    const o = parseEchoObservation("peet", fetched(fixture("echo-peet-h1.json")));
    expect(JSON.stringify(o)).not.toContain("203.0.113.7");
  });

  it.each([
    ["HTTP 403", fetched("forbidden", { status: 403 }), /403/],
    ["JSON でない", fetched("<html>"), /JSON/],
    ["ヘッダが無い JSON", fetched("{}"), /ヘッダ/],
    ["fetch が例外", fetched("", { status: null, bodyText: null, error: "boom" }), /boom/],
  ])("失敗(%s)は ok=false で、理由を error に残す", (_name, f, pattern) => {
    const o = parseEchoObservation("peet", f);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(pattern);
    expect(o.headers).toEqual([]);
  });
});

describe("parseEchoObservation: httpbin.org", () => {
  it("ヘッダの名前と値を取る。HTTP バージョンと TLS は観測できない(null)", () => {
    const o = parseEchoObservation("httpbin", fetched(fixture("echo-httpbin.json")));
    expect(o.ok).toBe(true);
    expect(o.httpVersion).toBeNull();
    expect(o.tlsJa4).toBeNull();
    expect(o.tlsJa3Hash).toBeNull();
    expect(o.headers.map((h) => h.name)).toEqual(["Accept", "Host", "User-Agent", "X-Amzn-Trace-Id"]);
  });

  it("ヘッダ値が文字列でないものは無視せず失敗にする", () => {
    const o = parseEchoObservation("httpbin", fetched('{"headers":{"A":1}}'));
    expect(o.ok).toBe(false);
  });
});

describe("parseEchoObservation: エコーが Cloudflare 上にあるかの警告", () => {
  it.each([
    ["cf-ray あり", { "cf-ray": "abc-IAD" }, true],
    ["server: cloudflare", { server: "cloudflare" }, true],
    ["server: Cloudflare(大文字)", { server: "Cloudflare" }, true],
    ["どちらも無い", { server: "gunicorn/19.9.0" }, false],
    ["ヘッダ自体が無い", {}, false],
  ])("%s なら cloudflareHosted=%s", (_name, responseHeaders, expected) => {
    expect(parseEchoObservation("httpbin", fetched(fixture("echo-httpbin.json"), { responseHeaders })).cloudflareHosted).toBe(expected);
  });
});

describe("computeHeaderDiff(Worker とランナーのヘッダ差)", () => {
  const worker = [
    { name: "user-agent", value: "ua" },
    { name: "accept-encoding", value: "br, gzip" },
    { name: "cf-connecting-ip", value: "198.51.100.9" },
    { name: "cf-worker", value: "example.workers.dev" },
    { name: "x-real-ip", value: "198.51.100.9" },
  ];
  const runner = [
    { name: "Host", value: "x" },
    { name: "User-Agent", value: "ua" },
    { name: "accept", value: "*/*" },
    { name: "accept-language", value: "*" },
    { name: "accept-encoding", value: "gzip, deflate" },
  ];

  it("Worker にだけある名前を、値つきで返す(名前の大文字小文字は区別しない)", () => {
    const d = computeHeaderDiff(worker, runner);
    expect(d.workerOnly.map((h) => h.name)).toEqual(["cf-connecting-ip", "cf-worker", "x-real-ip"]);
    expect(d.workerOnly[0]).toEqual({ name: "cf-connecting-ip", value: "198.51.100.9" });
  });

  it("ランナーにだけある名前を返す(Host は転送の都合で比べない)", () => {
    expect(computeHeaderDiff(worker, runner).runnerOnly).toEqual(["accept", "accept-language"]);
  });

  it("名前が同じで値が違うものを、両側の値つきで返す(user-agent は同じなので含めない)", () => {
    expect(computeHeaderDiff(worker, runner).valueDiffers).toEqual([
      { name: "accept-encoding", workerValue: "br, gzip", runnerValue: "gzip, deflate" },
    ]);
  });

  describe("同名のヘッダが複数回現れたとき(', ' で連結して1つの値にする)", () => {
    it("Worker 側に同名が2回あれば、出現順に ', ' で連結した値で workerOnly に入る(名前は最初の出現のもの)", () => {
      const d = computeHeaderDiff(
        [
          { name: "X-Dup", value: "1" },
          { name: "x-dup", value: "2" },
        ],
        [],
      );
      expect(d.workerOnly).toEqual([{ name: "X-Dup", value: "1, 2" }]);
    });

    it("両側が同じ連結値なら、値の差に数えない(Worker は2行・ランナーは1行 'a, b' でも同じ)", () => {
      const d = computeHeaderDiff(
        [
          { name: "x-a", value: "a" },
          { name: "x-a", value: "b" },
        ],
        [{ name: "x-a", value: "a, b" }],
      );
      expect(d.valueDiffers).toEqual([]);
      expect(d.workerOnly).toEqual([]);
    });

    it("連結値が違えば、連結した値のまま値の差に入る(区切りは ', ' で、',' だけにはしない)", () => {
      const d = computeHeaderDiff(
        [
          { name: "x-a", value: "a" },
          { name: "x-a", value: "b" },
        ],
        [{ name: "x-a", value: "a" }],
      );
      expect(d.valueDiffers).toEqual([{ name: "x-a", workerValue: "a, b", runnerValue: "a" }]);
    });

    it("ランナー側の同名の連結も同じ規則(値の差の runnerValue に連結値が入る)", () => {
      const d = computeHeaderDiff(
        [{ name: "x-a", value: "z" }],
        [
          { name: "X-A", value: "p" },
          { name: "x-a", value: "q" },
        ],
      );
      expect(d.valueDiffers).toEqual([{ name: "x-a", workerValue: "z", runnerValue: "p, q" }]);
    });
  });

  it("エコー側のインフラが足す揮発のヘッダ(x-amzn-trace-id)は、値が違っても差に数えない", () => {
    const d = computeHeaderDiff([{ name: "X-Amzn-Trace-Id", value: "Root=1-a" }], [{ name: "X-Amzn-Trace-Id", value: "Root=1-b" }]);
    expect(d.valueDiffers).toEqual([]);
    expect(d.workerOnly).toEqual([]);
  });

  it("差が無ければすべて空", () => {
    const d = computeHeaderDiff(runner, runner);
    expect(d).toEqual({ workerOnly: [], runnerOnly: [], valueDiffers: [] });
  });
});

describe("selectE2Headers(E2 で付けるヘッダの選別)", () => {
  it("IP を値に持つヘッダ(cf-connecting-ip・x-real-ip)も付ける。Worker が実際に付けた値のまま", () => {
    const r = selectE2Headers([
      { name: "cf-connecting-ip", value: "198.51.100.9" },
      { name: "x-real-ip", value: "198.51.100.9" },
      { name: "cdn-loop", value: "cloudflare" },
    ]);
    expect(r.send).toEqual([
      { name: "cf-connecting-ip", value: "198.51.100.9" },
      { name: "x-real-ip", value: "198.51.100.9" },
      { name: "cdn-loop", value: "cloudflare" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it.each([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "content-length",
    "expect",
    "proxy-authorization",
    "accept-encoding",
  ])("宛先に転送されない種類・fetch が付け替えるもの(%s)は付けず、理由つきで記録する", (name) => {
    const r = selectE2Headers([{ name, value: "x" }, { name: "cf-ray", value: "r" }]);
    expect(r.send.map((h) => h.name)).toEqual(["cf-ray"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.name).toBe(name);
    expect(r.skipped[0]!.reason).toMatch(/転送|付け替え/);
  });

  it.each([
    ["名前に空白", { name: "bad name", value: "x" }],
    ["名前に CR/LF", { name: "a\r\nb", value: "x" }],
    ["疑似ヘッダ", { name: ":authority", value: "x" }],
    ["値に改行", { name: "x-a", value: "1\r\nX-Evil: 2" }],
    ["値が非 ASCII", { name: "x-a", value: "日本語" }],
    ["値が200文字を超える", { name: "x-a", value: "v".repeat(201) }],
  ])("エコーは第三者の応答なので、不正な入力(%s)は付けず、理由つきで記録する", (_n, h) => {
    const r = selectE2Headers([h]);
    expect(r.send).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toMatch(/不正/);
  });

  it("値が200文字ちょうどなら付ける", () => {
    expect(selectE2Headers([{ name: "x-a", value: "v".repeat(200) }]).send).toHaveLength(1);
  });

  it("20個までは付け、21個目以降は付けない(個数の上限)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `x-h${i}`, value: "v" }));
    const r = selectE2Headers(many);
    expect(r.send).toHaveLength(20);
    expect(r.skipped).toHaveLength(5);
    expect(r.skipped.every((s) => /上限/.test(s.reason))).toBe(true);
    expect(r.send.length + r.skipped.length).toBe(25);
  });

  it("Worker にだけ現れるヘッダが無ければ、付けるものは空", () => {
    expect(selectE2Headers([])).toEqual({ send: [], skipped: [] });
  });
});

describe("deriveSocketHeaders(E3 のヘッダ集合)", () => {
  it("ランナーの観測から導出する: Host・Connection・Accept-Encoding を除き、順序と名前の大文字小文字を保つ", () => {
    const runner = obs({
      headers: [
        { name: "host", value: "tls.peet.ws" },
        { name: "connection", value: "keep-alive" },
        { name: "User-Agent", value: "ua-x" },
        { name: "accept", value: "*/*" },
        { name: "accept-language", value: "*" },
        { name: "sec-fetch-mode", value: "cors" },
        { name: "accept-encoding", value: "gzip, deflate" },
      ],
    });
    const r = deriveSocketHeaders(runner);
    expect(r.source).toBe("runner-echo");
    expect(r.headers).toEqual([
      { name: "User-Agent", value: "ua-x" },
      { name: "accept", value: "*/*" },
      { name: "accept-language", value: "*" },
      { name: "sec-fetch-mode", value: "cors" },
    ]);
  });

  it.each([
    ["観測が無い(E1 が失敗)", null],
    ["観測が ok でない", obs({ ok: false, headers: [] })],
    ["User-Agent が観測に無い", obs({ headers: [{ name: "accept", value: "*/*" }] })],
  ])("%s なら、静的フォールバック(Node 22 で実測した集合)を使い、使ったことを source に記録する", (_n, runner) => {
    const r = deriveSocketHeaders(runner);
    expect(r.source).toBe("static-fallback");
    expect(r.headers).toEqual(STATIC_SOCKET_HEADERS);
  });

  it("httpbin にフォールバックしたときも、エコー側の中継(ALB)が足した X-Amzn-Trace-Id は E3 のヘッダに入れない(ランナーの fetch は送っていない)", () => {
    const runner = parseEchoObservation(
      "httpbin",
      fetched(JSON.stringify({ headers: { Accept: "*/*", Host: "httpbin.org", "User-Agent": "ua-x", "X-Amzn-Trace-Id": "Root=1-6ac20693-0063337c495ff4803d1b30e7" } })),
    );
    // 前提: 観測には X-Amzn-Trace-Id が入っている(除外されるのは導出の段階)
    expect(runner.headers.map((h) => h.name)).toContain("X-Amzn-Trace-Id");
    const r = deriveSocketHeaders(runner);
    expect(r.source).toBe("runner-echo");
    expect(r.headers).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "User-Agent", value: "ua-x" },
    ]);
  });

  it("実際の httpbin 応答(フィクスチャ)から導出しても X-Amzn-Trace-Id は入らない", () => {
    const runner = parseEchoObservation("httpbin", fetched(fixture("echo-httpbin.json")));
    expect(runner.headers.map((h) => h.name.toLowerCase())).toContain("x-amzn-trace-id");
    expect(deriveSocketHeaders(runner).headers.map((h) => h.name.toLowerCase())).not.toContain("x-amzn-trace-id");
  });

  it("エコー側の中継が足すヘッダだけを除く(それ以外の未知のヘッダは、ランナーが送ったものとして残す)", () => {
    const runner = obs({
      headers: [
        { name: "User-Agent", value: "ua" },
        { name: "x-custom", value: "1" },
        { name: "X-Amzn-Trace-Id", value: "Root=1-a" },
      ],
    });
    expect(deriveSocketHeaders(runner).headers.map((h) => h.name)).toEqual(["User-Agent", "x-custom"]);
  });

  it("静的フォールバックは Node 22 の fetch が実測で出した4つ(User-Agent は core の既定)", () => {
    expect(STATIC_SOCKET_HEADERS).toEqual([
      { name: "User-Agent", value: DEFAULT_USER_AGENT },
      { name: "accept", value: "*/*" },
      { name: "accept-language", value: "*" },
      { name: "sec-fetch-mode", value: "cors" },
    ]);
  });
});

describe("maskText / maskHeaderValue(公開される記録へのマスク)", () => {
  const ctx = { subdomain: "my-sub", workerName: "keiba-cf-spike-123456-1" };

  it.each([
    ["IPv4", "198.51.100.9", "<ip>"],
    ["IPv4 とポート", "198.51.100.9:443", "<ip>:443"],
    ["IPv4 の列(X-Forwarded-For)", "198.51.100.9, 203.0.113.7", "<ip>, <ip>"],
    ["IPv6(完全形)", "2001:0db8:0000:0000:0000:0000:0000:0001", "<ip>"],
    ["IPv6(圧縮)", "2001:db8::1", "<ip>"],
    ["IPv6(ループバック)", "::1", "<ip>"],
    ["IPv6(IPv4 射影)", "::ffff:198.51.100.9", "<ip>"],
    ["IPv4 と IPv6 の混在", "198.51.100.9, 2001:db8::1", "<ip>, <ip>"],
    ["文中の IPv4", "client=198.51.100.9;proto=https", "client=<ip>;proto=https"],
  ])("%s: %s → %s", (_name, input, expected) => {
    expect(maskText(input, ctx)).toBe(expected);
  });

  it.each([
    ["サブドメイン(ctx の値)", "my-sub", "<subdomain>"],
    ["サブドメイン(大文字小文字を区別しない)", "MY-SUB", "<subdomain>"],
    ["workers.dev のホスト", "my-sub.workers.dev", "<subdomain>.workers.dev"],
    ["Worker 名つきのホスト", "keiba-cf-spike-123456-1.my-sub.workers.dev", "<worker>.<subdomain>.workers.dev"],
    ["URL の中", "https://keiba-cf-spike-123456-1.my-sub.workers.dev/ping", "https://<worker>.<subdomain>.workers.dev/ping"],
    ["Worker 名(ctx の値)", "keiba-cf-spike-123456-1", "<worker>"],
    ["別の実行の Worker 名(接頭辞のパターン)", "keiba-cf-spike-999-2", "<worker>"],
    ["ctx に無い別のサブドメインの workers.dev", "other-acct.workers.dev", "<subdomain>.workers.dev"],
  ])("%s: %s → %s", (_name, input, expected) => {
    expect(maskText(input, ctx)).toBe(expected);
  });

  it.each([
    "keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)",
    "*/*",
    "gzip, br",
    "cors",
    "cloudflare",
    "text/html; charset=UTF-8",
  ])("IP でも自分の識別子でもない値(%s)は変えない", (value) => {
    expect(maskText(value, ctx)).toBe(value);
  });

  it("ctx が空(サブドメイン・Worker 名が未設定)でも、IP と workers.dev のパターンは常にマスクする", () => {
    expect(maskText("x.y.workers.dev 198.51.100.9", {})).toBe("<subdomain>.workers.dev <ip>");
  });

  it("サブドメインが空文字のときは、全文を置換してしまわない(空文字の置換の落とし穴)", () => {
    expect(maskText("abc", { subdomain: "", workerName: "" })).toBe("abc");
  });

  it("サブドメインに正規表現の特殊文字があっても、文字どおりに置換する", () => {
    expect(maskText("a.b", { subdomain: "a.b" })).toBe("<subdomain>");
    expect(maskText("axb", { subdomain: "a.b" })).toBe("axb");
  });

  it("CF-Worker の値(ゾーン名・workers.dev のサブドメインを含みうる)をマスクする", () => {
    expect(maskHeaderValue("cf-worker", "my-sub.workers.dev", ctx)).toBe("<subdomain>.workers.dev");
    expect(maskHeaderValue("CF-Worker", "my-sub", ctx)).toBe("<subdomain>");
  });

  it("cf-connecting-ip・x-real-ip・x-forwarded-for の値をマスクする", () => {
    expect(maskHeaderValue("cf-connecting-ip", "198.51.100.9", ctx)).toBe("<ip>");
    expect(maskHeaderValue("x-real-ip", "2001:db8::1", ctx)).toBe("<ip>");
    expect(maskHeaderValue("x-forwarded-for", "198.51.100.9, 203.0.113.7", ctx)).toBe("<ip>, <ip>");
  });

  it("cf-ray は一意の部分を隠し、データセンターの接尾辞だけ残す", () => {
    expect(maskHeaderValue("cf-ray", "a4529772a8754b00-IAD", ctx)).toBe("<ray>-IAD");
    expect(maskHeaderValue("cf-ray", "not-a-ray", ctx)).toBe("<ray>");
  });
});
