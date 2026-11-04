import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { RaceArchiveRunsStatus } from "../src/race-archive-runs-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #590(#549-B3-2): 過去の結果の毎晩の変換の管理者の口 `GET /api/race-archive/runs`(状態。読み取り専用)。管理者専用(route-policy.ts)。
 * 手で動かす口(POST)は無い。netkeiba にも LLM にも出ない。DO は偽物。
 */

const ORIGIN = "https://cloud.invalid";

const STATUS: RaceArchiveRunsStatus = {
  state: "stopped",
  waitReason: "stopped",
  stopReason: "capacity",
  nextRunAt: 1_793_900_000_000,
  night: { date: "2026-11-05", rows: 12_345, races: 700, failed: 2 },
  nightlyRowLimit: 30_000,
  cursor: "202105040811",
  catalog: { total: 17_000, byVersion: { "1": 700, null: 16_300 } },
  failing: 1,
  gaveUp: 0,
  rejectedByClass: { "count-mismatch": 3 },
  totals: { races: 700, rows: 9_000 },
  dbSizeBytes: 31_000_000,
  lastStop: { reason: "capacity", at: 1_793_800_000_000 },
};

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  readonly names: string[];
  readonly calls: string[];
  fails: boolean;
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    names: [],
    calls: [],
    fails: false,
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {} as unknown as Env["DB"],
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            RACE_ARCHIVE_RUNS: {
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

const req = (token?: string, method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/race-archive/runs`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/race-archive/runs: 過去の結果の毎晩の変換の状態", () => {
  it("変換の DO(単一インスタンス main)の状態をそのまま返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(req(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...STATUS });
    expect(h.names).toEqual(["main"]);
    expect(h.calls).toEqual(["getStatus"]);
  });

  it("認証が無ければ 403 で DO に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(req(), h.env(), {}, deps)).status).toBe(403);
    expect(h.names).toEqual([]);
  });

  it("DO の失敗・binding なしは 503(固定の種類名だけ。例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const failed = await handle(req(token), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    const body = JSON.stringify(await failed.json());
    expect(body).toBe(JSON.stringify({ ok: false, error: { type: "race-archive-runs-error" } }));
    expect(body).not.toContain("SECRET");
    const none = await handle(req(token), harness().env(false), {}, deps);
    expect(none.status).toBe(503);
  });

  it("GET だけ: POST・PUT・DELETE・HEAD は 405 で DO に触れない(手で動かす口は無い)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await handle(req(token, method, { Origin: ORIGIN }), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
    }
    expect(h.names).toEqual([]);
  });
});
