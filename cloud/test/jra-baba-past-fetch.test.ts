import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createJraBabaPastFetcher } from "../src/jra-baba-past-fetch";
import { BABA_PAST_MAX_PDF_BYTES } from "../src/jra-baba-past-pdf";
import { parseBabaPastYearPage } from "../src/jra-baba-past-links";
import { JRA_MAX_BODY_BYTES } from "../src/jra-http";
import { pathFromMeta } from "./meta-path";

/** Issue #769: 過去の馬場の取得口(年の頁と PDF)。偽の fetch で、URL・メソッド・本文の上限・失敗の分類を確かめる(実サイトには出ない)。 */

const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);
const yearBytes = new Uint8Array(readFileSync(`${FIXTURES}jra_baba_past_year_2021.html`));
const pdfBytes = new Uint8Array(readFileSync(`${FIXTURES}jra_baba_past_2021_tokyo01.pdf`));

describe("fetchYear", () => {
  it("GET の年の頁。リダイレクトは追わない。Shift_JIS を読んで頁にする(読めて 36 本)", async () => {
    const calls: { url: string; method: string | undefined; redirect: string | undefined }[] = [];
    const { fetchYear } = createJraBabaPastFetcher({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, redirect: init.redirect });
        return new Response(yearBytes, { status: 200 });
      },
    });
    const out = await fetchYear(2021);
    expect(calls).toEqual([{ url: "https://www.jra.go.jp/keiba/baba/archive/2021.html", method: undefined, redirect: "manual" }]);
    expect(out.kind).toBe("page");
    if (out.kind === "page") {
      const parsed = parseBabaPastYearPage(out.html, 2021);
      expect(parsed.ok && parsed.links.length).toBe(36);
    }
  });

  it("本文の上限は既定の 256KB(年の頁は約 71KB)。超えれば too-large", async () => {
    expect(yearBytes.byteLength).toBeLessThan(JRA_MAX_BODY_BYTES / 2);
    expect(await createJraBabaPastFetcher({ fetch: async () => new Response(new Uint8Array(JRA_MAX_BODY_BYTES + 1), { status: 200 }) }).fetchYear(2021)).toEqual({ kind: "failed", reason: "too-large" });
  });

  it("年が整数でなければ、取らずに失敗(http-400)にする", async () => {
    let called = false;
    const { fetchYear } = createJraBabaPastFetcher({ fetch: async () => ((called = true), new Response("x")) });
    expect(await fetchYear(2021.5)).toEqual({ kind: "failed", reason: "http-400" });
    expect(called).toBe(false);
  });
});

describe("fetchPdf", () => {
  it("GET の PDF。バイト列のまま返す(文字には直さない)。URL は年の頁のパスから組む", async () => {
    const calls: string[] = [];
    const { fetchPdf } = createJraBabaPastFetcher({
      fetch: async (url) => {
        calls.push(url);
        return new Response(pdfBytes, { status: 200 });
      },
    });
    const out = await fetchPdf("2021pdf/tokyo01.pdf");
    expect(calls).toEqual(["https://www.jra.go.jp/keiba/baba/archive/2021pdf/tokyo01.pdf"]);
    expect(out.kind).toBe("pdf");
    if (out.kind === "pdf") expect(Array.from(out.bytes)).toEqual(Array.from(pdfBytes));
  });

  it("本文の上限は PDF の読み取りの上限(1MB)。ちょうどは読み、1 バイト超えれば too-large", async () => {
    const at = new Uint8Array(BABA_PAST_MAX_PDF_BYTES).fill(0x20);
    expect((await createJraBabaPastFetcher({ fetch: async () => new Response(at, { status: 200 }) }).fetchPdf("2021pdf/tokyo01.pdf")).kind).toBe("pdf");
    expect(await createJraBabaPastFetcher({ fetch: async () => new Response(new Uint8Array(BABA_PAST_MAX_PDF_BYTES + 1), { status: 200 }) }).fetchPdf("2021pdf/tokyo01.pdf")).toEqual({
      kind: "failed",
      reason: "too-large",
    });
  });

  it("失敗の分類: 200 以外は http-<状態>、3xx は redirect、fetch の例外は timeout か network(名前だけで分け、メッセージは読まない)", async () => {
    const f = (impl: () => Promise<Response>) => createJraBabaPastFetcher({ fetch: impl }).fetchPdf("2021pdf/tokyo01.pdf");
    expect(await f(async () => new Response("x", { status: 503 }))).toEqual({ kind: "failed", reason: "http-503" });
    expect(await f(async () => new Response("x", { status: 404 }))).toEqual({ kind: "failed", reason: "http-404" });
    expect(await f(async () => new Response(null, { status: 302, headers: { location: "/x" } }))).toEqual({ kind: "failed", reason: "redirect" });
    expect(
      await f(async () => {
        throw Object.assign(new Error("secret"), { name: "TimeoutError" });
      }),
    ).toEqual({ kind: "failed", reason: "timeout" });
    expect(
      await f(async () => {
        throw new Error("secret");
      }),
    ).toEqual({ kind: "failed", reason: "network" });
  });

  it("PDF の名前の形が違うもの(別のパス・.. ・大文字・拡張子違い)は、取らずに失敗(http-400)にする", async () => {
    let called = 0;
    const { fetchPdf } = createJraBabaPastFetcher({ fetch: async () => ((called += 1), new Response("x")) });
    for (const bad of ["../2021pdf/tokyo01.pdf", "2021pdf/Tokyo01.pdf", "2021pdf/tokyo01.html", "2021pdf/tokyo01.pdf?x=1", "/2021pdf/tokyo01.pdf", "2021/tokyo01.pdf", ""]) {
      expect(await fetchPdf(bad), bad).toEqual({ kind: "failed", reason: "http-400" });
    }
    expect(called).toBe(0);
  });
});
