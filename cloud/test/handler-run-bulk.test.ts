import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { MAX_BULK_RACES, type ScheduleManyInput, type ScheduleManyResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #251: 一括の手動起動 `POST /api/analyses/run/bulk`(管理者だけ)。競馬場ごとに、事前分析(morning)か発走前の分析(pre_race)をまとめて予約する。
 * 日単位の DO(RaceDay)は偽物(呼び出しを記録する)。実 netkeiba・実 DO・LLM には触れない。
 * AC: 認証と役割(閲覧者は 403・DO を呼ばない)/ Origin / 入力の検証は DO を呼ぶ前 / 202 でレースごとの結果 / 上限超過は 409 day-cap / DO の失敗の文面は出さない。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";
const R1 = "202603020201";
const R2 = "202603020202";
const R3 = "202603020203";

interface FakeRaceDay {
  readonly names: string[];
  readonly many: ScheduleManyInput[];
  readonly singles: number[];
  impl: (input: ScheduleManyInput) => Promise<ScheduleManyResult>;
  readonly namespace: Env["RACE_DAY"];
  calls(): number;
}

function fakeRaceDay(): FakeRaceDay {
  const f: FakeRaceDay = {
    names: [],
    many: [],
    singles: [],
    impl: async (input) => ({ accepted: true, mode: input.mode, results: input.raceIds.map((raceId) => ({ raceId, result: "accepted" as const })) }),
    namespace: undefined as never,
    calls: () => f.names.length,
  };
  const never = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  (f as { namespace: Env["RACE_DAY"] }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () => ({
      scheduleMany: (input: ScheduleManyInput) => {
        f.many.push(input);
        return f.impl(input);
      },
      schedule: () => {
        f.singles.push(1);
        throw new Error("schedule は呼ばれない想定(一括は scheduleMany 1 回)");
      },
      getBoard: never("getBoard"),
      getMorningPrior: never("getMorningPrior"),
      getRaceList: never("getRaceList"),
      requestPlan: never("requestPlan"),
      getPlanProgress: never("getPlanProgress"),
      getAutoRunResults: never("getAutoRunResults"),
      getNotifications: never("getNotifications"),
      requestResultImport: never("requestResultImport"),
      getResultImportProgress: never("getResultImportProgress"),
    }),
  };
  return f;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function envOf(raceDay: FakeRaceDay): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: raceDay.namespace,
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { key, deps, token, stranger };
}

function post(body: unknown, init: { token?: string; origin?: string | null; contentType?: string | null; headers?: Record<string, string>; raw?: string; path?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Request(`${ORIGIN}${init.path ?? "/api/analyses/run/bulk"}`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}

function get(path: string, token: string | undefined, method = "GET"): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { method, headers });
}

/** 中央の有効なレース ID を n 個(場コード 01〜10 × 12R)。 */
function manyIds(n: number): string[] {
  const ids: string[] = [];
  for (let venue = 1; venue <= 10 && ids.length < n; venue++) {
    for (let race = 1; race <= 12 && ids.length < n; race++) {
      ids.push(`2026${String(venue).padStart(2, "0")}0101${String(race).padStart(2, "0")}`);
    }
  }
  expect(ids).toHaveLength(n); // 前提: 欲しい数だけ作れた
  return ids;
}

const GOOD_BODY = { kaisai_date: DATE, mode: "pre_race", race_ids: [R1, R2, R3] };

describe("POST /api/analyses/run/bulk(Issue #251)", () => {
  it("正しい入力は 202 で、日単位の DO(名前は開催日)に scheduleMany を 1 回だけ呼ぶ(1 レースごとの schedule は呼ばない)。本文はレースごとの結果", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: true,
      kaisai_date: DATE,
      mode: "pre_race",
      results: [
        { race_id: R1, result: "accepted" },
        { race_id: R2, result: "accepted" },
        { race_id: R3, result: "accepted" },
      ],
    });
    expect(raceDay.names).toEqual([DATE]);
    expect(raceDay.many).toEqual([{ kaisaiDate: DATE, mode: "pre_race", raceIds: [R1, R2, R3] }]);
    expect(raceDay.singles).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("実行中のレースは already-running(状態つき)で結果に載る。応答は DO の結果から固定の形だけを作る(余計なフィールドを写さない)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    raceDay.impl = async (input) =>
      ({
        accepted: true,
        mode: input.mode,
        results: [
          { raceId: R1, result: "already-running", status: "fetched", secret: "leak" },
          { raceId: R2, result: "accepted", secret: "leak" },
        ],
        secret: "leak",
      }) as unknown as ScheduleManyResult;
    const response = await handle(post({ ...GOOD_BODY, race_ids: [R1, R2] }, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: true,
      kaisai_date: DATE,
      mode: "pre_race",
      results: [
        { race_id: R1, result: "already-running", status: "fetched" },
        { race_id: R2, result: "accepted" },
      ],
    });
  });

  it("morning でも受理する。地方のレース ID も、月日が開催日と合っていれば通る。件数の上限(MAX_BULK_RACES)ちょうどは通る", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const a = await handle(post({ kaisai_date: DATE, mode: "morning", race_ids: [R1] }, { token }), envOf(raceDay), {}, deps);
    expect(a.status).toBe(202);
    const b = await handle(post({ kaisai_date: "20260712", mode: "morning", race_ids: ["202654071210"] }, { token }), envOf(raceDay), {}, deps);
    expect(b.status).toBe(202);
    const ids = manyIds(MAX_BULK_RACES);
    const c = await handle(post({ kaisai_date: DATE, mode: "morning", race_ids: ids }, { token }), envOf(raceDay), {}, deps);
    expect(c.status).toBe(202);
    expect(raceDay.many).toHaveLength(3);
  });

  describe("認証と役割(管理者専用)", () => {
    it.each([
      ["JWT なし", undefined],
      ["壊れた JWT", "a.b.c"],
    ])("%s の POST は 403 で、DO を呼ばない", async (_name, badToken) => {
      const { deps } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, badToken === undefined ? {} : { token: badToken }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(raceDay.calls()).toBe(0);
    });

    it("管理者でないアカウント(閲覧者)の POST は 403(admin-only)で、本文を読まず DO を呼ばない", async () => {
      const { deps, stranger } = await setup();
      const raceDay = fakeRaceDay();
      const request = post(GOOD_BODY, { token: stranger });
      const response = await handle(request, envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(JSON.stringify({ ok: false, error: { type: "admin-only" } }));
      expect(request.bodyUsed).toBe(false);
      expect(raceDay.calls()).toBe(0);
    });

    it("閲覧者は GET でも 403(同じ階層の {id} に化けて読み取りが開かない)。DO を呼ばない", async () => {
      const { deps, stranger } = await setup();
      const raceDay = fakeRaceDay();
      for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
        const response = await handle(get("/api/analyses/run/bulk", stranger, method), envOf(raceDay), {}, deps);
        expect(response.status, method).toBe(403);
      }
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("Origin の確認(他サイトから送られた POST を拒否する)", () => {
    it.each([
      ["別のサイトの Origin", "https://evil.example"],
      ["Origin が無い", null],
      ["Origin: null", "null"],
      ["スキームが違う", "http://cloud.invalid"],
    ])("%s は 403(origin-mismatch)で、DO を呼ばない", async (_name, origin) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, { token, origin }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
      expect(raceDay.calls()).toBe(0);
    });

    it("Sec-Fetch-Site が same-origin でないなら拒否する。same-origin・無しは通る(対照)", async () => {
      const { deps, token } = await setup();
      const bad = fakeRaceDay();
      expect((await handle(post(GOOD_BODY, { token, headers: { "Sec-Fetch-Site": "cross-site" } }), envOf(bad), {}, deps)).status).toBe(403);
      expect(bad.calls()).toBe(0);
      const ok = fakeRaceDay();
      expect((await handle(post(GOOD_BODY, { token, headers: { "Sec-Fetch-Site": "same-origin" } }), envOf(ok), {}, deps)).status).toBe(202);
    });
  });

  describe("不正な入力は 400(または 415・413)で、DO を呼ばない", () => {
    const cases: Array<[string, unknown]> = [
      ["race_ids が無い", { kaisai_date: DATE, mode: "pre_race" }],
      ["kaisai_date が無い", { mode: "pre_race", race_ids: [R1] }],
      ["mode が無い(既定の種類を持たない=課金を伴うので明示させる)", { kaisai_date: DATE, race_ids: [R1] }],
      ["mode が未知", { ...GOOD_BODY, mode: "evening" }],
      ["mode が文字列でない", { ...GOOD_BODY, mode: 1 }],
      ["race_ids が配列でない", { ...GOOD_BODY, race_ids: R1 }],
      ["race_ids が空", { ...GOOD_BODY, race_ids: [] }],
      ["race_ids の要素が文字列でない", { ...GOOD_BODY, race_ids: [R1, 202603020202] }],
      ["race_ids に重複", { ...GOOD_BODY, race_ids: [R1, R2, R1] }],
      ["race_ids が MAX_BULK_RACES 超過", { ...GOOD_BODY, race_ids: manyIds(MAX_BULK_RACES + 1) }],
      ["race_ids に無効なレース ID(桁が違う)", { ...GOOD_BODY, race_ids: [R1, "2026030202"] }],
      ["race_ids に無効なレース ID(帯広は対象外)", { ...GOOD_BODY, race_ids: [R1, "202665010101"] }],
      ["年が違うレース ID", { ...GOOD_BODY, race_ids: [R1, "202503020201"] }],
      ["地方のレース ID の月日が開催日と違う", { kaisai_date: "20260713", mode: "morning", race_ids: ["202654071210"] }],
      ["kaisai_date が YYYYMMDD でない", { ...GOOD_BODY, kaisai_date: "2026-06-28" }],
      ["kaisai_date が存在しない日", { ...GOOD_BODY, kaisai_date: "20260230" }],
      ["kaisai_date が文字列でない", { ...GOOD_BODY, kaisai_date: 20260628 }],
      ["未知のキー", { ...GOOD_BODY, extra: 1 }],
      ["単独の run のキー(race_id)を混ぜる", { ...GOOD_BODY, race_id: R1 }],
      ["本文が配列", [R1]],
      ["本文が null", null],
    ];

    it.each(cases)("%s → 400", async (_name, body) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(body, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(400);
      expect(raceDay.calls()).toBe(0);
    });

    it("JSON として読めない本文・空の本文は 400", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      expect((await handle(post(undefined, { token, raw: "{not json" }), envOf(raceDay), {}, deps)).status).toBe(400);
      expect((await handle(post(undefined, { token, raw: "" }), envOf(raceDay), {}, deps)).status).toBe(400);
      expect(raceDay.calls()).toBe(0);
    });

    it("Content-Type が application/json でないなら 415", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, { token, contentType: "text/plain" }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(415);
      expect(raceDay.calls()).toBe(0);
    });

    it("本文が大きすぎる(4 KiB 超)なら 413。MAX_BULK_RACES 件の正しい本文はその内側に収まる(件数の上限と本文の上限が食い違わない)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const big = await handle(post(undefined, { token, raw: JSON.stringify({ ...GOOD_BODY, race_ids: [R1], pad: "x".repeat(5000) }) }), envOf(raceDay), {}, deps);
      expect(big.status).toBe(413);
      expect(raceDay.calls()).toBe(0);
      const ids = manyIds(MAX_BULK_RACES);
      const maxBody = JSON.stringify({ kaisai_date: DATE, mode: "pre_race", race_ids: ids });
      expect(maxBody.length).toBeLessThan(4096); // 前提: 最大件数の本文が上限の内側
      expect((await handle(post(undefined, { token, raw: maxBody }), envOf(raceDay), {}, deps)).status).toBe(202);
    });
  });

  describe("1 日の上限(全か無か)", () => {
    it("DO が day-cap を返したら 409(本文は固定の形: type・limit・used・needed)。202 にしない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.impl = async () => ({ accepted: false, reason: "day-cap", limit: 100, used: 99, needed: 2 });
      const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error: { type: "day-cap", limit: 100, used: 99, needed: 2 } });
    });
  });

  describe("DO の失敗は内部の文面を出さない", () => {
    it("DO が投げたら 503(race-day-error)。例外の文面・スタック・SQL を本文に含めない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.impl = async () => {
        throw new Error("SQLITE_ERROR: no such table race_day_tasks at /internal/path secret-value");
      };
      const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "race-day-error" } });
      for (const leaked of ["SQLITE", "race_day_tasks", "/internal", "secret-value"]) {
        expect(text.includes(leaked), leaked).toBe(false);
      }
    });

    it("DO が想定外の形を返したら 503(応答の形を信用しない。202 にしない)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.impl = async () => ({ accepted: true, mode: "pre_race", results: "oops" }) as unknown as ScheduleManyResult;
      const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: { type: "race-day-error" } });
    });
  });

  it("POST 以外(GET・HEAD・PUT・DELETE)は 405(認証の後。DO を呼ばない)。単独の /api/analyses/run は従来どおり", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const response = await handle(get("/api/analyses/run/bulk", token, method), envOf(raceDay), {}, deps);
      expect(response.status, method).toBe(405);
      // GET・HEAD は個別の 405(allow: POST)。PUT・DELETE は、その手前の共通の 405(単独の run と同じ)
      if (method === "GET" || method === "HEAD") expect(response.headers.get("allow")).toBe("POST");
    }
    expect(raceDay.calls()).toBe(0);
    // 対照: 単独の run に一括の本文を送っても 400(キーが違う)で、DO は呼ばない
    const single = await handle(post(GOOD_BODY, { token, path: "/api/analyses/run" }), envOf(raceDay), {}, deps);
    expect(single.status).toBe(400);
    expect(raceDay.calls()).toBe(0);
  });
});
