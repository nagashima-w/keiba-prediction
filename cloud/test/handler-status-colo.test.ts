import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { Board } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #812: 板(`GET /api/analyses/status?kaisai_date=`)に、DO の拠点(`colo`)を足す。**管理者だけ**: 閲覧者には応答のキー自体が無く、DO の拠点の読み出し(`getBoard(true)`)も呼ばない。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20261129";
const RACE_ID = "202603020211";

async function run(role: "admin" | "viewer", colo: Board["colo"], query = `kaisai_date=${DATE}`): Promise<{ status: number; body: Record<string, unknown>; args: unknown[][]; cache: string | null }> {
  const key = await makeKey("k1");
  const token = await signToken(key, role === "admin" ? {} : { email: "friend@example.com" });
  const args: unknown[][] = [];
  const env = {
    ...GOOD_ENV,
    RACE_DAY: {
      idFromName: (n: string) => n,
      get: () => ({
        getBoard: async (...a: unknown[]) => {
          args.push(a);
          return a[0] === true ? ({ kaisaiDate: DATE, races: [], colo } satisfies Board) : ({ kaisaiDate: DATE, races: [] } satisfies Board);
        },
        getMorningPrior: async () => null,
      }),
    } as unknown as Env["RACE_DAY"],
  } as unknown as Env;
  const res = await handle(new Request(`${ORIGIN}/api/analyses/status?${query}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, { keys: () => localKeys(key), now: () => NOW, log: () => {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, args, cache: res.headers.get("cache-control") };
}

describe("板の応答の colo(管理者だけ)", () => {
  it("管理者: getBoard(true) を 1 回呼び、colo と確認日を足す。応答は no-store", async () => {
    const r = await run("admin", { colo: "NRT", day: "20261128" });
    expect(r.status).toBe(200);
    expect(r.args).toEqual([[true]]);
    expect(r.body.colo).toEqual({ colo: "NRT", day: "20261128" });
    expect(r.cache).toBe("no-store");
  });
  it("管理者でも、まだ取れていなければ colo は null(キーはある)", async () => {
    const r = await run("admin", null);
    expect(Object.hasOwn(r.body, "colo")).toBe(true);
    expect(r.body.colo).toBeNull();
  });
  it("閲覧者: 応答に colo のキー自体が無い。getBoard(true) を呼ばない(拠点のメタを読ませない)。応答は no-store", async () => {
    const r = await run("viewer", { colo: "NRT", day: "20261128" });
    expect(r.status).toBe(200);
    expect(r.args).toEqual([[false]]);
    expect(Object.hasOwn(r.body, "colo")).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("NRT");
    expect(r.cache).toBe("no-store");
  });
  it("race_id つきでも同じ(管理者は colo あり、閲覧者は無し)", async () => {
    const q = `kaisai_date=${DATE}&race_id=${RACE_ID}`;
    expect((await run("admin", { colo: "KIX", day: "20261129" }, q)).body.colo).toEqual({ colo: "KIX", day: "20261129" });
    expect(Object.hasOwn((await run("viewer", { colo: "KIX", day: "20261129" }, q)).body, "colo")).toBe(false);
  });
  it("DO が返した形が違う colo(小文字・長さ違い・日付違い)は、管理者でも null に倒す", async () => {
    for (const bad of [{ colo: "nrt", day: "20261128" }, { colo: "NRTT", day: "20261128" }, { colo: "NRT", day: "11/28" }] as const) {
      expect((await run("admin", bad)).body.colo).toBeNull();
    }
  });
});
