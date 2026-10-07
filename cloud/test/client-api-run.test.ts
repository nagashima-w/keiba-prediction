import { describe, expect, it } from "vitest";
import { classify, failureMessage, type FetchLike } from "../client/api";
import { postRun, runFailureMessage, type RunFailure } from "../client/api-run";

/**
 * Issue #186 段階2: 起動 `POST /api/analyses/run` の呼び出しと応答の分類。純関数・偽の fetch。
 *
 * **Origin**: ページは全応答に `Referrer-Policy: no-referrer` を付けている。現行の Fetch 仕様(append a request `Origin` header)では、
 * fetch() の既定(mode が cors)の POST は、参照元ポリシーによらず実際のオリジンを送る(`Origin: null` になるのは mode が cors 以外のとき)。
 * したがって `referrerPolicy: "same-origin"` は**仕様上は不要の見込みで、ブラウザ差への保険**。init に fetch の `mode` を入れない(入れるなら cors)ことと併せて固定する。
 * 実ブラウザでの確認は本番での実機確認項目(Node の undici は古い仕様の実装で、ここでは確かめられない)。
 */

const BASE = { raceId: "202603020211", date: "20260628", mode: "pre_race" } as const;
type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const ACCEPTED = { ok: true, accepted: true, race_id: BASE.raceId, kaisai_date: BASE.date, mode: "pre_race", status: "queued" };

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

describe("postRun(リクエストの形)", () => {
  it("POST /api/analyses/run に、JSON の本文 {race_id, kaisai_date, mode} の 3 キーだけを送る(キー・値の取り違えを防ぐ)", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    await postRun(f.fetch, BASE);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/analyses/run");
    expect(f.calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(f.calls[0]!.init.body!);
    expect(body).toEqual({ race_id: "202603020211", kaisai_date: "20260628", mode: "pre_race" });
    expect(Object.keys(body).sort()).toEqual(["kaisai_date", "mode", "race_id"]);
    const morning = fake(async () => resp(202, { ...ACCEPTED, mode: "morning" }));
    await postRun(morning.fetch, { ...BASE, mode: "morning" });
    expect(JSON.parse(morning.calls[0]!.init.body!).mode).toBe("morning"); // mode は常に明示して送る
  });

  it("ヘッダ(content-type が application/json)・同じオリジンの資格情報・referrerPolicy: same-origin。fetch の mode は指定しない(または cors)", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    await postRun(f.fetch, BASE);
    const init = f.calls[0]!.init;
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(init.referrerPolicy).toBe("same-origin");
    // 参照元ポリシー no-referrer のとき、mode が cors 以外だと Origin が null になる(サーバの完全一致で 403)。入れるなら cors だけ。
    expect([undefined, "cors"]).toContain((init as { mode?: string }).mode);
  });
});

describe("postRun(応答の分類)", () => {
  it("202 で本文が整っている(ok・accepted・race_id・kaisai_date・mode の一致・status が queued)なら accepted", async () => {
    const f = fake(async () => resp(202, ACCEPTED));
    expect(await postRun(f.fetch, BASE)).toEqual({ kind: "accepted" });
  });

  const malformed202: readonly [string, unknown][] = [
    ["本文なし", undefined],
    ["accepted が false", { ...ACCEPTED, accepted: false }],
    ["race_id が違う", { ...ACCEPTED, race_id: "202603020212" }],
    ["kaisai_date が違う", { ...ACCEPTED, kaisai_date: "20260629" }],
    ["mode が違う", { ...ACCEPTED, mode: "morning" }],
    ["status が queued でない", { ...ACCEPTED, status: "fetched" }],
    ["ok が無い", { accepted: true, race_id: BASE.raceId, kaisai_date: BASE.date, mode: "pre_race", status: "queued" }],
  ];
  for (const [name, body] of malformed202) {
    it(`202 でも本文が想定外(${name})なら accepted-malformed(成功扱いにしない。呼び出し側は失敗の文言を出し、追跡は始める)`, async () => {
      const f = fake(async () => resp(202, body));
      expect(await postRun(f.fetch, BASE)).toEqual({ kind: "accepted-malformed" });
    });
  }

  it("409 は、本文が already-running で status が queued・fetched のときだけ already-running(status を保つ)", async () => {
    for (const status of ["queued", "fetched"] as const) {
      const f = fake(async () => resp(409, { ok: false, error: { type: "already-running", status } }));
      expect(await postRun(f.fetch, BASE)).toEqual({ kind: "already-running", status });
    }
  });

  const bad409: readonly [string, unknown][] = [
    ["status が done", { ok: false, error: { type: "already-running", status: "done" } }],
    ["status が failed", { ok: false, error: { type: "already-running", status: "failed" } }],
    ["status が無い", { ok: false, error: { type: "already-running" } }],
    ["type が違う", { ok: false, error: { type: "other", status: "queued" } }],
    ["本文なし", undefined],
    ["error が無い", { ok: false }],
  ];
  for (const [name, body] of bad409) {
    it(`409 でも本文が想定外(${name})なら、採用せず失敗(unexpected 409)`, async () => {
      const f = fake(async () => resp(409, body));
      expect(await postRun(f.fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
    });
  }

  it("403 は、本文の error.type が origin-mismatch なら origin-mismatch、それ以外(Access の拒否の平文・本文なし)は forbidden", async () => {
    const origin = fake(async () => resp(403, { ok: false, error: { type: "origin-mismatch" } }));
    expect(await postRun(origin.fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "origin-mismatch" } });
    const plain = fake(async () => ({ status: 403, json: async () => Promise.reject(new Error("not json")) }));
    expect(await postRun(plain.fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "forbidden" } });
    const other = fake(async () => resp(403, { ok: false, error: { type: "something-else" } }));
    expect(await postRun(other.fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "forbidden" } });
  });

  it("400・413・415 は bad-request、503 は server-error(netkeiba-unavailable の形でも)、その他の状態は unexpected(HTTP 状態を保つ)、通信失敗(例外)は network", async () => {
    for (const status of [400, 413, 415]) {
      expect(await postRun(fake(async () => resp(status, { ok: false, error: { type: "x", message: "サーバの文面" } })).fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "bad-request" } });
    }
    expect(await postRun(fake(async () => resp(503, { ok: false, error: { type: "race-day-error" } })).fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "server-error" } });
    expect(await postRun(fake(async () => resp(503, { ok: false, error: { type: "netkeiba-unavailable", reason: "busy" } })).fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "server-error" } });
    expect(await postRun(fake(async () => resp(500, undefined)).fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 500 } });
    expect(await postRun(fake(async () => resp(200, { ok: true })).fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 200 } });
    const thrown = fake(async () => {
      throw new Error("Failed to fetch: サーバ由来でない例外の文面");
    });
    expect(await postRun(thrown.fetch, BASE)).toEqual({ kind: "failed", failure: { kind: "network" } });
  });

  it("fetch が同期的に投げても(関数が例外を投げる実装でも)network として返す(二重押しの印が戻らなくなる例外を漏らさない)", async () => {
    const sync: FetchLike = () => {
      throw new Error("sync");
    };
    expect(await postRun(sync, BASE)).toEqual({ kind: "failed", failure: { kind: "network" } });
  });
});

describe("classify・failureMessage の origin-mismatch", () => {
  it("classify: 403 の本文が origin-mismatch なら origin-mismatch、そうでなければ forbidden(GET の応答にも同じ)", () => {
    expect(classify(403, { ok: false, error: { type: "origin-mismatch" } })).toEqual({ kind: "origin-mismatch" });
    expect(classify(403, undefined)).toEqual({ kind: "forbidden" });
    expect(classify(403, { ok: false, error: { type: "x" } })).toEqual({ kind: "forbidden" });
    expect(classify(400, { ok: false, error: { type: "origin-mismatch" } })).toEqual({ kind: "bad-request" }); // 403 以外では見ない
  });
  it("文言は forbidden(ログインの期限切れ)と異なり、Origin の不一致であることを示す", () => {
    const origin = failureMessage({ kind: "origin-mismatch" });
    expect(origin).toContain("Origin");
    expect(origin).not.toBe(failureMessage({ kind: "forbidden" }));
    expect(runFailureMessage({ kind: "origin-mismatch" })).toContain("Origin");
    expect(runFailureMessage({ kind: "forbidden" })).not.toContain("Origin");
  });
});

describe("runFailureMessage(起動の失敗の固定の文言。サーバの文面は出さない。再試行できることを示す)", () => {
  const failures: RunFailure[] = [
    { kind: "forbidden" },
    { kind: "origin-mismatch" },
    { kind: "bad-request" },
    { kind: "server-error" },
    { kind: "unexpected", httpStatus: 409 },
    { kind: "network" },
  ];
  it("種類ごとに、空でない・互いに異なる文言(unexpected は HTTP 状態を含む)", () => {
    const messages = failures.map(runFailureMessage);
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(failures.length);
    expect(runFailureMessage({ kind: "unexpected", httpStatus: 418 })).toContain("418");
  });
  it("一時的な失敗(通信・サーバ・想定外)は、もう一度押して再試行できることを示す。ログインの期限切れの可能性(forbidden・network)は再読み込みを促す", () => {
    for (const f of [{ kind: "network" }, { kind: "server-error" }, { kind: "unexpected", httpStatus: 500 }] as RunFailure[]) {
      expect(runFailureMessage(f)).toContain("もう一度");
    }
    expect(runFailureMessage({ kind: "forbidden" })).toContain("再読み込み");
    expect(runFailureMessage({ kind: "network" })).toContain("再読み込み");
  });
});
