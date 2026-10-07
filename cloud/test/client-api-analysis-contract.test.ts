import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { fetchRaceStatus, type FetchLike } from "../client/api";
import { fetchAnalysis, fetchPastAnalyses } from "../client/api-analysis";
import { buildResultModel } from "../client/result";
import { D1AnalysisStore } from "../src/analysis-repository";
import { handle, type Env } from "../src/handler";
import type { Board, BoardRace, MorningPrior } from "../src/race-day-core";
import { contractCases } from "./fixtures-contract";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #185: 契約テスト。実際の `handle()` が返した本物の応答を、クライアントの取得関数(`fetchRaceStatus`・`fetchPastAnalyses`・`fetchAnalysis`)にそのまま通す。
 * サーバ側のキー名・形(snake_case/camelCase・null の扱い・配分の `fallbackReason`・`betUnit`)が変わると、クライアントが読めなくなる(`unexpected`)ことをここで検出する。
 * 分析の一覧・詳細は、ローカル(workerd)の本物の D1・R2 に保存した分析を読む。クライアントが組み立てた URL は、サーバの検証(400)を通ることも兼ねて確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";
const RACE_ID = "202603020211";

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

async function connect(over: Partial<Env>): Promise<{ fetch: FetchLike; calls: string[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const calls: string[] = [];
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED, batch: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    ...over,
  };
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(url);
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return { fetch: fetchLike, calls };
}

function boardRace(raceId: string, over: Partial<BoardRace> = {}): BoardRace {
  return { raceId, mode: "morning", status: "queued", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, computedAt: null, analysisId: null, detail: null, childrenOk: null, ...over };
}

describe("契約: GET /api/analyses/status?race_id= の本物の応答をクライアントが読める", () => {
  it("板の行と朝の prior(サーバが prior の高い順に並べて rank を付けたもの)を、値を保って読む。クライアントの URL はサーバの検証を通る", async () => {
    const board: Board = {
      kaisaiDate: DATE,
      races: [boardRace(RACE_ID, { mode: "morning", status: "done", computedAt: 5000 }), boardRace(RACE_ID, { mode: "pre_race", status: "done", analysisId: 7, detail: "stored", childrenOk: true })],
    };
    const prior = {
      computedAt: 5000,
      result: {
        raceName: "福島民報杯",
        venueName: "福島",
        date: "2026-06-28",
        rows: [
          { umaban: 1, horseName: "ブラボー", prior: 0.2 },
          { umaban: 3, horseName: "アルファ", prior: 0.5 },
        ],
      },
    } as unknown as MorningPrior;
    const { fetch, calls } = await connect({ RACE_DAY: { idFromName: (n: string) => n, get: () => ({ getBoard: async () => board, getMorningPrior: async () => prior }) } as unknown as Env["RACE_DAY"] });
    const result = await fetchRaceStatus(fetch, DATE, RACE_ID);
    expect(calls).toEqual([`/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`]);
    expect(result).toEqual({
      ok: true,
      rows: [
        { raceId: RACE_ID, mode: "morning", status: "done", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, prior: true, analysisId: null },
        { raceId: RACE_ID, mode: "pre_race", status: "done", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, prior: false, analysisId: 7 },
      ],
      prior: {
        raceName: "福島民報杯",
        venueName: "福島",
        date: "2026-06-28",
        computedAt: 5000,
        rows: [
          { rank: 1, umaban: 3, horseName: "アルファ", prior: 0.5 },
          { rank: 2, umaban: 1, horseName: "ブラボー", prior: 0.2 },
        ],
      },
    });
  });

  it("prior が無いレースは prior: null。DO の例外は server-error", async () => {
    const empty = await connect({ RACE_DAY: { idFromName: (n: string) => n, get: () => ({ getBoard: async () => ({ kaisaiDate: DATE, races: [] }), getMorningPrior: async () => null }) } as unknown as Env["RACE_DAY"] });
    expect(await fetchRaceStatus(empty.fetch, DATE, RACE_ID)).toEqual({ ok: true, rows: [], prior: null });
    const failing = await connect({
      RACE_DAY: {
        idFromName: (n: string) => n,
        get: () => ({
          getBoard: async () => {
            throw new Error("DO の失敗");
          },
        }),
      } as unknown as Env["RACE_DAY"],
    });
    expect(await fetchRaceStatus(failing.fetch, DATE, RACE_ID)).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});

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

async function record(allocationOver: Record<string, unknown>, bets: AnalysisRecord["allocation"] extends infer A ? (A extends { bets: infer B } ? B : never) : never): Promise<AnalysisRecord> {
  const { race } = await scrapeFixtureRace();
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: DATE,
    promptVersion: null,
    rawResponse: null,
    raceSnapshot: JSON.parse(JSON.stringify(buildRaceSnapshot(race))),
    horses: race.horses.map((h) => ({ umaban: h.shutuba.umaban, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 2, ev: 1.1, isPositive: true, contributions: null, mark: null, reason: null })),
    allocation: { meta: { ...meta, ...allocationOver }, bets },
  } as AnalysisRecord;
}

const realEnv = (): Partial<Env> => ({ DB: local.db as Env["DB"], ANALYSIS_DETAIL: local.r2 });

describe("契約: GET /api/analyses・GET /api/analyses/{id} の本物の応答(ローカルの D1・R2)をクライアントが読み、exe の表示関数まで通る", () => {
  it("過去の分析の一覧: クライアントの URL(race_id・kaisai_date・limit=20)がサーバの検証を通り、新しい順に読める", async () => {
    const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    const first = await store.saveAnalysis(await record({}, []));
    const second = await store.saveAnalysis({ ...(await record({}, [])), analyzedAt: "2026-06-28T06:00:00.000Z" });
    const { fetch, calls } = await connect(realEnv());
    const result = await fetchPastAnalyses(fetch, DATE, RACE_ID);
    expect(calls).toEqual([`/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`]);
    expect(result).toEqual({
      ok: true,
      analyses: [
        { id: second.id, analyzedAt: "2026-06-28T06:00:00.000Z", evEstimated: false, model: null },
        { id: first.id, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null },
      ],
    });
    // 別のレース・別の日は混ざらない
    expect(await fetchPastAnalyses(fetch, "20260627", RACE_ID)).toEqual({ ok: true, analyses: [] });
  });

  it("分析の詳細: 馬名つきで読める。配分の見送り(cap-too-small)は、サーバが返した betUnit(100)と fallbackReason が exe の注記になる(キーが欠けると「単位額が記録されていません」・注記なしに落ちる)", async () => {
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(
      await record({ route: "place-only", skipReasonCode: "cap-too-small", fallbackReason: "no-combo-candidates", betUnit: 100 }, []),
    );
    const { fetch, calls } = await connect(realEnv());
    const result = await fetchAnalysis(fetch, saved.id);
    expect(calls).toEqual([`/api/analyses/${saved.id}`]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.detail).toBe("present");
    expect(result.analysis.horses.every((h) => h.name !== null && h.name.length > 0)).toBe(true);
    expect(result.analysis.allocation).toMatchObject({ route: "place-only", skipReasonCode: "cap-too-small", fallbackReason: "no-combo-candidates", betUnit: 100 });
    const model = buildResultModel({ route: { date: DATE, venue: "central", race: null, analysis: saved.id, settings: false }, source: { kind: "ready", analysis: result.analysis } });
    expect(model.content!.allocation.kind).toBe("skip");
    expect(model.content!.allocation.notices).toEqual(["1レースの上限が100円未満のため配分できません", "組合せ券種にEVプラスの候補が無かったため複勝のみの配分になっています。"]);
  });

  it("配分あり(買い目)と、記録が無い分析(allocation: null)", async () => {
    const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    const withBets = await store.saveAnalysis(
      await record({ route: "mixed", skipReasonCode: null, fallbackReason: null }, [
        { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
        { betType: "wide", comboKey: "0102", stake: 200, odds: 5.5, ev: 1.3 },
      ]),
    );
    const { allocation: _drop, ...noAllocation } = await record({}, []);
    const without = await store.saveAnalysis(noAllocation as AnalysisRecord);
    const { fetch } = await connect(realEnv());
    const a = await fetchAnalysis(fetch, withBets.id);
    expect(a.ok && a.analysis.allocation?.bets).toEqual([
      { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
      { betType: "wide", comboKey: "0102", stake: 200, odds: 5.5, ev: 1.3 },
    ]);
    const b = await fetchAnalysis(fetch, without.id);
    expect(b.ok && b.analysis.allocation).toBeNull();
  });

  it("無い id は not-found(404)。D1 の失敗は server-error", async () => {
    const { fetch } = await connect(realEnv());
    expect(await fetchAnalysis(fetch, 424242)).toEqual({ ok: false, error: { kind: "not-found" } });
    const failing = await connect({
      DB: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => {
          throw new Error("D1_ERROR: 秘密");
        },
      } as unknown as Env["DB"],
    });
    expect(await fetchAnalysis(failing.fetch, 1)).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});
