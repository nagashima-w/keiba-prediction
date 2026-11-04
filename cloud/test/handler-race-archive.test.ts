import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { RaceArchiveFetchStatus } from "../src/race-archive-fetch-types";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #554(#549-A3-3): 過去の結果の取得の管理者の口。`GET /api/race-archive`(状態。読み取り専用)と `POST /api/race-archive/resume`(手で再開)。
 * どちらも管理者専用(route-policy.ts)。netkeiba にも LLM にも出ない。DO は偽物。
 */

const ORIGIN = "https://cloud.invalid";

const STATUS: RaceArchiveFetchStatus = {
  state: "manual-stopped",
  waitReason: "stopped",
  nextRunAt: null,
  notBeforeMs: 1_793_718_000_000,
  night: { date: "20261105", requests: 120, saved: 100, failed: 2, rowsRead: 4000 },
  totals: { months: { pending: 0, done: 60, dead: 0 }, days: { pending: 3, listed: 1, done: 400, dead: 0 }, races: { pending: 40, done: 9000, existing: 12, skipped: 3, dead: 1 } },
  skippedByClass: { 結果未確定: 3 },
  lastStop: { kind: "refused", detail: "http-403", at: 1_793_800_000_000, resumeAt: null },
  autoResume: { used: true, resumedNight: "20261106" },
  dbSizeBytes: 31_000_000,
  lastRequestAt: 1_793_800_000_000,
};

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  readonly names: string[];
  readonly calls: string[];
  fails: boolean;
  resumeResult: { resumed: boolean; previous: string };
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    names: [],
    calls: [],
    fails: false,
    resumeResult: { resumed: true, previous: "manual-stopped" },
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {} as unknown as Env["DB"],
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            RACE_ARCHIVE_FETCH: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                kick: NOT_CALLED,
                getStatus: async () => {
                  h.calls.push("getStatus");
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return STATUS;
                },
                resume: async () => {
                  h.calls.push("resume");
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return h.resumeResult;
                },
              }),
            },
          }
        : {}),
    }),
  };
  return h;
}

async function setup() {
  const key = await makeKey("k1");
  return { deps: { keys: () => localKeys(key), now: () => NOW, log: () => {} }, token: await signToken(key) };
}

const status = (token?: string, method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/race-archive`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });
const resume = (token: string | undefined, body: string | null = "{}", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/race-archive/resume`, {
    method: "POST",
    headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), origin: ORIGIN, "content-type": "application/json", ...extra },
    ...(body === null ? {} : { body }),
  });

describe("GET /api/race-archive: 過去の結果の取得の状態", () => {
  it("取得の DO(単一インスタンス main)の状態をそのまま返す。resume は呼ばない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(status(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...STATUS });
    expect(h.names).toEqual(["main"]);
    expect(h.calls).toEqual(["getStatus"]);
  });
  it("認証が無ければ 403 で DO に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(status(), h.env(), {}, deps)).status).toBe(403);
    expect(h.names).toEqual([]);
  });
  it("DO の失敗・binding なしは 503(固定の種類名だけ。例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const failed = await handle(status(token), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, error: { type: "race-archive-error" } });
    const none = await handle(status(token), harness().env(false), {}, deps);
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ ok: false, error: { type: "race-archive-error" } });
  });
  it("GET だけ: POST・PUT・DELETE・HEAD は 405 で DO に触れない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await handle(status(token, method, { Origin: ORIGIN }), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
    }
    expect(h.names).toEqual([]);
  });
});

describe("POST /api/race-archive/resume: 手で再開", () => {
  it("本文 {} で DO の resume を 1 回だけ呼び、結果(再開したか・前の状態)を返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(resume(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resumed: true, previous: "manual-stopped" });
    expect(h.calls).toEqual(["resume"]);
    expect(h.names).toEqual(["main"]);
  });
  it("止まっていないときは resumed false(200)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.resumeResult = { resumed: false, previous: "running" };
    const res = await handle(resume(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resumed: false, previous: "running" });
  });
  it.each([
    ["Origin が無い", { origin: "" }, 403],
    ["別のサイトの Origin", { origin: "https://evil.example" }, 403],
    ["Content-Type が JSON でない", { "content-type": "text/plain" }, 415],
  ] as [string, Record<string, string>, number][])("守り(%s)は DO に触れる前に弾く", async (_name, headers, expected) => {
    const { deps, token } = await setup();
    const h = harness();
    const req = resume(token, "{}", headers);
    if (headers.origin === "") req.headers.delete("origin");
    expect((await handle(req, h.env(), {}, deps)).status).toBe(expected);
    expect(h.calls).toEqual([]);
  });
  it.each([
    ["JSON でない", "not json"],
    ["配列", "[]"],
    ["余計なキーがある", '{"force":true}'],
  ])("本文が不正(%s)は 400 で DO に触れない", async (_name, body) => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(resume(token, body), h.env(), {}, deps)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
  it("認証が無ければ 403。DO の失敗・binding なしは 503(固定の種類名だけ)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(resume(undefined), h.env(), {}, deps)).status).toBe(403);
    h.fails = true;
    const failed = await handle(resume(token), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("SECRET");
    expect((await handle(resume(token), harness().env(false), {}, deps)).status).toBe(503);
  });
  it("GET は 405(POST だけ)で DO に触れない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(new Request(`${ORIGIN}/api/race-archive/resume`, { headers: { "Cf-Access-Jwt-Assertion": token } }), h.env(), {}, deps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(h.calls).toEqual([]);
  });
});
