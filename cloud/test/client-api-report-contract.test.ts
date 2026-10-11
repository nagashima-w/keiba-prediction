import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchReport, fetchReportList, postReportRun } from "../client/api-report";
import { handle, type Env } from "../src/handler";
import type { ReportRecord } from "../src/daily-report-core";
import { buildSavedRecord, FIXTURE_DATE } from "./daily-report-fixtures";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #235: 契約テスト。クライアントの `fetchReportList`・`fetchReport`・`postReportRun` が送るリクエストを実際の `handle()`(偽の D1・偽の日報の DO)に通し、
 * **本物の `DailyReportCore` が作った日報**(保存される `ReportRecord`)をクライアントのパーサに通す。サーバ(日報の組み立て・API)のキー名・形が変わると、ここで検出する。
 */
const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Connected {
  readonly fetch: FetchLike;
  readonly requests: Array<{ kaisaiDate: string; mode: string }>;
}

async function connect(record: ReportRecord, options: { readonly statusFails?: boolean } = {}): Promise<Connected> {
  const key = await makeKey("k1");
  const token = await signToken(key);
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const requests: Array<{ kaisaiDate: string; mode: string }> = [];
  const row = {
    kaisaiDate: record.kaisaiDate, createdAt: record.createdAt, model: record.model, raceCount: record.raceCount, totalStake: record.totalStake, totalReturn: record.totalReturn,
    summary: record.summary, bodyJson: JSON.stringify(record.body), llmCallsJson: record.llmCallsJson,
  };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: {
      prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => (args[0] === row.kaisaiDate ? row : null), all: async () => ({ results: [row] }) }) }),
      batch: NOT_CALLED,
    } as unknown as Env["DB"],
    ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
    DAILY_REPORT: {
      idFromName: (n: string) => n,
      get: () => ({
        requestReport: async (input: { kaisaiDate: string; mode: string }) => {
          requests.push(input);
          return { accepted: true as const };
        },
        getStatus: async () => {
          if (options.statusFails === true) throw new Error("日報の DO の RPC の失敗");
          return { phase: "gather" as const, status: "running" as const, attempts: 0 };
        },
      }),
    },
  };
  const fetchLike: FetchLike = async (url, init) => {
    const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": token, ...(init.headers ?? {}) };
    if (init.method === "POST") headers["origin"] = ORIGIN;
    const res = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers, body: init.body as string | undefined }), env, {}, deps);
    return { status: res.status, json: () => res.json() };
  };
  return { fetch: fetchLike, requests };
}

describe("契約: 本物の日報(DailyReportCore の出力)を、クライアントのパーサが読める", () => {
  it("一覧: 開催日・件数・賭け金・払戻・総括が読める", async () => {
    const record = await buildSavedRecord();
    const { fetch } = await connect(record);
    const list = await fetchReportList(fetch);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({ date: FIXTURE_DATE, raceCount: 3, totalStake: record.totalStake, totalReturn: record.totalReturn, model: "claude-sonnet-5-5" });
    expect(list.reports[0]!.summary).toContain("3 レース");
  });

  it("本文: 統計・レースごとの行・文章が、サーバが書いた値のまま読める", async () => {
    const record = await buildSavedRecord();
    expect(record.totalStake).toBeGreaterThan(0); // 前提(空振り防止): 賭け金のある日報で検査している
    expect(record.body.stats.byMark.length).toBeGreaterThan(0);
    const { fetch } = await connect(record);
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    expect(detail.ok).toBe(true);
    if (!detail.ok || detail.report === null) throw new Error("日報が読めませんでした");
    const r = detail.report;
    expect(r.stats).toStrictEqual(record.body.stats);
    expect(r.races.map((x) => x.raceId)).toEqual(record.body.races.map((x) => x.raceId));
    expect(r.races[0]).toMatchObject({ title: record.body.races[0]!.title, hasResult: true, comment: "◎→▲の組み合わせが有効だった" });
    expect(r.races[0]!.top3.map((t) => t.finishPosition)).toEqual([1, 2, 3]);
    expect(r.races[2]).toMatchObject({ hasResult: false, top3: [] });
    expect(r.narrative).toStrictEqual({ summary: record.body.narrative!.summary, good: [...record.body.narrative!.good], improve: [...record.body.narrative!.improve] });
    expect(r.note).toBeNull();
    expect(detail.job).toBeNull();
    expect(detail.jobStatus).toBe("ok");
  });

  it("文章が無い日報(LLM なし)・生の文章の日報も読める", async () => {
    const noText = await buildSavedRecord({ llmText: "これは JSON ではない文章です。" });
    const { fetch } = await connect(noText);
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    if (!detail.ok || detail.report === null) throw new Error("日報が読めませんでした");
    expect(detail.report.narrative).toBeNull();
    expect(detail.report.narrativeRaw).toContain("JSON ではない");
    expect(detail.report.note).not.toBeNull();
  });

  it("日報が無い日は report: null と進行状況(job)が読める", async () => {
    const { fetch } = await connect(await buildSavedRecord());
    const detail = await fetchReport(fetch, "20200101");
    expect(detail).toStrictEqual({ ok: true, report: null, job: { phase: "gather", status: "running", attempts: 0 }, jobStatus: "ok" });
  });

  it("Issue #245: 日報が無い日に日報の DO の取得が失敗すると、jobStatus: unavailable で読める(ジョブが無い〈ok〉とは別の値)", async () => {
    const { fetch } = await connect(await buildSavedRecord(), { statusFails: true });
    const detail = await fetchReport(fetch, "20200101");
    expect(detail).toStrictEqual({ ok: true, report: null, job: null, jobStatus: "unavailable" });
    // 対照: 取得できる構成では ok(上のテストが job つきで固定している)
    const healthy = await fetchReport((await connect(await buildSavedRecord())).fetch, "20200101");
    expect(healthy).toMatchObject({ ok: true, jobStatus: "ok" });
  });

  it("手動の作成: 202 を accepted と分類し、日報の DO へ manual で依頼が届く", async () => {
    const { fetch, requests } = await connect(await buildSavedRecord());
    expect(await postReportRun(fetch, "20261006")).toStrictEqual({ kind: "accepted" });
    expect(requests).toEqual([{ kaisaiDate: "20261006", mode: "manual" }]);
    expect(await postReportRun(fetch, "20261230")).toMatchObject({ kind: "failed", failure: { kind: "bad-request" } }); // 未来の日
  });
});
