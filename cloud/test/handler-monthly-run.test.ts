import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { MonthlyMode, MonthlyStatus, RequestMonthlyResult } from "../src/monthly-report-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #280(#265-B): `POST /api/monthly-reports/run`(管理者専用)と、`GET /api/monthly-reports/{YYYYMM}` の進行状況(管理者だけ DO を読む)。
 * 作成と作り直しは `regenerate` フラグで分ける(日報の `POST /api/reports/run` と同じ形)。DO・D1 は偽物。LLM・netkeiba には出ない。今日は NOW = 2026-10-06(JST 9 時)。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  requests: Array<{ month: string; mode: MonthlyMode }>;
  names: string[];
  statusCalls: string[];
  requestResult: RequestMonthlyResult;
  requestFails: boolean;
  status: MonthlyStatus | null;
  statusFails: boolean;
  /** 月報の行(本文つき)。月が一致すれば返す。 */
  report: boolean;
  env(withBinding?: boolean): Env;
}

const BODY_JSON = JSON.stringify({ format: 1, month: "202609", lastDayPending: false });

function harness(): Harness {
  const h: Harness = {
    requests: [],
    names: [],
    statusCalls: [],
    requestResult: { accepted: true },
    requestFails: false,
    status: null,
    statusFails: false,
    report: true,
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({
            first: async () =>
              h.report && args[0] === "202609"
                ? { month: "202609", createdAt: "2026-09-30T13:00:00.000Z", model: null, raceCount: 1, totalStake: 0, totalReturn: 0, summary: null, bodyJson: BODY_JSON, llmCallsJson: null }
                : null,
            all: async () => ({ results: [] }),
          }),
        }),
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
      ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            MONTHLY_REPORT: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                requestMonthlyReport: async (input: { month: string; mode: MonthlyMode }) => {
                  h.requests.push(input);
                  if (h.requestFails) throw new Error("DO の詳細 SECRET-DO");
                  return h.requestResult;
                },
                getStatus: async (month: string) => {
                  h.statusCalls.push(month);
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

async function setup(email?: string) {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key, email === undefined ? undefined : { email });
  return { deps, token };
}

const auth = (token?: string): Record<string, string> => (token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token });
const get = (path: string, token?: string, method = "GET"): Request => new Request(`${ORIGIN}${path}`, { method, headers: auth(token) });
const post = (body: unknown, token?: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/monthly-reports/run`, {
    method: "POST",
    headers: { ...auth(token), origin: ORIGIN, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("認証・役割: 管理者専用", () => {
  it("トークンが無ければ 403(DO を呼ばない)", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(post({ month: "202609" }), h.env(), {}, deps)).status).toBe(403);
    expect(h.requests).toEqual([]);
  });

  it("閲覧者(管理者以外のログイン)の POST は 403(DO を呼ばない)。GET の /run も 403", async () => {
    const { deps, token } = await setup("friend@example.com");
    const h = harness();
    expect((await handle(post({ month: "202609" }, token), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(post({ month: "202609", regenerate: true }, token), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(get("/api/monthly-reports/run", token), h.env(), {}, deps)).status).toBe(403);
    expect(h.requests).toEqual([]);
  });

  it("管理者の GET /api/monthly-reports/run は 405(Allow: POST)。月の本文としては扱わない", async () => {
    const { deps, token } = await setup();
    const res = await handle(get("/api/monthly-reports/run", token), harness().env(), {}, deps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /api/monthly-reports/run: 手動の作成", () => {
  it("終わった月なら月報の DO に mode: manual で依頼し、202 を返す", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(post({ month: "202609" }, token), h.env(), {}, deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toStrictEqual({ ok: true, accepted: true, month: "202609" });
    expect(h.requests).toEqual([{ month: "202609", mode: "manual" }]);
    expect(h.names).toEqual(["main"]);
  });

  it.each([
    ["作成済み", { accepted: false, reason: "exists" } as RequestMonthlyResult, "already-exists"],
    ["作成中", { accepted: false, reason: "in-progress" } as RequestMonthlyResult, "in-progress"],
  ])("DO が断ったとき(%s)は 409", async (_name, result, type) => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestResult = result;
    const res = await handle(post({ month: "202609" }, token), h.env(), {}, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toStrictEqual({ ok: false, error: { type } });
  });

  it("入力の検証: 今月・先の月(終わっていない月)・不正な月・型違い・余計なキー・欠けたキーは 400(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const bodies = [{ month: "202610" }, { month: "202611" }, { month: "202613" }, { month: "202600" }, { month: 202609 }, { month: "2026-09" }, { month: "20260901" }, { month: "202609", mode: "auto" }, {}];
    for (const body of bodies) {
      expect((await handle(post(body, token), h.env(), {}, deps)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.requests).toEqual([]);
  });

  it("守り: Origin が違えば 403・Content-Type が JSON でなければ 415・JSON でなければ 400(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(post({ month: "202609" }, token, { origin: "https://evil.invalid" }), h.env(), {}, deps)).status).toBe(403);
    expect((await handle(post({ month: "202609" }, token, { "content-type": "text/plain" }), h.env(), {}, deps)).status).toBe(415);
    expect((await handle(post("{broken", token), h.env(), {}, deps)).status).toBe(400);
    expect(h.requests).toEqual([]);
  });

  it("DO の失敗・binding なしは 503(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestFails = true;
    const failed = await handle(post({ month: "202609" }, token), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(JSON.parse(text)).toStrictEqual({ ok: false, error: { type: "report-error" } });
    expect(text).not.toContain("SECRET-DO");
    expect((await handle(post({ month: "202609" }, token), h.env(false), {}, deps)).status).toBe(503);
  });

  it("DO が作り直し専用の理由(not-exists・daily-limit)や、検証で弾いたはずの理由(not-ended)を通常の作成に返したら、食い違いなので 503", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const reason of ["not-exists", "daily-limit", "not-ended", "invalid-month", "too-old"] as const) {
      h.requestResult = { accepted: false, reason };
      expect((await handle(post({ month: "202609" }, token), h.env(), {}, deps)).status, reason).toBe(503);
    }
  });
});

describe("POST /api/monthly-reports/run の regenerate: true(管理者による月報の作り直し)", () => {
  it("regenerate: true なら月報の DO に mode: regenerate で依頼し、202 を返す(通常の mode: manual ではない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(post({ month: "202609", regenerate: true }, token), h.env(), {}, deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toStrictEqual({ ok: true, accepted: true, month: "202609" });
    expect(h.requests).toEqual([{ month: "202609", mode: "regenerate" }]);
  });

  it("regenerate: false・キーなしは通常の作成(mode: manual。古いクライアントの束で作り直しが起きない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(post({ month: "202609", regenerate: false }, token), h.env(), {}, deps)).status).toBe(202);
    expect((await handle(post({ month: "202609" }, token), h.env(), {}, deps)).status).toBe(202);
    expect(h.requests).toEqual([
      { month: "202609", mode: "manual" },
      { month: "202609", mode: "manual" },
    ]);
  });

  it.each([["文字列 true", "true"], ["数値 1", 1], ["null", null], ["配列", [true]]])("regenerate が boolean でなければ 400(DO を呼ばない): %s", async (_name, value) => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(post({ month: "202609", regenerate: value }, token), h.env(), {}, deps)).status).toBe(400);
    expect(h.requests).toEqual([]);
  });

  it("作り直しでも入力の検証は同じ: 今月・不正な月・余計なキーは 400(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    for (const body of [{ month: "202610", regenerate: true }, { month: "202613", regenerate: true }, { month: "202609", regenerate: true, mode: "auto" }, { regenerate: true }]) {
      expect((await handle(post(body, token), h.env(), {}, deps)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.requests).toEqual([]);
  });

  it.each([
    ["作成中", { accepted: false, reason: "in-progress" } as RequestMonthlyResult, 409, "in-progress"],
    ["月報が無い", { accepted: false, reason: "not-exists" } as RequestMonthlyResult, 409, "not-exists"],
    ["1 日の回数の上限", { accepted: false, reason: "daily-limit" } as RequestMonthlyResult, 429, "daily-limit"],
  ])("作り直しを DO が断ったとき(%s)は固定の型で返す", async (_name, result, status, type) => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestResult = result;
    const res = await handle(post({ month: "202609", regenerate: true }, token), h.env(), {}, deps);
    expect(res.status).toBe(status);
    expect(await res.json()).toStrictEqual({ ok: false, error: { type } });
  });

  it("作り直しに exists が返ってきたら(あり得ない理由)、通常の作成の already-exists と取り違えず 503", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.requestResult = { accepted: false, reason: "exists" };
    expect((await handle(post({ month: "202609", regenerate: true }, token), h.env(), {}, deps)).status).toBe(503);
  });
});

describe("GET /api/monthly-reports/{YYYYMM} の進行状況(job): 管理者だけ DO を読む", () => {
  const RUNNING: MonthlyStatus = { phase: "generate", status: "running", attempts: 0, regenerate: true };

  it("管理者: 月報があっても DO の進行状況を付ける(作り直しの進行・失敗を画面が見る)。job_status は ok", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.status = RUNNING;
    const body = (await (await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps)).json()) as { report: { month: string } | null; job: unknown; job_status: string };
    expect(body.report?.month).toBe("202609");
    expect(body.job).toStrictEqual({ phase: "generate", status: "running", attempts: 0, regenerate: true });
    expect(body.job_status).toBe("ok");
    expect(h.statusCalls).toEqual(["202609"]);
  });

  it("管理者: 月報が無い月でも進行状況を付ける。regenerate は true のときだけ写す(通常の作成のジョブにキーを作らない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.report = false;
    h.status = { phase: "read", status: "running", attempts: 1 };
    const body = (await (await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps)).json()) as { report: unknown; job: Record<string, unknown> };
    expect(body.report).toBeNull();
    expect(body.job).toStrictEqual({ phase: "read", status: "running", attempts: 1 });
    expect("regenerate" in body.job).toBe(false);
  });

  it("管理者: ジョブが無ければ job: null・ok。binding が無い構成も job: null・ok(ジョブが存在しえない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const none = (await (await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps)).json()) as { job: unknown; job_status: string };
    expect(none).toMatchObject({ job: null, job_status: "ok" });
    const noBinding = (await (await handle(get("/api/monthly-reports/202609", token), h.env(false), {}, deps)).json()) as { job: unknown; job_status: string };
    expect(noBinding).toMatchObject({ job: null, job_status: "ok" });
  });

  it("管理者: DO の取得が失敗しても月報は 200 で返し、job_status を unavailable にする(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.statusFails = true;
    const res = await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-DO");
    expect(JSON.parse(text)).toMatchObject({ ok: true, job: null, job_status: "unavailable" });
  });

  it("閲覧者: 月報があってもなくても DO に触れない(job: null・ok)。閲覧者の GET は集計・LLM に繋がらない", async () => {
    const { deps, token } = await setup("friend@example.com");
    const h = harness();
    h.status = RUNNING; // DO を読めば見えてしまう状態にしておく(読まないことの確認)
    const withReport = (await (await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps)).json()) as { report: unknown; job: unknown; job_status: string };
    expect(withReport.report).not.toBeNull();
    expect(withReport).toMatchObject({ job: null, job_status: "ok" });
    h.report = false;
    const without = (await (await handle(get("/api/monthly-reports/202609", token), h.env(), {}, deps)).json()) as { report: unknown; job: unknown; job_status: string };
    expect(without.report).toBeNull();
    expect(without).toMatchObject({ job: null, job_status: "ok" });
    expect(h.statusCalls).toEqual([]);
    expect(h.requests).toEqual([]);
  });
});
