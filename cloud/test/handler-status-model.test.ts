import { describe, expect, it } from "vitest";
import { parseRaceModelBlock } from "../client/api-analysis";
import { handle, type Env } from "../src/handler";
import type { Board, BoardRace } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #806: レースの画面の状態の応答(`GET /api/analyses/status?kaisai_date=&race_id=`)に、別の Worker の確率の塊(`model`)を足す。
 * 呼ぶのは race_id つきの 1 レースだけ(板の全体の取得〈race_id なし〉では呼ばない)。発走前の分析がすでにあるレースは、詳しい中身の API が同じ値を出すので呼ばない。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";
const RACE_ID = "202603020211";
const NAR_RACE_ID = "202642062811";

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

const boardRace = (over: Partial<BoardRace> = {}): BoardRace => ({ raceId: RACE_ID, mode: "morning", status: "queued", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, computedAt: null, analysisId: null, detail: null, childrenOk: null, ...over });

const PREDAY_BODY = {
  race_id: RACE_ID,
  status: "none",
  reason: "not_ready",
  stage: "preday",
  odds_source: "lead-1",
  odds_lead_min: -1,
  odds_taken_at_ms: 1,
  model_version: "v",
  computed_at: "2026-11-26T05:21:00Z",
  odds_minutes_before: null,
  horses: [
    { umaban: 1, p_win: 0.25, odds_win: 8, u_mat: 0.3 },
    { umaban: 2, p_win: 0.5, odds_win: 3, u_mat: -0.1 },
  ],
};

async function get(path: string, races: BoardRace[], model: Fetcher | undefined): Promise<{ status: number; body: Record<string, unknown>; dbCalls: number }> {
  const key = await makeKey("k1");
  const token = await signToken(key);
  let dbCalls = 0;
  const board: Board = { kaisaiDate: DATE, races };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: () => ((dbCalls += 1), { bind: () => ({ first: async () => null }) }), batch: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: (n: string) => n, get: () => ({ getBoard: async () => board, getMorningPrior: async () => null }) } as unknown as Env["RACE_DAY"],
    ...(model === undefined ? {} : { MODEL: model }),
  };
  const res = await handle(new Request(`${ORIGIN}${path}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, { keys: () => localKeys(key), now: () => NOW, log: () => {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, dbCalls };
}

function fakeModel(body: unknown = PREDAY_BODY, httpStatus = 200): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const fetcher = {
    fetch: async (input: string) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status: httpStatus });
    },
  } as unknown as Fetcher;
  return { fetcher, urls };
}

const URL_RACE = `/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`;

describe("GET /api/analyses/status?race_id= の model(Issue #806)", () => {
  it("MODEL あり・朝の prior なしでも、model を足す(暫定の確率・確率×応答の単勝)。MODEL の GET は 1 回", async () => {
    const m = fakeModel();
    const r = await get(URL_RACE, [boardRace()], m.fetcher);
    expect(r.status).toBe(200);
    expect(m.urls).toHaveLength(1);
    const model = r.body["model"] as { status: string; stage: string; horses: { umaban: number; prob: number; ev: number }[] };
    expect(model.status).toBe("ok");
    expect(model.stage).toBe("preday");
    expect(model.horses.map((h) => [h.umaban, h.prob, h.ev])).toEqual([[1, 0.25, 2], [2, 0.5, 1.5]]);
    expect(r.body["prior"]).toBeNull();
  });

  it("race_id なし(板の取得)は MODEL を呼ばず、model のキーも無い", async () => {
    const m = fakeModel();
    const r = await get(`/api/analyses/status?kaisai_date=${DATE}`, [boardRace()], m.fetcher);
    expect(r.status).toBe(200);
    expect(m.urls).toHaveLength(0);
    expect("model" in r.body).toBe(false);
  });

  it("MODEL が無いとき: キーを足さず、D1 も読まない", async () => {
    const r = await get(URL_RACE, [boardRace()], undefined);
    expect("model" in r.body).toBe(false);
    expect(r.dbCalls).toBe(0);
  });

  it("地方のレースは MODEL を呼ばず、キーも無い", async () => {
    const m = fakeModel();
    const r = await get(`/api/analyses/status?kaisai_date=${DATE}&race_id=${NAR_RACE_ID}`, [], m.fetcher);
    expect(r.status).toBe(200);
    expect(m.urls).toHaveLength(0);
    expect("model" in r.body).toBe(false);
  });

  it("発走前の分析が済んでいる(done で analysis_id あり)レースは MODEL を呼ばず、キーも無い", async () => {
    const m = fakeModel();
    const r = await get(URL_RACE, [boardRace(), boardRace({ mode: "pre_race", status: "done", analysisId: 7 })], m.fetcher);
    expect(m.urls).toHaveLength(0);
    expect("model" in r.body).toBe(false);
  });

  it("別のレースの発走前の分析(done・analysis_id あり)は、このレースの呼び出しを止めない", async () => {
    const m = fakeModel();
    const r = await get(URL_RACE, [boardRace({ raceId: "202603020212", mode: "pre_race", status: "done", analysisId: 7 })], m.fetcher);
    expect(m.urls).toHaveLength(1);
    expect("model" in r.body).toBe(true);
  });

  it("発走前が実行中(fetched)・失敗・analysis_id なしなら、呼ぶ(詳しい中身は出ないため)", async () => {
    for (const over of [{ status: "fetched" as const }, { status: "failed" as const }, { status: "done" as const, analysisId: null }, { status: "failed" as const, analysisId: 7 }, { status: "queued" as const, analysisId: 7 }]) {
      const m = fakeModel();
      const r = await get(URL_RACE, [boardRace({ mode: "pre_race", ...over })], m.fetcher);
      expect(m.urls, JSON.stringify(over)).toHaveLength(1);
      expect("model" in r.body).toBe(true);
    }
  });

  it("MODEL が例外・500・不正な応答でも 200。注記だけの model(馬なし)で、例外の文面は出さない", async () => {
    const boom = { fetch: async () => { throw new Error("SECRET-MODEL"); } } as unknown as Fetcher;
    for (const f of [boom, fakeModel({}, 500).fetcher, fakeModel({ race_id: "x" }).fetcher]) {
      const r = await get(URL_RACE, [boardRace()], f);
      expect(r.status).toBe(200);
      const model = r.body["model"] as { status: string; horses: unknown[] };
      expect(model.status).toBe("none");
      expect(model.horses).toEqual([]);
      expect(JSON.stringify(r.body)).not.toContain("SECRET-MODEL");
    }
  });

  it("既存のキー(ok・kaisai_date・races・prior)は変えない(この呼び出しは管理者なので、Issue #812 の colo が加わる)", async () => {
    const m = fakeModel();
    const r = await get(URL_RACE, [boardRace()], m.fetcher);
    expect(Object.keys(r.body).sort()).toEqual(["colo", "kaisai_date", "model", "ok", "prior", "races"]);
  });

  it("契約: サーバが返した本物の塊を、クライアントのパーサが読める(馬ごとの値・補助・コース成績・コースが保たれる)", async () => {
    const withCourse = {
      ...PREDAY_BODY,
      course: { key: "05-T-1600-out", name: "東京 芝1600" },
      horses: [{ ...PREDAY_BODY.horses[0]!, course_fit: { same: { runs: 2, wins: 1, top3: 2, best: 1 }, similar: { runs: 0, wins: 0, top3: 0, best: null }, unknown_ring: 0 } }, PREDAY_BODY.horses[1]!],
    };
    const r = await get(URL_RACE, [boardRace()], fakeModel(withCourse).fetcher);
    const parsed = parseRaceModelBlock(r.body);
    expect(parsed, "前提: クライアントが読める").not.toBeNull();
    expect(parsed!.stage).toBe("preday");
    expect(parsed!.horses.map((h) => [h.umaban, h.prob, h.ev, h.aux?.rank])).toEqual([[1, 0.25, 2, 1], [2, 0.5, 1.5, 2]]);
    expect(parsed!.horses[0]!.courseFit?.same).toEqual({ runs: 2, wins: 1, top3: 2, best: 1 });
    expect(parsed!.horses[1]!.courseFit).toBeUndefined();
    expect(parsed!.course?.name).toBe("東京 芝1600");
    const none = parseRaceModelBlock((await get(URL_RACE, [boardRace()], fakeModel({}, 500).fetcher)).body);
    expect(none?.status).toBe("none");
    expect(none?.horses).toEqual([]);
  });
});
