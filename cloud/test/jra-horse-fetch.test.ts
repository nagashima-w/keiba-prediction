import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseHorseProfilePage } from "../src/jra-horse-parse";
import { createJraHorseFetcher } from "../src/jra-horse-fetch";
import { JRA_MAX_BODY_BYTES } from "../src/jra-http";

/** Issue #697: 馬の頁の取得口。偽の fetch で、URL・メソッド・本文の上限・失敗の分類を確かめる(実サイトには出ない)。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = new Uint8Array(readFileSync(path.join(ROOT, "fixtures", "jra_695_horse_2018106541_retired2022.html")));

describe("createJraHorseFetcher", () => {
  it("馬の頁の GET。URL は accessU.html の CNAME=pw01dud10<ID>/<2 桁>。Shift_JIS を読んで頁にする", async () => {
    const calls: { url: string; method: string | undefined; redirect: string | undefined }[] = [];
    const fetcher = createJraHorseFetcher({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, redirect: init.redirect });
        return new Response(fixture, { status: 200 });
      },
    });
    const out = await fetcher("2018106541", "DC");
    expect(calls).toEqual([{ url: "https://www.jra.go.jp/JRADB/accessU.html?CNAME=pw01dud102018106541/DC", method: "GET", redirect: "manual" }]);
    expect(out.kind).toBe("page");
    if (out.kind === "page") {
      const parsed = parseHorseProfilePage(out.html);
      expect(parsed.ok && parsed.profile.name).toBe("ラストサムライ");
    }
  });

  it("本文の上限は 256KB でなく 1MB。300KB の頁は読め、1MB を超える頁は too-large", async () => {
    const big = new Uint8Array(300 * 1024).fill(0x20);
    expect(big.byteLength).toBeGreaterThan(JRA_MAX_BODY_BYTES);
    expect((await createJraHorseFetcher({ fetch: async () => new Response(big, { status: 200 }) })("2018106541", "DC")).kind).toBe("page");
    const huge = new Uint8Array(1024 * 1024 + 1);
    expect(await createJraHorseFetcher({ fetch: async () => new Response(huge, { status: 200 }) })("2018106541", "DC")).toEqual({ kind: "failed", reason: "too-large" });
  });

  it("失敗の分類: 200 以外は http、3xx は redirect、fetch の例外は timeout か network(名前だけで分け、メッセージは読まない)", async () => {
    const f = (impl: () => Promise<Response>) => createJraHorseFetcher({ fetch: impl })("2018106541", "DC");
    expect(await f(async () => new Response("x", { status: 503 }))).toEqual({ kind: "failed", reason: "http" });
    expect(await f(async () => new Response("x", { status: 404 }))).toEqual({ kind: "failed", reason: "http" });
    expect(await f(async () => new Response(null, { status: 302, headers: { location: "/x" } }))).toEqual({ kind: "failed", reason: "redirect" });
    expect(
      await f(async () => {
        throw Object.assign(new Error("m"), { name: "TimeoutError" });
      }),
    ).toEqual({ kind: "failed", reason: "timeout" });
    expect(
      await f(async () => {
        throw new TypeError("net");
      }),
    ).toEqual({ kind: "failed", reason: "network" });
  });
});
