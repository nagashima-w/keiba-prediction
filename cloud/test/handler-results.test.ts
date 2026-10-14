import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { RequestResultImportResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #208(#182-B): 手動の結果の取り込み `POST /api/results/import`。本文は JSON `{ from, to }`(JST の開催日 8 桁。範囲は両端を含めて 31 日以内。今日は含めない)。
 * 中身は cron と同じ `dispatchResultImports`(窓の未取込を列挙 → 日ごとに、その日の DO へ依頼)。認証・Origin・Content-Type・本文の大きさ・JSON の検査は `/api/analyses/run` と同じ。
 * D1 の列挙と日単位の DO は偽物（呼び出しを記録する）。netkeiba・LLM には出ない（gate は呼ばれない）。今日は NOW = 2026-10-06 09:00 JST。
 */

const ORIGIN = "https://cloud.invalid";
const TODAY = "20261006";

interface Harness {
  readonly names: string[];
  readonly requests: { kaisaiDate: string; raceIds: string[] }[];
  readonly binds: unknown[][];
  /** 列挙(D1)が返す行。 */
  rows: { raceId: string; firstDate: string }[];
  dbFails: boolean;
  /** 日ごとの依頼の挙動の上書き。 */
  requestImpl: (input: { kaisaiDate: string; raceIds: readonly string[] }) => Promise<RequestResultImportResult>;
  env(): Env;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function harness(): Harness {
  const h: Harness = {
    names: [],
    requests: [],
    binds: [],
    rows: [],
    dbFails: false,
    requestImpl: async (input) => ({ accepted: input.raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } }),
    env: () => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            h.binds.push(args);
            return {
              all: async () => {
                if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
                return { results: h.rows };
              },
            };
          },
        }),
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
      ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
      RACE_DAY: {
        idFromName: (name: string) => {
          h.names.push(name);
          return name;
        },
        get: () =>
          ({
            requestResultImport: (input: { kaisaiDate: string; raceIds: string[] }) => {
              h.requests.push({ kaisaiDate: input.kaisaiDate, raceIds: [...input.raceIds] });
              return h.requestImpl(input);
            },
            schedule: NOT_CALLED,
            scheduleMany: NOT_CALLED,
            getBoard: NOT_CALLED,
            getMorningPrior: NOT_CALLED,
            getRaceList: NOT_CALLED,
            requestPlan: NOT_CALLED,
            getPlanProgress: NOT_CALLED,
            getAutoRunResults: NOT_CALLED,
            getNotifications: NOT_CALLED,
            getResultImportProgress: NOT_CALLED,
          }) as never,
      },
    }),
  };
  return h;
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { deps, token, stranger };
}

function post(body: unknown, init: { token?: string; origin?: string | null; contentType?: string | null; headers?: Record<string, string>; raw?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Request(`${ORIGIN}/api/results/import`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}

const GOOD = { from: "20261001", to: "20261005" };

describe("POST /api/results/import: 正常系", () => {
  it("窓の未取込を列挙(1 クエリ。束縛は from・to・1 日 60・手動は 3 日・合計 120)し、日ごとに、その日の DO(名前は開催日)へ依頼して 202。応答は件数だけ", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.rows = [
      { raceId: "202603020211", firstDate: "20261005" },
      { raceId: "202603020212", firstDate: "20261005" },
      { raceId: "202603020111", firstDate: "20261003" },
    ];
    const response = await handle(post(GOOD, { token }), h.env(), {}, deps);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.binds).toEqual([["20261001", "20261005", 60, 3, 120]]);
    expect(h.names).toEqual(["20261005", "20261003"]);
    expect(h.requests).toEqual([
      { kaisaiDate: "20261005", raceIds: ["202603020211", "202603020212"] },
      { kaisaiDate: "20261003", raceIds: ["202603020111"] },
    ]);
    expect(await response.json()).toEqual({ ok: true, listed: 3, days: 2, accepted: 3, failed_days: 0 });
  });

  it("未取込が無ければ DO を呼ばずに 202（0 件）", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const response = await handle(post(GOOD, { token }), h.env(), {}, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, listed: 0, days: 0, accepted: 0, failed_days: 0 });
    expect(h.names).toEqual([]);
  });

  it("範囲の境界: 前日(今日 − 1)までは通る。ちょうど 31 日(両端を含む)は通る。from = to（1 日）も通る", async () => {
    const { deps, token } = await setup();
    for (const body of [
      { from: "20261005", to: "20261005" },
      { from: "20260905", to: "20261005" }, // 9/5〜10/5 = 31 日
    ]) {
      const h = harness();
      const response = await handle(post(body, { token }), h.env(), {}, deps);
      expect(response.status, JSON.stringify(body)).toBe(202);
      expect(h.binds, JSON.stringify(body)).toEqual([[body.from, body.to, 60, 3, 120]]);
    }
  });

  it("D1 の列挙が失敗したら 503（list-failed）。例外の文面・SQL を出さず、DO を呼ばない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.dbFails = true;
    const response = await handle(post(GOOD, { token }), h.env(), {}, deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "result-import-error" } });
    expect(text).not.toContain("SECRET");
    expect(h.names).toEqual([]);
  });

  it("DO への依頼が一部の日で失敗したら 202（failed_days に数える）、すべての日で失敗したら 503。文面は出さない", async () => {
    const { deps, token } = await setup();
    const rows = [
      { raceId: "202603020211", firstDate: "20261005" },
      { raceId: "202603020111", firstDate: "20261003" },
    ];
    const partial = harness();
    partial.rows = rows;
    partial.requestImpl = async (input) => {
      if (input.kaisaiDate === "20261005") throw new Error("DO の詳細 SECRET-DO");
      return { accepted: input.raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
    };
    const r1 = await handle(post(GOOD, { token }), partial.env(), {}, deps);
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ ok: true, listed: 2, days: 2, accepted: 1, failed_days: 1 });

    const all = harness();
    all.rows = rows;
    all.requestImpl = async () => {
      throw new Error("DO の詳細 SECRET-DO");
    };
    const r2 = await handle(post(GOOD, { token }), all.env(), {}, deps);
    expect(r2.status).toBe(503);
    const text = await r2.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "result-import-error" } });
    expect(text).not.toContain("SECRET");
  });
});

describe("POST /api/results/import: 認証・Origin・形式（/api/analyses/run と同じ守り）", () => {
  // Issue #238(契約変更): 別メール(閲覧者)の本文は、認証なしの `forbidden` ではなく管理者専用の固定の本文(`admin-only`)で 403。D1 も DO も呼ばないことは同じ。
  it("認証なし・別メール(閲覧者)は 403 で、D1 も DO も呼ばない", async () => {
    const { deps, stranger } = await setup();
    for (const [token, body] of [[undefined, "forbidden"], [stranger, JSON.stringify({ ok: false, error: { type: "admin-only" } })]] as const) {
      const h = harness();
      const response = await handle(post(GOOD, { token }), h.env(), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(body);
      expect(h.binds).toEqual([]);
      expect(h.names).toEqual([]);
    }
  });

  it.each([
    ["Origin が無い", null],
    ["別のサイト", "https://evil.example"],
    ["Origin: null", "null"],
    ["スキームが違う", "http://cloud.invalid"],
    ["ポートが違う", "https://cloud.invalid:8443"],
  ])("%s は 403（origin-mismatch）で、D1 も DO も呼ばない", async (_name, origin) => {
    const { deps, token } = await setup();
    const h = harness();
    const response = await handle(post(GOOD, { token, origin }), h.env(), {}, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    expect(h.binds).toEqual([]);
    expect(h.names).toEqual([]);
  });

  it("Sec-Fetch-Site が same-origin でない（cross-site・same-site・none）なら 403。same-origin・無しは通る（対照）", async () => {
    const { deps, token } = await setup();
    for (const site of ["cross-site", "same-site", "none"]) {
      const h = harness();
      const response = await handle(post(GOOD, { token, headers: { "Sec-Fetch-Site": site } }), h.env(), {}, deps);
      expect(response.status, site).toBe(403);
      expect(h.binds, site).toEqual([]);
    }
    expect((await handle(post(GOOD, { token, headers: { "Sec-Fetch-Site": "same-origin" } }), harness().env(), {}, deps)).status).toBe(202);
    expect((await handle(post(GOOD, { token }), harness().env(), {}, deps)).status).toBe(202);
  });

  it("Content-Type が application/json でないなら 415。本文が大きすぎる（1 KiB 超）なら 413。D1 も DO も呼ばない", async () => {
    const { deps, token } = await setup();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const h = harness();
      const response = await handle(post(GOOD, { token, contentType }), h.env(), {}, deps);
      expect(response.status, String(contentType)).toBe(415);
      expect(h.binds).toEqual([]);
    }
    const h = harness();
    const big = await handle(post({ ...GOOD, extra: "x".repeat(2000) }, { token }), h.env(), {}, deps);
    expect(big.status).toBe(413);
    expect(h.binds).toEqual([]);
  });
});

describe("POST /api/results/import: 入力の検証（400。D1 も DO も呼ばない）", () => {
  const cases: Array<[string, unknown]> = [
    ["from が無い", { to: "20261005" }],
    ["to が無い", { from: "20261001" }],
    ["from が文字列でない", { from: 20261001, to: "20261005" }],
    ["from が YYYYMMDD でない", { from: "2026-10-01", to: "20261005" }],
    ["to が存在しない日", { from: "20261001", to: "20261031x" }],
    ["存在しない日付", { from: "20260230", to: "20261005" }],
    ["from が to より後", { from: "20261005", to: "20261001" }],
    ["to が今日（含めない）", { from: "20261001", to: TODAY }],
    ["to が未来", { from: "20261001", to: "20261007" }],
    ["from も to も未来", { from: "20261101", to: "20261105" }],
    ["範囲が 32 日（両端を含む）", { from: "20260904", to: "20261005" }],
    ["範囲が 1 年", { from: "20251001", to: "20261005" }],
    ["未知のキー", { ...GOOD, race_id: "202603020211" }],
    ["本文が配列", [GOOD.from, GOOD.to]],
    ["本文が null", null],
  ];
  it.each(cases)("%s", async (_name, body) => {
    const { deps, token } = await setup();
    const h = harness();
    const response = await handle(post(body, { token }), h.env(), {}, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { type: "bad-request" } });
    expect(h.binds).toEqual([]);
    expect(h.names).toEqual([]);
  });

  it("JSON として読めない本文・空の本文は 400", async () => {
    const { deps, token } = await setup();
    for (const raw of ["{not json", ""]) {
      const h = harness();
      const response = await handle(post(null, { token, raw }), h.env(), {}, deps);
      expect(response.status, raw).toBe(400);
      expect(h.binds, raw).toEqual([]);
    }
  });

  it("GET・HEAD は受けない（POST だけ。D1 も DO も呼ばない）", async () => {
    const { deps, token } = await setup();
    for (const method of ["GET", "HEAD", "PUT"]) {
      const h = harness();
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": token });
      const response = await handle(new Request(`${ORIGIN}/api/results/import`, { method, headers }), h.env(), {}, deps);
      expect([404, 405], method).toContain(response.status);
      expect(h.binds, method).toEqual([]);
      expect(h.names, method).toEqual([]);
    }
  });
});
