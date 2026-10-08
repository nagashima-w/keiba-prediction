import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { ScheduleInput, ScheduleResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #189: JSON の POST の守り(`readJsonObjectBody`)の特性化テスト。
 * run(`POST /api/analyses/run`)の守りの各段の**応答(status と本文の完全一致)と、裏側(DO・D1)を呼ばないこと**を固定する。
 * 守りを関数に抜き出す前に、今のコードで緑にして書いた(抜き出しで run の挙動が変わらないことの根拠)。
 * 同じ表を settings(`POST /api/settings`)と、結果の取り込み(`POST /api/results/import`。Issue #208。上限は run と同じ 1 KiB)にも回す(守りの順序: Origin 403 → Content-Type 415 → 本文の大きさ 413 → JSON・オブジェクト 400)。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface GuardRoute {
  readonly name: string;
  readonly path: string;
  /** 本文の上限(バイト)。 */
  readonly limit: number;
  /** 守りを通ったあと、ルート固有の検証で 400 になる本文(未知のキーだけを持つ)の作り方。 */
  readonly unknownKeyBody: (padding: string) => string;
  /** 裏側(DO・D1)へ触れた回数を数える環境を作る。 */
  readonly makeEnv: () => { env: Env; touched: () => number };
}

function runEnv(): { env: Env; touched: () => number } {
  let touched = 0;
  const raceDay = {
    idFromName: (name: string) => {
      touched += 1;
      return name;
    },
    get: () => ({
      schedule: (input: ScheduleInput): Promise<ScheduleResult> => {
        touched += 1;
        return Promise.resolve({ accepted: true, raceId: input.raceId, mode: input.mode ?? "morning", status: "queued" } as ScheduleResult);
      },
    }),
  } as unknown as Env["RACE_DAY"];
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: raceDay,
  };
  return { env, touched: () => touched };
}

function settingsEnv(): { env: Env; touched: () => number } {
  let touched = 0;
  const db = {
    prepare: () => {
      touched += 1;
      throw new Error("守りの内側では D1 に触れない想定");
    },
  } as unknown as Env["DB"];
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: db,
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
  };
  return { env, touched: () => touched };
}

/** 結果の取り込み(Issue #208)。守りの内側では D1（列挙）にも DO にも触れない。 */
function resultsImportEnv(): { env: Env; touched: () => number } {
  let touched = 0;
  const touch = (): never => {
    touched += 1;
    throw new Error("守りの内側では D1・DO に触れない想定");
  };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: touch, batch: touch } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: touch, get: touch },
  };
  return { env, touched: () => touched };
}

const ROUTES: readonly GuardRoute[] = [
  {
    name: "run(POST /api/analyses/run)",
    path: "/api/analyses/run",
    limit: 1024,
    unknownKeyBody: (padding) => JSON.stringify({ x: padding }),
    makeEnv: runEnv,
  },
  {
    name: "settings(POST /api/settings。上限は run と別: 16 KiB)",
    path: "/api/settings",
    limit: 16 * 1024,
    unknownKeyBody: (padding) => JSON.stringify({ x: padding }),
    makeEnv: settingsEnv,
  },
  {
    name: "results import(POST /api/results/import。上限は run と同じ: 1 KiB)",
    path: "/api/results/import",
    limit: 1024,
    unknownKeyBody: (padding) => JSON.stringify({ x: padding }),
    makeEnv: resultsImportEnv,
  },
];

describe("本文の上限はルートごとに持つ", () => {
  it("run は 1 KiB のまま・settings は 16 KiB: 1,025 バイトの本文は run で 413・settings では守りを通る(400)", async () => {
    const { deps, token } = await setup();
    const [runRoute, settingsRoute] = ROUTES as [GuardRoute, GuardRoute];
    expect(runRoute.limit).toBe(1024);
    expect(settingsRoute.limit).toBe(16384);
    const raw = exactSizedBody(runRoute, 1025);
    const onRun = await handle(post(runRoute.path, { token, raw }), runRoute.makeEnv().env, {}, deps);
    const onSettings = await handle(post(settingsRoute.path, { token, raw }), settingsRoute.makeEnv().env, {}, deps);
    expect(onRun.status).toBe(413);
    expect(onSettings.status).toBe(400);
  });
});

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  return { deps, token };
}

interface PostInit {
  token?: string;
  origin?: string | null;
  contentType?: string | null;
  raw: string;
}

function post(path: string, init: PostInit): Request {
  const headers = new Headers();
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: init.raw });
}

/** ちょうど `bytes` バイトの、`{"x":"aaa…"}` の形の JSON(キーは `unknownKeyBody` が作る)。 */
function exactSizedBody(route: GuardRoute, bytes: number): string {
  const overhead = Buffer.byteLength(route.unknownKeyBody(""));
  const body = route.unknownKeyBody("a".repeat(bytes - overhead));
  expect(Buffer.byteLength(body), "前提: 本文がちょうど指定のバイト数").toBe(bytes);
  return body;
}

describe.each(ROUTES)("JSON の POST の守り: $name", (route) => {
  it("認証なしは 403(forbidden)。裏側を呼ばない", async () => {
    const { deps } = await setup();
    const { env, touched } = route.makeEnv();
    const response = await handle(post(route.path, { raw: "{}" }), env, {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(touched()).toBe(0);
  });

  it("違反が重なったときの順序: Origin 不正 + Content-Type 不正 + 大きすぎる本文 + 壊れた JSON は 403(origin-mismatch の固定の本文)", async () => {
    const { deps, token } = await setup();
    const { env, touched } = route.makeEnv();
    const response = await handle(post(route.path, { token, origin: "https://evil.example", contentType: "text/plain", raw: "{" + "x".repeat(route.limit + 1) }), env, {}, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    expect(touched()).toBe(0);
  });

  it("Origin が正しく、Content-Type 不正 + 大きすぎる本文 + 壊れた JSON は 415(固定の本文)", async () => {
    const { deps, token } = await setup();
    const { env, touched } = route.makeEnv();
    const response = await handle(post(route.path, { token, contentType: "text/plain", raw: "{" + "x".repeat(route.limit + 1) }), env, {}, deps);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: { type: "unsupported-media-type", message: "Content-Type は application/json にしてください" } });
    expect(touched()).toBe(0);
  });

  it("Content-Type が無い場合も 415", async () => {
    const { deps, token } = await setup();
    const { env, touched } = route.makeEnv();
    const response = await handle(post(route.path, { token, contentType: null, raw: "{}" }), env, {}, deps);
    expect(response.status).toBe(415);
    expect(touched()).toBe(0);
  });

  it("Content-Type が正しく、上限を 1 バイト超えた本文(壊れた JSON でも)は 413(上限のバイト数つきの固定の本文)。ちょうど上限なら 413 にならない(境界)", async () => {
    const { deps, token } = await setup();
    const over = route.makeEnv();
    const response = await handle(post(route.path, { token, raw: "{" + "x".repeat(route.limit) }), over.env, {}, deps);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: { type: "payload-too-large", message: `本文は ${route.limit} バイトまでです` } });
    expect(over.touched()).toBe(0);

    const overValid = route.makeEnv();
    const overValidResponse = await handle(post(route.path, { token, raw: exactSizedBody(route, route.limit + 1) }), overValid.env, {}, deps);
    expect(overValidResponse.status).toBe(413);

    const atLimit = route.makeEnv();
    const atLimitResponse = await handle(post(route.path, { token, raw: exactSizedBody(route, route.limit) }), atLimit.env, {}, deps);
    expect(atLimitResponse.status, "上限ちょうどは守りを通り、ルート固有の検証(未知のキー)で 400").toBe(400);
    expect(atLimit.touched()).toBe(0);
  });

  it("JSON として読めない本文・空の本文は 400(固定の message)", async () => {
    const { deps, token } = await setup();
    for (const raw of ["{not json", ""]) {
      const { env, touched } = route.makeEnv();
      const response = await handle(post(route.path, { token, raw }), env, {}, deps);
      expect(response.status, raw).toBe(400);
      expect(await response.json(), raw).toEqual({ ok: false, error: { type: "bad-request", message: "本文が JSON として読めません" } });
      expect(touched(), raw).toBe(0);
    }
  });

  it("JSON のオブジェクトでない本文(配列・null・数値・文字列)は 400(固定の message)", async () => {
    const { deps, token } = await setup();
    for (const raw of ["[]", "null", "5", '"x"']) {
      const { env, touched } = route.makeEnv();
      const response = await handle(post(route.path, { token, raw }), env, {}, deps);
      expect(response.status, raw).toBe(400);
      expect(await response.json(), raw).toEqual({ ok: false, error: { type: "bad-request", message: "本文は JSON のオブジェクトにしてください" } });
      expect(touched(), raw).toBe(0);
    }
  });

  it("charset つきの application/json は守りを通る(対照。ルート固有の検証で 400 になる本文で、守りの 415 でないことを確かめる)", async () => {
    const { deps, token } = await setup();
    const { env } = route.makeEnv();
    const response = await handle(post(route.path, { token, contentType: "application/json; charset=utf-8", raw: route.unknownKeyBody("a") }), env, {}, deps);
    expect(response.status).toBe(400);
  });
});
