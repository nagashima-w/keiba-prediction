import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { ReportStatus, RequestReportResult } from "../src/daily-report-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #235: 日報の API。`GET /api/reports`(一覧)・`GET /api/reports/{YYYYMMDD}`(本文 + 進行状況)・`POST /api/reports/run`(手動の作成)。
 * D1 と日報の DO は偽物(呼び出しを記録する)。netkeiba・LLM には出ない(Worker は日報の DO へ依頼するだけ。LLM を呼ぶのは DO)。今日は NOW = 2026-10-06 09:00 JST。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface StoredRow {
  kaisaiDate: string;
  createdAt: string;
  model: string | null;
  raceCount: number;
  totalStake: number;
  totalReturn: number;
  summary: string | null;
  bodyJson: string;
  llmCallsJson: string | null;
}

const ROW_A: StoredRow = { kaisaiDate: "20261005", createdAt: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 24, totalStake: 12000, totalReturn: 15600, summary: "総括A", bodyJson: JSON.stringify({ format: 1, kaisaiDate: "20261005", races: [], note: null }), llmCallsJson: '[{"ok":true}]' };
const ROW_B: StoredRow = { kaisaiDate: "20261004", createdAt: "2026-10-04T11:00:00.000Z", model: null, raceCount: 10, totalStake: 0, totalReturn: 0, summary: null, bodyJson: JSON.stringify({ format: 1 }), llmCallsJson: null };

interface Harness {
  rows: StoredRow[];
  dbFails: boolean;
  readonly dbCalls: string[];
  readonly names: string[];
  readonly requests: Array<{ kaisaiDate: string; mode: string }>;
  status: ReportStatus | null;
  statusFails: boolean;
  requestResult: RequestReportResult;
  requestFails: boolean;
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    rows: [ROW_A, ROW_B],
    dbFails: false,
    dbCalls: [],
    names: [],
    requests: [],
    status: null,
    statusFails: false,
    requestResult: { accepted: true },
    requestFails: false,
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              h.dbCalls.push(sql);
              if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
              return h.rows.find((r) => r.kaisaiDate === args[0]) ?? null;
            },
            all: async () => {
              h.dbCalls.push(sql);
              if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
              return { results: [...h.rows].sort((a, b) => (a.kaisaiDate < b.kaisaiDate ? 1 : -1)).slice(0, Number(args[0])) };
            },
          }),
        }),
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
      ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            DAILY_REPORT: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                requestReport: async (input: { kaisaiDate: string; mode: string }) => {
                  h.requests.push(input);
                  if (h.requestFails) throw new Error("DO の詳細 SECRET-DO");
                  return h.requestResult;
                },
                getStatus: async () => {
                  if (h.statusFails) throw new Error("DO の詳細 SECRET-DO");
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

const auth = (token?: string): Record<string, string> => (token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token });
const get = (path: string, token?: string, method = "GET"): Request => new Request(`${ORIGIN}${path}`, { method, headers: auth(token) });
const post = (body: unknown, token?: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/reports/run`, {
    method: "POST",
    headers: { ...auth(token), origin: ORIGIN, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("認証: 3 つのルートとも、認証の後ろにある", () => {
  it("トークンが無ければ 403(D1・DO を呼ばない)", async () => {
    const { deps } = await setup();
    const h = harness();
    for (const req of [get("/api/reports"), get("/api/reports/20261005"), post({ date: "20261005" })]) {
      expect((await handle(req, h.env(), {}, deps)).status).toBe(403);
    }
    expect(h.dbCalls).toEqual([]);
    expect(h.requests).toEqual([]);
  });
});

describe("GET /api/reports: 日報の一覧", () => {
  it("開催日の新しい順に、本文を含まない行を返す(キーは snake_case)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get("/api/reports", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      ok: true,
      reports: [
        { date: "20261005", created_at: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", race_count: 24, total_stake: 12000, total_return: 15600, summary: "総括A" },
        { date: "20261004", created_at: "2026-10-04T11:00:00.000Z", model: null, race_count: 10, total_stake: 0, total_return: 0, summary: null },
      ],
    });
  });

  it("日報が 0 件でも空の配列を返す。クエリは受け付けない(400)。GET 以外は 405", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.rows = [];
    expect(await (await handle(get("/api/reports", token), h.env(), {}, deps)).json()).toStrictEqual({ ok: true, reports: [] });
    expect((await handle(get("/api/reports?limit=5", token), h.env(), {}, deps)).status).toBe(400);
    const head = await handle(get("/api/reports", token, "HEAD"), h.env(), {}, deps);
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
  });

  it("D1 の失敗は 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.dbFails = true;
    const res = await handle(get("/api/reports", token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toStrictEqual({ ok: false, error: { type: "report-error" } });
    expect(text).not.toContain("SECRET-D1");
  });
});

describe("GET /api/reports/{YYYYMMDD}: 1 日の日報", () => {
  it("日報があれば本文つきで返し、進行状況(job)は null(日報の DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get("/api/reports/20261005", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      ok: true,
      report: { date: "20261005", created_at: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", race_count: 24, total_stake: 12000, total_return: 15600, summary: "総括A", body: { format: 1, kaisaiDate: "20261005", races: [], note: null } },
      job: null,
      job_status: "ok",
    });
    expect(h.names).toEqual([]);
  });

  it("日報が無ければ report は null で、日報の DO の進行状況(作成中・失敗)を返す。DO が失敗しても 200 で job は null(画面を壊さない)。ただし失敗は job_status が unavailable で、ジョブが無い(ok)と区別する(Issue #245)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.status = { phase: "gather", status: "running", attempts: 1 };
    const res = await handle(get("/api/reports/20261003", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true, report: null, job: { phase: "gather", status: "running", attempts: 1 }, job_status: "ok" });
    expect(h.names).toEqual(["main"]);
    h.statusFails = true;
    const again = await handle(get("/api/reports/20261003", token), h.env(), {}, deps);
    expect(await again.json()).toStrictEqual({ ok: true, report: null, job: null, job_status: "unavailable" });
    // 前提: DO が応答して「ジョブが無い」(null)のときは ok。失敗(例外)とは別の値になる
    h.statusFails = false;
    h.status = null;
    const none = await handle(get("/api/reports/20261003", token), h.env(), {}, deps);
    expect(await none.json()).toStrictEqual({ ok: true, report: null, job: null, job_status: "ok" });
    const noBinding = await handle(get("/api/reports/20261003", token), h.env(false), {}, deps);
    expect(await noBinding.json()).toStrictEqual({ ok: true, report: null, job: null, job_status: "ok" }); // binding が無い構成には、ジョブが存在しえない
  });

  it("開催日の形が 8 桁の実在の日でなければ 404(D1 を引かない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const path of ["/api/reports/2026100", "/api/reports/20261340", "/api/reports/abc", "/api/reports/20261005/x"]) {
      expect((await handle(get(path, token), h.env(), {}, deps)).status, path).toBe(404);
    }
    expect(h.dbCalls).toEqual([]);
  });

  it("D1 の失敗は 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.dbFails = true;
    const res = await handle(get("/api/reports/20261005", token), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET-D1");
  });
});

describe("POST /api/reports/run: 手動の作成", () => {
  it("今日以前の開催日なら日報の DO に mode: manual で依頼し、202 を返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(post({ date: "20261006" }, token), h.env(), {}, deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toStrictEqual({ ok: true, accepted: true, date: "20261006" });
    expect(h.requests).toEqual([{ kaisaiDate: "20261006", mode: "manual" }]);
    expect(h.names).toEqual(["main"]);
  });

  it.each([
    ["作成済み", { accepted: false, reason: "exists" } as RequestReportResult, "already-exists"],
    ["作成中", { accepted: false, reason: "in-progress" } as RequestReportResult, "in-progress"],
  ])("DO が断ったとき(%s)は 409", async (_name, result, type) => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestResult = result;
    const res = await handle(post({ date: "20261005" }, token), h.env(), {}, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toStrictEqual({ ok: false, error: { type } });
  });

  it("入力の検証: 未来の日・不正な日付・型違い・余計なキー・欠けたキーは 400(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const body of [{ date: "20261007" }, { date: "20261340" }, { date: 20261005 }, { date: "20261005", mode: "auto" }, {}, { date: "2026-10-05" }]) {
      expect((await handle(post(body, token), h.env(), {}, deps)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.requests).toEqual([]);
  });

  it("守り: Origin が違えば 403・Content-Type が JSON でなければ 415・JSON でなければ 400(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(post({ date: "20261005" }, token, { origin: "https://evil.invalid" }), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(post({ date: "20261005" }, token, { "content-type": "text/plain" }), h.env(), {}, deps)).status).toBe(415);
    expect((await handle(post("{broken", token), h.env(), {}, deps)).status).toBe(400);
    expect(h.requests).toEqual([]);
  });

  it("DO の失敗・binding なしは 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestFails = true;
    const failed = await handle(post({ date: "20261005" }, token), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("SECRET-DO");
    const none = await handle(post({ date: "20261005" }, token), h.env(false), {}, deps);
    expect(none.status).toBe(503);
  });

  it("GET は 405(Allow: POST)", async () => {
    const { deps, token } = await setup();
    const res = await handle(get("/api/reports/run", token), harness().env(), {}, deps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
