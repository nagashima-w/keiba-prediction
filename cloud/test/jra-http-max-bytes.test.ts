import { describe, expect, it } from "vitest";

import { JRA_ENTRY_MAX_BODY_BYTES, JRA_MAX_BODY_BYTES, fetchOne, type JraFetchLike } from "../src/jra-http";

/**
 * Issue #639: 詳細ページ(約 25 万バイト。18 頭で 252,680 バイト)は、馬場の取得の上限(256KB)のすぐ手前。
 * `fetchOne` に任意の上限を渡せるようにし、**既定(馬場の取得・確認口)は 256KB のまま**であることを固定する。
 */

const bodyOf = (bytes: number, withLength: boolean): Response => {
  const data = new Uint8Array(bytes).fill(0x61);
  return new Response(data, { status: 200, headers: withLength ? { "content-length": String(bytes), "content-type": "text/html" } : { "content-type": "text/html" } });
};
const fetchReturning = (make: () => Response): JraFetchLike => async () => make();

describe("fetchOne の本文の上限", () => {
  const OVER_DEFAULT = JRA_MAX_BODY_BYTES + 1000;

  it("既定は 256KB: 超えたら too-large(content-length が申告されていても、無くても)", async () => {
    for (const withLength of [true, false]) {
      const r = await fetchOne(fetchReturning(() => bodyOf(OVER_DEFAULT, withLength)), "https://example.invalid/", { method: "GET" }, 5000);
      expect(r.summary.status, `withLength=${withLength}`).toBe("too-large");
      expect(r.body).toBeNull();
    }
  });
  it("上限を引数で広げれば、同じ大きさでも読める(申告ありでも無しでも)", async () => {
    for (const withLength of [true, false]) {
      const r = await fetchOne(fetchReturning(() => bodyOf(OVER_DEFAULT, withLength)), "https://example.invalid/", { method: "GET" }, 5000, JRA_ENTRY_MAX_BODY_BYTES);
      expect(r.summary.status, `withLength=${withLength}`).toBe(200);
      expect(r.body?.byteLength).toBe(OVER_DEFAULT);
    }
  });
  it("広げた上限も超えたら too-large", async () => {
    const r = await fetchOne(fetchReturning(() => bodyOf(JRA_ENTRY_MAX_BODY_BYTES + 1, false)), "https://example.invalid/", { method: "GET" }, 5000, JRA_ENTRY_MAX_BODY_BYTES);
    expect(r.summary.status).toBe("too-large");
  });
  it("詳細ページの上限は、実測した最大(18 頭で 252,680 バイト)より十分に大きく、馬場の既定より大きい", () => {
    expect(JRA_ENTRY_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(JRA_ENTRY_MAX_BODY_BYTES).toBeGreaterThan(JRA_MAX_BODY_BYTES);
    expect(JRA_MAX_BODY_BYTES).toBe(256 * 1024);
  });
});
