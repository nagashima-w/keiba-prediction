import { describe, expect, it } from "vitest";
import { SOCKET_MAX_HEADERS, validateEchoRequest, validateSocketRequest } from "../cloudflare-spike/worker-input.js";

/**
 * #160 Worker の新しい公開エンドポイント(`/echo`・`/netkeiba-socket`)の入力検査。
 * 共有秘密を持っていても、固定表以外の URL・許可ホスト以外・禁止ヘッダ・CR/LF は通さない
 * (公開 URL が任意の宛先へのプロキシ、ヘッダ・リクエスト行の注入口にならないようにする)。
 * 共有秘密なしの 403 は worker.ts の入口(`isAuthorized`。auth のテストと、ローカルのスモークテスト)が担う。
 */

describe("validateEchoRequest(/echo。URL は固定表だけ)", () => {
  it.each([
    ["peet", "https://tls.peet.ws/api/all"],
    ["httpbin", "https://httpbin.org/headers"],
  ])("service=%s は、固定表の URL(%s)に解決される", (service, url) => {
    expect(validateEchoRequest({ service })).toEqual({ ok: true, value: { service, url } });
  });

  it.each([
    ["未知のサービス", { service: "postman" }],
    ["service が無い", {}],
    ["service が文字列でない", { service: 1 }],
    ["service がオブジェクト", { service: { toString: () => "peet" } }],
    ["service が配列", { service: ["peet"] }],
    ["本文が null", null],
    ["本文が文字列", "peet"],
    ["本文が配列", ["peet"]],
  ])("%s は拒否する", (_name, body) => {
    expect(validateEchoRequest(body).ok).toBe(false);
  });

  it.each([
    ["url で任意の宛先を指定", { service: "peet", url: "https://evil.example/" }],
    ["url で固定表と同じ宛先を指定(url フィールド自体を受け付けない)", { service: "peet", url: "https://tls.peet.ws/api/all" }],
    ["host を指定", { service: "peet", host: "evil.example" }],
    ["headers を指定", { service: "peet", headers: [] }],
  ])("service 以外のフィールドは拒否する: %s", (_name, body) => {
    const r = validateEchoRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/service 以外|受け付け/);
    }
  });
});

const validSocketBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetId: "central-shutuba",
  url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
  kind: "shutuba",
  encoding: "utf-8",
  headers: [
    { name: "User-Agent", value: "ua" },
    { name: "accept", value: "*/*" },
  ],
  ...over,
});

describe("validateSocketRequest(/netkeiba-socket)", () => {
  it("正しい入力は通り、ヘッダは順序のまま返る", () => {
    const r = validateSocketRequest(validSocketBody());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.url).toContain("race.netkeiba.com");
      expect(r.value.headers).toEqual([
        { name: "User-Agent", value: "ua" },
        { name: "accept", value: "*/*" },
      ]);
    }
  });

  it("db の馬ページ(EUC-JP)も通る", () => {
    expect(
      validateSocketRequest(validSocketBody({ targetId: "db-horse-page", url: "https://db.netkeiba.com/horse/2021105857/", kind: "horse-page", encoding: "euc-jp" })).ok,
    ).toBe(true);
  });

  it("ヘッダが空の配列でも通る(ヘッダは任意)", () => {
    expect(validateSocketRequest(validSocketBody({ headers: [] })).ok).toBe(true);
  });

  it.each([
    ["許可ホスト以外", "https://example.com/"],
    ["サブドメインの偽装(許可ホストを接頭辞に持つ別ドメイン)", "https://race.netkeiba.com.evil.example/"],
    ["サブドメインの偽装(許可ホストを接尾辞に持つ別ドメイン)", "https://evilrace.netkeiba.com/"],
    ["http(TLS でない)", "http://race.netkeiba.com/"],
    ["ポート指定あり", "https://race.netkeiba.com:8443/"],
    ["ユーザー情報つき", "https://user:pw@race.netkeiba.com/"],
    ["IP アドレス", "https://203.0.113.7/"],
    ["Cloudflare の内部ホスト", "https://localhost/"],
    ["URL でない", "not a url"],
  ])("URL: %s は拒否する", (_name, url) => {
    expect(validateSocketRequest(validSocketBody({ url })).ok).toBe(false);
  });

  it.each([
    "host",
    "Host",
    "connection",
    "Connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
    "Accept-Encoding",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-authorization",
    "Proxy-Connection",
  ])("禁止ヘッダ %s は拒否する", (name) => {
    const r = validateSocketRequest(validSocketBody({ headers: [{ name, value: "x" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(name);
    }
  });

  it.each([
    ["値に CRLF(ヘッダ注入)", { name: "x-a", value: "1\r\nX-Evil: 2" }],
    ["値に LF", { name: "x-a", value: "1\nX-Evil: 2" }],
    ["値に CR", { name: "x-a", value: "1\rX" }],
    ["値に NUL", { name: "x-a", value: "1\u0000" }],
    ["値が非 ASCII", { name: "x-a", value: "日本語" }],
    ["値が長すぎる", { name: "x-a", value: "v".repeat(1025) }],
    ["名前に CRLF", { name: "x-a\r\nX-Evil", value: "1" }],
    ["名前に空白", { name: "x a", value: "1" }],
    ["名前にコロン", { name: "x:a", value: "1" }],
    ["疑似ヘッダの名前", { name: ":authority", value: "1" }],
    ["名前が空", { name: "", value: "1" }],
    ["値が文字列でない", { name: "x-a", value: 1 }],
    ["名前が文字列でない", { name: 1, value: "x" }],
    ["要素がオブジェクトでない", "x-a: 1"],
  ])("ヘッダ: %s は拒否する", (_name, header) => {
    expect(validateSocketRequest(validSocketBody({ headers: [header] })).ok).toBe(false);
  });

  it(`ヘッダの個数は ${SOCKET_MAX_HEADERS} 個まで`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `x-h${i}`, value: "v" }));
    expect(validateSocketRequest(validSocketBody({ headers: make(SOCKET_MAX_HEADERS) })).ok).toBe(true);
    expect(validateSocketRequest(validSocketBody({ headers: make(SOCKET_MAX_HEADERS + 1) })).ok).toBe(false);
  });

  it.each([
    ["headers が配列でない(オブジェクト)", { headers: { "User-Agent": "ua" } }],
    ["headers が無い", { headers: undefined }],
    ["kind が未知", { kind: "evil" }],
    ["encoding が未知", { encoding: "shift_jis" }],
    ["targetId が文字列でない", { targetId: 1 }],
    ["url が文字列でない", { url: 1 }],
  ])("%s は拒否する", (_name, over) => {
    expect(validateSocketRequest(validSocketBody(over)).ok).toBe(false);
  });

  it.each([[null], ["x"], [[]], [1]])("本文が %j(オブジェクトでない)なら拒否する", (body) => {
    expect(validateSocketRequest(body).ok).toBe(false);
  });
});

/**
 * #162 段階1: `acceptEncoding`(gzip の opt-in)と、新しい取得対象の種類(三連複の JSON・地方オッズのページ)。
 * `headers` から Accept-Encoding を足す経路は、これまでどおり禁止のまま(上のテストが固定している)。
 */
describe("validateSocketRequest: acceptEncoding(#162)", () => {
  it("省略すると、結果にも acceptEncoding は入らない(従来の入力はそのまま通る)", () => {
    const r = validateSocketRequest(validSocketBody());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.acceptEncoding).toBeUndefined();
      expect("acceptEncoding" in r.value).toBe(false);
    }
  });

  it('"gzip" は通り、結果に入る', () => {
    const r = validateSocketRequest(validSocketBody({ acceptEncoding: "gzip" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.acceptEncoding).toBe("gzip");
    }
  });

  it.each([["identity"], ["br"], ["gzip, br"], ["GZIP"], [""], [null], [1], [true], [["gzip"]]])("gzip 以外の値 %j は拒否する", (value) => {
    const r = validateSocketRequest(validSocketBody({ acceptEncoding: value }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/acceptEncoding/);
    }
  });

  it("acceptEncoding を指定しても、headers 側の Accept-Encoding は拒否する(経路は1つだけ)", () => {
    expect(validateSocketRequest(validSocketBody({ acceptEncoding: "gzip", headers: [{ name: "Accept-Encoding", value: "gzip" }] })).ok).toBe(false);
  });
});

describe("validateSocketRequest: 新しい取得対象の種類(#162)", () => {
  it.each([
    ["三連複の JSON", "combo-trio-json", "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init"],
    ["地方のオッズページ", "nar-odds-page", "https://nar.netkeiba.com/odds/index.html?type=b1&race_id=202654071210"],
  ])("%s(kind=%s)は通る", (_name, kind, url) => {
    expect(validateSocketRequest(validSocketBody({ kind, url })).ok).toBe(true);
  });
});
