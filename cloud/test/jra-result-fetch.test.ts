import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createJraResultFetcher } from "../src/jra-result-fetch";
import { JRA_MAX_BODY_BYTES } from "../src/jra-http";
import { parseResultPage } from "../src/jra-result-parse";

/** Issue #698: 過去の結果の取得口。偽の fetch で、URL・メソッド・本文・本文の上限・失敗の分類を確かめる(実サイトには出ない)。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = new Uint8Array(readFileSync(path.join(ROOT, "fixtures", "jra_695_result_nakayama01R_20210105.html")));

describe("createJraResultFetcher", () => {
  it("POST accessS.html、本文は cname=<cname>(form)。リダイレクトは追わない。Shift_JIS を読んで頁にする", async () => {
    const calls: { url: string; method: string | undefined; redirect: string | undefined; body: unknown; type: string | null }[] = [];
    const fetcher = createJraResultFetcher({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, redirect: init.redirect, body: init.body, type: new Headers(init.headers).get("content-type") });
        return new Response(fixture, { status: 200 });
      },
    });
    const out = await fetcher("pw01sde1006202101010120210105/4F");
    expect(calls).toEqual([{ url: "https://www.jra.go.jp/JRADB/accessS.html", method: "POST", redirect: "manual", body: "cname=pw01sde1006202101010120210105/4F", type: "application/x-www-form-urlencoded" }]);
    expect(out.kind).toBe("page");
    if (out.kind === "page") expect(parseResultPage(out.html)).toMatchObject({ ok: true, headCount: 16 });
  });

  it("本文の上限は既定の 256KB(取った最大の頁は 97KB 前後)。fixtures の最大は上限の半分以下。256KB を超える頁は too-large", async () => {
    const sizes = ["jra_695_result_hanshin01R_20250405.html", "jra_695_skl_month_202101.html", "jra_695_skl_past_search_20261109.html", "jra_695_srl_nakayama_20210105.html"].map((f) => readFileSync(path.join(ROOT, "fixtures", f)).byteLength);
    expect(Math.max(...sizes)).toBeLessThan(JRA_MAX_BODY_BYTES / 2);
    const huge = new Uint8Array(JRA_MAX_BODY_BYTES + 1);
    expect(await createJraResultFetcher({ fetch: async () => new Response(huge, { status: 200 }) })("pw01skl00999999/B3")).toEqual({ kind: "failed", reason: "too-large" });
    const ok = new Uint8Array(JRA_MAX_BODY_BYTES).fill(0x20);
    expect((await createJraResultFetcher({ fetch: async () => new Response(ok, { status: 200 }) })("pw01skl00999999/B3")).kind).toBe("page");
  });

  it("失敗の分類: 200 以外は http、3xx は redirect、fetch の例外は timeout か network(名前だけで分け、メッセージは読まない)", async () => {
    const f = (impl: () => Promise<Response>) => createJraResultFetcher({ fetch: impl })("pw01skl00999999/B3");
    expect(await f(async () => new Response("x", { status: 503 }))).toEqual({ kind: "failed", reason: "http" });
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
});
