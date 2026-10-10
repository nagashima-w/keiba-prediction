import { describe, expect, it } from "vitest";
import { handle, type Env, type RaceDayStubLike } from "../src/handler";
import type { AutoRunResults, NotificationRecord, PlanProgress, ResultImportProgress } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #206(#166-E G-E3): 本番での自動実行を外から観測する、読み取り専用の入口 `GET /api/plan?kaisai_date=YYYYMMDD`。
 * 返すもの: 朝の計画(`getPlanProgress`)・自動実行の各レースの結果(`getAutoRunResults`)・通知の一覧(`getNotifications`。Webhook の URL は含まない)・結果の取り込みの状態(`getResultImportProgress`。Issue #208)。
 * netkeiba にも LLM にも出ない。状態も変えない(DO の読み取りの RPC 4 つだけを呼ぶ)。日単位の DO は偽物(呼び出しを記録する)。
 * 順序: メソッド(GET だけ。HEAD は 405)→ Sec-Fetch-Site(別サイトなら 403)→ クエリの検証(400)→ DO(失敗は 503・文面なし)。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";
const CANARY = "https://discord.com/api/webhooks/123456789/CANARY-WEBHOOK-TOKEN";

const PLAN: PlanProgress = {
  stage: "done",
  requestedAt: 1_000,
  finalizedAt: 2_000,
  offsetMinutes: 45,
  offsetSource: "settings",
  venues: [
    { venue: "central", state: "ok", attempts: 1, reason: null, listed: 24, targeted: 24 },
    { venue: "nar", state: "failed", attempts: 3, reason: "r".repeat(500), listed: null, targeted: null },
  ],
  rows: [
    {
      raceId: "202606040901",
      venue: "central",
      venueName: "中山",
      raceNumber: 1,
      raceName: "2歳未勝利",
      grade: null,
      startTime: "09:50",
      dueMs: 3_000,
      disposition: "scheduled",
      skipReason: null,
      state: "planned",
      morning: "done",
    },
  ],
  morningAllTerminal: true,
};

const RESULTS: AutoRunResults = {
  stage: "done",
  finalizedAt: 2_000,
  results: [
    { raceId: "202606040901", venue: "central", venueName: "中山", raceNumber: 1, raceName: "2歳未勝利", grade: null, startTime: "09:50", dueMs: 3_000, outcome: { kind: "waiting" } },
    { raceId: "202606040902", venue: "central", venueName: "中山", raceNumber: 2, raceName: "3歳未勝利", grade: null, startTime: "10:20", dueMs: 4_000, outcome: { kind: "completed", analysisId: 7, detail: "stored" } },
    { raceId: "202606040903", venue: "central", venueName: "中山", raceNumber: 3, raceName: "3歳1勝クラス", grade: null, startTime: "10:50", dueMs: 5_000, outcome: { kind: "failed", reason: "fetch-exhausted", message: "m".repeat(500) } },
    { raceId: "202606040904", venue: "central", venueName: "中山", raceNumber: 4, raceName: "4歳以上", grade: null, startTime: null, dueMs: null, outcome: { kind: "skipped", reason: "no-start-time" } },
  ],
};

const NOTIFICATIONS: NotificationRecord[] = [
  { key: "race:202606040902", kind: "analysis", state: "sent", analysisId: 7, errorClass: null, updatedAt: 9_000 },
  { key: "summary", kind: "summary", state: "failed", analysisId: null, errorClass: "http-401", updatedAt: 9_500 },
];

const RESULT_IMPORT: ResultImportProgress = {
  total: 3,
  queued: 1,
  imported: 1,
  gaveUp: 1,
  races: [
    { raceId: "202606040901", state: "imported", attempts: 1, deferrals: 0, requestedOn: "20260629", nextTryAt: null, lastClass: "imported", updatedAt: 11_000 },
    { raceId: "202606040902", state: "queued", attempts: 2, deferrals: 1, requestedOn: "20260629", nextTryAt: 12_000, lastClass: "no-payout", updatedAt: 11_500 },
    { raceId: "202606040903", state: "gave_up", attempts: 3, deferrals: 0, requestedOn: "20260629", nextTryAt: null, lastClass: "not-confirmed", updatedAt: 11_900 },
  ],
};

interface FakePlanDay {
  readonly names: string[];
  readonly calls: string[];
  planImpl: () => Promise<PlanProgress>;
  resultsImpl: () => Promise<AutoRunResults>;
  notificationsImpl: () => Promise<NotificationRecord[]>;
  resultImportImpl: () => Promise<ResultImportProgress>;
  readonly namespace: Env["RACE_DAY"];
}

function fakePlanDay(): FakePlanDay {
  const f: FakePlanDay = {
    names: [],
    calls: [],
    planImpl: async () => PLAN,
    resultsImpl: async () => RESULTS,
    notificationsImpl: async () => NOTIFICATIONS,
    resultImportImpl: async () => RESULT_IMPORT,
    namespace: undefined as never,
  };
  const forbid = (name: string) => () => {
    f.calls.push(`FORBIDDEN:${name}`);
    throw new Error(`${name} は呼ばれない想定`);
  };
  const stub: RaceDayStubLike = {
    schedule: forbid("schedule"),
    getBoard: forbid("getBoard"),
    getMorningPrior: forbid("getMorningPrior"),
    getRaceList: forbid("getRaceList"),
    requestPlan: forbid("requestPlan"),
    requestResultImport: forbid("requestResultImport"),
    getResultImportProgress: () => {
      f.calls.push("getResultImportProgress");
      return f.resultImportImpl();
    },
    getPlanProgress: () => {
      f.calls.push("getPlanProgress");
      return f.planImpl();
    },
    getAutoRunResults: () => {
      f.calls.push("getAutoRunResults");
      return f.resultsImpl();
    },
    getNotifications: () => {
      f.calls.push("getNotifications");
      return f.notificationsImpl();
    },
  };
  (f as { namespace: Env["RACE_DAY"] }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () => stub,
  };
  return f;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function envOf(f: FakePlanDay, overrides: Partial<Env> = {}): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: f.namespace,
    ...overrides,
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { deps, token, stranger };
}

function get(path: string, token?: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

const sortedKeys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();

describe("GET /api/plan(Issue #206 G-E3)", () => {
  it("認証なしは 403 で、DO を呼ばない(開く = 表を作ることもしない)", async () => {
    const { deps } = await setup();
    const f = fakePlanDay();
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, undefined), envOf(f), {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(f.names).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  // Issue #238(契約変更): 旧「別メールは 403 で DO を呼ばない」は、「別メール(閲覧者)は読み取りの GET /api/plan を使える」に変わった(閲覧者の読み取りの許可。管理者専用の拒否は handler-roles.test.ts)
  it("別メール(閲覧者)は GET /api/plan を読める(200。読み取りの RPC 4 つだけ)", async () => {
    const { deps, stranger } = await setup();
    const f = fakePlanDay();
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, stranger), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(f.names).toEqual([DATE]);
    expect([...f.calls].sort()).toEqual(["getAutoRunResults", "getNotifications", "getPlanProgress", "getResultImportProgress"]);
  });

  it("開催日の DO(名前は開催日)の読み取りの RPC 4 つだけを呼び、200 で計画・結果・通知・結果の取り込みを返す。キャッシュしない", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(f.names).toEqual([DATE]);
    expect([...f.calls].sort()).toEqual(["getAutoRunResults", "getNotifications", "getPlanProgress", "getResultImportProgress"]);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["kaisai_date"]).toBe(DATE);
    const plan = body["plan"] as Record<string, unknown>;
    expect(plan["stage"]).toBe("done");
    expect(plan["requested_at"]).toBe(1_000);
    expect(plan["finalized_at"]).toBe(2_000);
    expect(plan["offset_minutes"]).toBe(45);
    expect(plan["offset_source"]).toBe("settings");
    expect(plan["morning_all_terminal"]).toBe(true);
    const venues = plan["venues"] as Record<string, unknown>[];
    expect(venues).toHaveLength(2);
    expect(venues[0]).toEqual({ venue: "central", state: "ok", attempts: 1, reason: null, listed: 24, targeted: 24 });
    const rows = plan["rows"] as Record<string, unknown>[];
    expect(rows).toEqual([
      { race_id: "202606040901", venue: "central", venue_name: "中山", race_number: 1, race_name: "2歳未勝利", grade: null, start_time: "09:50", due_ms: 3_000, disposition: "scheduled", skip_reason: null, state: "planned", morning: "done" },
    ]);
    const results = body["results"] as { race_id: string; outcome: Record<string, unknown> }[];
    expect(results.map((r) => [r.race_id, r.outcome["kind"]])).toEqual([
      ["202606040901", "waiting"],
      ["202606040902", "completed"],
      ["202606040903", "failed"],
      ["202606040904", "skipped"],
    ]);
    expect(results[1]!.outcome).toEqual({ kind: "completed", reason: null, analysis_id: 7, detail: "stored", message: null });
    expect(results[3]!.outcome).toEqual({ kind: "skipped", reason: "no-start-time", analysis_id: null, detail: null, message: null });
    expect(body["notifications"]).toEqual([
      { key: "race:202606040902", kind: "analysis", state: "sent", analysis_id: 7, error_class: null, updated_at: 9_000 },
      { key: "summary", kind: "summary", state: "failed", analysis_id: null, error_class: "http-401", updated_at: 9_500 },
    ]);
    // Issue #208: 結果の取り込み。件数(キューに入っている・取り込み済み・諦めた)と、各レースの状態を、固定の語と数値だけで返す
    expect(body["result_import"]).toEqual({
      total: 3,
      queued: 1,
      imported: 1,
      gave_up: 1,
      races: [
        { race_id: "202606040901", state: "imported", attempts: 1, deferrals: 0, requested_on: "20260629", next_try_at: null, last_class: "imported", updated_at: 11_000 },
        { race_id: "202606040902", state: "queued", attempts: 2, deferrals: 1, requested_on: "20260629", next_try_at: 12_000, last_class: "no-payout", updated_at: 11_500 },
        { race_id: "202606040903", state: "gave_up", attempts: 3, deferrals: 0, requested_on: "20260629", next_try_at: null, last_class: "not-confirmed", updated_at: 11_900 },
      ],
    });
  });

  it("応答のキーは固定(ホワイトリスト)。DO の返り値に余計なキー(URL を含む)があっても、本文に出ない。env の Webhook の URL も出ない(カナリア)", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    // 余計なキーを仕込んだ返り値(DO の実装が将来キーを足しても、応答に漏れないことを確かめる)
    f.planImpl = async () => ({ ...PLAN, webhookUrl: CANARY, venues: PLAN.venues.map((v) => ({ ...v, secret: CANARY })), rows: PLAN.rows.map((r) => ({ ...r, token: CANARY })) }) as never;
    f.resultsImpl = async () => ({ ...RESULTS, webhookUrl: CANARY, results: RESULTS.results.map((r) => ({ ...r, secret: CANARY, outcome: { ...r.outcome, url: CANARY } })) }) as never;
    f.notificationsImpl = async () => NOTIFICATIONS.map((n) => ({ ...n, payloadJson: CANARY, webhookUrl: CANARY })) as never;
    f.resultImportImpl = async () => ({ ...RESULT_IMPORT, webhookUrl: CANARY, races: RESULT_IMPORT.races.map((r) => ({ ...r, secret: CANARY, message: CANARY })) }) as never;
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f, { DISCORD_WEBHOOK_URL: CANARY }), {}, deps);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const leaked of [CANARY, "CANARY", "discord.com", "webhookUrl", "payloadJson", "secret", "token"]) {
      expect(text.includes(leaked), leaked).toBe(false);
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(sortedKeys(body)).toEqual(["kaisai_date", "notifications", "ok", "plan", "result_import", "results"]);
    const plan = body["plan"] as Record<string, unknown>;
    expect(sortedKeys(plan)).toEqual(["finalized_at", "morning_all_terminal", "offset_minutes", "offset_source", "requested_at", "rows", "stage", "venues"]);
    expect(sortedKeys((plan["venues"] as unknown[])[0])).toEqual(["attempts", "listed", "reason", "state", "targeted", "venue"]);
    expect(sortedKeys((plan["rows"] as unknown[])[0])).toEqual(["disposition", "due_ms", "grade", "morning", "race_id", "race_name", "race_number", "skip_reason", "start_time", "state", "venue", "venue_name"]);
    const results = body["results"] as { outcome: unknown }[];
    expect(results).toHaveLength(4); // 前提: 結果の行がある(キーの検査が空振りしない)
    for (const r of results) {
      expect(sortedKeys(r)).toEqual(["due_ms", "grade", "outcome", "race_id", "race_name", "race_number", "start_time", "venue", "venue_name"]);
      expect(sortedKeys(r.outcome)).toEqual(["analysis_id", "detail", "kind", "message", "reason"]);
    }
    const resultImport = body["result_import"] as { races: unknown[] };
    expect(sortedKeys(resultImport)).toEqual(["gave_up", "imported", "queued", "races", "total"]);
    expect(resultImport.races).toHaveLength(3); // 前提: 行がある(キーの検査が空振りしない)
    for (const r of resultImport.races) {
      expect(sortedKeys(r)).toEqual(["attempts", "deferrals", "last_class", "next_try_at", "race_id", "requested_on", "state", "updated_at"]);
    }
    const notifications = body["notifications"] as unknown[];
    expect(notifications).toHaveLength(2);
    for (const n of notifications) {
      expect(sortedKeys(n)).toEqual(["analysis_id", "error_class", "key", "kind", "state", "updated_at"]);
    }
  });

  it("自由文(会場の reason・失敗の message)は 200 文字に切って返す", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
    const body = (await response.json()) as { plan: { venues: { reason: string | null }[] }; results: { outcome: { message: string | null } }[] };
    // 前提: 元の値は 200 文字を超えている(切る処理が働いたことが見える)
    expect(PLAN.venues[1]!.reason!.length).toBe(500);
    expect(body.plan.venues[1]!.reason).toBe("r".repeat(200));
    expect(body.results[2]!.outcome.message).toBe("m".repeat(200));
    expect(body.plan.venues[0]!.reason).toBeNull();
  });

  it("Issue #245: 自由文(会場の reason・失敗の message)は、保存済みの値でも sk-ant- の鍵の形を伏せてから 200 文字に切る", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    const KEY = "sk-ant-api03-SECRET_BODY-0123456789";
    const stored = `${"r".repeat(190)}${KEY}${"r".repeat(50)}`;
    // 前提: 鍵は 200 文字目をまたぐ位置にある(切ってから伏せると、鍵の先頭の断片が残る)
    expect(stored.indexOf(KEY)).toBeLessThan(200);
    expect(stored.indexOf(KEY) + KEY.length).toBeGreaterThan(200);
    f.planImpl = async () => ({ ...PLAN, venues: [{ venue: "nar", state: "failed", attempts: 3, reason: stored, listed: null, targeted: null }] });
    f.resultsImpl = async () => ({
      ...RESULTS,
      results: [
        { raceId: "202606040903", venue: "central", venueName: "中山", raceNumber: 3, raceName: "3歳1勝クラス", grade: null, startTime: "10:50", dueMs: 5_000, outcome: { kind: "failed", reason: "fetch-exhausted", message: `${stored}` } },
        { raceId: "202606040904", venue: "central", venueName: "中山", raceNumber: 4, raceName: "4歳以上", grade: null, startTime: "11:20", dueMs: 6_000, outcome: { kind: "failed", reason: "blocked", message: `取得に失敗 ${KEY}` } },
      ],
    });
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { plan: { venues: { reason: string }[] }; results: { outcome: { message: string } }[] };
    expect(body.results).toHaveLength(2); // 前提: 2 件とも検査される
    expect(body.plan.venues[0]!.reason).toBe(`${"r".repeat(190)}sk-ant-***`);
    expect(body.results[0]!.outcome.message).toBe(`${"r".repeat(190)}sk-ant-***`);
    expect(body.results[1]!.outcome.message).toBe("取得に失敗 sk-ant-***");
    expect(text).not.toContain("SECRET_BODY");
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("sk-ant-a");
  });

  it("依頼の前の DO(stage none・空の結果)も 200 で返す。開いただけでは何も起きない(RPC は読み取りの 4 つだけ)", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    f.planImpl = async () => ({ stage: "none", requestedAt: null, finalizedAt: null, offsetMinutes: null, offsetSource: null, venues: [], rows: [], morningAllTerminal: false });
    f.resultsImpl = async () => ({ stage: "none", finalizedAt: null, results: [] });
    f.notificationsImpl = async () => [];
    f.resultImportImpl = async () => ({ total: 0, queued: 0, imported: 0, gaveUp: 0, races: [] });
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      kaisai_date: DATE,
      plan: { stage: "none", requested_at: null, finalized_at: null, offset_minutes: null, offset_source: null, morning_all_terminal: false, venues: [], rows: [] },
      results: [],
      notifications: [],
      result_import: { total: 0, queued: 0, imported: 0, gave_up: 0, races: [] },
    });
    expect(f.calls.some((c) => c.startsWith("FORBIDDEN:"))).toBe(false);
  });

  it("GET 以外は 405 で DO を呼ばない: HEAD(Allow: GET)・POST・PUT・DELETE", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token, { method }), envOf(f), {}, deps);
      expect(response.status, method).toBe(405);
      if (method === "HEAD") {
        expect(response.headers.get("allow"), method).toBe("GET"); // HEAD でも DO を開かない(他の GET の入口と同じ)
      }
    }
    expect(f.names).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("別サイトからの GET(Sec-Fetch-Site が cross-site・same-site)は 403 origin-mismatch で、DO を呼ばない。same-origin・none・ヘッダなしは通る", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    for (const site of ["cross-site", "same-site"]) {
      const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token, { headers: { "Sec-Fetch-Site": site } }), envOf(f), {}, deps);
      expect(response.status, site).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    }
    expect(f.names).toEqual([]);
    for (const site of ["same-origin", "none"]) {
      const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token, { headers: { "Sec-Fetch-Site": site } }), envOf(f), {}, deps);
      expect(response.status, site).toBe(200);
    }
    expect((await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps)).status).toBe(200);
  });

  it("入力の検証(400。DO を呼ばない): kaisai_date が無い・形が違う・実在しない日・長すぎる・クエリの重複・未知のキー", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    const bad = [
      "/api/plan",
      "/api/plan?kaisai_date=",
      "/api/plan?kaisai_date=2026-06-28",
      "/api/plan?kaisai_date=2026062",
      "/api/plan?kaisai_date=20260230",
      "/api/plan?kaisai_date=20261301",
      `/api/plan?kaisai_date=${"9".repeat(200)}`,
      `/api/plan?kaisai_date=${DATE}&kaisai_date=${DATE}`,
      `/api/plan?kaisai_date=${DATE}&race_id=202606040901`,
      `/api/plan?kaisai_date=${DATE}&venue=central`,
    ];
    for (const path of bad) {
      const response = await handle(get(path, token), envOf(f), {}, deps);
      expect(response.status, path).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)["ok"]).toBe(false);
      expect(text.length, path).toBeLessThan(400); // 長い入力をそのまま写さない
    }
    expect(f.names).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("DO のどれかの読み取りが失敗したら 503 race-day-error。例外の文面・SQL を返さない", async () => {
    const { deps, token } = await setup();
    for (const which of ["planImpl", "resultsImpl", "notificationsImpl", "resultImportImpl"] as const) {
      const f = fakePlanDay();
      f[which] = async () => {
        throw new Error("SQLITE_ERROR race_day_plan secret-value");
      };
      const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
      expect(response.status, which).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "race-day-error" } });
      for (const leaked of ["SQLITE", "race_day_plan", "secret-value"]) {
        expect(text.includes(leaked), `${which}: ${leaked}`).toBe(false);
      }
    }
  });

  it("netkeiba の出口(NETKEIBA_GATE)にも D1・R2 にも触れない(env の該当 binding は呼ばれたら失敗する偽物)", async () => {
    const { deps, token } = await setup();
    const f = fakePlanDay();
    const response = await handle(get(`/api/plan?kaisai_date=${DATE}`, token), envOf(f), {}, deps);
    expect(response.status).toBe(200); // NOT_CALLED の binding を触っていれば例外になり 200 にならない
  });
});
