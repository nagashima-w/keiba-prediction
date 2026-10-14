import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createMonthlyScreen, type MonthlyScreen } from "../client/monthly-screen";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #279(#265-A): 月報の画面の制御。取得・月の切替・更新。fetch は偽。
 * 守ること: 開くと一覧と本文だけを取る(他の API に出ない)/ 同じ月で重ねて呼んでも取得は増えない / 月が変わったら本文だけを取り直す / 古い応答は反映しない / 離れると状態を捨てる。
 */

const TODAY = "20261105";

type Reply = { status: number; body: unknown } | "throw";
const LIST_ROW = (month: string) => ({ month, created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null });

function statsJson(): Record<string, unknown> {
  return {
    raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
    refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0, maxPayout: 800, maxPayoutStake: 200,
    byBetType: {}, byMark: [], whatIf: null, fromDate: "20261001", toDate: "20261031", dayCount: 1,
    days: [{ date: "20261003", raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1, refundedBetCount: 0 }],
    byVersion: [],
  };
}
const detailJson = (month: string): Record<string, unknown> => ({
  month, created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null,
  body: { format: 1, month, stats: statsJson(), lastDayPending: false },
});

interface Net {
  readonly fetch: FetchLike;
  readonly calls: string[];
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

function setup() {
  const n = net();
  const timers = createFakeTimers();
  let changes = 0;
  const screen: MonthlyScreen = createMonthlyScreen({ fetch: n.fetch, timers, isVisible: () => true, today: () => TODAY, onChange: () => void (changes += 1) });
  return { n, timers, screen, changes: () => changes };
}

describe("開く", () => {
  it("一覧と、表示する月の本文だけを取る。届くと月報の本文(タイル・日ごとの行)が出る", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [LIST_ROW("202610"), LIST_ROW("202609")] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    screen.enter("202610");
    await timers.flush();
    expect([...n.calls].sort()).toEqual(["GET /api/monthly-reports", "GET /api/monthly-reports/202610"]);
    const m = screen.model();
    expect(m.shownLabel).toBe("2026年10月");
    expect(m.body!.heading).toBe("2026年10月の月報");
    expect(m.body!.dayRows).toHaveLength(1);
    expect(m.monthNav.prevHref).toBe("#report=202609");
    expect(m.loading).toBe(false);
  });

  it("取得の前は読み込み中。月報が無い月は notice を出す(本文なし)", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202607"] = [ok({ report: null })];
    expect(screen.model().loading).toBe(true); // enter の前
    screen.enter("202607");
    expect(screen.model().loading).toBe(true);
    await timers.flush();
    const m = screen.model();
    expect(m.loading).toBe(false);
    expect(m.body).toBeNull();
    expect(m.notice?.text).toContain("まだありません");
  });

  it("重ねて同じ月で呼んでも取得は増えない。月が変わったら本文だけを取り直す(一覧は取り直さない)", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [LIST_ROW("202610"), LIST_ROW("202609")] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    n.script["GET /api/monthly-reports/202609"] = [ok({ report: detailJson("202609") })];
    screen.enter("202610");
    await timers.flush();
    const before = n.calls.length;
    screen.enter("202610");
    await timers.flush();
    expect(n.calls.length).toBe(before);
    screen.enter("202609");
    await timers.flush();
    expect(n.calls.slice(before)).toEqual(["GET /api/monthly-reports/202609"]);
    expect(screen.model().shownLabel).toBe("2026年9月");
    expect(screen.model().body!.heading).toBe("2026年9月の月報");
  });

  it("一覧の取得が失敗しても、本文は出す。本文の取得が失敗したら固定の文言を出す(例外の文面を持ち込まない)", async () => {
    const a = setup();
    a.n.script["GET /api/monthly-reports"] = [{ status: 503, body: { ok: false, error: { type: "report-error" } } }];
    a.n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    a.screen.enter("202610");
    await a.timers.flush();
    expect(a.screen.model().error).toContain("サーバでエラー");
    expect(a.screen.model().body).not.toBeNull();
    const b = setup();
    b.n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    b.n.script["GET /api/monthly-reports/202610"] = ["throw"];
    b.screen.enter("202610");
    await b.timers.flush();
    expect(b.screen.model().error).toContain("通信に失敗");
    expect(JSON.stringify(b.screen.model())).not.toContain("network");
    expect(b.screen.model().body).toBeNull();
  });

  it("遅れて届いた古い応答は反映しない(月を替えたあと・離れたあと)", async () => {
    const { n, screen, timers } = setup();
    const slow = deferred<void>();
    n.gate["GET /api/monthly-reports/202610"] = slow.promise;
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    n.script["GET /api/monthly-reports/202609"] = [ok({ report: null })];
    screen.enter("202610");
    await timers.flush();
    screen.enter("202609"); // 202610 の応答が遅れている間に月を替える
    await timers.flush();
    slow.resolve();
    await timers.flush();
    expect(screen.model().shownLabel).toBe("2026年9月");
    expect(screen.model().body).toBeNull(); // 遅れて届いた 202610 の本文を出さない
    screen.leave();
    expect(screen.model().body).toBeNull();
  });

  it("一覧の応答が遅れている間に月を替えても、一覧は届いたら反映する(一覧は月に依らない)。離れたあとに届いたものは反映しない", async () => {
    const { n, screen, timers } = setup();
    const slow = deferred<void>();
    n.gate["GET /api/monthly-reports"] = slow.promise;
    n.script["GET /api/monthly-reports"] = [ok({ reports: [LIST_ROW("202610"), LIST_ROW("202609")] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    n.script["GET /api/monthly-reports/202609"] = [ok({ report: detailJson("202609") })];
    screen.enter("202610");
    await timers.flush();
    screen.enter("202609"); // 一覧がまだ届いていない間に月を替える
    await timers.flush();
    expect(screen.model().monthNav).toStrictEqual({ prevHref: null, nextHref: null, latestHref: null }); // 一覧は読み込み中
    slow.resolve();
    await timers.flush();
    expect(screen.model().monthNav.nextHref).toBe("#report=202610"); // 一覧が反映された
    // 離れたあとに届く一覧は反映しない
    const other = setup();
    const slow2 = deferred<void>();
    other.n.gate["GET /api/monthly-reports"] = slow2.promise;
    other.n.script["GET /api/monthly-reports"] = [ok({ reports: [LIST_ROW("202610")] })];
    other.n.script["GET /api/monthly-reports/202609"] = [ok({ report: null })];
    other.screen.enter("202609");
    await other.timers.flush();
    other.screen.leave();
    slow2.resolve();
    await other.timers.flush();
    expect(other.screen.model().monthNav).toStrictEqual({ prevHref: null, nextHref: null, latestHref: null });
    expect(other.screen.model().loading).toBe(true);
  });

  it("離れると状態を捨てる(読み込み中に戻る)。開き直せば取り直す", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    screen.enter("202610");
    await timers.flush();
    expect(screen.model().body).not.toBeNull();
    screen.leave();
    expect(screen.model().body).toBeNull();
    expect(screen.model().loading).toBe(true);
    const before = n.calls.length;
    screen.enter("202610");
    await timers.flush();
    expect(n.calls.length).toBe(before + 2);
    expect(screen.model().body).not.toBeNull();
  });
});

describe("更新", () => {
  it("一覧と本文を取り直す。取得中・開く前は無視する", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: null })];
    screen.onRefresh(); // 開く前: 何もしない
    expect(n.calls).toEqual([]);
    screen.enter("202610");
    screen.onRefresh(); // 取得中: 無視
    await timers.flush();
    const before = n.calls.length;
    expect(before).toBe(2);
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: detailJson("202610") })];
    screen.onRefresh();
    await timers.flush();
    expect(n.calls.length).toBe(before + 2);
    expect(screen.model().body).not.toBeNull();
  });

  it("pending() は取得中の約束を返す(テストの待ち用)。終われば空", async () => {
    const { n, screen, timers } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: null })];
    screen.enter("202610");
    expect(screen.pending().length).toBeGreaterThan(0);
    await timers.flush();
    expect(screen.pending()).toEqual([]);
  });

  it("onChange(再描画の要求)は取得の完了で呼ばれる", async () => {
    const { n, screen, timers, changes } = setup();
    n.script["GET /api/monthly-reports"] = [ok({ reports: [] })];
    n.script["GET /api/monthly-reports/202610"] = [ok({ report: null })];
    screen.enter("202610");
    const afterEnter = changes();
    await timers.flush();
    expect(changes()).toBeGreaterThan(afterEnter);
  });
});
