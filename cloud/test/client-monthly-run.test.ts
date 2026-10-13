import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import {
  MONTHLY_CREATE_CAUTION,
  MONTHLY_CREATE_FAILED_NOTICE,
  MONTHLY_CREATE_REQUESTED_NOTICE,
  MONTHLY_CREATING_NOTICE,
  MONTHLY_NO_REPORT_NOTICE,
  MONTHLY_REGEN_CONFIRM_TEXT,
  MONTHLY_REGEN_DONE_NOTICE,
  MONTHLY_REGEN_FAILED_NOTICE,
  MONTHLY_REGEN_REQUESTED_NOTICE,
} from "../client/monthly-model";
import { createMonthlyScreen, type MonthlyScreen } from "../client/monthly-screen";
import { JOB_UNAVAILABLE_NOTICE, REGEN_LIMIT_MESSAGE } from "../client/report-model";
import { REPORT_MAX_FAILURES, REPORT_MAX_POLLS, REPORT_POLL_MS } from "../client/report-screen";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #280(#265-B / B-2): 月報の画面の制御のうち、管理者の「この月の月報を作る」(作成)と「月報を作り直す」(確認つき)・完了と失敗のポーリング。日報の #235・#268 と同じ作り。
 * 守ること:
 *  - 作成は、管理者の、終わった月で月報が無い月だけ。作り直しは、管理者の、終わった月で月報がある月だけで、確認を経ない限り POST は出ない
 *  - 依頼のあとは、月報が現れる/作成時刻が変わる/ジョブが失敗するまで確認する。作成時刻が変わらず、ジョブも見えない間は『完了』にしない
 *  - 非表示の間は確認を止め、表示に戻ったら即時に 1 回取る。上限回数で止める。離れると捨てる
 */

const TODAY = "20261105"; // 2026 年 10 月は終わった月・11 月は今月
const MONTH = "202610";
const FIRST_AT = "2026-10-31T13:05:00.000Z";
const SECOND_AT = "2026-11-05T01:30:00.000Z";

type Reply = { status: number; body: unknown } | "throw";
const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, job: null, job_status: "ok", ...body } });
const LIST_ROW = (month: string) => ({ month, created_at: FIRST_AT, model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null });

function statsJson(): Record<string, unknown> {
  return {
    raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
    refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0, maxPayout: 800, maxPayoutStake: 200,
    byBetType: {}, byMark: [], whatIf: null, fromDate: "20261001", toDate: "20261031", dayCount: 1,
    days: [{ date: "20261003", raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1, refundedBetCount: 0 }],
    byVersion: [],
  };
}
const reportJson = (createdAt: string): Record<string, unknown> => ({
  month: MONTH, created_at: createdAt, model: "claude-sonnet-5-5", race_count: 3, total_stake: 300, total_return: 800, summary: "総括",
  body: {
    format: 1, month: MONTH, stats: statsJson(), lastDayPending: false,
    narrative: { summary: "総括", good: ["良い点"], improve: ["改善点"], outlook: ["来月"] }, narrativeRaw: null, note: null, promptVersion: "monthly-2026-10-13.1",
  },
});

interface Net {
  readonly fetch: FetchLike;
  readonly calls: string[];
  /** POST の本文(JSON を戻したもの)。 */
  readonly posts: unknown[];
  script: Record<string, Reply[]>;
  /** 設定すると、月の本文の取得(GET)はこの Promise が解決するまで返らない(取得中に画面の状態が変わる場合の確認用)。 */
  gate: Promise<void> | null;
}

function net(): Net {
  const n: Net = {
    calls: [],
    posts: [],
    script: {},
    gate: null,
    fetch: async (url, init) => {
      const key = `${init.method} ${url}`;
      n.calls.push(key);
      if (n.gate !== null && init.method === "GET" && /^\/api\/monthly-reports\/\d{6}$/.test(url)) await n.gate;
      if (init.method === "POST") n.posts.push(JSON.parse(init.body as string));
      const queue = n.script[key];
      if (queue === undefined || queue.length === 0) throw new Error(`応答の指定が無い: ${key}`);
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (reply === "throw") throw new Error("network");
      return { status: reply.status, json: async () => reply.body };
    },
  };
  return n;
}

const POST_OK: Reply = { status: 202, body: { ok: true, accepted: true, month: MONTH } };
const POST_URL = "POST /api/monthly-reports/run";
const RUNNING_REGEN = { phase: "generate", status: "running", attempts: 0, regenerate: true };
const RUNNING_CREATE = { phase: "read", status: "running", attempts: 0 };

interface Opened {
  readonly n: Net;
  readonly screen: MonthlyScreen;
  readonly timers: ReturnType<typeof createFakeTimers>;
  visible: { value: boolean };
}

/** 月 `month`(既定は終わった月 2026 年 10 月)を開いた管理者(または閲覧者)の画面。`details` は本文の応答(先頭から消費。尽きたら最後を繰り返す)。 */
async function open(details: Reply[], options: { readOnly?: boolean; month?: string } = {}): Promise<Opened> {
  const month = options.month ?? MONTH;
  const n = net();
  const timers = createFakeTimers();
  const visible = { value: true };
  n.script["GET /api/monthly-reports"] = [ok({ reports: [LIST_ROW("202609")] })];
  n.script[`GET /api/monthly-reports/${month}`] = details;
  const screen = createMonthlyScreen({
    fetch: n.fetch, timers, isVisible: () => visible.value, today: () => TODAY, onChange: () => {},
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  screen.enter(month);
  await timers.flush();
  return { n, screen, timers, visible };
}

describe("作成(この月の月報を作る)", () => {
  it("月報が無い終わった月: ボタンが出る。押すと POST 1 回(本文は { month }。regenerate なし)。依頼中は無効で、連打で POST は増えない", async () => {
    const { n, screen, timers } = await open([ok({ report: null })]);
    expect(screen.model().create).toStrictEqual({ label: "この月の月報を作る", disabled: false, caution: MONTHLY_CREATE_CAUTION, todayCaution: null });
    n.script[POST_URL] = [POST_OK];
    screen.onRun();
    expect(screen.model().create).toStrictEqual({ label: "依頼中…", disabled: true, caution: MONTHLY_CREATE_CAUTION, todayCaution: null });
    screen.onRun();
    await timers.flush();
    expect(n.posts).toStrictEqual([{ month: MONTH }]);
  });

  it("受け付けたら作成を依頼した旨の案内を出し、REPORT_POLL_MS ごとに本文を取り直す。月報が現れたら止まる(本文に替わる・一覧も取り直す)", async () => {
    const { n, screen, timers } = await open([
      ok({ report: null }),
      ok({ report: null, job: RUNNING_CREATE }), // 依頼の直後の確認: 作成中
      ok({ report: null, job: RUNNING_CREATE }),
      ok({ report: reportJson(FIRST_AT) }),
    ]);
    n.script[POST_URL] = [POST_OK];
    screen.onRun();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "wait", text: MONTHLY_CREATING_NOTICE });
    expect(screen.model().create).toBeNull();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice!.text).toBe(MONTHLY_CREATING_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    const listCalls = n.calls.filter((c) => c === "GET /api/monthly-reports").length;
    await timers.advance(REPORT_POLL_MS);
    const m = screen.model();
    expect(m.body).not.toBeNull();
    expect(m.body!.summary).toBe("総括");
    expect(m.notice).toBeNull();
    expect(m.create).toBeNull();
    expect(timers.pending()).toBe(0);
    expect(n.calls.filter((c) => c === "GET /api/monthly-reports").length).toBe(listCalls + 1); // 新しく現れた月報を一覧に入れる
  });

  it("依頼のあとで進行状況を取れなかった(unavailable)ときは、固定の案内を出して確認を続ける。依頼した旨の案内は、進行状況が取れたうえでジョブがまだ無い間", async () => {
    const { n, screen, timers } = await open([ok({ report: null }), ok({ report: null, job: null, job_status: "unavailable" }), ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRun();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(JOB_UNAVAILABLE_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().body).not.toBeNull();
    expect(MONTHLY_CREATE_REQUESTED_NOTICE).toContain("依頼しました");
  });

  it("ジョブが失敗(failed)したら止めて、失敗の案内とボタンを出す(もう一度押せる)", async () => {
    const { n, screen, timers } = await open([ok({ report: null }), ok({ report: null, job: { phase: "read", status: "failed", attempts: 3 } })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRun();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: MONTHLY_CREATE_FAILED_NOTICE });
    expect(screen.model().create).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("依頼は受け付けられたのに、月報もジョブも無い(ok)なら、分析が無く作られずに終わった旨を出して止める。unavailable のときは断定しない", async () => {
    const { n, screen, timers } = await open([ok({ report: null })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRun();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "info", text: MONTHLY_NO_REPORT_NOTICE });
    expect(timers.pending()).toBe(0);
    expect(screen.model().create).toBeNull();
  });

  it("サーバが『作成済み』(409 already-exists)と答えたら本文を取り直して表示する。『作成中』(409 in-progress)なら作成中の表示にして確認を始める", async () => {
    const exists = await open([ok({ report: null }), ok({ report: reportJson(FIRST_AT) })]);
    exists.n.script[POST_URL] = [{ status: 409, body: { ok: false, error: { type: "already-exists" } } }];
    exists.screen.onRun();
    await exists.timers.flush();
    expect(exists.screen.model().body).not.toBeNull();
    expect(exists.timers.pending()).toBe(0);

    const busy = await open([ok({ report: null }), ok({ report: null, job: RUNNING_CREATE })]);
    busy.n.script[POST_URL] = [{ status: 409, body: { ok: false, error: { type: "in-progress" } } }];
    busy.screen.onRun();
    await busy.timers.flush();
    expect(busy.screen.model().notice!.text).toBe(MONTHLY_CREATING_NOTICE);
    expect(busy.timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it.each([
    ["通信の失敗", "throw" as Reply],
    ["サーバのエラー(503)", { status: 503, body: { ok: false, error: { type: "report-error" } } } as Reply],
    ["Origin の不一致(403)", { status: 403, body: { ok: false, error: { type: "origin-mismatch" } } } as Reply],
  ])("%s: 月報を主語にした固定の文言を出し、確認は始めない。ボタンは戻る", async (_name, reply) => {
    const { n, screen, timers } = await open([ok({ report: null })]);
    n.script[POST_URL] = [reply];
    screen.onRun();
    await timers.flush();
    const m = screen.model();
    expect(m.notice!.tone).toBe("error");
    expect(m.notice!.text).toContain("月報");
    expect(m.notice!.text).not.toContain("日報");
    expect(timers.pending()).toBe(0);
    expect(m.create).not.toBeNull();
    expect(m.create!.disabled).toBe(false);
  });

  it("閲覧者(readOnly)・今月・月報がある月・読み込み中では、押しても POST は出ない。対照: 管理者・終わった月・月報なしでは出る", async () => {
    const viewer = await open([ok({ report: null })], { readOnly: true });
    viewer.n.script[POST_URL] = [POST_OK];
    viewer.screen.onRun();
    await viewer.timers.flush();
    expect(viewer.n.calls.includes(POST_URL)).toBe(false);

    const current = await open([ok({ report: null })], { month: "202611" });
    current.n.script[POST_URL] = [POST_OK];
    current.screen.onRun();
    await current.timers.flush();
    expect(current.n.calls.includes(POST_URL)).toBe(false);

    const has = await open([ok({ report: reportJson(FIRST_AT) })]);
    has.n.script[POST_URL] = [POST_OK];
    has.screen.onRun();
    await has.timers.flush();
    expect(has.n.calls.includes(POST_URL)).toBe(false);

    const admin = await open([ok({ report: null })]);
    admin.n.script[POST_URL] = [POST_OK];
    admin.screen.onRun();
    await admin.timers.flush();
    expect(admin.n.calls.includes(POST_URL)).toBe(true);
  });
});

describe("作り直し(月報を作り直す): 確認を経ない限り POST は出ない", () => {
  it("開くと確認が出る(POST なし)。確認の文面・実行・やめるの語。やめると閉じる(POST なし)", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    expect(screen.model().regen).toStrictEqual({ label: "月報を作り直す", disabled: false, confirm: null });
    screen.onRegenOpen();
    const confirm = screen.model().regen!.confirm!;
    expect(confirm.text).toBe(MONTHLY_REGEN_CONFIRM_TEXT);
    for (const fact of ["置き換え", "元に戻せません", "費用", "上限", "Discord には送りません"]) {
      expect(confirm.text, fact).toContain(fact);
    }
    expect([confirm.goLabel, confirm.cancelLabel]).toEqual(["作り直す", "やめる"]);
    screen.onRegenCancel();
    await timers.flush();
    expect(screen.model().regen).toStrictEqual({ label: "月報を作り直す", disabled: false, confirm: null });
    expect(n.calls.includes(POST_URL)).toBe(false);
  });

  it("確認を開かずに実行(onRegenGo)しても POST は出ない", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    screen.onRegenGo();
    await timers.flush();
    expect(n.calls.includes(POST_URL)).toBe(false);
  });

  it("実行すると POST 1 回(本文は { month, regenerate: true })。依頼中は無効で、連打で POST は増えない", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    expect(screen.model().regen).toStrictEqual({ label: "依頼中…", disabled: true, confirm: null });
    screen.onRegenGo();
    screen.onRegenOpen();
    await timers.flush();
    expect(n.posts).toStrictEqual([{ month: MONTH, regenerate: true }]);
  });

  it("閲覧者(readOnly)・今月は、開いても実行しても POST は出ない。対照: 管理者・終わった月では出る", async () => {
    for (const [readOnly, month, expectPost] of [[true, MONTH, false], [false, "202611", false], [false, MONTH, true]] as const) {
      const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })], { readOnly, month });
      n.script[POST_URL] = [POST_OK];
      screen.onRegenOpen();
      screen.onRegenGo();
      await timers.flush();
      expect(n.calls.includes(POST_URL), `readOnly=${readOnly} month=${month}`).toBe(expectPost);
    }
  });
});

describe("作り直しの依頼のあとの確認", () => {
  it("作成時刻が変わるまで作り直し中の表示を続け、変わったら完了の表示にしてボタンを戻す。確認の自動更新は止まる", async () => {
    const { n, screen, timers } = await open([
      ok({ report: reportJson(FIRST_AT) }),
      ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN }),
      ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN }),
      ok({ report: reportJson(SECOND_AT) }),
    ]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "wait", text: MONTHLY_REGEN_REQUESTED_NOTICE });
    expect(screen.model().regen).toBeNull();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice).toStrictEqual({ tone: "ok", text: MONTHLY_REGEN_DONE_NOTICE });
    expect(screen.model().body!.meta).toContain("10:30"); // 新しい作成時刻(JST 2026-11-05 10:30)の本文に替わっている
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("作成時刻が変わらないままジョブも見えない間は『完了』にしない(確認を続ける)", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    await timers.advance(REPORT_POLL_MS * 2);
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("作り直しのジョブが失敗(failed。置き換えを断られた〈kept〉を含む)したら、前の月報のままだと伝えて確認を止め、ボタンを戻す。本文は前の月報のまま", async () => {
    const { n, screen, timers } = await open([
      ok({ report: reportJson(FIRST_AT) }),
      ok({ report: reportJson(FIRST_AT), job: { phase: "save", status: "failed", attempts: 0, regenerate: true } }),
    ]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: MONTHLY_REGEN_FAILED_NOTICE });
    expect(MONTHLY_REGEN_FAILED_NOTICE).toContain("前の月報のまま");
    expect(screen.model().regen).not.toBeNull();
    expect(screen.model().body!.summary).toBe("総括");
    expect(timers.pending()).toBe(0);
  });

  it("進行状況を取れなかった(unavailable)ときは、固定の案内を出して確認を続ける", async () => {
    const { n, screen, timers } = await open([
      ok({ report: reportJson(FIRST_AT) }),
      ok({ report: reportJson(FIRST_AT), job_status: "unavailable" }),
      ok({ report: reportJson(SECOND_AT) }),
    ]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(JOB_UNAVAILABLE_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_DONE_NOTICE);
  });

  it("サーバが『作成中』(409 in-progress)と答えたら、作り直し中の表示にして確認を始める", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) }), ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN })]);
    n.script[POST_URL] = [{ status: 409, body: { ok: false, error: { type: "in-progress" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("作り直しの最中(サーバの regenerate のジョブが running)の月を開いたときも、自動で確認する。完了すると止まる", async () => {
    const { screen, timers } = await open([ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN }), ok({ report: reportJson(SECOND_AT) })]);
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice).toBeNull(); // 依頼した画面ではないので『完了』の案内は出さず、新しい本文だけに替わる
    expect(screen.model().body!.meta).toContain("10:30");
    expect(timers.pending()).toBe(0);
  });

  it("サーバの作成中(job running)の月報なしの月を開いたときも、自動で確認する(最終日の夜の自動作成の最中に開いた管理者)", async () => {
    const { screen, timers } = await open([ok({ report: null, job: RUNNING_CREATE }), ok({ report: reportJson(FIRST_AT) })]);
    expect(screen.model().notice!.text).toBe(MONTHLY_CREATING_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().body).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });
});

describe("断られた・失敗したとき(作り直し)", () => {
  it("1 日の回数の上限(429 daily-limit)は日報と同じ固定の案内を出し、確認は始めず、ボタンを戻す。もう一度押せる", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [{ status: 429, body: { ok: false, error: { type: "daily-limit" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: REGEN_LIMIT_MESSAGE });
    expect(timers.pending()).toBe(0);
    expect(screen.model().regen).toStrictEqual({ label: "月報を作り直す", disabled: false, confirm: null });
    screen.onRegenOpen();
    expect(screen.model().regen!.confirm).not.toBeNull();
  });

  it.each([
    ["通信の失敗", "throw" as Reply],
    ["サーバのエラー(503)", { status: 503, body: { ok: false, error: { type: "report-error" } } } as Reply],
    ["月報が無い(409 not-exists)", { status: 409, body: { ok: false, error: { type: "not-exists" } } } as Reply],
  ])("%s: 固定の文言を出し、確認は始めない。ボタンは戻る", async (_name, reply) => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [reply];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    const m = screen.model();
    expect(m.notice!.tone).toBe("error");
    expect(m.notice!.text).not.toContain("日報");
    expect(timers.pending()).toBe(0);
    expect(m.regen).not.toBeNull();
    expect(m.regen!.disabled).toBe(false);
  });

  it("「更新」で、失敗・完了の表示を消す", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [{ status: 429, body: { ok: false, error: { type: "daily-limit" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).not.toBeNull();
    screen.onRefresh();
    await timers.flush();
    expect(screen.model().notice).toBeNull();
  });
});

describe("確認の止め方", () => {
  it("上限回数(REPORT_MAX_POLLS)で止める。止めたら『自動更新を止めた』旨の案内にする。『更新』で再開できる", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    await timers.advance(REPORT_POLL_MS * (REPORT_MAX_POLLS + 2));
    expect(timers.pending()).toBe(0);
    expect(screen.model().notice!.text).toBe("作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。");
    // 本文の取得 = 開いたときの 1 回 + 確認の REPORT_MAX_POLLS 回(依頼の直後の確認も、この回数に数える)。上限を超えて取り続けない。
    expect(n.calls.filter((c) => c === `GET /api/monthly-reports/${MONTH}`).length).toBe(1 + REPORT_MAX_POLLS);
    // 「更新」で再開できる(自動更新を止めた状態を解く)
    screen.onRefresh();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("確認中の通信の失敗が REPORT_MAX_FAILURES 回続いたら止める。1 回の失敗では前の表示を残して続ける", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) }), "throw"]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().body).not.toBeNull(); // 失敗しても本文は残る
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS * (REPORT_MAX_FAILURES + 1));
    expect(timers.pending()).toBe(0);
  });

  it("非表示の間は確認を止め、表示に戻ったら(確認中なら)即時に 1 回取って再開する", async () => {
    const { n, screen, timers, visible } = await open([ok({ report: reportJson(FIRST_AT) }), ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    visible.value = false;
    screen.onVisibilityChange();
    expect(timers.pending()).toBe(0);
    const before = n.calls.length;
    await timers.advance(REPORT_POLL_MS * 3);
    expect(n.calls.length).toBe(before); // 非表示の間は取らない
    visible.value = true;
    screen.onVisibilityChange();
    await timers.flush();
    expect(n.calls.length).toBe(before + 1);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("確認の取得の最中に非表示になったら、その応答が届いても次の確認のタイマーを張らない。表示に戻ったら再開する", async () => {
    const { n, screen, timers, visible } = await open([ok({ report: reportJson(FIRST_AT) }), ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN })]);
    n.script[POST_URL] = [POST_OK];
    const gate = deferred<void>();
    n.gate = gate.promise;
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush(); // POST は済み、確認の取得が gate で止まっている
    expect(n.calls.filter((c) => c === `GET /api/monthly-reports/${MONTH}`)).toHaveLength(2);
    visible.value = false;
    screen.onVisibilityChange();
    n.gate = null;
    gate.resolve();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(MONTHLY_REGEN_REQUESTED_NOTICE); // 応答は反映される
    expect(timers.pending()).toBe(0); // 非表示の間は次の確認を張らない
    visible.value = true;
    screen.onVisibilityChange();
    await timers.flush();
    expect(n.calls.filter((c) => c === `GET /api/monthly-reports/${MONTH}`)).toHaveLength(3);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("月を替える・画面を離れると、確認のタイマーと状態を捨てる(遅れて届く応答も反映しない)", async () => {
    const { n, screen, timers } = await open([ok({ report: reportJson(FIRST_AT) }), ok({ report: reportJson(FIRST_AT), job: RUNNING_REGEN })]);
    n.script[POST_URL] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(timers.pending()).toBe(1);
    screen.leave();
    expect(timers.pending()).toBe(0);
    n.script[`GET /api/monthly-reports/${MONTH}`] = [ok({ report: reportJson(FIRST_AT) })]; // 開き直したときの応答(ジョブなし)
    screen.enter(MONTH);
    await timers.flush();
    expect(screen.model().notice).toBeNull(); // 前の画面の『作り直し中』を持ち越さない
    expect(screen.model().regen).not.toBeNull();
  });
});
