import { describe, expect, it } from "vitest";
import { getOkBody, isNum, isStr, type FetchLike } from "../client/api";
import { fetchItemList, isYmd, parseHeadOf } from "../client/api-report";

/**
 * Issue #397(R-6 後半): 日報と月報の取得・先頭 7 項目の共通部品の単体テスト。
 * 日報・月報の各 API 関数としての振る舞いは `client-api-characterization.test.ts`(先頭 7 項目の表ほか)と既存の `client-api-report*.test.ts`・`client-api-monthly*.test.ts` が守る。
 */

const reply = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
const throwing: FetchLike = async () => {
  throw new Error("SECRET");
};
const badJson = (status: number): FetchLike => async () => ({
  status,
  json: async () => {
    throw new SyntaxError("x");
  },
});

describe("getOkBody(GET して、200 かつ { ok: true } の本文だけを通す)", () => {
  it("通ったときは { ok: true, body } を返し、GET の init で呼ぶ", async () => {
    const calls: unknown[] = [];
    const got = await getOkBody(
      async (url, init) => {
        calls.push([url, init]);
        return { status: 200, json: async () => ({ ok: true, x: 1 }) };
      },
      "/api/x",
      false,
    );
    expect(got).toStrictEqual({ ok: true, body: { ok: true, x: 1 } });
    expect(calls).toStrictEqual([["/api/x", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } }]]);
  });

  it("通信の失敗は network(例外の文面を持ち込まない)", async () => {
    expect(await getOkBody(throwing, "/a", false)).toStrictEqual({ ok: false, error: { kind: "network" } });
    expect(
      await getOkBody(() => {
        throw new Error("SECRET");
      }, "/a", true),
    ).toStrictEqual({ ok: false, error: { kind: "network" } });
  });

  it("200 以外・ok が true でない・本文がオブジェクトでない・JSON でないは、classify の失敗(status を保つ)", async () => {
    expect(await getOkBody(reply(403, {}), "/a", false)).toStrictEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await getOkBody(reply(503, { error: { type: "netkeiba-unavailable", reason: "busy" } }), "/a", false)).toStrictEqual({ ok: false, error: { kind: "netkeiba-unavailable", reason: "busy" } });
    expect(await getOkBody(reply(500, { ok: true }), "/a", false)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 500 } });
    for (const body of [{ ok: false }, {}, null, [], "x", { ok: "true" }]) {
      expect(await getOkBody(reply(200, body), "/a", false)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    }
    expect(await getOkBody(badJson(200), "/a", false)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("404 は、notFound が true のときだけ not-found(false のときは unexpected:404)", async () => {
    expect(await getOkBody(reply(404, { ok: true }), "/a", true)).toStrictEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getOkBody(reply(404, { ok: true }), "/a", false)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 404 } });
    expect(await getOkBody(badJson(404), "/a", true)).toStrictEqual({ ok: false, error: { kind: "not-found" } });
  });
});

describe("fetchItemList(一覧: getOkBody のあと、reports を 1 行ずつ parse)", () => {
  const parse = (row: unknown): { n: number } | null => (typeof row === "object" && row !== null && isNum((row as { n?: unknown }).n) ? { n: (row as { n: number }).n } : null);

  it("全行が読めれば { ok: true, reports }(順序を保つ)。空配列も成功", async () => {
    expect(await fetchItemList(reply(200, { ok: true, reports: [{ n: 2 }, { n: 1 }] }), "/a", parse)).toStrictEqual({ ok: true, reports: [{ n: 2 }, { n: 1 }] });
    expect(await fetchItemList(reply(200, { ok: true, reports: [] }), "/a", parse)).toStrictEqual({ ok: true, reports: [] });
  });

  it("reports が配列でない・無い、1 行でも parse できないは unexpected:200(一部の行だけを採用しない)", async () => {
    const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };
    expect(await fetchItemList(reply(200, { ok: true, reports: {} }), "/a", parse)).toStrictEqual(unexpected);
    expect(await fetchItemList(reply(200, { ok: true }), "/a", parse)).toStrictEqual(unexpected);
    expect(await fetchItemList(reply(200, { ok: true, reports: [{ n: 1 }, { n: "x" }] }), "/a", parse)).toStrictEqual(unexpected);
  });

  it("getOkBody の失敗はそのまま(network・classify。404 は not-found にせず unexpected:404)", async () => {
    expect(await fetchItemList(throwing, "/a", parse)).toStrictEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchItemList(reply(404, {}), "/a", parse)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 404 } });
    expect(await fetchItemList(reply(403, {}), "/a", parse)).toStrictEqual({ ok: false, error: { kind: "forbidden" } });
  });
});

describe("parseHeadOf(日報・月報の先頭 7 項目。ID のキーと検査だけが違う)", () => {
  const isAbc = (v: unknown): v is string => isStr(v) && /^abc$/.test(v);
  const ROW = { key: "abc", created_at: "t", model: null, race_count: 3, total_stake: 100, total_return: 0, summary: "s", other: 1 };

  it("読めれば ID を id に、残りを camelCase に写す(キーの順: id・createdAt・model・raceCount・totalStake・totalReturn・summary。余計なキーは持ち込まない)", () => {
    const head = parseHeadOf(ROW, "key", isAbc);
    expect(head).toStrictEqual({ id: "abc", createdAt: "t", model: null, raceCount: 3, totalStake: 100, totalReturn: 0, summary: "s" });
    expect(Object.keys(head!)).toEqual(["id", "createdAt", "model", "raceCount", "totalStake", "totalReturn", "summary"]);
  });

  it("ID は指定したキーを、指定した検査で見る(別のキーの値や検査に通らない値は null)", () => {
    expect(parseHeadOf({ ...ROW, key: "abd" }, "key", isAbc)).toBeNull();
    expect(parseHeadOf({ ...ROW, key: undefined, date: "abc" }, "key", isAbc)).toBeNull();
    expect(parseHeadOf({ ...ROW, key: undefined, date: "abc" }, "date", isAbc)).not.toBeNull();
  });

  it("6 項目それぞれの型違い・欠落は null(model・summary は null でよい。件数は 0 以上の整数、金額は有限の数)", () => {
    const bad: Record<string, unknown[]> = {
      created_at: [undefined, null, 5],
      model: [undefined, 5],
      race_count: [undefined, null, "3", 1.5, -1, Infinity],
      total_stake: [undefined, null, "1", Infinity],
      total_return: [undefined, null, "1", Infinity],
      summary: [undefined, 5],
    };
    let checked = 0;
    for (const [field, values] of Object.entries(bad)) {
      for (const v of values) {
        checked += 1;
        expect([field, String(v), parseHeadOf({ ...ROW, [field]: v }, "key", isAbc)]).toEqual([field, String(v), null]);
      }
    }
    expect(checked).toBe(3 + 2 + 6 + 4 + 4 + 2);
    expect(parseHeadOf({ ...ROW, model: null, summary: null }, "key", isAbc)).not.toBeNull();
  });

  it("日報の ID の検査 isYmd は 8 桁の数字だけ(日報の一覧・詳細が使う)", () => {
    expect(["20261005", "2026100", "202610051", "2026-10-05", "２０２６１００５", 20261005, null].map(isYmd)).toEqual([true, false, false, false, false, false, false]);
  });
});
