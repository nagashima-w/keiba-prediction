import { describe, expect, it } from "vitest";

import { buildFailDetail, classifyThrownKind, detectCfErrorCode, isEdgeBlock, parseTraceColo } from "../src/jra-fail-detail";

/**
 * Issue #804: 取得の失敗の詳細(`fail_detail`)の部品。判定にだけ例外の message・応答のヘッダ・本文を読み、残すのは固定の語と数字だけ。
 */

describe("classifyThrownKind: 例外の種類(message は判定にだけ読む)", () => {
  const err = (name: string, message: string): Error => Object.assign(new Error(message), { name });
  it.each([
    ["名前の解決(workerd の実測: internal error)", err("Error", "internal error; reference = abc123"), "dns"],
    ["接続の拒否・切断・TLS(workerd の実測: Network connection lost)", err("Error", "Network connection lost."), "reset"],
    ["TimeoutError は timeout", err("TimeoutError", "The operation was aborted due to timeout"), "timeout"],
    ["AbortError は timeout", err("AbortError", "aborted"), "timeout"],
    ["知らない message は unknown", err("Error", "something else"), "unknown"],
    ["TypeError の知らない message も unknown", err("TypeError", "fetch failed"), "unknown"],
    ["Error でない値は unknown", "boom", "unknown"],
    ["null は unknown", null, "unknown"],
    ["message が文字列でない値は unknown", { name: "Error", message: 42 }, "unknown"],
  ])("%s", (_label, error, expected) => {
    expect(classifyThrownKind(error)).toBe(expected);
  });
});

describe("detectCfErrorCode: Cloudflare 自身のエラー応答の本文(error code: NNNN)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it("本文がちょうど `error code: 1016` なら 1016", () => {
    expect(detectCfErrorCode(enc("error code: 1016"))).toBe(1016);
  });
  it("前後の空白・改行は許す", () => {
    expect(detectCfErrorCode(enc("error code: 1016\n"))).toBe(1016);
  });
  it.each([["数字が 3 桁", "error code: 522"], ["数字が 5 桁", "error code: 10160"], ["前に別の文", "Oops error code: 1016"], ["後ろに別の文", "error code: 1016 more"], ["空", ""], ["HTML", "<html>error code: 1016</html>"]])("%s は null", (_l, text) => {
    expect(detectCfErrorCode(enc(text))).toBeNull();
  });
  it("null の本文は null", () => {
    expect(detectCfErrorCode(null)).toBeNull();
  });
});

describe("isEdgeBlock: 配信の防御(Akamai)の拒否の目印", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it("server ヘッダが AkamaiGHost なら true(本文が無くても)", () => {
    expect(isEdgeBlock("AkamaiGHost", null)).toBe(true);
    expect(isEdgeBlock("akamaighost", enc(""))).toBe(true);
  });
  it("本文の先頭に Access Denied と edgesuite の両方があれば true", () => {
    expect(isEdgeBlock(null, enc("<HTML><TITLE>Access Denied</TITLE> https://errors.edgesuite.net/18.x"))).toBe(true);
  });
  it("Access Denied だけ・edgesuite だけは false(両方が要る)", () => {
    expect(isEdgeBlock(null, enc("<TITLE>Access Denied</TITLE>"))).toBe(false);
    expect(isEdgeBlock(null, enc("https://errors.edgesuite.net/"))).toBe(false);
  });
  it("目印が 2KB より後ろにあるときは見ない", () => {
    expect(isEdgeBlock(null, enc("x".repeat(2048) + "Access Denied edgesuite"))).toBe(false);
  });
  it("2KB ちょうどまでに収まる目印は見る", () => {
    expect(isEdgeBlock(null, enc("Access Denied edgesuite" + "x".repeat(3000)))).toBe(true);
  });
  it("server が別の値で本文も無関係なら false", () => {
    expect(isEdgeBlock("nginx", enc("forbidden"))).toBe(false);
    expect(isEdgeBlock(null, null)).toBe(false);
  });
});

describe("buildFailDetail: fail_detail の JSON(決まった鍵と値だけ)", () => {
  it("全部あれば p・k・h・c の順で組む", () => {
    expect(buildFailDetail({ page: "tanpuku", kind: "blocked", http: 403, colo: "NRT" })).toBe('{"p":"tanpuku","k":"blocked","h":403,"c":"NRT"}');
  });
  it("http・colo が無ければその鍵を出さない", () => {
    expect(buildFailDetail({ page: "cushion", kind: "dns", http: null, colo: null })).toBe('{"p":"cushion","k":"dns"}');
  });
  it("k が語彙に無ければ unknown", () => {
    expect(buildFailDetail({ page: "tanpuku", kind: "weird" as never, http: null, colo: null })).toBe('{"p":"tanpuku","k":"unknown"}');
  });
  it.each([1016, 522, 9999])("cf-NNNN は 4 桁のときだけ通す(%i)", (n) => {
    const detail = buildFailDetail({ page: "tanpuku", kind: `cf-${n}` as never, http: 530, colo: null });
    expect(detail).toBe(n >= 1000 ? `{"p":"tanpuku","k":"cf-${n}","h":530}` : '{"p":"tanpuku","k":"unknown","h":530}');
  });
  it("p が語彙に無ければ unknown(外の文字列を入れない)", () => {
    expect(buildFailDetail({ page: 'evil"x', kind: "http", http: 500, colo: null })).toBe('{"p":"unknown","k":"http","h":500}');
  });
  it("colo が 3 文字の大文字でなければ出さない", () => {
    expect(buildFailDetail({ page: "tanpuku", kind: "http", http: 500, colo: "nrt" })).toBe('{"p":"tanpuku","k":"http","h":500}');
    expect(buildFailDetail({ page: "tanpuku", kind: "http", http: 500, colo: 'NR"' })).toBe('{"p":"tanpuku","k":"http","h":500}');
  });
  it("http が整数 100〜599 でなければ出さない", () => {
    expect(buildFailDetail({ page: "tanpuku", kind: "http", http: 1.5, colo: null })).toBe('{"p":"tanpuku","k":"http"}');
    expect(buildFailDetail({ page: "tanpuku", kind: "http", http: 99, colo: null })).toBe('{"p":"tanpuku","k":"http"}');
    expect(buildFailDetail({ page: "tanpuku", kind: "http", http: 600, colo: null })).toBe('{"p":"tanpuku","k":"http"}');
  });
});

describe("parseTraceColo: cdn-cgi/trace の本文から colo", () => {
  it("colo=NRT の行を読む", () => {
    expect(parseTraceColo("fl=1\nip=1.2.3.4\ncolo=NRT\nhttp=http/2\n")).toBe("NRT");
  });
  it.each([["colo 行が無い", "fl=1\nip=1"], ["小文字", "colo=nrt"], ["4 文字", "colo=NRTX"], ["2 文字", "colo=NR"], ["空", ""]])("%s は null", (_l, text) => {
    expect(parseTraceColo(text)).toBeNull();
  });
});
