import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #279(#265-A): 月報の API。`GET /api/monthly-reports`(一覧)・`GET /api/monthly-reports/{YYYYMM}`(本文)。読み取り専用(D1 の monthly_reports を読むだけ)で、閲覧者にも見せる(ユーザーの決定)。
 * D1 は偽物(呼び出しを記録する)。DO・LLM・netkeiba には出ない。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface StoredRow {
  month: string;
  createdAt: string;
  model: string | null;
  raceCount: number;
  totalStake: number;
  totalReturn: number;
  summary: string | null;
  bodyJson: string;
  llmCallsJson: string | null;
}

const ROW_A: StoredRow = { month: "202609", createdAt: "2026-09-30T13:00:00.000Z", model: null, raceCount: 120, totalStake: 40000, totalReturn: 34000, summary: null, bodyJson: JSON.stringify({ format: 1, month: "202609", lastDayPending: false }), llmCallsJson: null };
const ROW_B: StoredRow = { month: "202608", createdAt: "2026-08-31T13:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 80, totalStake: 0, totalReturn: 0, summary: "総括B", bodyJson: JSON.stringify({ format: 1, month: "202608" }), llmCallsJson: '[{"ok":true}]' };

interface Harness {
  rows: StoredRow[];
  dbFails: boolean;
  readonly dbCalls: string[];
  env(): Env;
}

function harness(): Harness {
  const h: Harness = {
    rows: [ROW_A, ROW_B],
    dbFails: false,
    dbCalls: [],
    env: () => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              h.dbCalls.push(sql);
              if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
              return h.rows.find((r) => r.month === args[0]) ?? null;
            },
            all: async () => {
              h.dbCalls.push(sql);
              if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
              return { results: [...h.rows].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, Number(args[0])) };
            },
          }),
        }),
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
      ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    }),
  };
  return h;
}

async function setup(email?: string) {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key, email === undefined ? undefined : { email });
  return { deps, token };
}

const get = (path: string, token?: string, method = "GET"): Request => new Request(`${ORIGIN}${path}`, { method, headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token } });

describe("認証: 2 つのルートとも、認証の後ろにある", () => {
  it("トークンが無ければ 403(D1 を呼ばない)", async () => {
    const { deps } = await setup();
    const h = harness();
    for (const path of ["/api/monthly-reports", "/api/monthly-reports/202609"]) {
      expect((await handle(get(path), h.env(), {}, deps)).status, path).toBe(403);
    }
    expect(h.dbCalls).toEqual([]);
  });
});

describe("GET /api/monthly-reports: 月報の一覧", () => {
  it("月の新しい順に、本文を含まない行を返す(キーは snake_case)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get("/api/monthly-reports", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      ok: true,
      reports: [
        { month: "202609", created_at: "2026-09-30T13:00:00.000Z", model: null, race_count: 120, total_stake: 40000, total_return: 34000, summary: null },
        { month: "202608", created_at: "2026-08-31T13:00:00.000Z", model: "claude-sonnet-5-5", race_count: 80, total_stake: 0, total_return: 0, summary: "総括B" },
      ],
    });
  });

  it("閲覧者(管理者以外のログイン)にも返す", async () => {
    const { deps, token } = await setup("friend@example.com");
    const h = harness();
    const res = await handle(get("/api/monthly-reports", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reports: unknown[] }).reports).toHaveLength(2);
  });

  it("月報が 0 件でも空の配列を返す。クエリは受け付けない(400)。GET 以外は(管理者でも)405", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.rows = [];
    expect(await (await handle(get("/api/monthly-reports", token), h.env(), {}, deps)).json()).toStrictEqual({ ok: true, reports: [] });
    expect((await handle(get("/api/monthly-reports?limit=5", token), h.env(), {}, deps)).status).toBe(400);
    const head = await handle(get("/api/monthly-reports", token, "HEAD"), h.env(), {}, deps);
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    expect((await handle(get("/api/monthly-reports", token, "POST"), h.env(), {}, deps)).status).toBe(405);
  });

  it("D1 の失敗は 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.dbFails = true;
    const res = await handle(get("/api/monthly-reports", token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toStrictEqual({ ok: false, error: { type: "report-error" } });
    expect(text).not.toContain("SECRET-D1");
  });
});

describe("GET /api/monthly-reports/{YYYYMM}: 1 か月の月報", () => {
  it("月報があれば本文つきで返す。閲覧者にも返す", async () => {
    const { deps, token } = await setup("friend@example.com");
    const h = harness();
    const res = await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      ok: true,
      report: { month: "202609", created_at: "2026-09-30T13:00:00.000Z", model: null, race_count: 120, total_stake: 40000, total_return: 34000, summary: null, body: { format: 1, month: "202609", lastDayPending: false } },
      job: null, // 閲覧者は DO に触れない(Issue #280。進行状況は管理者だけ)
      job_status: "ok",
    });
  });

  it("月報が無い月は report: null(200。画面が『まだありません』と出す)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get("/api/monthly-reports/202607", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true, report: null, job: null, job_status: "ok" });
  });

  it("月の形が 6 桁の実在の月でなければ 404(D1 を引かない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const path of ["/api/monthly-reports/20260", "/api/monthly-reports/202613", "/api/monthly-reports/202600", "/api/monthly-reports/abcdef", "/api/monthly-reports/20260901", "/api/monthly-reports/202609/x", "/api/monthly-reports/"]) {
      expect((await handle(get(path, token), h.env(), {}, deps)).status, path).toBe(404);
    }
    expect(h.dbCalls).toEqual([]);
  });

  it("クエリは受け付けない(400)。GET 以外は(管理者でも)405", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(get("/api/monthly-reports/202609?x=1", token), h.env(), {}, deps)).status).toBe(400);
    expect((await handle(get("/api/monthly-reports/202609", token, "POST"), h.env(), {}, deps)).status).toBe(405);
  });

  it("D1 の失敗は 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.dbFails = true;
    const res = await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET-D1");
  });
});

describe("役割: 閲覧者は読み取り(GET)だけ", () => {
  it("閲覧者の POST・HEAD は 403(管理者専用に倒れる)。GET は 200", async () => {
    const { deps, token } = await setup("friend@example.com");
    const h = harness();
    expect((await handle(get("/api/monthly-reports", token, "POST"), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(get("/api/monthly-reports/202609", token, "POST"), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(get("/api/monthly-reports", token, "HEAD"), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(get("/api/monthly-reports/run", token), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(get("/api/monthly-reports", token), h.env(), {}, deps)).status).toBe(200);
  });
});
