import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchMonthly, fetchMonthlyList, monthlyFetchFailureMessage, postMonthlyRun } from "../client/api-monthly";

/** Issue #279(#265-A): 月報の API 呼び出しの分類(応答を信用しない・サーバの文面を出さない・一部だけを採用しない)。 */

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

const LIST_ROW = { month: "202610", created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null };

describe("fetchMonthlyList", () => {
  it("正常な一覧を読む。GET /api/monthly-reports を同一オリジンの資格情報つきで送る", async () => {
    const calls: Array<{ url: string; init: { method: string; credentials?: string } }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true, reports: [LIST_ROW] }) };
    };
    expect(await fetchMonthlyList(fetchLike)).toStrictEqual({
      ok: true,
      reports: [{ month: "202610", createdAt: "2026-10-31T13:00:00.000Z", model: null, raceCount: 3, totalStake: 300, totalReturn: 800, summary: null }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/monthly-reports");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(await fetchMonthlyList(reply(200, { ok: true, reports: [] }))).toStrictEqual({ ok: true, reports: [] });
  });

  it.each([
    ["reports が配列でない", { ok: true, reports: {} }],
    ["行の month が 6 桁でない", { ok: true, reports: [{ ...LIST_ROW, month: "2026-10" }] }],
    ["行が null(Issue #446〈H-6〉: 投げずに unexpected)", { ok: true, reports: [null] }],
    ["行の month が実在しない月", { ok: true, reports: [{ ...LIST_ROW, month: "202613" }] }],
    ["行の month が数(文字列でない)", { ok: true, reports: [{ ...LIST_ROW, month: 202610 }] }],
    ["行の件数が負", { ok: true, reports: [{ ...LIST_ROW, race_count: -1 }] }],
    ["行の金額が文字列", { ok: true, reports: [{ ...LIST_ROW, total_stake: "100" }] }],
    ["1 行だけ壊れている(一部だけを採用しない)", { ok: true, reports: [LIST_ROW, { ...LIST_ROW, summary: 5 }] }],
    ["ok が true でない", { ok: false, reports: [LIST_ROW] }],
  ])("想定外の形は unexpected: %s", async (_name, body) => {
    expect(await fetchMonthlyList(reply(200, body))).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("通信の失敗・JSON でない応答・403・503 を分類する(例外の文面は持ち込まない)", async () => {
    expect(await fetchMonthlyList(throwing)).toStrictEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchMonthlyList(badJson)).toMatchObject({ ok: false });
    expect(await fetchMonthlyList(reply(403, "forbidden"))).toStrictEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await fetchMonthlyList(reply(503, { ok: false, error: { type: "report-error" } }))).toStrictEqual({ ok: false, error: { kind: "server-error" } });
  });
});

/** 期間の統計(サーバの `PeriodStats`)の最小の本物の形。 */
function stats(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
    refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 2, expectedHits: 0.8, expectedBaseHits: 1, maxPayout: 800, maxPayoutStake: 200,
    byBetType: { win: { betCount: 2, hitCount: 1, stake: 300, payout: 800, refundCount: 0, expectedBetCount: 2, expectedHits: 0.8, expectedBaseHits: 1 } },
    byMark: [{ mark: "◎", count: 3, win: 1, top3: 2 }],
    whatIf: null,
    fromDate: "20261001", toDate: "20261031", dayCount: 2,
    days: [
      { date: "20261003", raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1, refundedBetCount: 0 },
      { date: "20261031", raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0, refundedBetCount: 0 },
    ],
    byVersion: [
      { promptVersion: "v1", raceCount: 2, resultRaceCount: 2, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1 },
      { promptVersion: null, raceCount: 1, resultRaceCount: 1, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0 },
    ],
    ...over,
  };
}

const DETAIL = { month: "202610", created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null, body: { format: 1, month: "202610", stats: stats(), lastDayPending: false } };

describe("fetchMonthly", () => {
  it("月報を読む: 月・作成時刻・件数・統計(日ごとの行・版ごとの行つき)・最終日の未確定の印。GET /api/monthly-reports/{月}", async () => {
    const calls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      calls.push(url);
      return { status: 200, json: async () => ({ ok: true, report: DETAIL }) };
    };
    const got = await fetchMonthly(fetchLike, "202610");
    expect(calls).toEqual(["/api/monthly-reports/202610"]);
    expect(got.ok).toBe(true);
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.month).toBe("202610");
    expect(got.report.createdAt).toBe("2026-10-31T13:00:00.000Z");
    expect(got.report.raceCount).toBe(3);
    expect(got.report.lastDayPending).toBe(false);
    expect(got.report.stats.totalStake).toBe(300);
    expect(got.report.stats.fromDate).toBe("20261001");
    expect(got.report.stats.dayCount).toBe(2);
    expect(got.report.stats.days).toHaveLength(2);
    expect(got.report.stats.days[0]).toStrictEqual({ date: "20261003", raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1, refundedBetCount: 0 });
    expect(got.report.stats.byVersion.map((v) => v.promptVersion)).toEqual(["v1", null]);
  });

  it("月報が無い月は report: null", async () => {
    expect(await fetchMonthly(reply(200, { ok: true, report: null }), "202607")).toStrictEqual({ ok: true, report: null, job: null, jobStatus: "ok" });
  });

  it("最終日の未確定の印(lastDayPending)が true の月報を読める", async () => {
    const got = await fetchMonthly(reply(200, { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, lastDayPending: true } } }), "202610");
    expect(got.ok && got.report?.lastDayPending).toBe(true);
  });

  it("文章の項目が無い本文(段階 A の形)も、余計なキーがあっても読める(文章は null・理由と版も null)", async () => {
    const got = await fetchMonthly(reply(200, { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, extra: 1 } } }), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toBeNull();
    expect(got.report.narrativeRaw).toBeNull();
    expect(got.report.note).toBeNull();
    expect(got.report.promptVersion).toBeNull();
  });

  it.each([
    ["report が壊れている(月が 6 桁でない)", { ok: true, report: { ...DETAIL, month: "2026" } }],
    ["report の月が数(文字列でない)", { ok: true, report: { ...DETAIL, month: 202610 } }],
    ["report の件数が負", { ok: true, report: { ...DETAIL, race_count: -1 } }],
    ["body が無い", { ok: true, report: { ...DETAIL, body: null } }],
    ["stats が無い", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: undefined } } }],
    ["stats の期間の日付が 8 桁でない", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ fromDate: "2026-10" }) } } }],
    ["日ごとの行の日付が 8 桁でない", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ days: [{ date: "1003" }] }) } } }],
    ["日ごとの行の金額が文字列", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ days: [{ ...(stats()["days"] as Record<string, unknown>[])[0], totalStake: "200" }] }) } } }],
    ["日ごとの行の回収率が文字列", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ days: [{ ...(stats()["days"] as Record<string, unknown>[])[0], recoveryRate: "4" }] }) } } }],
    ["日ごとの行が配列でない", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ days: {} }) } } }],
    ["版ごとの行の版が数値", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ byVersion: [{ ...(stats()["byVersion"] as Record<string, unknown>[])[0], promptVersion: 1 }] }) } } }],
    ["版ごとの行が配列でない", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ byVersion: null }) } } }],
    ["最終日の未確定の印が真偽値でない", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, lastDayPending: "no" } } }],
    ["1 行だけ壊れた日ごとの行(一部だけを採用しない)", { ok: true, report: { ...DETAIL, body: { ...DETAIL.body, stats: stats({ days: [...(stats()["days"] as unknown[]), { date: "20261015" }] }) } } }],
    ["ok が true でない", { ok: false, report: null }],
    ["report のキーが無い", { ok: true }],
  ])("想定外の形は unexpected: %s", async (_name, body) => {
    expect(await fetchMonthly(reply(200, body), "202610")).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("404 は not-found、通信の失敗・JSON でない応答・403・503 を分類する(例外の文面は持ち込まない)", async () => {
    expect(await fetchMonthly(reply(404, { ok: false, error: { type: "not-found" } }), "202610")).toStrictEqual({ ok: false, error: { kind: "not-found" } });
    expect(await fetchMonthly(throwing, "202610")).toStrictEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchMonthly(badJson, "202610")).toMatchObject({ ok: false });
    expect(await fetchMonthly(reply(403, "forbidden"), "202610")).toStrictEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await fetchMonthly(reply(503, { ok: false, error: { type: "report-error" } }), "202610")).toStrictEqual({ ok: false, error: { kind: "server-error" } });
  });
});

describe("monthlyFetchFailureMessage(固定の文言。サーバの文面・例外の文面を含めない)", () => {
  it.each([
    { kind: "forbidden" as const },
    { kind: "origin-mismatch" as const },
    { kind: "network" as const },
    { kind: "bad-request" as const },
    { kind: "not-found" as const },
    { kind: "server-error" as const },
    { kind: "netkeiba-unavailable" as const, reason: "failed" as const },
    { kind: "unexpected" as const, httpStatus: 200 },
  ])("%j は月報を主語にした固定の文言", (failure) => {
    const text = monthlyFetchFailureMessage(failure);
    expect(text).toContain("月報");
    expect(text).not.toContain("SECRET");
  });

  it("想定外の応答には HTTP ステータスを添える", () => {
    expect(monthlyFetchFailureMessage({ kind: "unexpected", httpStatus: 502 })).toContain("HTTP 502");
  });
});

describe("fetchMonthly: LLM の文章(Issue #280)", () => {
  const NARRATIVE = { summary: "10 月は 3 レースを分析。", good: ["良い点"], improve: ["改善点 1", "改善点 2"], outlook: ["来月に見ておく数字"] };
  const withBody = (extra: Record<string, unknown>) => ({ ok: true, report: { ...DETAIL, model: "claude-sonnet-5-5", summary: NARRATIVE.summary, body: { ...DETAIL.body, ...extra } } });

  it("文章(総括・良かった点・改善点・来月に向けて)と、文章が無い理由・プロンプトの版を読む", async () => {
    const got = await fetchMonthly(reply(200, withBody({ narrative: NARRATIVE, narrativeRaw: null, note: null, promptVersion: "monthly-2026-10-13.1" })), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toStrictEqual(NARRATIVE);
    expect(got.report.narrativeRaw).toBeNull();
    expect(got.report.note).toBeNull();
    expect(got.report.promptVersion).toBe("monthly-2026-10-13.1");
    expect(got.report.model).toBe("claude-sonnet-5-5");
  });

  it("文章が読めなかった月報は、生の文章(narrativeRaw)と理由を読む", async () => {
    const got = await fetchMonthly(reply(200, withBody({ narrative: null, narrativeRaw: "これは生の文章", note: "LLM の応答を構造として読めなかったため、生の文章を載せています" })), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toBeNull();
    expect(got.report.narrativeRaw).toBe("これは生の文章");
    expect(got.report.note).toContain("構造として読めなかった");
  });

  it.each([
    ["narrative が配列", { narrative: [] }],
    ["総括が文字列でない", { narrative: { ...NARRATIVE, summary: 5 } }],
    ["総括が無い", { narrative: { good: [], improve: [], outlook: [] } }],
    ["良かった点が配列でない", { narrative: { ...NARRATIVE, good: "a" } }],
    ["改善点に文字列でない要素", { narrative: { ...NARRATIVE, improve: ["a", 3] } }],
    ["来月に向けてが無い", { narrative: { summary: "s", good: [], improve: [] } }],
    ["narrativeRaw が数値", { narrativeRaw: 3 }],
    ["note が数値", { note: 3 }],
    ["promptVersion が数値", { promptVersion: 3 }],
  ])("文章の項目が壊れていたら unexpected(一部だけを採用しない): %s", async (_name, extra) => {
    expect(await fetchMonthly(reply(200, withBody(extra)), "202610")).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });
});

describe("fetchMonthly: 進行状況(job・job_status。Issue #280)", () => {
  const withJob = (extra: Record<string, unknown>, report: unknown = DETAIL) => ({ ok: true, report, ...extra });

  it("job と job_status が無い応答(古いサーバ・閲覧者の想定)は、ジョブなし・ok として読む", async () => {
    const got = await fetchMonthly(reply(200, { ok: true, report: DETAIL }), "202610");
    expect(got.ok && got.job).toBeNull();
    expect(got.ok && got.jobStatus).toBe("ok");
  });

  it.each(["read", "generate", "save", "notify"] as const)("段階 %s の running のジョブを読む。作り直しのジョブは regenerate: true を持つ", async (phase) => {
    const plain = await fetchMonthly(reply(200, withJob({ job: { phase, status: "running", attempts: 1 }, job_status: "ok" }, null)), "202610");
    expect(plain).toStrictEqual({ ok: true, report: null, job: { phase, status: "running", attempts: 1 }, jobStatus: "ok" });
    const regen = await fetchMonthly(reply(200, withJob({ job: { phase, status: "failed", attempts: 0, regenerate: true }, job_status: "ok" })), "202610");
    if (!regen.ok) throw new Error("読めている想定");
    expect(regen.job).toStrictEqual({ phase, status: "failed", attempts: 0, regenerate: true });
    expect("regenerate" in (plain.ok ? plain.job! : {})).toBe(false);
  });

  it("進行状況を取れなかった応答(job: null・job_status: unavailable)は jobStatus を unavailable にする", async () => {
    const got = await fetchMonthly(reply(200, withJob({ job: null, job_status: "unavailable" })), "202610");
    expect(got.ok && got.jobStatus).toBe("unavailable");
    expect(got.ok && got.job).toBeNull();
  });

  it.each([
    ["日報の段階(list)は月報では想定外", { job: { phase: "list", status: "running", attempts: 0 }, job_status: "ok" }],
    ["status が想定外", { job: { phase: "read", status: "done", attempts: 0 }, job_status: "ok" }],
    ["attempts が負", { job: { phase: "read", status: "running", attempts: -1 }, job_status: "ok" }],
    ["regenerate が false", { job: { phase: "read", status: "running", attempts: 0, regenerate: false }, job_status: "ok" }],
    ["job が配列", { job: [], job_status: "ok" }],
    ["job_status が想定外", { job: null, job_status: "maybe" }],
    ["unavailable なのに job がある", { job: { phase: "read", status: "running", attempts: 0 }, job_status: "unavailable" }],
  ])("壊れた進行状況は unexpected: %s", async (_name, extra) => {
    expect(await fetchMonthly(reply(200, withJob(extra)), "202610")).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });
});

describe("postMonthlyRun(POST /api/monthly-reports/run。Issue #280)", () => {
  const post = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });

  it("本文は { month }(作成)・{ month, regenerate: true }(作り直し)で、同一オリジンの資格情報つき・JSON で送る。Origin は referrerPolicy: same-origin", async () => {
    const calls: Array<{ url: string; init: { method: string; credentials?: string; referrerPolicy?: string; headers?: Record<string, string>; body?: string } }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init: init as never });
      return { status: 202, json: async () => ({ ok: true, accepted: true, month: "202609" }) };
    };
    expect(await postMonthlyRun(fetchLike, "202609")).toStrictEqual({ kind: "accepted" });
    expect(await postMonthlyRun(fetchLike, "202609", true)).toStrictEqual({ kind: "accepted" });
    expect(calls.map((c) => c.url)).toEqual(["/api/monthly-reports/run", "/api/monthly-reports/run"]);
    expect(calls.map((c) => JSON.parse(c.init.body!))).toEqual([{ month: "202609" }, { month: "202609", regenerate: true }]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[0]!.init.referrerPolicy).toBe("same-origin");
    expect(calls[0]!.init.headers?.["content-type"]).toBe("application/json");
  });

  it("202 でも本文が想定外(月が違う)なら accepted-malformed(サーバは依頼を受け付けている)", async () => {
    expect(await postMonthlyRun(post(202, { ok: true, accepted: true, month: "202608" }), "202609")).toStrictEqual({ kind: "accepted-malformed" });
    expect(await postMonthlyRun(post(202, "x"), "202609")).toStrictEqual({ kind: "accepted-malformed" });
  });

  // Issue #446(H-6・レビュー指摘): 削除した特性テストから移した。202 で本文が読めない(json() が失敗)でも、投げずに accepted-malformed(サーバは依頼を受け付けている)。
  it("202 で json() が失敗(本文が読めない)しても、投げずに accepted-malformed", async () => {
    const failing202: FetchLike = async () => ({
      status: 202,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    expect(await postMonthlyRun(failing202, "202609")).toStrictEqual({ kind: "accepted-malformed" });
    expect(await postMonthlyRun(post(202, null), "202609")).toStrictEqual({ kind: "accepted-malformed" });
  });

  it("409 は already-exists・in-progress、それ以外の 409(not-exists など)は想定外。429 daily-limit は上限", async () => {
    expect(await postMonthlyRun(post(409, { ok: false, error: { type: "already-exists" } }), "202609")).toStrictEqual({ kind: "already-exists" });
    expect(await postMonthlyRun(post(409, { ok: false, error: { type: "in-progress" } }), "202609")).toStrictEqual({ kind: "in-progress" });
    expect(await postMonthlyRun(post(409, { ok: false, error: { type: "not-exists" } }), "202609", true)).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
    expect(await postMonthlyRun(post(429, { ok: false, error: { type: "daily-limit" } }), "202609", true)).toStrictEqual({ kind: "daily-limit" });
    expect(await postMonthlyRun(post(429, { ok: false, error: { type: "other" } }), "202609", true)).toMatchObject({ kind: "failed" });
  });

  it("400・413・415 は bad-request、403 は forbidden、503 は server-error、通信の失敗は network(例外の文面は持ち込まない)", async () => {
    for (const status of [400, 413, 415]) {
      expect(await postMonthlyRun(post(status, { ok: false }), "202609")).toStrictEqual({ kind: "failed", failure: { kind: "bad-request" } });
    }
    expect(await postMonthlyRun(post(403, "x"), "202609")).toStrictEqual({ kind: "failed", failure: { kind: "forbidden" } });
    expect(await postMonthlyRun(post(503, { ok: false, error: { type: "report-error" } }), "202609")).toStrictEqual({ kind: "failed", failure: { kind: "server-error" } });
    expect(await postMonthlyRun(throwing, "202609")).toStrictEqual({ kind: "failed", failure: { kind: "network" } });
  });
});
