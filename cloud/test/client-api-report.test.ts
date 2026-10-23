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
    ["行が null(Issue #446〈H-6〉: 投げずに unexpected)", { ok: true, reports: [null] }],
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
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null, job_status: "ok" }), "20261005")).toStrictEqual({ ok: true, report: null, job: null, jobStatus: "ok" });
    expect(await fetchReport(reply(200, { ok: true, report: null, job: { phase: "save", status: "failed", attempts: 3 }, job_status: "ok" }), "20261005")).toStrictEqual({
      ok: true,
      report: null,
      job: { phase: "save", status: "failed", attempts: 3 },
      jobStatus: "ok",
    });
    expect(await fetchReport(reply(200, { ok: true, report: null, job: { phase: "weird", status: "running", attempts: 0 }, job_status: "ok" }), "20261005")).toMatchObject({ ok: false });
    expect(await fetchReport(reply(200, { ok: true, report: null, job_status: "ok" }), "20261005")).toMatchObject({ ok: false }); // job の欠落
  });

  it("Issue #245: job_status は ok / unavailable のどちらか。欠落・未知の値・unavailable なのに job がある、は unexpected(一部だけを採用しない)", async () => {
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null, job_status: "unavailable" }), "20261005")).toStrictEqual({ ok: true, report: null, job: null, jobStatus: "unavailable" });
    const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null }), "20261005")).toStrictEqual(unexpected); // 欠落
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null, job_status: "weird" }), "20261005")).toStrictEqual(unexpected);
    expect(await fetchReport(reply(200, { ok: true, report: null, job: null, job_status: true }), "20261005")).toStrictEqual(unexpected);
    // 取れなかった(unavailable)のに進行状況の本体がある、は矛盾
    expect(await fetchReport(reply(200, { ok: true, report: null, job: { phase: "save", status: "failed", attempts: 3 }, job_status: "unavailable" }), "20261005")).toStrictEqual(unexpected);
  });

  it("本文が壊れていれば(統計・レースの型違い)一部だけ採用せず unexpected", async () => {
    const bad = { date: "20261005", created_at: "x", model: null, race_count: 1, total_stake: 1, total_return: 1, summary: null, body: { stats: {}, races: [], narrative: null, narrativeRaw: null, note: null } };
    expect(await fetchReport(reply(200, { ok: true, report: bad, job: null, job_status: "ok" }), "20261005")).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("404 は not-found、通信の失敗は network", async () => {
    expect(await fetchReport(reply(404, { ok: false, error: { type: "not-found" } }), "20261005")).toStrictEqual({ ok: false, error: { kind: "not-found" } });
    expect(await fetchReport(throwing, "20261005")).toStrictEqual({ ok: false, error: { kind: "network" } });
  });

  it("要求の URL に開催日が入る", async () => {
    const urls: string[] = [];
    const spy: FetchLike = async (url) => {
      urls.push(url);
      return { status: 200, json: async () => ({ ok: true, report: null, job: null, job_status: "ok" }) };
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

  // Issue #446(H-6・レビュー指摘): 削除した特性テストから移した。202 で本文が読めない(json() が失敗)でも、投げずに accepted-malformed(サーバは依頼を受け付けている)。
  it("202 で json() が失敗(本文が読めない)しても、投げずに accepted-malformed", async () => {
    expect(await postReportRun(badJson, "20261005")).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 200 } });
    const failing202: FetchLike = async () => ({
      status: 202,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    expect(await postReportRun(failing202, "20261005")).toStrictEqual({ kind: "accepted-malformed" });
    expect(await postReportRun(async () => ({ status: 202, json: async () => null }), "20261005")).toStrictEqual({ kind: "accepted-malformed" });
  });

  it("409 は error.type で already-exists / in-progress。未知の型は unexpected", async () => {
    expect(await postReportRun(reply(409, { ok: false, error: { type: "already-exists" } }), "20261005")).toStrictEqual({ kind: "already-exists" });
    expect(await postReportRun(reply(409, { ok: false, error: { type: "in-progress" } }), "20261005")).toStrictEqual({ kind: "in-progress" });
    expect(await postReportRun(reply(409, { ok: false, error: { type: "other" } }), "20261005")).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
  });

  // Issue #446(H-6): 削除した特性テストから移した。本文が読めない 409(プロキシの平文の応答ほか。json() の失敗は本文なし〈undefined〉になる)でも、投げずに unexpected:409。
  it.each([
    ["本文なし(json() が失敗)", undefined],
    ["本文が null", null],
    ["本文が文字列", "x"],
    ["本文が error を持たないオブジェクト", {}],
  ])("409 で %s は、投げずに unexpected:409(already-exists・in-progress にしない)", async (_n, body) => {
    const failing: FetchLike = async () => ({
      status: 409,
      json: async () => {
        if (body === undefined) throw new SyntaxError("not json");
        return body;
      },
    });
    expect(await postReportRun(failing, "20261005")).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
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

describe("Issue #264: 見込みの的中数・直近 28 日の累計を読む", () => {
  const STATS = {
    raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 2, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
    byBetType: { win: { betCount: 2, hitCount: 1, stake: 600, payout: 1300 } },
    byMark: [{ mark: "◎", count: 2, win: 1, top3: 1 }],
  };
  const EXPECTED = { expectedBetCount: 4, expectedHits: 1.25, expectedBaseHits: 1, maxPayout: 1300, maxPayoutStake: 600 };
  const TYPE_EXPECTED = { expectedBetCount: 2, expectedHits: 0.6, expectedBaseHits: 1 };
  const withExpected = { ...STATS, ...EXPECTED, byBetType: { win: { ...STATS.byBetType.win, ...TYPE_EXPECTED } } };
  const PERIOD = { ...withExpected, fromDate: "20260913", toDate: "20261010", dayCount: 7 };
  const ROLLING = { windowDays: 28, prior: { ...PERIOD, toDate: "20261009", dayCount: 6 }, total: PERIOD };
  const detail = (stats: unknown, rolling?: unknown) => ({
    date: "20261010", created_at: "2026-10-10T11:00:00.000Z", model: null, race_count: 2, total_stake: 1000, total_return: 1300, summary: null,
    body: { format: 1, kaisaiDate: "20261010", stats, races: [], narrative: null, narrativeRaw: null, note: null, ...(rolling === undefined ? {} : { rolling }) },
  });
  const fetchWith = (report: unknown) => fetchReport(reply(200, { ok: true, report, job: null, job_status: "ok" }), "20261010");
  const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };

  it("見込みの項目(全体・券種別)と累計を、サーバが書いた値のまま読む", async () => {
    const got = await fetchWith(detail(withExpected, ROLLING));
    expect(got.ok).toBe(true);
    if (!got.ok || got.report === null) throw new Error("読めませんでした");
    expect(got.report.stats).toStrictEqual(withExpected);
    expect(got.report.rolling).toStrictEqual(ROLLING);
    // 前提(空振り防止): 見込みの項目が実際に値を持っている
    expect(got.report.stats.expectedHits).toBe(1.25);
    expect(got.report.rolling!.total.dayCount).toBe(7);
  });

  it("この項目を持つ前の日報(見込みも累計も無い)は、そのまま読める。キーを足さない", async () => {
    const got = await fetchWith(detail(STATS));
    if (!got.ok || got.report === null) throw new Error("読めませんでした");
    expect(got.report.stats).toStrictEqual(STATS);
    expect("rolling" in got.report).toBe(false);
    expect("expectedHits" in got.report.stats).toBe(false);
  });

  it.each([
    ["見込みの項目が一部だけ(expectedHits だけ)", { ...STATS, expectedHits: 1.2 }],
    ["見込みの点数が負", { ...withExpected, expectedBetCount: -1 }],
    ["見込みの的中数が文字列", { ...withExpected, expectedHits: "1.2" }],
    ["最大払戻の賭け金だけ", { ...STATS, maxPayoutStake: 100 }],
    ["券種別の見込みが一部だけ", { ...STATS, byBetType: { win: { ...STATS.byBetType.win, expectedHits: 0.5 } } }],
  ])("想定外の形は一部だけ採用せず unexpected: %s", async (_n, stats) => {
    expect(await fetchWith(detail(stats))).toStrictEqual(unexpected);
  });

  it.each([
    ["total が無い", { windowDays: 28, prior: PERIOD }],
    ["prior が無い", { windowDays: 28, total: PERIOD }],
    ["windowDays が数でない", { ...ROLLING, windowDays: "28" }],
    ["total の範囲(fromDate)が 8 桁でない", { ...ROLLING, total: { ...PERIOD, fromDate: "2026-09-13" } }],
    ["total の開催日数が負", { ...ROLLING, total: { ...PERIOD, dayCount: -1 } }],
    ["total の統計が壊れている", { ...ROLLING, total: { ...PERIOD, totalStake: "x" } }],
    ["累計がオブジェクトでない", "x"],
  ])("累計が壊れていれば unexpected: %s", async (_n, rolling) => {
    expect(await fetchWith(detail(withExpected, rolling))).toStrictEqual(unexpected);
  });

  // Issue #446(H-6): 削除した特性テスト(client-api-characterization)から移した。本文(統計・累計)が整っていても、先頭 7 項目が 1 つでも壊れていれば、投げずに unexpected。
  it("対照: 先頭 7 項目が整っていれば読める(下の「壊れていれば」が空振りでないことの前提)", async () => {
    const got = await fetchWith(detail(withExpected, ROLLING));
    expect(got.ok).toBe(true);
  });

  it.each([
    ["開催日が 8 桁でない", { date: "2026-10-10" }],
    ["開催日が数", { date: 20261010 }],
    ["作成日時が null", { created_at: null }],
    ["model が数", { model: 5 }],
    ["件数が負", { race_count: -1 }],
    ["賭け金が文字列", { total_stake: "1000" }],
    ["払戻が文字列", { total_return: "1300" }],
    ["summary が数", { summary: 5 }],
  ])("先頭 7 項目が壊れていれば、本文が整っていても投げずに unexpected: %s", async (_n, patch) => {
    expect(await fetchWith({ ...detail(withExpected, ROLLING), ...patch })).toStrictEqual(unexpected);
  });

  it.each([
    ["body が無い(undefined)", undefined],
    ["body が null", null],
    ["body が配列", []],
    ["body が文字列", "x"],
  ])("詳細の %s は、投げずに unexpected", async (_n, body) => {
    expect(await fetchWith({ ...detail(withExpected, ROLLING), body })).toStrictEqual(unexpected);
  });
});

describe("Issue #272: 印の定型の買い方(whatIf)と惜しかったレースを読む", () => {
  const tpl = (over: Record<string, number> = {}) => ({ betCount: 10, hitCount: 2, stake: 1000, payout: 1500, unjudgedCount: 1, inapplicableCount: 3, ...over });
  const WHATIF = { win: tpl(), place: tpl({ hitCount: 5, payout: 1100 }), wide: tpl({ betCount: 0, hitCount: 0, stake: 0, payout: 0 }), quinella: tpl(), trio: tpl() };
  const STATS = {
    raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 2, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
    byBetType: { win: { betCount: 2, hitCount: 1, stake: 600, payout: 1300 } },
    byMark: [{ mark: "◎", count: 2, win: 1, top3: 1 }],
  };
  const NEAR = { total: 4, shown: [{ raceId: "202605030801", templateId: "trio", payout: 12340 }] };
  const detail = (stats: unknown, extra: Record<string, unknown> = {}) => ({
    date: "20261010", created_at: "2026-10-10T11:00:00.000Z", model: null, race_count: 2, total_stake: 1000, total_return: 1300, summary: null,
    body: { format: 1, kaisaiDate: "20261010", stats, races: [], narrative: null, narrativeRaw: null, note: null, ...extra },
  });
  const fetchWith = (report: unknown) => fetchReport(reply(200, { ok: true, report, job: null, job_status: "ok" }), "20261010");
  const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };

  it("whatIf(型ごとの成績)と nearMisses を、サーバが書いた値のまま読む", async () => {
    const got = await fetchWith(detail({ ...STATS, whatIf: WHATIF }, { nearMisses: NEAR }));
    if (!got.ok || got.report === null) throw new Error("読めませんでした");
    expect(got.report.stats.whatIf).toStrictEqual(WHATIF);
    expect(got.report.nearMisses).toStrictEqual(NEAR);
    // 前提(空振り防止): 値が実際に入っている
    expect(got.report.stats.whatIf!["place"]!.hitCount).toBe(5);
  });

  it("whatIf が null(旧形のジョブで作った日報)は null のまま読む。項目そのものが無い日報(旧形)はキーを足さない", async () => {
    const asNull = await fetchWith(detail({ ...STATS, whatIf: null }));
    if (!asNull.ok || asNull.report === null) throw new Error("読めませんでした");
    expect(asNull.report.stats.whatIf).toBeNull();
    expect("nearMisses" in asNull.report).toBe(false);
    const legacy = await fetchWith(detail(STATS));
    if (!legacy.ok || legacy.report === null) throw new Error("読めませんでした");
    expect("whatIf" in legacy.report.stats).toBe(false);
    expect("nearMisses" in legacy.report).toBe(false);
  });

  it.each([
    ["型の統計が一部の項目だけ", { ...STATS, whatIf: { ...WHATIF, win: { betCount: 1 } } }],
    ["点数が負", { ...STATS, whatIf: { ...WHATIF, win: tpl({ betCount: -1 }) } }],
    ["払戻が文字列", { ...STATS, whatIf: { ...WHATIF, win: tpl({ payout: "1" as unknown as number }) } }],
    ["判定不能の数が小数", { ...STATS, whatIf: { ...WHATIF, win: tpl({ unjudgedCount: 1.5 }) } }],
    ["型の統計がオブジェクトでない", { ...STATS, whatIf: { ...WHATIF, win: 3 } }],
    ["whatIf が配列", { ...STATS, whatIf: [] }],
    ["whatIf が文字列", { ...STATS, whatIf: "x" }],
  ])("想定外の形は一部だけ採用せず unexpected: %s", async (_n, stats) => {
    expect(await fetchWith(detail(stats))).toStrictEqual(unexpected);
  });

  it.each([
    ["total が無い", { shown: [] }],
    ["total が負", { total: -1, shown: [] }],
    ["shown が配列でない", { total: 1, shown: "x" }],
    ["shown の払戻が数でない", { total: 1, shown: [{ raceId: "R", templateId: "trio", payout: "1" }] }],
    ["shown の raceId が無い", { total: 1, shown: [{ templateId: "trio", payout: 1 }] }],
    ["nearMisses がオブジェクトでない", "x"],
    ["nearMisses が null", null],
  ])("惜しかったレースが壊れていれば unexpected: %s", async (_n, nearMisses) => {
    expect(await fetchWith(detail(STATS, { nearMisses }))).toStrictEqual(unexpected);
  });
});

describe("Issue #268: 作り直し(regenerate)の API", () => {
  const BODY = { ok: true, accepted: true, date: "20261005" };

  it("postReportRun(…, true) は本文に regenerate: true を足す。省略(従来の呼び出し)は { date } だけで、キーそのものを付けない", async () => {
    const bodies: unknown[] = [];
    const spy: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return { status: 202, json: async () => BODY };
    };
    expect(await postReportRun(spy, "20261005", true)).toStrictEqual({ kind: "accepted" });
    await postReportRun(spy, "20261005");
    await postReportRun(spy, "20261005", false);
    expect(bodies).toStrictEqual([{ date: "20261005", regenerate: true }, { date: "20261005" }, { date: "20261005" }]);
  });

  it("429 は error.type が daily-limit のときだけ daily-limit(1 日の上限)。型が違う・本文が無い 429 は unexpected", async () => {
    expect(await postReportRun(reply(429, { ok: false, error: { type: "daily-limit" } }), "20261005", true)).toStrictEqual({ kind: "daily-limit" });
    expect(await postReportRun(reply(429, { ok: false, error: { type: "other" } }), "20261005", true)).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 429 } });
    expect(await postReportRun(reply(429, "x"), "20261005", true)).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 429 } });
  });

  // Issue #446(H-6): 削除した特性テストから移した。error の無い・null の 429(上限の判定が error.type を読む前に落ちる形)でも、投げずに unexpected:429。
  it.each([
    ["error の無いオブジェクト", { ok: false }],
    ["error が null", { ok: false, error: null }],
    ["本文なし(json() が失敗)", undefined],
  ])("429 で本文が %s でも、投げずに unexpected:429(daily-limit にしない)", async (_n, body) => {
    const failing: FetchLike = async () => ({
      status: 429,
      json: async () => {
        if (body === undefined) throw new SyntaxError("not json");
        return body;
      },
    });
    expect(await postReportRun(failing, "20261005", true)).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 429 } });
  });

  it("409 の not-exists(作り直しなのに日報が無い。画面からは出せない)は、既知の型にせず unexpected(固定の文言で出る)", async () => {
    expect(await postReportRun(reply(409, { ok: false, error: { type: "not-exists" } }), "20261005", true)).toStrictEqual({ kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } });
  });

  it("job の regenerate: true を読む。無ければキーを足さない。true 以外(false・文字列)は壊れた応答として unexpected", async () => {
    const withJob = (job: unknown) => reply(200, { ok: true, report: null, job, job_status: "ok" });
    expect(await fetchReport(withJob({ phase: "save", status: "failed", attempts: 3, regenerate: true }), "20261005")).toMatchObject({ ok: true, job: { phase: "save", status: "failed", attempts: 3, regenerate: true } });
    const plain = (await fetchReport(withJob({ phase: "save", status: "failed", attempts: 3 }), "20261005")) as { job: object };
    expect("regenerate" in plain.job).toBe(false);
    for (const regenerate of [false, "true", 1, null]) {
      expect(await fetchReport(withJob({ phase: "save", status: "failed", attempts: 3, regenerate }), "20261005"), String(regenerate)).toMatchObject({ ok: false });
    }
  });
});
