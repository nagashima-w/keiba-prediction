import { describe, expect, it } from "vitest";
import {
  buildHttp1Request,
  decodeChunked,
  Http1Error,
  isValidHeaderName,
  isValidHeaderValue,
  parseHttp1Response,
  peekHttp1Status,
} from "../cloudflare-spike/http1.js";

/**
 * #160 ソケット用 HTTP/1.1 クライアントの純ロジック(`scripts/cloudflare-spike/http1.ts`)。
 * Worker の `connect()` で自前の HTTP を話すために、リクエストの組み立て・応答のパース・chunked の解除を
 * ネットワークなしで検証する。
 */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const bytes = (s: string): Uint8Array => enc.encode(s);

describe("isValidHeaderName / isValidHeaderValue(ヘッダ注入の防止)", () => {
  it.each([
    ["User-Agent", true],
    ["accept-language", true],
    ["x-1", true],
    ["", false],
    ["a b", false],
    ["a:b", false],
    ["a\r\nb", false],
    [":authority", false],
    ["日本語", false],
  ])("名前 %j は %s", (name, expected) => {
    expect(isValidHeaderName(name)).toBe(expected);
  });

  it.each([
    ["keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)", true],
    ["*/*", true],
    ["", true],
    ["a\r\nX-Evil: 1", false],
    ["a\nb", false],
    ["a\rb", false],
    ["a\u0000b", false],
    ["日本語", false],
    ["x".repeat(1025), false],
  ])("値 %j は %s", (value, expected) => {
    expect(isValidHeaderValue(value)).toBe(expected);
  });
});

describe("buildHttp1Request(リクエストの組み立て)", () => {
  it("リクエスト行・Host・指定ヘッダ(順序どおり)・Connection: close・空行の順に組み立てる", () => {
    const text = buildHttp1Request({
      host: "race.netkeiba.com",
      path: "/race/shutuba.html?race_id=202603020211",
      headers: [
        { name: "User-Agent", value: "ua" },
        { name: "accept", value: "*/*" },
      ],
    });
    expect(text).toBe(
      "GET /race/shutuba.html?race_id=202603020211 HTTP/1.1\r\n" +
        "Host: race.netkeiba.com\r\n" +
        "User-Agent: ua\r\n" +
        "accept: */*\r\n" +
        "Connection: close\r\n" +
        "\r\n",
    );
  });

  it("Accept-Encoding は含めない(指定しなければ付かない)", () => {
    const text = buildHttp1Request({ host: "db.netkeiba.com", path: "/horse/2021105857/", headers: [{ name: "User-Agent", value: "ua" }] });
    expect(text.toLowerCase()).not.toContain("accept-encoding");
  });

  it.each([
    "host",
    "Host",
    "connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-authorization",
  ])("禁止ヘッダ %s を指定したら拒否する(Host と Connection は自前で付ける)", (name) => {
    expect(() => buildHttp1Request({ host: "db.netkeiba.com", path: "/", headers: [{ name, value: "x" }] })).toThrow(Http1Error);
  });

  it("ヘッダの値に CR/LF があれば拒否する(リクエスト行・ヘッダ注入の防止)", () => {
    expect(() =>
      buildHttp1Request({ host: "db.netkeiba.com", path: "/", headers: [{ name: "x-a", value: "1\r\nX-Evil: 2" }] }),
    ).toThrow(Http1Error);
  });

  it.each([
    ["", "空のパス"],
    ["race", "/ で始まらない"],
    ["/a b", "空白を含む"],
    ["/a\r\nHost: evil", "CR/LF を含む"],
    ["/日本語", "ASCII でない"],
  ])("パス %j(%s)は拒否する", (path) => {
    expect(() => buildHttp1Request({ host: "db.netkeiba.com", path, headers: [] })).toThrow(Http1Error);
  });

  it.each(["", "a b", "a/b", "a\r\nb", "evil.com:80@x", "日本"])("ホスト %j は拒否する", (host) => {
    expect(() => buildHttp1Request({ host, path: "/", headers: [] })).toThrow(Http1Error);
  });
});

describe("decodeChunked(chunked の解除)", () => {
  it("複数の chunk を連結する", () => {
    const body = decodeChunked(bytes("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"));
    expect(dec.decode(body)).toBe("hello world");
  });

  it("chunk のサイズは16進数(大文字小文字どちらも)", () => {
    const body = decodeChunked(bytes("A\r\n0123456789\r\na\r\nabcdefghij\r\n0\r\n\r\n"));
    expect(dec.decode(body)).toBe("0123456789abcdefghij");
  });

  it("chunk 拡張(;name=value)を無視する", () => {
    expect(dec.decode(decodeChunked(bytes("3;ext=1\r\nabc\r\n0;last\r\n\r\n")))).toBe("abc");
  });

  it("トレーラを読み飛ばす", () => {
    expect(dec.decode(decodeChunked(bytes("3\r\nabc\r\n0\r\nX-Trailer: 1\r\nX-Other: 2\r\n\r\n")))).toBe("abc");
  });

  it("chunk の中に CRLF を含む本文でも、サイズで切り出す(CRLF を区切りと誤認しない)", () => {
    expect(dec.decode(decodeChunked(bytes("8\r\nab\r\ncd\r\n\r\n0\r\n\r\n")))).toBe("ab\r\ncd\r\n");
  });

  it("バイト列(UTF-8 の多バイト)を壊さない", () => {
    const payload = bytes("競馬");
    const framed = Uint8Array.from([...bytes(`${payload.length.toString(16)}\r\n`), ...payload, ...bytes("\r\n0\r\n\r\n")]);
    expect(dec.decode(decodeChunked(framed))).toBe("競馬");
  });

  it.each([
    ["終端の 0 chunk が無い(途中で切断)", "5\r\nhello\r\n"],
    ["最後の空行が無い(途中で切断)", "5\r\nhello\r\n0\r\n"],
    ["chunk のデータが途中で切れている", "a\r\nabc"],
    ["chunk の後ろに CRLF が無い", "3\r\nabcXX0\r\n\r\n"],
    ["サイズ行が16進数でない", "zz\r\nabc\r\n0\r\n\r\n"],
    ["サイズ行が空", "\r\nabc\r\n0\r\n\r\n"],
    ["サイズ行が改行で終わらない", "5"],
    ["サイズが巨大(桁あふれ)", "ffffffffffffffffff\r\nabc\r\n0\r\n\r\n"],
  ])("不正な入力(%s)は例外にする", (_name, raw) => {
    expect(() => decodeChunked(bytes(raw))).toThrow(Http1Error);
  });
});

describe("parseHttp1Response(応答のパース)", () => {
  it("Content-Length の本文を読み、ステータス・理由・ヘッダ(名前は小文字)を返す", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: 5\r\n\r\nhello"));
    expect(r.status).toBe(200);
    expect(r.reason).toBe("OK");
    expect(r.framing).toBe("content-length");
    expect(dec.decode(r.body)).toBe("hello");
    expect(r.headers).toContainEqual({ name: "content-type", value: "text/html; charset=UTF-8" });
    expect(r.headers).toContainEqual({ name: "content-length", value: "5" });
  });

  it("Content-Length を超える余剰のバイトは本文に含めない", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef"));
    expect(dec.decode(r.body)).toBe("abc");
  });

  it("Transfer-Encoding: chunked を解く(Content-Length があっても chunked を優先する)", () => {
    const r = parseHttp1Response(
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 999\r\n\r\n5\r\nhello\r\n0\r\n\r\n"),
    );
    expect(r.framing).toBe("chunked");
    expect(dec.decode(r.body)).toBe("hello");
  });

  it("Transfer-Encoding の大文字小文字・複数コーディングの末尾 chunked を認める", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n"));
    expect(dec.decode(r.body)).toBe("hi");
  });

  it("Content-Length も chunked も無ければ、EOF までを本文とする(Connection: close)", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nthe rest"));
    expect(r.framing).toBe("until-close");
    expect(dec.decode(r.body)).toBe("the rest");
  });

  it("本文0バイトの 400(CloudFront の拒否の形)を読める", () => {
    const r = parseHttp1Response(
      bytes("HTTP/1.1 400 Bad Request\r\nServer: CloudFront\r\nX-Cache: Error from cloudfront\r\nContent-Length: 0\r\n\r\n"),
    );
    expect(r.status).toBe(400);
    expect(r.body.byteLength).toBe(0);
    expect(r.headers).toContainEqual({ name: "x-cache", value: "Error from cloudfront" });
  });

  it("理由句が無いステータス行も読める", () => {
    expect(parseHttp1Response(bytes("HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n")).status).toBe(200);
  });

  it("同名のヘッダが複数あれば、出現順にすべて残す(set-cookie 等)", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n"));
    expect(r.headers.filter((h) => h.name === "set-cookie").map((h) => h.value)).toEqual(["a=1", "b=2"]);
  });

  it("ヘッダの値の前後の空白を除く", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nX-A:   padded \t\r\nContent-Length: 0\r\n\r\n"));
    expect(r.headers).toContainEqual({ name: "x-a", value: "padded" });
  });

  it("折り返し(obs-fold)の継続行を直前のヘッダの値に連結する", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nX-A: one\r\n two\r\nContent-Length: 0\r\n\r\n"));
    expect(r.headers).toContainEqual({ name: "x-a", value: "one two" });
  });

  it("ヘッダは Latin-1 として読む(本文のバイトには触れない)", () => {
    const head = latin1("HTTP/1.1 200 OK\r\nX-A: café\r\nContent-Length: 2\r\n\r\n");
    const r = parseHttp1Response(Uint8Array.from([...head, 0xa4, 0xa2]));
    expect(r.headers).toContainEqual({ name: "x-a", value: "café" });
    expect([...r.body]).toEqual([0xa4, 0xa2]);
  });

  it("本文に EUC-JP のバイト列(0x0d 0x0a を含みうる)があっても、そのまま取り出す", () => {
    const body = Uint8Array.from([0xa4, 0x0d, 0x0a, 0xa2]);
    const head = bytes("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n");
    expect([...parseHttp1Response(Uint8Array.from([...head, ...body])).body]).toEqual([...body]);
  });

  it.each([204, 304])("%d は本文を持たない(後続のバイトは本文にしない)", (status) => {
    const r = parseHttp1Response(bytes(`HTTP/1.1 ${status} X\r\nContent-Length: 3\r\n\r\nabc`));
    expect(r.framing).toBe("none");
    expect(r.body.byteLength).toBe(0);
  });

  it("リダイレクトの 301 は、ステータスと location を読むだけ(追従しない)", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 301 Moved Permanently\r\nLocation: https://example.com/\r\nContent-Length: 0\r\n\r\n"));
    expect(r.status).toBe(301);
    expect(r.headers).toContainEqual({ name: "location", value: "https://example.com/" });
  });

  it.each([
    ["空", ""],
    ["ヘッダの終端が無い(途中で切断)", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"],
    ["ステータス行が HTTP でない", "SSH-2.0-OpenSSH\r\n\r\n"],
    ["ステータスコードが3桁でない", "HTTP/1.1 20 OK\r\n\r\n"],
    ["HTTP/2 のステータス行(HTTP/1.1 で話しているのに)", "HTTP/2 200\r\n\r\n"],
    ["ヘッダ行にコロンが無い", "HTTP/1.1 200 OK\r\nbroken\r\n\r\n"],
    ["1xx の暫定応答", "HTTP/1.1 100 Continue\r\n\r\n"],
    ["Content-Length が数字でない", "HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\n"],
    ["Content-Length が負", "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n"],
    ["Content-Length が食い違って複数ある", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabcd"],
    ["Content-Length に対して本文が足りない(途中で切断)", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"],
    ["chunked の途中で切断", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel"],
    ["先頭の折り返し行(直前のヘッダが無い)", "HTTP/1.1 200 OK\r\n folded\r\n\r\n"],
  ])("不正・不完全な応答(%s)は例外にする", (_name, raw) => {
    expect(() => parseHttp1Response(bytes(raw))).toThrow(Http1Error);
  });

  it("Content-Length が同じ値で重複していれば受け入れる", () => {
    const r = parseHttp1Response(bytes("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc"));
    expect(dec.decode(r.body)).toBe("abc");
  });
});

describe("peekHttp1Status(途中までのバイトからステータスだけを読む。打ち切りの記録用)", () => {
  it("ステータス行が揃っていれば番号を返す", () => {
    expect(peekHttp1Status(bytes("HTTP/1.1 200 OK\r\nContent-Le"))).toBe(200);
  });
  it.each([[""], ["HTTP/1.1 20"], ["garbage\r\n"]])("ステータス行が揃っていない・読めない入力(%j)は null", (raw) => {
    expect(peekHttp1Status(bytes(raw))).toBeNull();
  });
});
