import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createReportScreen, REPORT_MAX_FAILURES, REPORT_MAX_POLLS, REPORT_POLL_MS, type ReportScreen } from "../client/report-screen";
import { buildSavedRecord } from "./daily-report-fixtures";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #235: 日報画面の制御。取得・日付の切替・手動の作成の依頼・作成中のポーリング。fetch・タイマーは偽。
 * 守ること: 開くと一覧と本文だけを取る / 日付の指定が無ければ最新の日報の日(無ければ今日)を出す / 古い応答は反映しない / 作成中だけ自動で取り直し、離れると止まる。
 */

const TODAY = "20261010";

type Reply = { status: number; body: unknown } | "throw";
const LIST_ROW = (date: string) => ({ date, created_at: "2026-10-10T11:00:00.000Z", model: null, race_count: 2, total_stake: 100, total_return: 0, summary: null });

async function reportJson(date: string): Promise<Record<string, unknown>> {
  const record = await buildSavedRecord();
  return { date, created_at: record.createdAt, model: record.model, race_count: record.raceCount, total_stake: record.totalStake, total_return: record.totalReturn, summary: record.summary, body: record.body };
}

interface Net {
  readonly fetch: FetchLike;
  readonly calls: string[];
  /** パスごとの応答(先頭から消費。尽きたら最後の応答を繰り返す)。 */
  script: Record<string, Reply[]>;
  gate: Record<string, Promise<void>>;
}

function net(): Net {
  const n: Net = {
    calls: [],
    script: {},
    gate: {},
    fetch: async (url, init) => {
      const key = `${init.method} ${url}`;
      n.calls.push(key);
      const gate = n.gate[key];
      if (gate !== undefined) await gate;
      const queue = n.script[key];
      if (queue === undefined || queue.length === 0) throw new Error(`応答の指定が無い: ${key}`);
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (reply === "throw") throw new Error("network");
      return { status: reply.status, json: async () => reply.body };
    },
  };
  return n;
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } });

function setup(visible = { value: true }) {
  const n = net();
  const timers = createFakeTimers();
  let changes = 0;
  const screen: ReportScreen = createReportScreen({ fetch: n.fetch, timers, isVisible: () => visible.value, today: () => TODAY, onChange: () => void (changes += 1) });
  return { n, timers, screen, visible, changes: () => changes };
}

describe("開く", () => {
  it("日付の指定が無ければ、一覧が届いたあと最新の日報の日を出す。取るのは一覧と本文だけ", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [LIST_ROW("20261009"), LIST_ROW("20261008")] })];
    n.script["GET /api/reports/20261010"] = [ok({ report: null, job: null })];
    n.script["GET /api/reports/20261009"] = [ok({ report: await reportJson("20261009"), job: null })];
    screen.enter(null);
    await timers.flush();
    expect(screen.model().shownLabel).toBe("2026年10月9日(金)");
    expect(screen.model().body!.heading).toBe("2026年10月9日(金)の日報");
    expect(n.calls.every((c) => c.startsWith("GET /api/reports"))).toBe(true);
    expect(n.calls).toContain("GET /api/reports/20261009");
  });

  it("日報が 1 件も無ければ今日を出し、作成のボタンが出る", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script["GET /api/reports/20261010"] = [ok({ report: null, job: null })];
    screen.enter(null);
    await timers.flush();
    const m = screen.model();
    expect(m.shownLabel).toBe("2026年10月10日(土)");
    expect(m.create).not.toBeNull();
    expect(m.body).toBeNull();
  });

  it("日付の指定があれば、その日の本文を取る(最新の日には切り替えない)", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [LIST_ROW("20261009")] })];
    n.script["GET /api/reports/20261005"] = [ok({ report: null, job: null })];
    screen.enter("20261005");
    await timers.flush();
    expect(screen.model().shownLabel).toBe("2026年10月5日(月)");
    expect(n.calls).not.toContain("GET /api/reports/20261009");
  });

  it("重ねて同じ指定で呼んでも取得は増えない。日付が変わったら本文だけを取り直す(一覧は取り直さない)", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [LIST_ROW("20261009")] })];
    n.script["GET /api/reports/20261009"] = [ok({ report: null, job: null })];
    n.script["GET /api/reports/20261008"] = [ok({ report: null, job: null })];
    screen.enter("20261009");
    await timers.flush();
    const before = n.calls.length;
    screen.enter("20261009");
    await timers.flush();
    expect(n.calls.length).toBe(before);
    screen.enter("20261008");
    await timers.flush();
    expect(n.calls.slice(before)).toEqual(["GET /api/reports/20261008"]);
    expect(screen.model().shownLabel).toBe("2026年10月8日(木)");
  });

  it("一覧の取得が失敗しても、本文は出す。本文の取得が失敗したら固定の文言を出す", async () => {
    const a = setup();
    a.n.script["GET /api/reports"] = [{ status: 503, body: { ok: false, error: { type: "report-error" } } }];
    a.n.script["GET /api/reports/20261010"] = [ok({ report: null, job: null })];
    a.screen.enter("20261010");
    await a.timers.flush();
    expect(a.screen.model().error).toContain("サーバでエラー");
    expect(a.screen.model().create).not.toBeNull();
    const b = setup();
    b.n.script["GET /api/reports"] = [ok({ reports: [] })];
    b.n.script["GET /api/reports/20261010"] = ["throw"];
    b.screen.enter("20261010");
    await b.timers.flush();
    expect(b.screen.model().error).toContain("通信に失敗");
    expect(JSON.stringify(b.screen.model())).not.toContain("network");
  });

  it("遅れて届いた古い応答は反映しない(日付を替えたあと・離れたあと)", async () => {
    const { n, screen, timers } = setup();
    const slow = deferred<void>();
    n.gate["GET /api/reports/20261009"] = slow.promise;
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script["GET /api/reports/20261009"] = [ok({ report: await reportJson("20261009"), job: null })];
    n.script["GET /api/reports/20261008"] = [ok({ report: null, job: null })];
    screen.enter("20261009");
    await timers.flush();
    screen.enter("20261008");
    await timers.flush();
    slow.resolve();
    await timers.flush();
    expect(screen.model().shownLabel).toBe("2026年10月8日(木)");
    expect(screen.model().body).toBeNull(); // 9 日の本文が 8 日の画面に出ない
    screen.leave();
    expect(screen.pending()).toHaveLength(0);
  });
});

describe("手動の作成と作成中のポーリング", () => {
  /** 一覧が空で、今日の本文の応答を先に決めてから開く(開いた時点で取得が始まるため)。 */
  async function openEmptyDay(detail: Reply[] = [ok({ report: null, job: null })], post?: Reply[]) {
    const s = setup();
    s.n.script["GET /api/reports"] = [ok({ reports: [] })];
    s.n.script["GET /api/reports/20261010"] = detail;
    if (post !== undefined) s.n.script["POST /api/reports/run"] = post;
    s.screen.enter("20261010");
    await s.timers.flush();
    return s;
  }

  it("ボタンで POST し、受け付けられたら作成中の表示にして、REPORT_POLL_MS ごとに本文を取り直す。日報が現れたら止まり、一覧も取り直す", async () => {
    const { n, screen, timers } = await openEmptyDay(
      [ok({ report: null, job: null }), ok({ report: null, job: { phase: "gather", status: "running", attempts: 0 } }), ok({ report: await reportJson("20261010"), job: null })],
      [{ status: 202, body: { ok: true, accepted: true, date: "20261010" } }],
    );
    expect(screen.model().create).not.toBeNull();
    screen.onRun();
    await timers.flush();
    expect(n.calls).toContain("POST /api/reports/run");
    expect(screen.model().notice!.text).toContain("作成");
    expect(screen.model().create).toBeNull();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    n.script["GET /api/reports"] = [ok({ reports: [LIST_ROW("20261010")] })];
    expect(screen.model().body).toBeNull(); // 依頼の直後の確認では、まだ作成中
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().body).not.toBeNull();
    expect(timers.pending()).toBe(0);
    expect(n.calls.filter((c) => c === "GET /api/reports").length).toBe(2); // 開いたときと、日報が現れたあと
  });

  it("R1: 分析が 0 件の日: 依頼が受け付けられても日報も進行状況も無ければ、作られずに終わった案内を出して確認を止める(10 分待たせない)", async () => {
    const { n, screen, timers } = await openEmptyDay([ok({ report: null, job: null })], [{ status: 202, body: { ok: true, accepted: true, date: "20261010" } }]);
    screen.onRun();
    await timers.flush();
    const m = screen.model();
    expect(m.notice!.text).toContain("分析したレースが無いため、日報は作られませんでした");
    expect(m.create).toBeNull();
    expect(timers.pending()).toBe(0); // 確認の自動更新は張られない
    const before = n.calls.length;
    await timers.advance(REPORT_POLL_MS * 5);
    expect(n.calls.length).toBe(before);
    // 更新ボタンで状態を戻し、もう一度依頼できる
    screen.onRefresh();
    await timers.flush();
    expect(screen.model().create).not.toBeNull();
  });

  it("押した直後に二重に POST しない(依頼中・作成中)", async () => {
    const { n, screen, timers } = await openEmptyDay([ok({ report: null, job: null })], [{ status: 202, body: { ok: true, accepted: true, date: "20261010" } }]);
    const hold = deferred<void>();
    n.gate["POST /api/reports/run"] = hold.promise;
    screen.onRun();
    screen.onRun();
    hold.resolve();
    await timers.flush();
    screen.onRun();
    await timers.flush();
    expect(n.calls.filter((c) => c === "POST /api/reports/run")).toHaveLength(1);
  });

  it("依頼の失敗は固定の文言を出し、ボタンは残る(もう一度押せる)。作成済みの断り(409)は本文を取り直す", async () => {
    const a = await openEmptyDay([ok({ report: null, job: null })], [{ status: 503, body: { ok: false, error: { type: "report-error" } } }]);
    a.screen.onRun();
    await a.timers.flush();
    expect(a.screen.model().notice!.tone).toBe("error");
    expect(a.screen.model().create).not.toBeNull();
    const b = await openEmptyDay([ok({ report: null, job: null }), ok({ report: await reportJson("20261010"), job: null })], [{ status: 409, body: { ok: false, error: { type: "already-exists" } } }]);
    b.screen.onRun();
    await b.timers.flush();
    expect(b.screen.model().body).not.toBeNull();
  });

  it("サーバの job が running の日を開いたときも、自動で取り直す。作成が failed になったら止まる", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script["GET /api/reports/20261010"] = [ok({ report: null, job: { phase: "generate", status: "running", attempts: 0 } }), ok({ report: null, job: { phase: "save", status: "failed", attempts: 3 } })];
    screen.enter("20261010");
    await timers.flush();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(timers.pending()).toBe(0);
    expect(screen.model().notice!.tone).toBe("error");
  });

  it(`取得の失敗が ${REPORT_MAX_FAILURES} 回続いたら止める。上限(${REPORT_MAX_POLLS} 回)でも止める`, async () => {
    const a = setup();
    a.n.script["GET /api/reports"] = [ok({ reports: [] })];
    a.n.script["GET /api/reports/20261010"] = [ok({ report: null, job: { phase: "gather", status: "running", attempts: 0 } }), "throw"];
    a.screen.enter("20261010");
    await a.timers.flush();
    for (let i = 0; i < REPORT_MAX_FAILURES + 2; i += 1) await a.timers.advance(REPORT_POLL_MS);
    expect(a.timers.pending()).toBe(0);
    expect(a.n.calls.filter((c) => c === "GET /api/reports/20261010").length).toBe(1 + REPORT_MAX_FAILURES);
    expect(a.screen.model().notice!.text).toContain("自動更新を止めました");

    const b = setup();
    b.n.script["GET /api/reports"] = [ok({ reports: [] })];
    b.n.script["GET /api/reports/20261010"] = [ok({ report: null, job: { phase: "gather", status: "running", attempts: 0 } })];
    b.screen.enter("20261010");
    await b.timers.flush();
    for (let i = 0; i < REPORT_MAX_POLLS + 5; i += 1) await b.timers.advance(REPORT_POLL_MS);
    expect(b.n.calls.filter((c) => c === "GET /api/reports/20261010").length).toBe(1 + REPORT_MAX_POLLS);
    expect(b.timers.pending()).toBe(0);
  });

  it("離れるとタイマーが止まり、状態が捨てられる。非表示の間は止め、表示に戻ったら(作成中なら)即時に 1 回取る", async () => {
    const vis = { value: true };
    const { n, screen, timers } = setup(vis);
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script["GET /api/reports/20261010"] = [ok({ report: null, job: { phase: "gather", status: "running", attempts: 0 } })];
    screen.enter("20261010");
    await timers.flush();
    expect(timers.pending()).toBe(1);
    vis.value = false;
    screen.onVisibilityChange();
    expect(timers.pending()).toBe(0);
    const before = n.calls.length;
    vis.value = true;
    screen.onVisibilityChange();
    await timers.flush();
    expect(n.calls.length).toBe(before + 1);
    screen.leave();
    expect(timers.pending()).toBe(0);
    expect(screen.model().body).toBeNull();
    expect(screen.model().loading).toBe(true); // 状態が捨てられている
  });

  it("更新ボタン: 一覧と本文を取り直す。取得中は無視する", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script["GET /api/reports/20261010"] = [ok({ report: null, job: null })];
    screen.enter("20261010");
    await timers.flush();
    const before = n.calls.length;
    screen.onRefresh();
    screen.onRefresh(); // 取得中(2 回目は無視)
    await timers.flush();
    expect(n.calls.length - before).toBe(2);
  });
});

describe("Issue #238: 閲覧者(readOnly)は日報を作成しない(POST /api/reports/run を出さない)", () => {
  it("readOnly の画面で onRun を呼んでも POST は出ない。対照: 同じ状態で管理者の onRun は POST を出す", async () => {
    for (const readOnly of [false, true]) {
      const n = net();
      const timers = createFakeTimers();
      const screen = createReportScreen({ fetch: n.fetch, timers, isVisible: () => true, today: () => TODAY, onChange: () => {}, readOnly });
      n.script["GET /api/reports"] = [ok({ reports: [] })];
      n.script["GET /api/reports/20261010"] = [ok({ report: null, job: null })];
      n.script["POST /api/reports/run"] = [{ status: 202, body: { ok: true, accepted: true, date: TODAY } }];
      screen.enter("20261010");
      await timers.flush();
      expect(screen.model().body, "前提: 日報の無い日の画面が開いている").toBeNull();
      expect(screen.model().create === null, `作成のボタン readOnly=${readOnly}`).toBe(readOnly);
      screen.onRun();
      await timers.flush();
      expect(n.calls.includes("POST /api/reports/run"), `POST readOnly=${readOnly}`).toBe(!readOnly);
    }
  });
});
