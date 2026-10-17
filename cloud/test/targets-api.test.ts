import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloseSavePayload } from "../src/analysis-close";
import { parseTargetsResponse } from "../client/api-targets";
import { buildTargetsModel } from "../client/targets-model";
import { D1AnalysisStore } from "../src/analysis-repository";
import { handle, type Env, type RaceDayStubLike } from "../src/handler";
import type { PlanProgress } from "../src/race-day-core";
import type { AnalysisAllocationRecord, AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { pathFromMeta } from "./meta-path.js";

/**
 * Issue #336 段階 A: 実際の `handle()` の `GET /api/targets` を、ローカルの本物の D1(migration は CI と同じ実コマンドで適用)に通す(DO だけ偽物)。
 * 段階 B のクライアントのパーサが頼る応答の形(キーと型)を固定する。R2(`ANALYSIS_DETAIL`)は、触れたら例外になる偽物にして、触れないことを確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20261017";
const R11 = "202605050811";
const R12 = "202605050812";
const R13 = "202605050813";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
const BASE_META = contractCases[0]!.record.allocation!.meta;

function allocation(bets: readonly { stake: number; ev: number }[]): AnalysisAllocationRecord {
  return {
    meta: { ...BASE_META, route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, bankroll: 100000, perRaceCap: 30000, oddsStatus: "middle" },
    bets: bets.map((b, i) => ({ betType: "wide", comboKey: `01${String(i + 2).padStart(2, "0")}`, stake: b.stake, odds: 5, ev: b.ev })),
  };
}

function record(raceId: string, bets: readonly { stake: number; ev: number }[], mark: number | null): AnalysisRecord {
  return {
    raceId,
    analyzedAt: "2026-10-17T02:00:00.000Z",
    kaisaiDate: DATE,
    promptVersion: "v-test",
    horses: Array.from({ length: 8 }, (_, i) => ({ umaban: i + 1, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 2, ev: 1, isPositive: false, contributions: null, mark: mark === i + 1 ? "◎" : null, reason: "r" })),
    allocation: allocation(bets),
  };
}

const DUE = Date.parse("2026-10-17T06:35:00Z");
const closeOk = (round: 1 | 2, bets: readonly { stake: number; ev: number }[]): CloseSavePayload => ({ round, status: "ok", reason: null, dueAtMs: DUE, firedAtMs: DUE + 500, lateMs: 500, oddsOfficialDatetime: "2026-10-17 15:36:00", allocation: allocation(bets) });

const PLAN: PlanProgress = {
  stage: "done",
  requestedAt: 1,
  finalizedAt: 2,
  offsetMinutes: 45,
  offsetSource: "settings",
  venues: [],
  rows: [R11, R12, R13].map((raceId, i) => ({ raceId, venue: "central" as const, venueName: "東京", raceNumber: 11 + i, raceName: "r", grade: null, startTime: ["15:40", "16:20", "17:00"][i]!, dueMs: 1, disposition: "scheduled" as const, skipReason: null, state: "promoted" as const, morning: "done" as const })),
  morningAllTerminal: true,
};

async function call(options: { email?: string; db?: Env["DB"]; plan?: boolean } = {}): Promise<{ status: number; body: Record<string, any>; doCalls: string[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key, options.email === undefined ? {} : { email: options.email });
  const doCalls: string[] = [];
  const forbid = (name: string) => () => {
    doCalls.push(`FORBIDDEN:${name}`);
    throw new Error(name);
  };
  const stub: RaceDayStubLike = {
    schedule: forbid("schedule"),
    scheduleMany: forbid("scheduleMany"),
    getBoard: forbid("getBoard"),
    getMorningPrior: forbid("getMorningPrior"),
    getRaceList: forbid("getRaceList"),
    requestPlan: forbid("requestPlan"),
    requestResultImport: forbid("requestResultImport"),
    getResultImportProgress: forbid("getResultImportProgress"),
    getAutoRunResults: forbid("getAutoRunResults"),
    getNotifications: forbid("getNotifications"),
    getPlanProgress: async () => {
      doCalls.push("getPlanProgress");
      return PLAN;
    },
  };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: options.db ?? (local.db as Env["DB"]),
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: (name: string) => name, get: () => stub },
  };
  const response = await handle(new Request(`${ORIGIN}/api/targets?kaisai_date=${DATE}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, deps);
  return { status: response.status, body: (await response.json()) as Record<string, any>, doCalls };
}

/** R11: 分析時 3 点・5 分前と 2 分前の再計算あり / R12: 分析時 2 点・5 分前だけ 0 点(見送り) / R13: 分析時 0 点(載らない)。 */
async function seed(): Promise<void> {
  const a11 = await store().saveAnalysis(record(R11, [{ stake: 300, ev: 1.2 }, { stake: 200, ev: 1.5 }, { stake: 100, ev: 1.1 }], 7));
  await store().saveClose(a11.id, closeOk(1, [{ stake: 400, ev: 1.3 }, { stake: 200, ev: 1.4 }, { stake: 100, ev: 1.2 }]));
  await store().saveClose(a11.id, closeOk(2, [{ stake: 500, ev: 1.35 }, { stake: 300, ev: 1.25 }]));
  const a12 = await store().saveAnalysis(record(R12, [{ stake: 200, ev: 1.2 }, { stake: 100, ev: 1.1 }], null));
  await store().saveClose(a12.id, closeOk(1, []));
  await store().saveAnalysis(record(R13, [], 2));
}

describe("GET /api/targets(本物の D1。Issue #336)", () => {
  it("狙い目(2 分前を優先)・見送り・提案なしが、発走時刻の順・正しい点数/合計/最大 EV で返る。DO は getPlanProgress だけ。R2 には触れない", async () => {
    await seed();
    const { status, body, doCalls } = await call();
    expect(status).toBe(200);
    expect(doCalls).toEqual(["getPlanProgress"]);
    expect(body["ok"]).toBe(true);
    expect(body["summary"]).toBe("分析済み 3 レース中、狙い目 1(見送り 1)");
    const races = body["races"] as Record<string, any>[];
    expect(races.map((r) => r["race_id"])).toEqual([R11, R12]); // R13(提案なし)は載らない
    expect(races[0]).toMatchObject({ place: "東京11R", pick: "◎7", start_time: "15:40", source: "close", round: 2, bet_count: 2, total_stake: 800, max_ev: 1.35, skipped: false, detail: "2点 800円 EV 1.35・発走2分前の再計算" });
    expect(races[1]).toMatchObject({ place: "東京12R", pick: null, start_time: "16:20", source: "close", round: 1, bet_count: 0, skipped: true, detail: "見送り・発走5分前の再計算で0点" });
  });

  it("応答の各項目の型(段階 B のパーサが頼る形): 数値は有限の数・文字列・null の別が固定", async () => {
    await seed();
    const { body } = await call();
    expect(Object.keys(body).sort()).toEqual(["kaisai_date", "now_ms", "ok", "races", "summary"]);
    expect(typeof body["now_ms"]).toBe("number");
    expect(typeof body["summary"]).toBe("string");
    for (const race of body["races"] as Record<string, any>[]) {
      expect(typeof race["race_id"]).toBe("string");
      expect(Number.isInteger(race["analysis_id"])).toBe(true);
      expect(Number.isFinite(race["start_ms"])).toBe(true);
      expect(typeof race["start_time"]).toBe("string");
      expect(typeof race["place"]).toBe("string");
      expect(race["pick"] === null || typeof race["pick"] === "string").toBe(true);
      expect(["analysis", "close"]).toContain(race["source"]);
      expect(race["round"] === null || Number.isInteger(race["round"])).toBe(true);
      expect(Number.isInteger(race["bet_count"])).toBe(true);
      expect(Number.isFinite(race["total_stake"])).toBe(true);
      expect(race["max_ev"] === null || Number.isFinite(race["max_ev"])).toBe(true);
      expect(typeof race["skipped"]).toBe("boolean");
      expect(typeof race["detail"]).toBe("string");
    }
    expect((body["races"] as unknown[]).length).toBeGreaterThan(0); // 前提: 行がある(型の検査が空振りしない)
  });

  it("契約: クライアントのパーサ(client/api-targets.ts)が、本物の応答を一部も落とさず読める。表示用データも作れる(段階 B)", async () => {
    await seed();
    const { status, body } = await call();
    expect(status).toBe(200);
    const parsed = parseTargetsResponse(status, JSON.parse(JSON.stringify(body)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.races.map((r) => r.raceId)).toEqual([R11, R12]);
    expect(parsed.data.races[0]).toMatchObject({ place: "東京11R", pick: "◎7", skipped: false, startTime: "15:40" });
    expect(parsed.data.races[1]).toMatchObject({ skipped: true, pick: null });
    // サーバの時計(NOW = 2026-10-06)より後の開催日のレースなので、2 件とも未発走で、行のリンクは結果画面
    const model = buildTargetsModel({ date: DATE, data: parsed.data, error: null, loading: false, nowMs: parsed.data.nowMs });
    expect(model.upcoming.map((r) => r.href)).toEqual([`#date=${DATE}&venue=central&analysis=${parsed.data.races[0]!.analysisId}`, `#date=${DATE}&venue=central&analysis=${parsed.data.races[1]!.analysisId}`]);
    expect(model.past).toEqual([]);
  });

  it("閲覧者(管理者でないメール)にも 200 で、管理者と同じ内容", async () => {
    await seed();
    const admin = await call();
    const viewer = await call({ email: "stranger@example.com" });
    expect(viewer.status).toBe(200);
    expect(viewer.body).toEqual(admin.body);
  });

  it("再計算の表が無くても(migration の適用前)200。分析時の提案で出す", async () => {
    await seed();
    await local.db.prepare("DROP TABLE analysis_close_bets").run();
    await local.db.prepare("DROP TABLE analysis_close").run();
    // 他のテストのために、表を元に戻す(migration 0019 と同じ定義)
    try {
      const { status, body } = await call();
      expect(status).toBe(200);
      const races = body["races"] as Record<string, any>[];
      expect(races.map((r) => [r["race_id"], r["source"], r["bet_count"]])).toEqual([
        [R11, "analysis", 3],
        [R12, "analysis", 2],
      ]);
    } finally {
      const { readFileSync } = await import("node:fs");
      const sql = readFileSync(pathFromMeta("../migrations/0019_close.sql", import.meta.url), "utf-8");
      const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
      for (const s of statements) await local.db.prepare(s).run();
    }
  });

  it("分析が 1 件も無い日は 200 で空。DO を呼ばない", async () => {
    const { status, body, doCalls } = await call();
    expect(status).toBe(200);
    expect(body["races"]).toEqual([]);
    expect(body["summary"]).toBe("まだ分析されたレースがありません");
    expect(doCalls).toEqual([]);
  });
});
