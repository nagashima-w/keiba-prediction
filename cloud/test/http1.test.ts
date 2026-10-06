import { describe, expect, it } from "vitest";
import { buildHttp1Request, decodeChunked, Http1Error, parseHttp1Response, peekHttp1Status } from "../src/http1";

/**
 * Issue #162 段階2a: ソケットで HTTP/1.1 を話すための純ロジック(リクエストの組立・応答の解釈・chunked の解除)。
 * ネットワークにもランタイムにも依存しない。
 */

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("buildHttp1Request", () => {
  it("リクエスト行・Host・指定ヘッダ(指定順)・Connection: close の順で、CRLF 区切り・空行で終わる", () => {
    const request = buildHttp1Request({
      host: "race.netkeiba.com",
      path: "/race/shutuba.html?race_id=202603020211",
      headers: [
        { name: "User-Agent", value: "ua" },
        { name: "accept", value: "*/*" },
      ],
    });
    expect(request).toBe(
      "GET /race/shutuba.html?race_id=202603020211 HTTP/1.1\r\nHost: race.netkeiba.com\r\nUser-Agent: ua\r\naccept: */*\r\nConnection: close\r\n\r\n",
    );
  });

  it("ヘッダが空でも Host と Connection: close は付く", () => {
    expect(buildHttp1Request({ host: "db.netkeiba.com", path: "/", headers: [] })).toBe(
      "GET / HTTP/1.1\r\nHost: db.netkeiba.com\r\nConnection: close\r\n\r\n",
    );
  });

  it.each([
    ["ホスト名に空白", { host: "a b", path: "/", headers: [] }],
    ["ホスト名が空", { host: "", path: "/", headers: [] }],
    ["ホスト名にスラッシュ", { host: "a.com/x", path: "/", headers: [] }],
    ["パスが / で始まらない", { host: "a.com", path: "x", headers: [] }],
    ["パスに CRLF(リクエスト行の注入)", { host: "a.com", path: "/x\r\nX: y", headers: [] }],
    ["パスに空白", { host: "a.com", path: "/x y", headers: [] }],
    ["パスに非 ASCII", { host: "a.com", path: "/あ", headers: [] }],
    ["ヘッダ名に空白", { host: "a.com", path: "/", headers: [{ name: "a b", value: "x" }] }],
    ["ヘッダ名が疑似ヘッダ", { host: "a.com", path: "/", headers: [{ name: ":path", value: "x" }] }],
    ["ヘッダ値に CRLF(ヘッダの注入)", { host: "a.com", path: "/", headers: [{ name: "x", value: "a\r\nB: c" }] }],
    ["ヘッダ値に非 ASCII", { host: "a.com", path: "/", headers: [{ name: "x", value: "あ" }] }],
    ["ヘッダ値が長すぎる(1025 文字)", { host: "a.com", path: "/", headers: [{ name: "x", value: "a".repeat(1025) }] }],
    ["Accept-Encoding(圧縮を要求しない)", { host: "a.com", path: "/", headers: [{ name: "Accept-Encoding", value: "gzip" }] }],
    ["Connection(自前で付ける)", { host: "a.com", path: "/", headers: [{ name: "connection", value: "keep-alive" }] }],
    ["Host(自前で付ける)", { host: "a.com", path: "/", headers: [{ name: "HOST", value: "b.com" }] }],
    ["Content-Length", { host: "a.com", path: "/", headers: [{ name: "Content-Length", value: "1" }] }],
    ["Transfer-Encoding", { host: "a.com", path: "/", headers: [{ name: "transfer-encoding", value: "chunked" }] }],
    ["proxy- で始まるヘッダ", { host: "a.com", path: "/", headers: [{ name: "Proxy-Authorization", value: "x" }] }],
  ])("不正な入力は例外にする: %s", (_label, input) => {
    expect(() => buildHttp1Request(input)).toThrow(Http1Error);
  });

  it("ヘッダ値の長さは 1024 文字まで許す(境界)", () => {
    expect(() => buildHttp1Request({ host: "a.com", path: "/", headers: [{ name: "x", value: "a".repeat(1024) }] })).not.toThrow();
  });
});

describe("decodeChunked", () => {
  it("複数の chunk をつなぎ、終端の 0 とトレーラを読み飛ばす", () => {
    const out = decodeChunked(bytes("5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nX-Trailer: a\r\n\r\n"));
    expect(text(out)).toBe("hello world");
  });

  it.each([
    ["サイズ行の途中で切断", "5\r\nhel"],
    ["終端の 0 の後の空行が無い", "5\r\nhello\r\n0\r\n"],
    ["chunk データが足りない", "a\r\nhello\r\n"],
    ["chunk データの後ろに CRLF が無い", "5\r\nhelloXX0\r\n\r\n"],
    ["サイズが 16 進でない", "zz\r\nhello\r\n0\r\n\r\n"],
    ["サイズの桁数が多すぎる(9 桁)", "100000000\r\n"],
  ])("不完全・不正な入力は例外にする: %s", (_label, input) => {
    expect(() => decodeChunked(bytes(input))).toThrow(Http1Error);
  });
});

const http = (head: string, body = ""): Uint8Array => bytes(`${head.replace(/\n/g, "\r\n")}\r\n\r\n${body}`);

describe("parseHttp1Response", () => {
  it("Content-Length で本文を切り出す(余分な後続バイトは捨てる)。ヘッダ名は小文字にする", () => {
    const parsed = parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Type: text/html; charset=UTF-8\nContent-Length: 5", "helloEXTRA"));
    expect(parsed.status).toBe(200);
    expect(parsed.framing).toBe("content-length");
    expect(text(parsed.body)).toBe("hello");
    expect(parsed.headers.find((h) => h.name === "content-type")?.value).toBe("text/html; charset=UTF-8");
  });

  it("Content-Length に足りなければ(途中で切断)例外にする。ちょうど足りれば通る", () => {
    expect(() => parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Length: 10", "hello"))).toThrow(Http1Error);
    expect(text(parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Length: 5", "hello")).body)).toBe("hello");
  });

  it("Content-Length が不正(数字以外・食い違う重複)なら例外にする。同じ値の重複は通す", () => {
    expect(() => parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Length: abc", "x"))).toThrow(Http1Error);
    expect(() => parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Length: 1\nContent-Length: 2", "xx"))).toThrow(Http1Error);
    expect(text(parseHttp1Response(http("HTTP/1.1 200 OK\nContent-Length: 2\nContent-Length: 2", "xx")).body)).toBe("xx");
  });

  it("chunked は解いて返す。Transfer-Encoding が Content-Length より優先される", () => {
    const parsed = parseHttp1Response(http("HTTP/1.1 200 OK\nTransfer-Encoding: chunked\nContent-Length: 999", "3\r\nabc\r\n0\r\n\r\n"));
    expect(parsed.framing).toBe("chunked");
    expect(text(parsed.body)).toBe("abc");
  });

  it("chunked が途中で切れていれば例外にする(途中までを成功にしない)", () => {
    expect(() => parseHttp1Response(http("HTTP/1.1 200 OK\nTransfer-Encoding: chunked", "5\r\nhel"))).toThrow(Http1Error);
  });

  it("長さの指定がなければ EOF までを本文とする(until-close)", () => {
    const parsed = parseHttp1Response(http("HTTP/1.1 200 OK", "all of it"));
    expect(parsed.framing).toBe("until-close");
    expect(text(parsed.body)).toBe("all of it");
  });

  it("204・304 は本文なし", () => {
    expect(parseHttp1Response(http("HTTP/1.1 304 Not Modified\nContent-Length: 5", "xxxxx")).body.length).toBe(0);
    expect(parseHttp1Response(http("HTTP/1.1 204 No Content")).framing).toBe("none");
  });

  it("3xx は追従せず、そのまま返す(Location も読める)", () => {
    const parsed = parseHttp1Response(http("HTTP/1.1 302 Found\nLocation: https://example.com/\nContent-Length: 0"));
    expect(parsed.status).toBe(302);
    expect(parsed.headers.find((h) => h.name === "location")?.value).toBe("https://example.com/");
  });

  it("理由句が無いステータス行・折り返しヘッダも読める", () => {
    const parsed = parseHttp1Response(http("HTTP/1.1 403\nX-Long: a\n b\nContent-Length: 0"));
    expect(parsed.status).toBe(403);
    expect(parsed.headers.find((h) => h.name === "x-long")?.value).toBe("a b");
  });

  it.each([
    ["ヘッダが終わる前に切断", "HTTP/1.1 200 OK\r\nContent-Le"],
    ["ステータス行が HTTP/1.x でない", "ICY 200 OK\r\n\r\n"],
    ["1xx の暫定応答", "HTTP/1.1 100 Continue\r\n\r\n"],
    ["ヘッダ行にコロンが無い", "HTTP/1.1 200 OK\r\nbroken\r\n\r\n"],
    ["ヘッダの先頭に折り返しの継続行", "HTTP/1.1 200 OK\r\n continued\r\n\r\n"],
    ["空の入力", ""],
  ])("不完全・不正な応答は例外にする: %s", (_label, raw) => {
    expect(() => parseHttp1Response(bytes(raw))).toThrow(Http1Error);
  });

  it("本文はバイトのまま返す(EUC-JP などのデコードは呼び出し側)", () => {
    const raw = new Uint8Array([...bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n"), 0xa4, 0xa2]);
    expect([...parseHttp1Response(raw).body]).toEqual([0xa4, 0xa2]);
  });
});

describe("peekHttp1Status(受信が途中でも、ステータス行が揃っていれば読む)", () => {
  it.each([
    ["200", "HTTP/1.1 200 OK\r\nContent-Le", 200],
    ["403(理由句なし)", "HTTP/1.1 403\r\n", 403],
    ["HTTP/1.0", "HTTP/1.0 429 Too Many Requests\r\nX: y", 429],
    ["境界: 200", "HTTP/1.1 200 OK\r\n", 200],
    ["境界: 599", "HTTP/1.1 599 X\r\n", 599],
  ])("読める: %s", (_label, raw, expected) => {
    expect(peekHttp1Status(bytes(raw))).toBe(expected);
  });

  it.each([
    ["CRLF が届いていない(ステータス行の途中)", "HTTP/1.1 40"],
    ["CRLF が届いていない(行は完結しているように見える)", "HTTP/1.1 403 Forbidden"],
    ["空", ""],
    ["HTTP/1.x でない", "ICY 200 OK\r\n"],
    ["1xx(暫定応答は応答として扱わない)", "HTTP/1.1 100 Continue\r\n"],
    ["境界: 199", "HTTP/1.1 199 X\r\n"],
    ["境界: 600", "HTTP/1.1 600 X\r\n"],
    ["ステータスが 3 桁でない", "HTTP/1.1 20 OK\r\n"],
  ])("読めない(undefined): %s", (_label, raw) => {
    expect(peekHttp1Status(bytes(raw))).toBeUndefined();
  });
});
