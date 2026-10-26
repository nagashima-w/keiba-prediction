import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { FETCH_LIST_LIMIT_DEFAULT } from "../src/baba-repository";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #360: 馬場の API の取得の結果を管理者が見る入口 `GET /api/baba-fetch`(管理者専用・読み取り専用)。
 * D1 は偽物(発行された SQL を記録する)。外部の API・netkeiba・LLM には出ない。SQL の中身の正しさは baba-repository.test.ts(ローカルの D1)で確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

const FETCH_ROW = {
  kaisai_date: "20261017",
  attempted_at: 1_000,
  finished_at: 1_500,
  result: "no-today-venues",
  api_fetched_at: "2026-10-16T23:00:00.000Z",
  venues_saved: 0,
  venues_dropped: 3,
  dropped_json: JSON.stringify([{ venue: "05", reason: "not-today", measured: "10月17日（土曜）7時00分" }]),
  // 想定外の列(応答に出してはならない)
  raw_json: "RAW-SECRET",
  url: "https://secret.test.invalid/baba",
};
const ATTEMPT_ROW = {
  kaisai_date: "20261017",
  slot: 1,
  attempted_at: 900_000,
  finished_at: 905_000,
  result: "ok",
  api_fetched_at: "2026-10-17T00:15:00.000Z",
  venues_saved: 2,
  venues_dropped: 1,
  dropped_json: JSON.stringify([{ venue: "05", reason: "not-today", measured: "10月17日（土曜）7時00分" }]),
  complete: 1,
  // 想定外の列(応答に出してはならない)
  raw_json: "RAW-SECRET",
};
const SAVED_ROW = { kaisai_date: "20261017", venue_code: "05", venue_name: "東京", measured_at: "2026-10-17T07:00+09:00", raw_json: "RAW-SECRET" };

interface Harness {
  readonly sqls: string[];
  readonly binds: unknown[][];
  fails: boolean;
  fetchRows: Record<string, unknown>[];
  savedRows: Record<string, unknown>[];
  attemptRows: Record<string, unknown>[];
  env(): Env;
}

function harness(): Harness {
  const h: Harness = {
    sqls: [],
    binds: [],
    fails: false,
    fetchRows: [FETCH_ROW],
    savedRows: [SAVED_ROW],
    attemptRows: [ATTEMPT_ROW],
    env: () => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
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
              return { results: sql.includes("FROM baba_fetch_attempts") ? h.attemptRows : sql.includes("FROM baba_conditions") ? h.savedRows : h.fetchRows };
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
  new Request(`${ORIGIN}/api/baba-fetch${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/baba-fetch: 診断", () => {
  it("既定で 200。直近の取得の記録を、明示の許可リストの形で返す(捨てた理由と計測日時の文字列・保存した競馬場を含み、想定外の列は出さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      kaisai_date: null,
      limit: FETCH_LIST_LIMIT_DEFAULT,
      fetches: [
        {
          kaisai_date: "20261017",
          attempted_at: 1_000,
          finished_at: 1_500,
          result: "no-today-venues",
          api_fetched_at: "2026-10-16T23:00:00.000Z",
          venues_saved: 0,
          venues_dropped: 3,
          dropped: [{ venue: "05", reason: "not-today", measured: "10月17日（土曜）7時00分" }],
          saved: [{ venue_code: "05", venue_name: "東京", measured_at: "2026-10-17T07:00+09:00" }],
          attempts: [
            {
              slot: 1,
              attempted_at: 900_000,
              finished_at: 905_000,
              result: "ok",
              api_fetched_at: "2026-10-17T00:15:00.000Z",
              venues_saved: 2,
              venues_dropped: 1,
              dropped: [{ venue: "05", reason: "not-today", measured: "10月17日（土曜）7時00分" }],
              complete: true,
            },
          ],
        },
      ],
    });
    expect(text).not.toContain("RAW-SECRET");
    expect(text).not.toContain("secret.test.invalid");
    // 読み取りだけ(書き込みの文を発行しない)。一覧は上限 14 件を束縛する
    expect(h.sqls.length).toBeGreaterThan(0);
    expect(h.sqls.every((s) => /^SELECT/.test(s))).toBe(true);
    expect(h.binds[0]).toEqual([FETCH_LIST_LIMIT_DEFAULT]);
  });

  it("旧版の記録(dropped_json が NULL)は dropped が null、結果の無い行は結果が null で返る", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.fetchRows = [{ kaisai_date: "20261018", attempted_at: 5, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped_json: null }];
    h.savedRows = [];
    h.attemptRows = [];
    const body = (await (await handle(get(token), h.env(), {}, deps)).json()) as { fetches: Record<string, unknown>[] };
    expect(body.fetches).toEqual([
      { kaisai_date: "20261018", attempted_at: 5, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped: null, saved: [], attempts: [] },
    ]);
  });

  it("枠ごとの記録(attempts)は、結果を記録できなかった枠〈完了の印 complete が NULL〉も返す(complete は null)。想定外の列は出さない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.attemptRows = [{ kaisai_date: "20261017", slot: 3, attempted_at: 7, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped_json: null, complete: null, raw_json: "RAW-SECRET" }];
    const text = await (await handle(get(token), h.env(), {}, deps)).text();
    const body = JSON.parse(text) as { fetches: { attempts: unknown[] }[] };
    expect(body.fetches[0]!.attempts).toEqual([
      { slot: 3, attempted_at: 7, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped: null, complete: null },
    ]);
    expect(text).not.toContain("RAW-SECRET");
  });

  it("kaisai_date を指定すると、その日だけを引く(開催日を束縛する)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(get(token, "?kaisai_date=20261017"), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kaisai_date: string }).kaisai_date).toBe("20261017");
    expect(h.binds[0]).toEqual(["20261017"]);
  });

  it("未知のクエリ・重複・開催日の形の誤りは 400(D1 に触れない)", async () => {
    const { deps, token } = await setup();
    for (const query of ["?x=1", "?kaisai_date=", "?kaisai_date=2026-10-17", "?kaisai_date=20261301", "?kaisai_date=abc", "?kaisai_date=20261017&kaisai_date=20261018", "?kaisai_date=20261017&x=1", "?limit=5"]) {
      const h = harness();
      const res = await handle(get(token, query), h.env(), {}, deps);
      expect(res.status, query).toBe(400);
      expect(h.sqls, query).toEqual([]);
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

  it("GET 以外(管理者の POST・HEAD など)は 405 で、D1 に触れない", async () => {
    const { deps, token } = await setup();
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
      const h = harness();
      const res = await handle(get(token, "", method), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
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
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "baba-fetch-error" } });
    expect(text).not.toContain("SECRET-D1");
  });
});
