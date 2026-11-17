import { describe, expect, it } from "vitest";
import { handle, type Env, type JraBabaPastBackfillNamespaceLike } from "../src/handler";
import type { BabaPastBackfillStatus } from "../src/jra-baba-past-backfill-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #769: 過去の馬場の埋め戻しの進み具合を管理者が見る入口 `GET /api/baba-past`(管理者専用・読み取り専用)。
 * D1・DO は偽物。JRA・netkeiba・LLM・R2 には出ない。SQL の中身の正しさは baba-past-repository.integration.test.ts(ローカルの D1)で確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

const STATUS: BabaPastBackfillStatus = {
  enabled: true,
  firstYear: 2021,
  lastYear: 2022,
  finished: false,
  waitReason: "active",
  day: "20261117",
  dayRows: 55,
  queued: 40,
  years: { "2021": "ok" },
};

interface Harness {
  readonly sqls: string[];
  readonly binds: unknown[][];
  statusCalls: number;
  fails: boolean;
  doFails: boolean;
  env(withDo?: boolean): Env;
}

function harness(): Harness {
  const rows: Record<string, Record<string, unknown>[]> = {
    "2021pdf/": [
      { source_pdf: "2021pdf/tokyo01.pdf", result: "ok", rows_saved: 12, r2_key: "SECRET-KEY" },
      { source_pdf: "2021pdf/tokyo02.pdf", result: "ok", rows_saved: 9 },
      { source_pdf: "2021pdf/tokyo03.pdf", result: "shape-mismatch", rows_saved: 0 },
    ],
    "2022pdf/": [],
  };
  const h: Harness = {
    sqls: [],
    binds: [],
    statusCalls: 0,
    fails: false,
    doFails: false,
    env: (withDo = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      ...(withDo
        ? {
            JRA_BABA_PAST_BACKFILL: {
              idFromName: () => "id",
              get: () => ({
                kick: NOT_CALLED,
                status: async () => {
                  h.statusCalls += 1;
                  if (h.doFails) throw new Error("DO の詳細 SECRET-DO");
                  return STATUS;
                },
              }),
            } satisfies JraBabaPastBackfillNamespaceLike,
          }
        : {}),
      DB: {
        prepare: (sql: string) => {
          h.sqls.push(sql);
          const statement = {
            bind: (...args: unknown[]) => {
              h.binds.push(args);
              return statement;
            },
            all: async () => {
              if (h.fails) throw new Error("D1 の詳細 SECRET-D1");
              const key = String(h.binds.at(-1)?.[0]);
              return { results: rows[key] ?? [] };
            },
          };
          return statement;
        },
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
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

const get = (token: string | undefined, query = "", method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/baba-past${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/baba-past: 進み具合", () => {
  it("200。DO の進み具合と、年ごとの PDF の記録の集計(PDF の数・書いた行数・結果の分類別の数)を返す。R2 のキー・想定外の列は出さない。読むのは SELECT だけ", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      status: { enabled: true, first_year: 2021, last_year: 2022, finished: false, wait_reason: "active", day: "20261117", day_rows: 55, queued: 40, years: { "2021": "ok" } },
      pdfs: {
        "2021": { total: 3, rows: 21, results: { ok: 2, "shape-mismatch": 1 } },
        "2022": { total: 0, rows: 0, results: {} },
      },
    });
    expect(text).not.toContain("SECRET-KEY");
    expect(h.statusCalls).toBe(1);
    expect(h.sqls).toHaveLength(2); // 年ごとに 1 本(2021・2022)
    expect(h.sqls.every((q) => /^\s*SELECT\b/.test(q))).toBe(true);
    expect(h.binds).toEqual([["2021pdf/", "2021pdf0"], ["2022pdf/", "2022pdf0"]]);
  });

  it("DO の binding が無い構成(ローカルなど)は status が null。D1 の集計(年の範囲は既定の 2021〜2024)は返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(false), {}, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: unknown; pdfs: Record<string, unknown> };
    expect(body.status).toBeNull();
    expect(Object.keys(body.pdfs)).toEqual(["2021", "2022", "2023", "2024"]);
  });

  it("閲覧者(admin でない)には開かない。認証なしは 401 か 403。POST などは 405", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(get(undefined), h.env(), {}, deps)).status).toBeGreaterThanOrEqual(401);
    expect((await handle(get(token, "", "POST"), h.env(), {}, deps)).status).toBe(405);
    expect(h.sqls).toEqual([]);
  });

  it("クエリは受け付けない(400。D1 に触れない)。別サイトからの要求は 403", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(get(token, "?year=2021"), h.env(), {}, deps)).status).toBe(400);
    expect((await handle(get(token, "", "GET", { "Sec-Fetch-Site": "cross-site" }), h.env(), {}, deps)).status).toBe(403);
    expect(h.sqls).toEqual([]);
    expect(h.statusCalls).toBe(0);
  });

  it("D1 か DO の失敗は 503 の固定の種類名だけ(例外の文面を出さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const a = await handle(get(token), h.env(), {}, deps);
    expect(a.status).toBe(503);
    const textA = await a.text();
    expect(JSON.parse(textA)).toEqual({ ok: false, error: { type: "baba-past-error" } });
    expect(textA).not.toContain("SECRET");
    h.fails = false;
    h.doFails = true;
    const b = await handle(get(token), h.env(), {}, deps);
    expect(b.status).toBe(503);
    expect(await b.text()).not.toContain("SECRET");
  });
});
