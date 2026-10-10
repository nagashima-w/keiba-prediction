import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchReport, fetchReportList, postReportRun, reportFetchFailureMessage, reportRunFailureMessage } from "../client/api-report";

/** Issue #235: 日報の API 呼び出しの分類(応答を信用しない・サーバの文面を出さない)。 */

const reply = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
const throwing: FetchLike = async () => {
  throw new Error("SECRET-NETWORK");
};
const badJson: FetchLike = async () => ({
  status: 200,
  json: async () => {
    throw new SyntaxError("SECRET-JSON");
  },
});

const LIST_ROW = { date: "20261005", created_at: "2026-10-05T11:00:00.000Z", model: null, race_count: 3, total_stake: 100, total_return: 0, summary: null };

describe("fetchReportList", () => {
  it("正常な一覧を読む", async () => {
    expect(await fetchReportList(reply(200, { ok: true, reports: [LIST_ROW] }))).toStrictEqual({
      ok: true,
      reports: [{ date: "20261005", createdAt: "2026-10-05T11:00:00.000Z", model: null, raceCount: 3, totalStake: 100, totalReturn: 0, summary: null }],
    });
    expect(await fetchReportList(reply(200, { ok: true, reports: [] }))).toStrictEqual({ ok: true, reports: [] });
  });

  it.each([
    ["reports が配列でない", { ok: true, reports: {} }],
    ["行の date が 8 桁でない", { ok: true, reports: [{ ...LIST_ROW, date: "2026-10-05" }] }],
    ["行の件数が負", { ok: true, reports: [{ ...LIST_ROW, race_count: -1 }] }],
    ["行の金額が文字列", { ok: true, reports: [{ ...LIST_ROW, total_stake: "100" }] }],
    ["1 行だけ壊れている(一部だけを採用しない)", { ok: true, reports: [LIST_ROW, { ...LIST_ROW, summary: 5 }] }],
    ["ok が true でない", { ok: false, reports: [LIST_ROW] }],
  ])("想定外の形は unexpected: %s", async (_name, body) => {
    expect(await fetchReportList(reply(200, body))).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("通信の失敗・JSON でない応答・403・503 を分類する(例外の文面は持ち込まない)", async () => {
    expect(await fetchReportList(throwing)).toStrictEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchReportList(badJson)).toMatchObject({ ok: false });
    expect(await fetchReportList(reply(403, "forbidden"))).toStrictEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await fetchReportList(reply(503, { ok: false, error: { type: "report-error" } }))).toStrictEqual({ ok: false, error: { kind: "server-error" } });
  });
});

describe("fetchReport", () => {
  it("日報が無い日: report null と job を読む。job が壊れていれば unexpected", async () => {
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null }), "20261005")).toStrictEqual({ ok: true, report: null, job: null });
    expect(await fetchReport(reply(200, { ok: true, report: null, job: { phase: "save", status: "failed", attempts: 3 } }), "20261005")).toStrictEqual({
      ok: true,
      report: null,
      job: { phase: "save", status: "failed", attempts: 3 },
    });
    expect(await fetchReport(reply(200, { ok: true, report: null, job: { phase: "weird", status: "running", attempts: 0 } }), "20261005")).toMatchObject({ ok: false });
    expect(await fetchReport(reply(200, { ok: true, report: null }), "20261005")).toMatchObject({ ok: false }); // job の欠落
  });

  it("本文が壊れていれば(統計・レースの型違い)一部だけ採用せず unexpected", async () => {
    const bad = { date: "20261005", created_at: "x", model: null, race_count: 1, total_stake: 1, total_return: 1, summary: null, body: { stats: {}, races: [], narrative: null, narrativeRaw: null, note: null } };
    expect(await fetchReport(reply(200, { ok: true, report: bad, job: null }), "20261005")).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("404 は not-found、通信の失敗は network", async () => {
    expect(await fetchReport(reply(404, { ok: false, error: { type: "not-found" } }), "20261005")).toStrictEqual({ ok: false, error: { kind: "not-found" } });
    expect(await fetchReport(throwing, "20261005")).toStrictEqual({ ok: false, error: { kind: "network" } });
  });

  it("要求の URL に開催日が入る", async () => {
    const urls: string[] = [];
    const spy: FetchLike = async (url) => {
      urls.push(url);
      return { status: 200, json: async () => ({ ok: true, report: null, job: null }) };
    };
    await fetchReport(spy, "20261005");
    expect(urls).toEqual(["/api/reports/20261005"]);
  });
});

describe("postReportRun", () => {
  it("202 + 本文が整っていれば accepted。整っていなければ accepted-malformed", async () => {
    expect(await postReportRun(reply(202, { ok: true, accepted: true, date: "20261005" }), "20261005")).toStrictEqual({ kind: "accepted" });
    expect(await postReportRun(reply(202, { ok: true, accepted: true, date: "20261004" }), "20261005")).toStrictEqual({ kind: "accepted-malformed" });
    expect(await postReportRun(reply(202, "x"), "20261005")).toStrictEqual({ kind: "accepted-malformed" });
  });

  it("409 は error.type で already-exists / in-progress。未知の型は unexpected", async () => {
    expect(await postReportRun(reply(409, { ok: false, error: { type: "already-exists" } }), "20261005")).toStrictEqual({ kind: "already-exists" });
    expect(await postReportRun(reply(409, { ok: false, error: { type: "in-progress" } }), "20261005")).toStrictEqual({ kind: "in-progress" });
    expect(await postReportRun(reply(409, { ok: false, error: { type: "other" } }), "20261005")).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
  });

  it("400・413・415 は bad-request、503 は server-error、403 の Origin 不一致は origin-mismatch、通信の失敗は network", async () => {
    expect(await postReportRun(reply(415, {}), "20261005")).toMatchObject({ failure: { kind: "bad-request" } });
    expect(await postReportRun(reply(503, { ok: false, error: { type: "report-error" } }), "20261005")).toMatchObject({ failure: { kind: "server-error" } });
    expect(await postReportRun(reply(403, { ok: false, error: { type: "origin-mismatch" } }), "20261005")).toMatchObject({ failure: { kind: "origin-mismatch" } });
    expect(await postReportRun(throwing, "20261005")).toStrictEqual({ kind: "failed", failure: { kind: "network" } });
  });

  it("要求: POST・JSON・同じオリジンの参照元ポリシー(mode は指定しない)で、本文は { date }", async () => {
    let seen: { url: string; init: Parameters<FetchLike>[1] } | null = null;
    const spy: FetchLike = async (url, init) => {
      seen = { url, init };
      return { status: 202, json: async () => ({ ok: true, accepted: true, date: "20261005" }) };
    };
    await postReportRun(spy, "20261005");
    expect(seen!.url).toBe("/api/reports/run");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.referrerPolicy).toBe("same-origin");
    expect(seen!.init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(seen!.init.body as string)).toStrictEqual({ date: "20261005" });
    expect("mode" in seen!.init).toBe(false);
  });
});

describe("固定の文言", () => {
  it("失敗の文言に、サーバ・例外の文面は入らない。どの種別も空でない", () => {
    for (const failure of [{ kind: "forbidden" }, { kind: "origin-mismatch" }, { kind: "bad-request" }, { kind: "server-error" }, { kind: "not-found" }, { kind: "network" }, { kind: "unexpected", httpStatus: 418 }] as const) {
      expect(reportFetchFailureMessage(failure).length).toBeGreaterThan(5);
      expect(reportRunFailureMessage(failure).length).toBeGreaterThan(5);
    }
    expect(reportFetchFailureMessage({ kind: "unexpected", httpStatus: 418 })).toContain("418");
  });
});
