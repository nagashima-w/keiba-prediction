import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { postBulk } from "../client/api-bulk";
import { handle, type Env } from "../src/handler";
import type { ScheduleManyInput, ScheduleManyResult } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #251: 契約テスト。クライアントの一括起動(`postBulk`)が送るリクエストを、実際の `handle()`(偽の DO)に通し、本物の応答をクライアントの分類に通す。
 * サーバ側のキー名・状態(本文のキー・Content-Type・Origin の検査・202/409/403 の形)が変わると、ここで検出する。
 * 偽の fetch が `handle()` を呼ぶだけで、リクエストの組み立て・サーバの検証・応答の分類は本物。ブラウザが付けるヘッダ(Origin・Sec-Fetch-Site)は、ブラウザが付ける値を模して付ける。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";
const R1 = "202603020201";
const R2 = "202603020202";
const REQUEST = { date: DATE, mode: "pre_race", raceIds: [R1, R2] } as const;

async function connect(options: { many?: (input: ScheduleManyInput) => Promise<ScheduleManyResult>; origin?: string | null; token?: boolean; viewer?: boolean } = {}): Promise<{ fetch: FetchLike; many: ScheduleManyInput[] }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = options.viewer === true ? await signToken(key, { email: "stranger@example.com" }) : await signToken(key);
  const many: ScheduleManyInput[] = [];
  const raceDay = {
    idFromName: (name: string) => name,
    get: () => ({
      scheduleMany: (input: ScheduleManyInput) => {
        many.push(input);
        return (options.many ?? (async (i: ScheduleManyInput) => ({ accepted: true, mode: i.mode, results: i.raceIds.map((raceId) => ({ raceId, result: "accepted" as const })) }) as ScheduleManyResult))(input);
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
  return { fetch: fetchLike, many };
}

describe("契約: POST /api/analyses/run/bulk の本物の応答をクライアントが分類できる", () => {
  it("202(受理): クライアントのリクエスト(本文のキー・Content-Type)をサーバが受け付け、レースごとの結果を読む。DO には開催日・mode・レース ID が 1 回で渡る", async () => {
    const { fetch, many } = await connect();
    expect(await postBulk(fetch, REQUEST)).toEqual({
      kind: "accepted",
      results: [
        { raceId: R1, result: "accepted" },
        { raceId: R2, result: "accepted" },
      ],
    });
    expect(many).toEqual([{ kaisaiDate: DATE, mode: "pre_race", raceIds: [R1, R2] }]);
    const morning = await connect();
    expect((await postBulk(morning.fetch, { ...REQUEST, mode: "morning" })).kind).toBe("accepted");
    expect(morning.many[0]!.mode).toBe("morning");
  });

  it("202(実行中を含む): already-running は状態(queued・fetched)を保つ", async () => {
    const { fetch } = await connect({
      many: async (i) =>
        ({
          accepted: true,
          mode: i.mode,
          results: [
            { raceId: R1, result: "already-running", status: "fetched" },
            { raceId: R2, result: "accepted" },
          ],
        }) as ScheduleManyResult,
    });
    expect(await postBulk(fetch, REQUEST)).toEqual({
      kind: "accepted",
      results: [
        { raceId: R1, result: "already-running", status: "fetched" },
        { raceId: R2, result: "accepted" },
      ],
    });
  });

  it("409(上限): day-cap の limit・used・needed を保つ", async () => {
    const { fetch } = await connect({ many: async () => ({ accepted: false, reason: "day-cap", limit: 100, used: 99, needed: 2 }) });
    expect(await postBulk(fetch, REQUEST)).toEqual({ kind: "day-cap", limit: 100, used: 99, needed: 2 });
  });

  it("403: Origin が `null`・無い・別のオリジンは origin-mismatch(サーバの本物の本文)。DO は呼ばれない", async () => {
    for (const origin of ["null", null, "https://evil.example"]) {
      const { fetch, many } = await connect({ origin });
      expect(await postBulk(fetch, REQUEST), String(origin)).toEqual({ kind: "failed", failure: { kind: "origin-mismatch" } });
      expect(many).toEqual([]);
    }
  });

  it("403: 認証に失敗した応答は forbidden。管理者でないアカウント(閲覧者)の応答も forbidden(origin-mismatch と取り違えない)。どちらも DO は呼ばれない", async () => {
    const noToken = await connect({ token: false });
    expect(await postBulk(noToken.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "forbidden" } });
    const viewer = await connect({ viewer: true });
    expect(await postBulk(viewer.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "forbidden" } });
    expect([...noToken.many, ...viewer.many]).toEqual([]);
  });

  it("400(不正な入力)は bad-request、DO の失敗(503)は server-error", async () => {
    const bad = await connect();
    expect(await postBulk(bad.fetch, { ...REQUEST, raceIds: [R1, "x"] })).toEqual({ kind: "failed", failure: { kind: "bad-request" } });
    expect(bad.many).toEqual([]);
    const broken = await connect({
      many: async () => {
        throw new Error("DO 内部の秘密");
      },
    });
    expect(await postBulk(broken.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "server-error" } });
  });
});
