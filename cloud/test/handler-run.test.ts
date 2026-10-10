import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { Board, MorningPrior, ScheduleInput, ScheduleResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #180(#164-e): 手動起動の入口 `POST /api/analyses/run` と、状態の確認 `GET /api/analyses/status`。
 * 日単位の DO(RaceDay)は偽物(呼び出しを記録する)。実 netkeiba・実 DO には触れない。
 * AC: e1 実行中の同じレースの重複起動は拒否(409)/ e2 認証なし・別メールは 403 / e3 Origin が違う POST は拒否 / 不正な入力は 400 で DO を呼ばない / DO の失敗の文面を出さない。
 */

const ORIGIN = "https://cloud.invalid";
const RACE = "202603020211";
const DATE = "20260628";

interface FakeRaceDay {
  readonly names: string[];
  readonly schedules: ScheduleInput[];
  readonly boards: number[];
  readonly priors: string[];
  scheduleImpl: (input: ScheduleInput) => Promise<ScheduleResult>;
  boardImpl: () => Promise<Board>;
  priorImpl: (raceId: string) => Promise<MorningPrior | null>;
  readonly namespace: Env["RACE_DAY"];
  /** DO への呼び出しの総数。 */
  calls(): number;
}

function fakeRaceDay(): FakeRaceDay {
  const f: FakeRaceDay = {
    names: [],
    schedules: [],
    boards: [],
    priors: [],
    scheduleImpl: async (input) => ({ accepted: true, raceId: input.raceId, mode: input.mode ?? "morning", status: "queued" }),
    boardImpl: async () => ({ kaisaiDate: DATE, races: [] }),
    priorImpl: async () => null,
    namespace: undefined as never,
    calls: () => f.names.length,
  };
  (f as { namespace: Env["RACE_DAY"] }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () => ({
      schedule: (input: ScheduleInput) => {
        f.schedules.push(input);
        return f.scheduleImpl(input);
      },
      getBoard: () => {
        f.boards.push(1);
        return f.boardImpl();
      },
      getMorningPrior: (raceId: string) => {
        f.priors.push(raceId);
        return f.priorImpl(raceId);
      },
      // Issue #251: 一括の予約は handler-run-bulk.test.ts の持ち分。ここでは呼ばれない。
      scheduleMany: () => {
        throw new Error("scheduleMany は呼ばれない想定");
      },
      // この偽物のファイルは一覧の入口を検査しない(handler-races.test.ts)。呼ばれたら失敗する。
      getRaceList: () => {
        throw new Error("getRaceList は呼ばれない想定");
      },
      // Issue #206: 計画の依頼・読み取りは cron と GET /api/plan の持ち分(handler-plan.test.ts)。ここでは呼ばれない。
      requestPlan: () => {
        throw new Error("requestPlan は呼ばれない想定");
      },
      getPlanProgress: () => {
        throw new Error("getPlanProgress は呼ばれない想定");
      },
      getAutoRunResults: () => {
        throw new Error("getAutoRunResults は呼ばれない想定");
      },
      getNotifications: () => {
        throw new Error("getNotifications は呼ばれない想定");
      },
      // Issue #208: 結果の取り込みの依頼・観測は、dispatchResultImports（cron・POST /api/results/import）と GET /api/plan の持ち分。ここでは呼ばれない。
      requestResultImport: () => {
        throw new Error("requestResultImport は呼ばれない想定");
      },
      getResultImportProgress: () => {
        throw new Error("getResultImportProgress は呼ばれない想定");
      },
    }),
  };
  return f;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function envOf(raceDay: FakeRaceDay, overrides: Partial<Env> = {}): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: raceDay.namespace,
    ...overrides,
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { key, deps, token, stranger };
}

function post(body: unknown, init: { token?: string; origin?: string | null; contentType?: string | null; headers?: Record<string, string>; raw?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Request(`${ORIGIN}/api/analyses/run`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}

function get(path: string, token?: string, method = "GET"): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { method, headers });
}

const GOOD_BODY = { race_id: RACE, kaisai_date: DATE, mode: "morning" };

describe("POST /api/analyses/run(Issue #180)", () => {
  it("正しい入力は 202 で、日単位の DO(名前は開催日)に予約を1回だけ入れる。本文は予約の結果(取得はまだ始まらない)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, accepted: true, race_id: RACE, kaisai_date: DATE, mode: "morning", status: "queued" });
    expect(raceDay.names).toEqual([DATE]);
    expect(raceDay.schedules).toEqual([{ raceId: RACE, kaisaiDate: DATE, mode: "morning" }]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("mode は省略できる(既定は朝の取得と prior)。地方のレースIDも、月日が開催日と合っていれば通る", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const a = await handle(post({ race_id: RACE, kaisai_date: DATE }, { token }), envOf(raceDay), {}, deps);
    expect(a.status).toBe(202);
    expect(((await a.json()) as { mode: string }).mode).toBe("morning");
    const b = await handle(post({ race_id: "202654071210", kaisai_date: "20260712" }, { token }), envOf(raceDay), {}, deps);
    expect(b.status).toBe(202);
    expect(raceDay.schedules).toHaveLength(2);
  });

  it("Issue #194: 未知の mode の 400 は、発走前の分析が LLM を使うことを説明する(API の応答に出る文。『LLM なし』という古い説明を残さない)。DO は呼ばない", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(post({ ...GOOD_BODY, mode: "evening" }, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } | string };
    const text = JSON.stringify(body);
    expect(text).toContain("pre_race");
    expect(text).toContain("発走前の分析。LLM を使う");
    expect(text).not.toContain("LLM なし");
    expect(raceDay.calls()).toBe(0);
  });

  it("Issue #178: mode: \"pre_race\"(発走前の分析)も 202 で、DO には mode つきで予約する。応答に mode を返す。実行中なら 409(朝の実行とは別のタスクなので、DO が種類ごとに判断する)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(post({ ...GOOD_BODY, mode: "pre_race" }, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, accepted: true, race_id: RACE, kaisai_date: DATE, mode: "pre_race", status: "queued" });
    expect(raceDay.schedules).toEqual([{ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" }]);
    // 朝は mode を明示して DO に渡す(既定の取り違えを避ける)
    const morning = fakeRaceDay();
    await handle(post(GOOD_BODY, { token }), envOf(morning), {}, deps);
    expect(morning.schedules).toEqual([{ raceId: RACE, kaisaiDate: DATE, mode: "morning" }]);
    raceDay.scheduleImpl = async (input) => ({ accepted: false, raceId: input.raceId, mode: "pre_race", status: "fetched" });
    expect((await handle(post({ ...GOOD_BODY, mode: "pre_race" }, { token }), envOf(raceDay), {}, deps)).status).toBe(409);
  });

  describe("e2: 認証(Access の関門の後ろ)", () => {
    it.each([
      ["JWT なし", undefined],
      ["壊れた JWT", "a.b.c"],
    ])("%s の POST は 403(固定の本文)で、DO を呼ばない。Origin・本文が正しくても同じ", async (_name, badToken) => {
      const { deps } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, badToken === undefined ? {} : { token: badToken }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(raceDay.calls()).toBe(0);
    });

    // Issue #238(契約変更): 本文は認証なしの `forbidden` ではなく、管理者専用の固定の本文(`admin-only`)。DO を呼ばないことは同じ。
    it("管理者でないアカウント(閲覧者)の JWT は 403(admin-only)で、DO を呼ばない", async () => {
      const { deps, stranger } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, { token: stranger }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(JSON.stringify({ ok: false, error: { type: "admin-only" } }));
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("e3: Origin の確認(他サイトから送られた POST を拒否する)", () => {
    it.each([
      ["別のサイトの Origin", "https://evil.example"],
      ["Origin が無い", null],
      ["Origin: null(サンドボックスの iframe 等)", "null"],
      ["スキームが違う", "http://cloud.invalid"],
      ["ポートが違う", "https://cloud.invalid:8443"],
      ["サブドメイン", "https://x.cloud.invalid"],
      ["末尾にパス", "https://cloud.invalid/"],
      ["空文字", ""],
    ])("%s は 403(origin-mismatch)で、DO を呼ばない", async (_name, origin) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(GOOD_BODY, { token, origin }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
      expect(raceDay.calls()).toBe(0);
    });

    it("Origin が正しくても、Sec-Fetch-Site が same-origin でない(cross-site・same-site・none 以外)なら拒否する。same-origin・無しは通る(対照)", async () => {
      const { deps, token } = await setup();
      for (const site of ["cross-site", "same-site", "none"]) {
        const raceDay = fakeRaceDay();
        const response = await handle(post(GOOD_BODY, { token, headers: { "Sec-Fetch-Site": site } }), envOf(raceDay), {}, deps);
        expect(response.status, site).toBe(403);
        expect(raceDay.calls(), site).toBe(0);
      }
      const ok = fakeRaceDay();
      expect((await handle(post(GOOD_BODY, { token, headers: { "Sec-Fetch-Site": "same-origin" } }), envOf(ok), {}, deps)).status).toBe(202);
      expect((await handle(post(GOOD_BODY, { token }), envOf(ok), {}, deps)).status).toBe(202);
    });

    it("Origin が違うと、本文が不正でも 400 ではなく 403(先に Origin を見る)", async () => {
      const { deps, token } = await setup();
      const response = await handle(post({ race_id: "x" }, { token, origin: "https://evil.example" }), envOf(fakeRaceDay()), {}, deps);
      expect(response.status).toBe(403);
    });
  });

  describe("不正な入力は 400(または 415)で、DO を呼ばない", () => {
    const cases: Array<[string, unknown, Parameters<typeof post>[1]?]> = [
      ["race_id が無い", { kaisai_date: DATE }],
      ["kaisai_date が無い", { race_id: RACE }],
      ["race_id が文字列でない", { race_id: 202603020211, kaisai_date: DATE }],
      ["race_id が無効(桁が違う)", { race_id: "2026030202", kaisai_date: DATE }],
      ["race_id が無効(帯広は対象外)", { race_id: "202665010101", kaisai_date: DATE }],
      ["kaisai_date が YYYYMMDD でない", { race_id: RACE, kaisai_date: "2026-06-28" }],
      ["kaisai_date が存在しない日", { race_id: RACE, kaisai_date: "20260230" }],
      ["年が違う", { race_id: RACE, kaisai_date: "20250628" }],
      ["地方のレースIDの月日が開催日と違う", { race_id: "202654071210", kaisai_date: "20260713" }],
      ["mode が未知", { ...GOOD_BODY, mode: "evening" }],
      ["mode が文字列でない", { ...GOOD_BODY, mode: 1 }],
      ["mode が空文字", { ...GOOD_BODY, mode: "" }],
      ["未知のキー", { ...GOOD_BODY, extra: 1 }],
      ["本文が配列", [RACE, DATE]],
      ["本文が null", null],
    ];
    it.each(cases)("%s", async (_name, body) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post(body, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(400);
      const json = (await response.json()) as { ok: boolean; error: { type: string; message: string } };
      expect(json).toMatchObject({ ok: false, error: { type: "bad-request" } });
      expect(raceDay.calls()).toBe(0);
    });

    it("JSON として読めない本文・空の本文は 400", async () => {
      const { deps, token } = await setup();
      for (const raw of ["{not json", ""]) {
        const raceDay = fakeRaceDay();
        const response = await handle(post(null, { token, raw }), envOf(raceDay), {}, deps);
        expect(response.status, raw).toBe(400);
        expect(raceDay.calls(), raw).toBe(0);
      }
    });

    it("Content-Type が application/json でないなら 415(フォームの送信などを受けない)。DO を呼ばない", async () => {
      const { deps, token } = await setup();
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
        const raceDay = fakeRaceDay();
        const response = await handle(post(GOOD_BODY, { token, contentType }), envOf(raceDay), {}, deps);
        expect(response.status, String(contentType)).toBe(415);
        expect(raceDay.calls()).toBe(0);
      }
      // charset つきの application/json は通る(対照)
      const ok = fakeRaceDay();
      expect((await handle(post(GOOD_BODY, { token, contentType: "application/json; charset=utf-8" }), envOf(ok), {}, deps)).status).toBe(202);
    });

    it("本文が大きすぎる(1 KiB 超)なら 413 で、DO を呼ばない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(post({ ...GOOD_BODY, mode: "x".repeat(2000) }, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(413);
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("e1: 実行中の同じレースの重複起動は拒否する", () => {
    it("DO が accepted: false(実行中)を返したら 409(already-running。いまの状態つき)。202 にしない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.scheduleImpl = async (input) => ({ accepted: false, raceId: input.raceId, mode: input.mode ?? "morning", status: "fetched" });
      const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error: { type: "already-running", status: "fetched" } });
      expect(raceDay.schedules).toHaveLength(1);
    });

    it("同じ入力を2回続けると、1回目は 202・2回目は 409(DO が実行中の状態を持つ)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      let active = false;
      raceDay.scheduleImpl = async (input) => {
        if (active) return { accepted: false, raceId: input.raceId, mode: input.mode ?? "morning", status: "queued" };
        active = true;
        return { accepted: true, raceId: input.raceId, mode: input.mode ?? "morning", status: "queued" };
      };
      expect((await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps)).status).toBe(202);
      expect((await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps)).status).toBe(409);
    });
  });

  describe("DO の失敗は内部の文面を出さない", () => {
    it("DO が投げたら 503(race-day-error)。例外の文面・スタック・SQL を本文に含めない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.scheduleImpl = async () => {
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

    it("DO が入力の拒否(上限・日付の不整合)を投げたときも、文面は返さず 503 とする(入口で先に検証しているので、ここへ来るのは想定外)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.scheduleImpl = async () => {
        throw new Error("この開催日に受け付けられるレース数の上限(100)に達しています");
      };
      const response = await handle(post(GOOD_BODY, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(503);
      expect((await response.text()).includes("上限")).toBe(false);
    });
  });

  it("POST /api/analyses/run 以外の POST は、従来どおり 405(認証の後)。GET・HEAD・PUT の /api/analyses/run も 405(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    for (const [method, path] of [["POST", "/"], ["POST", "/api/analyses"], ["POST", "/api/health"], ["POST", "/api/analyses/status"], ["GET", "/api/analyses/run"], ["HEAD", "/api/analyses/run"], ["PUT", "/api/analyses/run"], ["DELETE", "/api/analyses/run"]] as const) {
      const response = await handle(get(path, token, method), envOf(raceDay), {}, deps);
      expect(response.status, `${method} ${path}`).toBe(405);
    }
    expect(raceDay.calls()).toBe(0);
  });
});

describe("GET /api/analyses/status(Issue #180)", () => {
  const board: Board = {
    kaisaiDate: DATE,
    races: [
      { raceId: "202603020210", mode: "morning", status: "done", attempts: 1, error: null, queuedAt: 1000, updatedAt: 2000, computedAt: 2000, analysisId: null, detail: null, childrenOk: null },
      { raceId: "202603020210", mode: "pre_race", status: "done", attempts: 1, error: null, queuedAt: 3000, updatedAt: 4000, computedAt: null, analysisId: 7, detail: "stored", childrenOk: true },
      { raceId: RACE, mode: "pre_race", status: "failed", attempts: 3, error: "x".repeat(500), queuedAt: 1500, updatedAt: 2500, computedAt: null, analysisId: null, detail: null, childrenOk: null },
    ],
  };

  it("認証なしは 403 で、DO を呼ばない", async () => {
    const { deps } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, undefined), envOf(raceDay), {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(raceDay.calls()).toBe(0);
  });

  // Issue #238(契約変更): 旧「別メールは 403 で DO を呼ばない」は、「別メール(閲覧者)は状態(読み取り)を見られる」に変わった
  it("別メール(閲覧者)は状態を読める(403 にならず、DO の読み取りを呼ぶ)", async () => {
    const { deps, stranger } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, stranger), envOf(raceDay), {}, deps);
    expect(response.status).not.toBe(403);
    expect(raceDay.calls()).toBeGreaterThan(0);
  });

  it("Issue #245: 閲覧者に見える error は、保存済みの値でも sk-ant- の鍵の形を伏せる(伏せてから 200 文字に切る)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const KEY = "sk-ant-api03-SECRET_BODY-0123456789";
    // 前提: 鍵は 200 文字目をまたぐ位置にある(切ってから伏せると、鍵の先頭の断片が残る)
    const stored = `${"x".repeat(190)}${KEY}${"y".repeat(50)}`;
    expect(stored.indexOf(KEY)).toBeLessThan(200);
    expect(stored.indexOf(KEY) + KEY.length).toBeGreaterThan(200);
    raceDay.boardImpl = async () => ({
      kaisaiDate: DATE,
      races: [
        { raceId: RACE, mode: "pre_race", status: "failed", attempts: 3, error: stored, queuedAt: 1500, updatedAt: 2500, computedAt: null, analysisId: null, detail: null, childrenOk: null },
        { raceId: RACE, mode: "morning", status: "failed", attempts: 1, error: `取得に失敗 ${KEY}`, queuedAt: 1500, updatedAt: 2500, computedAt: null, analysisId: null, detail: null, childrenOk: null },
      ],
    });
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, token), envOf(raceDay), {}, deps);
    expect(response.status).toBe(200);
    const text = await response.text();
    const json = JSON.parse(text) as { races: { error: string }[] };
    expect(json.races).toHaveLength(2); // 前提: 2 件とも検査される
    expect(json.races[1]!.error).toBe("取得に失敗 sk-ant-***");
    expect(json.races[0]!.error).toBe(`${"x".repeat(190)}sk-ant-***`.slice(0, 200)); // 伏せた後に切る(「sk-ant-***」は 10 文字で 200 文字に収まる)
    expect(text).not.toContain("SECRET_BODY");
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("sk-ant-a");
  });

  it("開催日の DO の状態を返す: 各レースの状態・試行回数・エラー(200 文字まで)・朝の prior の有無。朝の prior の中身は返さない", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    raceDay.boardImpl = async () => board;
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, token), envOf(raceDay), {}, deps);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; kaisai_date: string; races: Record<string, unknown>[] };
    expect(raceDay.names).toEqual([DATE]);
    expect(json.ok).toBe(true);
    expect(json.kaisai_date).toBe(DATE);
    expect(json.races).toEqual([
      { race_id: "202603020210", mode: "morning", status: "done", attempts: 1, error: null, queued_at: 1000, updated_at: 2000, prior: true, analysis_id: null, detail: null, children_ok: null },
      { race_id: "202603020210", mode: "pre_race", status: "done", attempts: 1, error: null, queued_at: 3000, updated_at: 4000, prior: false, analysis_id: 7, detail: "stored", children_ok: true },
      { race_id: RACE, mode: "pre_race", status: "failed", attempts: 3, error: "x".repeat(200), queued_at: 1500, updated_at: 2500, prior: false, analysis_id: null, detail: null, children_ok: null },
    ]);
    expect(raceDay.priors).toEqual([]); // race_id を指定しなければ、朝の prior の中身は引かない
  });

  it("race_id を指定すると、そのレースの朝の prior の最小限(馬番・馬名・prior)を、prior の高い順に返す。無ければ prior: null", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    raceDay.boardImpl = async () => board;
    raceDay.priorImpl = async () =>
      ({
        computedAt: 2000,
        result: {
          raceName: "ラジオNIKKEI賞",
          venueName: "福島",
          date: "2026/06/28",
          rows: [
            { umaban: 1, horseName: "あ", prior: 0.2, ev: 9, adjustedProb: 0.3, reason: "漏れてはいけない" },
            { umaban: 2, horseName: "い", prior: 0.5, ev: 9, adjustedProb: 0.3, reason: null },
            { umaban: 3, horseName: "う", prior: 0.35, ev: 9, adjustedProb: 0.3, reason: null },
          ],
        },
      }) as unknown as MorningPrior;
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}&race_id=202603020210`, token), envOf(raceDay), {}, deps);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { prior: unknown };
    expect(raceDay.priors).toEqual(["202603020210"]);
    expect(json.prior).toEqual({
      race_name: "ラジオNIKKEI賞",
      venue_name: "福島",
      date: "2026/06/28",
      computed_at: 2000,
      rows: [
        { rank: 1, umaban: 2, horse_name: "い", prior: 0.5 },
        { rank: 2, umaban: 3, horse_name: "う", prior: 0.35 },
        { rank: 3, umaban: 1, horse_name: "あ", prior: 0.2 },
      ],
    });
    expect(JSON.stringify(json).includes("漏れてはいけない")).toBe(false);

    raceDay.priorImpl = async () => null;
    const none = await handle(get(`/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE}`, token), envOf(raceDay), {}, deps);
    expect(((await none.json()) as { prior: unknown }).prior).toBeNull();
  });

  it.each([
    ["kaisai_date が無い", "/api/analyses/status"],
    ["kaisai_date が不正", "/api/analyses/status?kaisai_date=2026-06-28"],
    ["存在しない日", "/api/analyses/status?kaisai_date=20260230"],
    ["未知のパラメータ", `/api/analyses/status?kaisai_date=${DATE}&x=1`],
    ["kaisai_date が重複", `/api/analyses/status?kaisai_date=${DATE}&kaisai_date=${DATE}`],
    ["race_id が不正", `/api/analyses/status?kaisai_date=${DATE}&race_id=abc`],
    ["race_id が開催日と整合しない(地方の月日)", "/api/analyses/status?kaisai_date=20260713&race_id=202654071210"],
  ])("%s は 400 で、DO を呼ばない", async (_name, path) => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(get(path, token), envOf(raceDay), {}, deps);
    expect(response.status).toBe(400);
    expect(raceDay.calls()).toBe(0);
  });

  it("DO が投げたら 503(race-day-error)で、文面を出さない。HEAD は 405(DO を呼ばない)", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    raceDay.boardImpl = async () => {
      throw new Error("内部の文面 SQLITE_BUSY");
    };
    const response = await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, token), envOf(raceDay), {}, deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "race-day-error" } });
    expect(text.includes("SQLITE")).toBe(false);
    const head = fakeRaceDay();
    expect((await handle(get(`/api/analyses/status?kaisai_date=${DATE}`, token, "HEAD"), envOf(head), {}, deps)).status).toBe(405);
    expect(head.calls()).toBe(0);
  });
});
