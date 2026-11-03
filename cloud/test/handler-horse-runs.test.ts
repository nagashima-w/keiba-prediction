import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { STATUS_DAYS_DEFAULT, STATUS_DAYS_MAX } from "../src/horse-runs-repository";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #256 段階A: 各馬の戦績の蓄積の診断 `GET /api/horse-runs`(管理者専用・読み取り専用)。
 * D1 は偽物(発行された SQL を記録する)。netkeiba・LLM には出ない。SQL の中身の正しさは horse-runs-status.test.ts(ローカルの D1)で確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

/** 出どころごとの総数の行(GROUP BY source)。 */
interface TotalsRow {
  readonly source: string | null;
  readonly rows: number;
  readonly horses: number;
  readonly firstSeenMin: number | null;
  readonly firstSeenMax: number | null;
  readonly runDateMin: string | null;
  readonly runDateMax: string | null;
}
const API_TOTALS: TotalsRow = { source: null, rows: 12, horses: 3, firstSeenMin: 1, firstSeenMax: 2, runDateMin: "2025/01/01", runDateMax: "2026/06/01" };

interface Harness {
  readonly sqls: string[];
  readonly binds: unknown[][];
  fails: boolean;
  env(): Env;
}

function harness(totals: readonly TotalsRow[] = [API_TOTALS]): Harness {
  const h: Harness = {
    sqls: [],
    binds: [],
    fails: false,
    env: () => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
      DB: {
        prepare: (sql: string) => {
          h.sqls.push(sql);
          const run = async (): Promise<unknown> => {
            if (h.fails) throw new Error("D1 の詳細 SECRET-D1");
            return null;
          };
          const statement = {
            bind: (...args: unknown[]) => {
              h.binds.push(args);
              return statement;
            },
            first: async () => {
              await run();
              if (sql.includes("COALESCE(SUM(n)")) {
                return sql.includes("source = 'result'") ? { cells: 6, runs: 90, n10: 4, n30: 2, n100: 0, resultRuns: 50 } : { cells: 4, runs: 40, n10: 2, n30: 1, n100: 0 };
              }
              return null;
            },
            all: async () => {
              await run();
              // 表の総数は出どころごと(GROUP BY source)の行で返る(Issue #552)。source が NULL = 戦績 API 由来
              if (sql.includes("COUNT(DISTINCT horse_id)")) {
                return { results: totals };
              }
              return { results: [] };
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
  new Request(`${ORIGIN}/api/horse-runs${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/horse-runs: 診断", () => {
  it("既定(14 日・セルなし)で 200。表の状態・保存の集計・段階Aの限界の注記を返し、セルの走査(全件走査)は発行しない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; table: { rows: number; horses: number }; saves: { days: number; sinceMs: number }; note: string; cells?: unknown };
    expect(body.ok).toBe(true);
    expect(body.table).toMatchObject({ rows: 12, horses: 3 });
    expect((body as { resultRows?: unknown }).resultRows).toStrictEqual({ rows: 0, horses: 0, byParserVersion: {}, runDateMin: null, runDateMax: null }); // Issue #552: 結果ページ由来の行は別の欄
    expect(body.saves.days).toBe(STATUS_DAYS_DEFAULT);
    expect(body.saves.sinceMs).toBe(NOW.getTime() - STATUS_DAYS_DEFAULT * 86_400_000);
    expect(body.note).toContain("手動の発走前だけの分析");
    expect(body.cells).toBeUndefined();
    expect(h.sqls.some((s) => s.includes("COALESCE(SUM(n)"))).toBe(false);
    // 読み取りだけ(書き込みの文を発行しない)
    expect(h.sqls.every((s) => /^SELECT/.test(s))).toBe(true);
  });

  it("結果ページ由来の行だけがあり、戦績 API の行が 0 件のとき: table は 0 件のまま、resultRows にその行が出る(結果ページ由来の行を table に混ぜない)", async () => {
    const { deps, token } = await setup();
    const result: TotalsRow = { source: "result", rows: 7, horses: 5, firstSeenMin: 10, firstSeenMax: 20, runDateMin: "2024/02/03", runDateMax: "2026/05/06" };
    const h = harness([result]);
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { table: { rows: number; horses: number; runDateMin: unknown; firstSeenMin: unknown }; resultRows: { rows: number; horses: number; runDateMin: unknown; runDateMax: unknown } };
    expect(body.table).toMatchObject({ rows: 0, horses: 0, runDateMin: null, firstSeenMin: null });
    expect(body.resultRows).toMatchObject({ rows: 7, horses: 5, runDateMin: "2024/02/03", runDateMax: "2026/05/06" });
    // 前提: 結果ページ由来の行の値を結果の欄に出している(上の table の 0 は、行そのものが読まれていないからではない)
    expect(body.resultRows.rows).not.toBe(body.table.rows);
  });

  it("days=7&cells=1: 期間が 7 日になり、セルの分布も返す(全件走査の文を発行する)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token, "?days=7&cells=1"), h.env(), {}, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saves: { days: number; sinceMs: number }; cells: unknown };
    expect(body.saves.days).toBe(7);
    expect(body.saves.sinceMs).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(body.cells).toStrictEqual({ cells: 4, runs: 40, n10: 2, n30: 1, n100: 0 });
    expect((body as { cellsWithResult?: unknown }).cellsWithResult).toStrictEqual({ cells: 6, runs: 90, n10: 4, n30: 2, n100: 0, resultRuns: 50 }); // Issue #591
    expect(h.sqls.some((s) => s.includes("COALESCE(SUM(n)"))).toBe(true);
  });

  it(`days は 1〜${STATUS_DAYS_MAX} の整数、cells は 0 か 1。未知のクエリ・重複は 400(D1 に触れない)`, async () => {
    const { deps, token } = await setup();
    for (const query of ["?days=0", `?days=${STATUS_DAYS_MAX + 1}`, "?days=abc", "?days=1.5", "?days=", "?cells=2", "?x=1", "?days=1&days=2", "?cells=1&cells=0"]) {
      const h = harness();
      const res = await handle(get(token, query), h.env(), {}, deps);
      expect(res.status, query).toBe(400);
      expect(h.sqls, query).toEqual([]);
    }
    // 境界の内側は通る
    for (const query of ["?days=1", `?days=${STATUS_DAYS_MAX}`, "?cells=0"]) {
      const h = harness();
      expect((await handle(get(token, query), h.env(), {}, deps)).status, query).toBe(200);
    }
  });

  it("別サイトからの要求(Sec-Fetch-Site: cross-site・same-site)は 403 origin-mismatch で、D1 に触れない。アドレスバー(none)・同じオリジン・ヘッダなしは通る", async () => {
    const { deps, token } = await setup();
    for (const site of ["cross-site", "same-site"]) {
      const h = harness();
      const res = await handle(get(token, "", "GET", { "sec-fetch-site": site }), h.env(), {}, deps);
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
      expect(h.sqls, site).toEqual([]);
    }
    for (const site of ["none", "same-origin"]) {
      const h = harness();
      expect((await handle(get(token, "", "GET", { "sec-fetch-site": site }), h.env(), {}, deps)).status, site).toBe(200);
    }
  });

  it("GET 以外(管理者の POST・HEAD)は 405 で、D1 に触れない", async () => {
    const { deps, token } = await setup();
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
      const h = harness();
      const res = await handle(get(token, "", method), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toMatch(/^GET\b/); // POST などは入口全体の method の関門が先に断る("GET, HEAD")。HEAD はこのルートが断る("GET")
      expect(h.sqls, method).toEqual([]);
    }
  });

  it("認証が無ければ 403 で D1 に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(get(undefined), h.env(), {}, deps)).status).toBe(403);
    expect(h.sqls).toEqual([]);
  });

  it("D1 の失敗は 503(固定の種類名だけ。例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fails = true;
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "horse-runs-error" } });
    expect(text).not.toContain("SECRET-D1");
  });
});
