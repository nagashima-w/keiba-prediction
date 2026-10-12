import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchReport, fetchReportList, postReportRun } from "../client/api-report";
import { handle, type Env } from "../src/handler";
import type { ReportRecord } from "../src/daily-report-core";
import { buildSavedRecord, FIXTURE_DATE, fixtureRaceInputs } from "./daily-report-fixtures";
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

/** 日報の DO が返す進行状況(偽)。既定は「収集中」。`null` は「ジョブなし」。 */
type FakeStatus = { phase: "list" | "gather" | "generate" | "save" | "notify"; status: "running" | "failed"; attempts: number; regenerate?: true } | null;

async function connect(record: ReportRecord, options: { readonly statusFails?: boolean; readonly status?: FakeStatus } = {}): Promise<Connected> {
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
          return options.status === undefined ? { phase: "gather" as const, status: "running" as const, attempts: 0 } : options.status;
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
    const { fetch } = await connect(record, { status: null }); // 管理者の要求は日報があっても進行状況を取る(Issue #268)。ここは「ジョブなし」の場合
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    expect(detail.ok).toBe(true);
    if (!detail.ok || detail.report === null) throw new Error("日報が読めませんでした");
    const r = detail.report;
    expect(r.stats).toStrictEqual(record.body.stats);
    // Issue #264: 見込みの的中数・最大払戻の 1 点・直近 28 日の累計も、サーバが書いたキー名のまま読める(前提: 実際に値がある)
    expect(record.body.stats.expectedBetCount).toBeGreaterThan(0);
    expect(record.body.stats.expectedHits).toBeGreaterThan(0);
    expect(record.body.stats.maxPayout).toBeGreaterThan(0);
    expect(Object.values(record.body.stats.byBetType).every((t) => t.expectedBetCount > 0)).toBe(true);
    expect(record.body.rolling).toBeDefined();
    expect(record.body.rolling!.total.dayCount).toBe(record.body.rolling!.prior.dayCount + 1);
    expect(r.rolling).toStrictEqual(record.body.rolling);
    // Issue #272: 印の定型の成績(その日・累計)と惜しかったレースも、サーバが書いたキー名のまま読める(前提: 実際に数えられている)
    expect(record.body.stats.whatIf!["win"]!.betCount).toBeGreaterThan(0);
    expect(record.body.stats.whatIf!["win"]!.hitCount).toBeGreaterThan(0);
    expect(record.body.rolling!.total.whatIf!["win"]!.betCount).toBeGreaterThan(record.body.stats.whatIf!["win"]!.betCount);
    expect(r.stats.whatIf).toStrictEqual(record.body.stats.whatIf);
    expect(r.rolling!.total.whatIf).toStrictEqual(record.body.rolling!.total.whatIf);
    expect(r.nearMisses).toStrictEqual(record.body.nearMisses);
    expect(r.races.map((x) => x.raceId)).toEqual(record.body.races.map((x) => x.raceId));
    expect(r.races[0]).toMatchObject({ title: record.body.races[0]!.title, hasResult: true, comment: "◎→▲の組み合わせが有効だった" });
    expect(r.races[0]!.top3.map((t) => t.finishPosition)).toEqual([1, 2, 3]);
    expect(r.races[2]).toMatchObject({ hasResult: false, top3: [] });
    expect(r.narrative).toStrictEqual({ summary: record.body.narrative!.summary, good: [...record.body.narrative!.good], improve: [...record.body.narrative!.improve] });
    expect(r.note).toBeNull();
    expect(detail.job).toBeNull();
    expect(detail.jobStatus).toBe("ok");
  });

  it("Issue #278: 返還(取消・除外の馬への買い目)のある日報の項目が、サーバが書いたキー名のまま読める", async () => {
    // 1R の◎1(単勝 300 円・ワイド 1-3 200 円の買い目)が取消・除外。単勝とワイド 1-3 は返還になる。
    const inputs = fixtureRaceInputs();
    const first = inputs[0]!;
    inputs[0] = {
      view: first.view,
      result: {
        horses: [
          { umaban: 1, finishPosition: null, winPayout: null, placePayout: null, scratched: true },
          { umaban: 2, finishPosition: 1, winPayout: 420, placePayout: 140, scratched: false },
          { umaban: 3, finishPosition: 2, winPayout: null, placePayout: 210, scratched: false },
          { umaban: 4, finishPosition: 3, winPayout: null, placePayout: 230, scratched: false },
        ],
        combos: { wide: { imported: true, payouts: [{ comboKey: "0203", payout: 900 }] }, quinella: { imported: false, payouts: [] } },
      },
    };
    const record = await buildSavedRecord({ inputs });
    // 前提(空振り防止): サーバが返還を実際に数えている
    expect(record.body.stats.refundedBetCount).toBeGreaterThanOrEqual(3);
    expect(record.body.stats.refundedStake).toBeGreaterThan(0);
    expect(record.body.stats.byBetType["win"]!.refundCount).toBeGreaterThan(0);
    expect(record.body.stats.whatIf!["win"]!.refundCount).toBeGreaterThan(0);
    expect(record.body.races[0]!.refundedBetCount).toBe(record.body.stats.refundedBetCount);
    const { fetch } = await connect(record, { status: null });
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    if (!detail.ok || detail.report === null) throw new Error("日報が読めませんでした");
    expect(detail.report.stats).toStrictEqual(record.body.stats);
    expect(detail.report.rolling).toStrictEqual(record.body.rolling);
    expect(detail.report.races[0]!.refundedBetCount).toBe(record.body.races[0]!.refundedBetCount);
    expect(detail.report.stats.refundedBetCount).toBe(record.body.stats.refundedBetCount);
  });

  it("Issue #272: 惜しかったレース(組合せ券種の型が的中したのに買っていない)が 1 件ある日報の nearMisses が、サーバが書いた値のまま読める", async () => {
    // 1R の◎1〇2▲3 が 1・2・3 着。ワイド 1-2(640 円)が出たが、実際に買ったのはワイド 1-3 と馬連 1-3 だけ。
    const inputs = fixtureRaceInputs();
    const first = inputs[0]!;
    inputs[0] = {
      view: first.view,
      result: {
        horses: [
          { umaban: 1, finishPosition: 1, winPayout: 420, placePayout: 140 },
          { umaban: 2, finishPosition: 2, winPayout: null, placePayout: 210 },
          { umaban: 3, finishPosition: 3, winPayout: null, placePayout: 230 },
          { umaban: 4, finishPosition: 4, winPayout: null, placePayout: null },
        ],
        combos: { wide: { imported: true, payouts: [{ comboKey: "0102", payout: 640 }, { comboKey: "0103", payout: 780 }, { comboKey: "0203", payout: 900 }] }, quinella: { imported: false, payouts: [] } },
      },
    };
    const record = await buildSavedRecord({ inputs });
    expect(record.body.nearMisses).toEqual({ total: 1, shown: [{ raceId: first.view.raceId, templateId: "wide", payout: 640 }] });
    const detail = await fetchReport((await connect(record)).fetch, FIXTURE_DATE);
    if (!detail.ok || detail.report === null) throw new Error("日報が読めませんでした");
    expect(detail.report.nearMisses).toStrictEqual(record.body.nearMisses);
    expect(detail.report.nearMisses!.shown[0]).toStrictEqual({ raceId: first.view.raceId, templateId: "wide", payout: 640 });
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

describe("契約(Issue #268): 日報がある日の作り直しの進行状況と、作り直しの依頼", () => {
  it("管理者の GET は日報があっても作り直しのジョブ(regenerate: true)を返し、クライアントが読める", async () => {
    const record = await buildSavedRecord();
    const { fetch } = await connect(record, { status: { phase: "generate", status: "running", attempts: 1, regenerate: true } });
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    expect(detail).toMatchObject({ ok: true, jobStatus: "ok", job: { phase: "generate", status: "running", attempts: 1, regenerate: true } });
    expect((detail as { report: unknown }).report).not.toBeNull();
  });

  it("日報がある日の進行状況の取得が失敗しても、日報は読める(jobStatus は unavailable)", async () => {
    const record = await buildSavedRecord();
    const { fetch } = await connect(record, { statusFails: true });
    const detail = await fetchReport(fetch, FIXTURE_DATE);
    expect(detail).toMatchObject({ ok: true, job: null, jobStatus: "unavailable" });
    expect((detail as { report: unknown }).report).not.toBeNull();
  });

  it("postReportRun(…, true) は、本物の handle() を通って mode: regenerate の依頼になり、accepted で返る", async () => {
    const record = await buildSavedRecord();
    const { fetch, requests } = await connect(record);
    expect(await postReportRun(fetch, "20261005", true)).toStrictEqual({ kind: "accepted" });
    expect(requests).toEqual([{ kaisaiDate: "20261005", mode: "regenerate" }]);
  });
});
