import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { BackfillStatus } from "../src/result-backfill-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #217(#167-C): 結果の補完の進捗 `GET /api/results/backfill`。読み取り専用(補完の DO の状態を読むだけ。netkeiba にも LLM にも出ない)。GET だけ。
 * DO は偽物(呼び出しを記録する)。
 */

const ORIGIN = "https://cloud.invalid";

const STATUS: BackfillStatus = {
  state: "ready",
  migrationState: "completed",
  remaining: 321,
  undated: 12,
  imported: 100,
  abandoned: { total: 4, byClass: { "no-payout": 3, "fetch-failed": 1 } },
  tonight: { night: "20261010", dispatched: 30, limit: 150 },
  inflight: null,
  nextRunAt: "2026-10-10T17:00:00.000Z",
  window: { startHour: 1, endHour: 6 },
};

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  readonly names: string[];
  status: BackfillStatus;
  fails: boolean;
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    names: [],
    status: STATUS,
    fails: false,
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {} as unknown as Env["DB"],
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            RESULT_BACKFILL: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                kick: NOT_CALLED,
                getStatus: async () => {
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return h.status;
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
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  return { deps, token };
}

const get = (token?: string, method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/results/backfill`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/results/backfill: 補完の進捗", () => {
  it("補完の DO(単一インスタンス main)の状態をそのまま返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...STATUS });
    expect(h.names).toEqual(["main"]);
  });

  it("認証が無ければ 403 で DO に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(get(), h.env(), {}, deps)).status).toBe(403);
    expect(h.names).toEqual([]);
  });

  it("DO の失敗は 503(固定の種類名だけ。例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: { type: "backfill-error" } });
  });

  it("binding が無い構成も 503(例外で落とさない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(false), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: { type: "backfill-error" } });
  });

  it("メソッドは GET だけ: POST・PUT・DELETE・HEAD は 405(HEAD は allow: GET。ほかは入口の共通の拒否で allow: GET, HEAD)。DO に触れない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await handle(get(token, method, { Origin: ORIGIN }), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe(method === "HEAD" ? "GET" : "GET, HEAD");
    }
    expect(h.names).toEqual([]);
  });
});
