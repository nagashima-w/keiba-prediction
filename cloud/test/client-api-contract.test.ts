import { describe, expect, it } from "vitest";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { fetchBoard, fetchRaces, type FetchLike } from "../client/api";
import { handle, type Env } from "../src/handler";
import type { Board, BoardRace, RaceListResult, RaceListVenue } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #184: 契約テスト。実際の `handle()`(偽の DO)が返した本物の応答を、クライアントの取得関数(`fetchRaces`・`fetchBoard`)にそのまま通す。
 * サーバ側のキー名・形(snake_case・null の扱い)が変わると、クライアントが読めなくなる(`unexpected`)ことをここで検出する。
 * 偽の fetch が `handle()` を呼ぶだけで、パーサ・取得関数・サーバの応答は本物。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";

function entry(raceId: string, over: Partial<RaceListEntry> = {}): RaceListEntry {
  return { raceId, name: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1600, entryCount: 16, venue: "福島", raceNumber: Number(raceId.slice(-2)), ...over } as RaceListEntry;
}

function boardRace(raceId: string, over: Partial<BoardRace> = {}): BoardRace {
  return { raceId, mode: "morning", status: "queued", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, computedAt: null, analysisId: null, detail: null, childrenOk: null, ...over };
}

async function connect(impl: { list?: () => Promise<RaceListResult>; board?: () => Promise<Board> }): Promise<{ fetch: FetchLike; calls: string[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const calls: string[] = [];
  const raceDay = {
    idFromName: (name: string) => name,
    get: () => ({
      getRaceList: (_date: string, _venue: RaceListVenue) => (impl.list ?? (async () => ({ ok: true, races: [] }) as RaceListResult))(),
      getBoard: async () => (impl.board ?? (async () => ({ kaisaiDate: DATE, races: [] })))(),
      getMorningPrior: async () => null,
    }),
  } as unknown as Env["RACE_DAY"];
  const NOT_CALLED = (): never => {
    throw new Error("呼ばれない想定");
  };
  const env: Env = { ...GOOD_ENV, NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED }, DB: { prepare: NOT_CALLED } as unknown as Env["DB"], ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"], RACE_DAY: raceDay };
  // ブラウザの same-origin の fetch と同じヘッダ(Sec-Fetch-Site)を付ける。認証は Access の JWT(ヘッダ)で通す。
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(url);
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return { fetch: fetchLike, calls };
}

describe("契約: GET /api/races の本物の応答をクライアントが読める", () => {
  it("レース一覧(中央・会場名あり/なし・グレードあり/なし)を、サーバの並び(race_id 昇順)のまま、値を保って読む", async () => {
    const { fetch } = await connect({
      list: async () => ({
        ok: true,
        races: [entry("202603020212", { grade: "G3", startTime: "15:40" }), entry("202603020211", { grade: undefined }), entry("202610020301", { venue: undefined, courseType: "ダ", distance: 1200, entryCount: 9 })] as RaceListEntry[],
      }),
    });
    const result = await fetchRaces(fetch, DATE, "central");
    expect(result).toEqual({
      ok: true,
      races: [
        { raceId: "202603020211", venueName: "福島", raceNumber: 11, raceName: "レース11", courseType: "芝", distance: 1600, entryCount: 16, grade: null, startTime: null },
        { raceId: "202603020212", venueName: "福島", raceNumber: 12, raceName: "レース12", courseType: "芝", distance: 1600, entryCount: 16, grade: "G3", startTime: "15:40" }, // Issue #236: 本物のサーバのキー名(start_time)をクライアントが読める
        { raceId: "202610020301", venueName: null, raceNumber: 1, raceName: "レース01", courseType: "ダ", distance: 1200, entryCount: 9, grade: null, startTime: null },
      ],
    });
  });

  it("開催なし(空の一覧)は成功の空配列", async () => {
    const { fetch } = await connect({});
    expect(await fetchRaces(fetch, DATE, "nar")).toEqual({ ok: true, races: [] });
  });

  it("netkeiba の取得失敗(503)は、reason ごとにクライアントの失敗へ写る", async () => {
    for (const reason of ["blocked", "busy", "failed"] as const) {
      const { fetch } = await connect({ list: async () => ({ ok: false, reason }) as RaceListResult });
      expect(await fetchRaces(fetch, DATE, "central")).toEqual({ ok: false, error: { kind: "netkeiba-unavailable", reason } });
    }
  });

  it("DO の例外(503 race-day-error)は server-error", async () => {
    const { fetch } = await connect({
      list: async () => {
        throw new Error("DO の失敗");
      },
    });
    expect(await fetchRaces(fetch, DATE, "central")).toEqual({ ok: false, error: { kind: "server-error" } });
  });

  it("クライアントが組み立てた URL は、サーバの検証(400)を通る(日付・区分のクエリのキー名が一致している)", async () => {
    const { fetch, calls } = await connect({});
    const result = await fetchRaces(fetch, DATE, "central");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([`/api/races?kaisai_date=${DATE}&venue=central`]);
  });
});

describe("契約: GET /api/analyses/status の本物の応答をクライアントが読める", () => {
  it("板(1レースの morning と pre_race の 2 行・状態・分析 id・朝の prior の有無)を、値を保って読む", async () => {
    const { fetch, calls } = await connect({
      board: async () => ({
        kaisaiDate: DATE,
        races: [
          boardRace("202603020211", { mode: "morning", status: "done", computedAt: 5000 }),
          boardRace("202603020211", { mode: "pre_race", status: "done", analysisId: 7, detail: "stored", childrenOk: true }),
          boardRace("202603020212", { mode: "morning", status: "failed", attempts: 3, error: "取得に失敗しました" }),
        ],
      }),
    });
    const result = await fetchBoard(fetch, DATE);
    expect(calls).toEqual([`/api/analyses/status?kaisai_date=${DATE}`]);
    expect(result).toEqual({
      ok: true,
      rows: [
        { raceId: "202603020211", mode: "morning", status: "done", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, prior: true, analysisId: null },
        { raceId: "202603020211", mode: "pre_race", status: "done", attempts: 0, error: null, queuedAt: 1000, updatedAt: 2000, prior: false, analysisId: 7 },
        { raceId: "202603020212", mode: "morning", status: "failed", attempts: 3, error: "取得に失敗しました", queuedAt: 1000, updatedAt: 2000, prior: false, analysisId: null },
      ],
    });
  });

  it("板が空の日は成功の空配列。DO の例外は server-error", async () => {
    expect(await fetchBoard((await connect({})).fetch, DATE)).toEqual({ ok: true, rows: [] });
    const { fetch } = await connect({
      board: async () => {
        throw new Error("DO の失敗");
      },
    });
    expect(await fetchBoard(fetch, DATE)).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});
