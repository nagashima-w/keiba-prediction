import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { bulkFailureMessage, postBulk } from "../client/api-bulk";
import { runFailureMessage } from "../client/api-run";

/**
 * Issue #251: 一括起動 `POST /api/analyses/run/bulk` の呼び出しと応答の分類。純関数・偽の fetch。
 * Origin まわり(referrerPolicy: "same-origin" を付け、fetch の mode は指定しない)は単独の `postRun` と同じ形(api-run.ts の冒頭コメントが根拠)。
 */

const REQUEST = { date: "20260628", mode: "pre_race", raceIds: ["202603020201", "202603020202"] } as const;
type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const ACCEPTED = {
  ok: true,
  accepted: true,
  kaisai_date: REQUEST.date,
  mode: "pre_race",
  results: [
    { race_id: "202603020201", result: "accepted" },
    { race_id: "202603020202", result: "already-running", status: "fetched" },
  ],
};

function fake(respond: () => Promise<Resp>): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

describe("postBulk(リクエストの形)", () => {
  it("POST /api/analyses/run/bulk に、JSON の本文 {kaisai_date, mode, race_ids} の 3 キーだけを送る", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    await postBulk(f.fetch, REQUEST);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/analyses/run/bulk");
    expect(f.calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body).toEqual({ kaisai_date: "20260628", mode: "pre_race", race_ids: ["202603020201", "202603020202"] });
    expect(Object.keys(body).sort()).toEqual(["kaisai_date", "mode", "race_ids"]);
  });

  it("ヘッダ(content-type が application/json)・同じオリジンの資格情報・referrerPolicy: same-origin。fetch の mode は指定しない", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    await postBulk(f.fetch, REQUEST);
    const init = f.calls[0]!.init;
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(init.referrerPolicy).toBe("same-origin");
    expect("mode" in init).toBe(false);
  });
});

describe("postBulk(応答の分類)", () => {
  it("202 で本文が整っていれば accepted。レースごとの結果(accepted・already-running〈状態つき〉)を入力の順に返す", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    expect(await postBulk(f.fetch, REQUEST)).toEqual({
      kind: "accepted",
      results: [
        { raceId: "202603020201", result: "accepted" },
        { raceId: "202603020202", result: "already-running", status: "fetched" },
      ],
    });
  });

  it.each([
    ["本文が JSON でない", undefined],
    ["ok が無い", { ...ACCEPTED, ok: undefined }],
    ["開催日が違う", { ...ACCEPTED, kaisai_date: "20260629" }],
    ["mode が違う", { ...ACCEPTED, mode: "morning" }],
    ["results が配列でない", { ...ACCEPTED, results: "x" }],
    ["件数が違う(足りない)", { ...ACCEPTED, results: ACCEPTED.results.slice(0, 1) }],
    ["race_id の順序が違う", { ...ACCEPTED, results: [...ACCEPTED.results].reverse() }],
    ["未知の result", { ...ACCEPTED, results: [{ race_id: "202603020201", result: "weird" }, ACCEPTED.results[1]] }],
    ["already-running の status が未知", { ...ACCEPTED, results: [ACCEPTED.results[0], { race_id: "202603020202", result: "already-running", status: "done" }] }],
  ])("202 でも本文が想定外(%s)なら accepted-malformed(サーバは受理している。呼び出し側は追跡を始める)", async (_name, body) => {
    const f = fake(async () => ({ status: 202, json: async () => { if (body === undefined) throw new Error("not json"); return body; } }));
    expect(await postBulk(f.fetch, REQUEST)).toEqual({ kind: "accepted-malformed" });
  });

  it("409 で error.type が day-cap(limit・used・needed が整数)なら day-cap。数値を返す", async () => {
    const f = fake(async () => resp(409, { ok: false, error: { type: "day-cap", limit: 100, used: 99, needed: 2 } }));
    expect(await postBulk(f.fetch, REQUEST)).toEqual({ kind: "day-cap", limit: 100, used: 99, needed: 2 });
  });

  it.each([
    ["type が違う", { ok: false, error: { type: "already-running", status: "queued" } }],
    ["数値が欠けている", { ok: false, error: { type: "day-cap", limit: 100 } }],
    ["数値が文字列", { ok: false, error: { type: "day-cap", limit: "100", used: 1, needed: 1 } }],
    ["本文なし", undefined],
  ])("409 でも day-cap の形でない(%s)なら unexpected(409)", async (_name, body) => {
    const f = fake(async () => ({ status: 409, json: async () => { if (body === undefined) throw new Error("x"); return body; } }));
    expect(await postBulk(f.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
  });

  it.each([
    [403, { ok: false, error: { type: "origin-mismatch" } }, { kind: "origin-mismatch" }],
    [403, { ok: false, error: { type: "admin-only" } }, { kind: "forbidden" }],
    [400, { ok: false, error: { type: "bad-request" } }, { kind: "bad-request" }],
    [413, {}, { kind: "bad-request" }],
    [415, {}, { kind: "bad-request" }],
    [503, { ok: false, error: { type: "race-day-error" } }, { kind: "server-error" }],
    [500, {}, { kind: "unexpected", httpStatus: 500 }],
  ])("%i は失敗として分類する", async (status, body, failure) => {
    const f = fake(async () => resp(status, body));
    expect(await postBulk(f.fetch, REQUEST)).toEqual({ kind: "failed", failure });
  });

  it("fetch が投げたら(同期・非同期とも)network。例外の文面は持ち込まない", async () => {
    const async_ = fake(async () => {
      throw new Error("secret detail");
    });
    expect(await postBulk(async_.fetch, REQUEST)).toEqual({ kind: "failed", failure: { kind: "network" } });
    const sync: FetchLike = () => {
      throw new Error("secret detail");
    };
    expect(await postBulk(sync, REQUEST)).toEqual({ kind: "failed", failure: { kind: "network" } });
  });
});

describe("bulkFailureMessage", () => {
  it("失敗の文言は単独の起動と同じ固定の文言(サーバの文面を含めない)。一括でも、サーバは全か無かで受けるので、通信の失敗や一時的なエラーは「もう一度押して再試行」でよい", () => {
    const failures = [{ kind: "network" }, { kind: "server-error" }, { kind: "forbidden" }, { kind: "origin-mismatch" }, { kind: "bad-request" }, { kind: "unexpected", httpStatus: 500 }] as const;
    const messages = failures.map((failure) => bulkFailureMessage(failure));
    expect(messages).toEqual(failures.map((failure) => runFailureMessage(failure)));
    expect(new Set(messages).size).toBe(failures.length); // 種類ごとに文言が違う(退化して同じ文言になっていない)
    expect(bulkFailureMessage({ kind: "network" })).toContain("通信に失敗しました");
    expect(bulkFailureMessage({ kind: "bad-request" })).toContain("正しくありません");
  });
});
