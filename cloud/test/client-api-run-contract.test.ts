import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { postRun } from "../client/api-run";
import { handle, type Env } from "../src/handler";
import type { ScheduleInput, ScheduleResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #186: 契約テスト。クライアントの起動(`postRun`)が送るリクエストを、実際の `handle()`(偽の DO)に通し、本物の応答をクライアントの分類に通す。
 * サーバ側のキー名・状態(本文のキー・Content-Type・Origin の検査・202/409/403 の形)が変わると、ここで検出する。
 * 偽の fetch が `handle()` を呼ぶだけで、リクエストの組み立て・サーバの検証・応答の分類は本物。
 * **ブラウザが付けるヘッダ(Origin・Sec-Fetch-Site)は、ブラウザが付ける値を模して付ける**(Origin はページのオリジン。`Origin: null` の場合を別に検査する)。
 */

const ORIGIN = "https://cloud.invalid";
const RACE = "202603020211";
const DATE = "20260628";
const REQUEST = { raceId: RACE, date: DATE, mode: "pre_race" } as const;

async function connect(options: { schedule?: (input: ScheduleInput) => Promise<ScheduleResult>; origin?: string | null; token?: boolean } = {}): Promise<{ fetch: FetchLike; schedules: ScheduleInput[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const schedules: ScheduleInput[] = [];
  const raceDay = {
    idFromName: (name: string) => name,
    get: () => ({
      schedule: (input: ScheduleInput) => {
        schedules.push(input);
        return (options.schedule ?? (async (i: ScheduleInput) => ({ accepted: true, raceId: i.raceId, mode: i.mode ?? "morning", status: "queued" }) as ScheduleResult))(input);
      },
    }),
  } as unknown as Env["RACE_DAY"];
  const NOT_CALLED = (): never => {
    throw new Error("呼ばれない想定");
  };
  const env: Env = { ...GOOD_ENV, NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED }, DB: { prepare: NOT_CALLED } as unknown as Env["DB"], ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"], RACE_DAY: raceDay };
  const fetchLike: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    if (options.token !== false) headers.set("Cf-Access-Jwt-Assertion", token);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.set("Origin", origin);
    headers.set("Sec-Fetch-Site", "same-origin");
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers, body: init.body }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return { fetch: fetchLike, schedules };
}

describe("契約: POST /api/analyses/run の本物の応答をクライアントが分類できる", () => {
  it("202(受理): クライアントのリクエスト(本文のキー・Content-Type)をサーバが受け付け、202 の本文を accepted と読む。DO には race_id・開催日・mode が渡る", async () => {
    const { fetch, schedules } = await connect();
    expect(await postRun(fetch, REQUEST)).toEqual({ kind: "accepted" });
    expect(schedules).toEqual([{ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" }]);
    const morning = await connect();
    expect(await postRun(morning.fetch, { ...REQUEST, mode: "morning" })).toEqual({ kind: "accepted" });
    expect(morning.schedules[0]!.mode).toBe("morning");
  });

  it("409(実行中): status(queued・fetched)を保って already-running", async () => {
    for (const status of ["queued", "fetched"] as const) {
      const { fetch } = await connect({ schedule: async (i) => ({ accepted: false, raceId: i.raceId, mode: i.mode ?? "morning", status }) as ScheduleResult });
      expect(await postRun(fetch, REQUEST)).toEqual({ kind: "already-running", status });
    }
  });

  it("403: Origin が `null`(参照元ポリシー no-referrer で、mode が cors 以外の fetch が付ける値)・無い・別のオリジンは、origin-mismatch(サーバの本物の本文)。DO は呼ばれない", async () => {
    for (const origin of ["null", null, "https://evil.example"]) {
      const { fetch, schedules } = await connect({ origin });
      expect(await postRun(fetch, REQUEST), String(origin)).toEqual({ kind: "failed", failure: { kind: "origin-mismatch" } });
      expect(schedules).toEqual([]);
    }
  });

  it("403: 認証に失敗した応答(Access の関門。本文は平文の forbidden)は forbidden(origin-mismatch と取り違えない)", async () => {
    const { fetch } = await connect({ token: false });
    expect(await postRun(fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "forbidden" } });
  });

  it("400(不正な入力)は bad-request、DO の失敗(503)は server-error", async () => {
    const bad = await connect();
    expect(await postRun(bad.fetch, { ...REQUEST, raceId: "x" })).toEqual({ kind: "failed", failure: { kind: "bad-request" } });
    expect(bad.schedules).toEqual([]);
    const broken = await connect({
      schedule: async () => {
        throw new Error("DO 内部の秘密");
      },
    });
    expect(await postRun(broken.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "server-error" } });
  });
});
