import { describe, expect, it } from "vitest";
import { classify, classifyWithoutNetkeiba, classifyWrite, getJson, isArr, isStrArr, postInit, postJson, readBody, type FetchLike } from "../client/api";

/**
 * Issue #397(R-6): client の API 層の共通部品(`api.ts`)の単体テスト。
 * 各 API 関数の振る舞いは `client-api-*.test.ts`(関数ごと)と `client-api-*-contract.test.ts` が守る(共通化の前後を固定していた特性テスト `client-api-characterization.test.ts` は Issue #446〈H-6〉で削除した)。ここは共通部品そのものの契約。
 */

describe("readBody", () => {
  it("json() の値を返す", async () => {
    expect(await readBody({ json: async () => ({ a: 1 }) })).toEqual({ a: 1 });
    expect(await readBody({ json: async () => null })).toBeNull();
  });

  it("json() が reject しても、同期で投げても undefined(例外を持ち込まない)", async () => {
    expect(
      await readBody({
        json: async () => {
          throw new SyntaxError("x");
        },
      }),
    ).toBeUndefined();
    expect(
      await readBody({
        json: () => {
          throw new SyntaxError("x");
        },
      }),
    ).toBeUndefined();
  });
});

describe("postJson", () => {
  function recorder(status: number, body: unknown): { fetch: FetchLike; calls: { url: string; init: unknown }[] } {
    const calls: { url: string; init: unknown }[] = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { status, json: async () => body };
      },
    };
  }

  it("POST で payload を JSON にして送る(同じオリジンの資格情報・referrerPolicy: same-origin・JSON のヘッダ。mode は付けない)。応答は { status, body }", async () => {
    const r = recorder(202, { ok: true });
    const got = await postJson(r.fetch, "/api/x", { a: 1, b: "あ" });
    expect(got).toStrictEqual({ status: 202, body: { ok: true } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe("/api/x");
    expect(r.calls[0]!.init).toStrictEqual({
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ a: 1, b: "あ" }),
    });
  });

  it("呼び出しごとに headers は新しいオブジェクト(呼び出し側が書き換えても次に影響しない)", async () => {
    const r = recorder(200, {});
    await postJson(r.fetch, "/a", {});
    await postJson(r.fetch, "/b", {});
    const [first, second] = r.calls.map((c) => (c.init as { headers: object }).headers);
    expect(first).not.toBe(second);
  });

  it("fetch が同期で投げても、reject しても null(例外の文面を持ち込まない)", async () => {
    expect(
      await postJson(() => {
        throw new Error("x");
      }, "/a", {}),
    ).toBeNull();
    expect(
      await postJson(async () => {
        throw new Error("x");
      }, "/a", {}),
    ).toBeNull();
  });

  it("JSON にできない payload(BigInt)は、fetch を呼ばずに null(stringify も try の内側)", async () => {
    const r = recorder(200, {});
    expect(await postJson(r.fetch, "/a", { n: 1n })).toBeNull();
    expect(r.calls).toHaveLength(0);
  });

  it("json() が失敗した応答は body: undefined(status は保つ)", async () => {
    const got = await postJson(
      async () => ({
        status: 502,
        json: async () => {
          throw new SyntaxError("x");
        },
      }),
      "/a",
      {},
    );
    expect(got).toStrictEqual({ status: 502, body: undefined });
  });
});

describe("postInit(fetchPromptPreview も使う。postJson から切り出した init の組み立て)", () => {
  it("postJson が送る init と同じ形(mode なし)。headers は呼び出しごとに新しい。JSON にできない payload では投げる(呼ぶ側が try の内側で呼ぶ)", () => {
    const init = postInit({ a: 1 });
    expect(init).toStrictEqual({
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: '{"a":1}',
    });
    expect(postInit({}).headers).not.toBe(postInit({}).headers);
    expect(() => postInit({ n: 1n })).toThrow();
  });
});

describe("getJson(既存。postJson と同じ形の応答を返す)", () => {
  it("GET の init と { status, body } / 失敗は null", async () => {
    const calls: unknown[] = [];
    const got = await getJson(async (url, init) => {
      calls.push([url, init]);
      return { status: 200, json: async () => ({ ok: true }) };
    }, "/a");
    expect(got).toStrictEqual({ status: 200, body: { ok: true } });
    expect(calls).toStrictEqual([["/a", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } }]]);
    expect(
      await getJson(async () => {
        throw new Error("x");
      }, "/a"),
    ).toBeNull();
  });
});

describe("失敗の分類の共通部品", () => {
  const BODIES: readonly [string, unknown][] = [
    ["本文なし", undefined],
    ["{}", {}],
    ["origin-mismatch", { error: { type: "origin-mismatch" } }],
    ["netkeiba blocked", { error: { type: "netkeiba-unavailable", reason: "blocked" } }],
    ["netkeiba busy", { error: { type: "netkeiba-unavailable", reason: "busy" } }],
    ["netkeiba 別の reason", { error: { type: "netkeiba-unavailable", reason: "zzz" } }],
    ["別の type", { error: { type: "other" } }],
  ];
  const STATUSES = [200, 202, 400, 401, 403, 404, 409, 413, 415, 429, 500, 502, 503];

  it("classifyWithoutNetkeiba: classify と同じだが、netkeiba-unavailable だけを server-error にする(ほかは classify そのまま)", () => {
    let mapped = 0;
    for (const status of STATUSES) {
      for (const [name, body] of BODIES) {
        const base = classify(status, body);
        const got = classifyWithoutNetkeiba(status, body);
        if (base.kind === "netkeiba-unavailable") {
          mapped += 1;
          expect([status, name, got]).toEqual([status, name, { kind: "server-error" }]);
        } else {
          expect([status, name, got]).toEqual([status, name, base]);
        }
      }
    }
    // 空振り防止: netkeiba の写しが実際に起きた組(503 × 3 本文)が表にある
    expect(mapped).toBe(3);
  });

  it("classifyWrite: 400・413・415 は bad-request(本文によらず)、それ以外は classifyWithoutNetkeiba", () => {
    let writeOnly = 0;
    for (const status of STATUSES) {
      for (const [name, body] of BODIES) {
        const got = classifyWrite(status, body);
        if (status === 400 || status === 413 || status === 415) {
          expect([status, name, got]).toEqual([status, name, { kind: "bad-request" }]);
          if (status !== 400) writeOnly += 1;
        } else {
          expect([status, name, got]).toEqual([status, name, classifyWithoutNetkeiba(status, body)]);
        }
      }
    }
    // 413・415 は classify だと unexpected になる行(classifyWrite だけが bad-request にする行)が、2 状態 × 7 本文ある
    expect(writeOnly).toBe(14);
    expect(classify(413, {})).toEqual({ kind: "unexpected", httpStatus: 413 });
  });
});

describe("配列の型ガード", () => {
  it("isArr は配列だけ", () => {
    expect([[], [1], "a", {}, null, undefined, 1].map(isArr)).toEqual([true, true, false, false, false, false, false]);
  });
  it("isStrArr は全要素が文字列の配列だけ(空配列は true・非配列は false)", () => {
    expect([[], ["a", "b"], ["a", 1], [null], "a", {}, null, undefined].map(isStrArr)).toEqual([true, true, false, false, false, false, false, false]);
  });
});
