import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createTargetsScreen, TARGETS_MAX_POLLS, TARGETS_POLL_MS, TARGETS_TICK_MS, type TargetsScreen } from "../client/targets-screen";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #336 段階 B: 今日の狙い目の画面の制御(取得・時計の更新・取り直し)。偽のタイマー・偽の fetch。
 * 守ること(ユーザー決定): 取り直しは 3 分ごと・画面が見えている間だけ・発走前のレースも結果待ちの行(Issue #361。収支の途中経過)も残っていなければ止める(まだ 1 件も分析されていない間は続ける)・回数に上限。残り時間は取得なしで 30 秒ごとに再描画する。
 */

const BASE = Date.parse("2026-10-17T05:00:00Z");
const MIN = 60_000;
const TODAY = "20261017";

type Row = Record<string, unknown>;
const raceRow = (id: string, startMs: number | null): Row => ({ race_id: id, analysis_id: Number(id.slice(-4)), start_ms: startMs, start_time: startMs === null ? null : "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時" });

interface Harness {
  readonly screen: TargetsScreen;
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly calls: string[];
  readonly changes: { count: number };
  visible: boolean;
  today: string;
  /** 次以降の応答を作る関数(呼ばれた時刻の偽の現在時刻を渡す)。 */
  respond: (nowMs: number) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** サーバの時計の進み(端末より何ミリ秒進んでいるか)。 */
  skewMs: number;
  rows: Row[];
}

function harness(): Harness {
  const timers = createFakeTimers();
  const calls: string[] = [];
  const changes = { count: 0 };
  const h: Harness = {
    screen: undefined as never,
    timers,
    calls,
    changes,
    visible: true,
    today: TODAY,
    skewMs: 0,
    rows: [],
    respond: async (nowMs) => ({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: nowMs + h.skewMs, summary: "要約", races: h.rows }) }),
  };
  const now = (): number => BASE + timers.now();
  const fetchLike: FetchLike = async (url) => {
    calls.push(url);
    return h.respond(now());
  };
  (h as { screen: TargetsScreen }).screen = createTargetsScreen({
    fetch: fetchLike,
    now,
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => h.visible,
    today: () => h.today,
    onChange: () => {
      changes.count += 1;
    },
  });
  return h;
}

const url = (date: string): string => `/api/targets?kaisai_date=${date}`;

describe("開く", () => {
  it("enter で GET /api/targets を 1 回だけ取る。最初は読み込み中で、届くと一覧になる。同じ日を重ねて enter しても取得は増えない", async () => {
    const h = harness();
    h.rows = [raceRow("202605050811", BASE + 30 * MIN)];
    h.screen.enter(TODAY);
    expect(h.screen.model()).toMatchObject({ loading: true, summary: null, upcoming: [] });
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
    expect(h.calls).toEqual([url(TODAY)]);
    expect(h.screen.model()).toMatchObject({ loading: false, summary: "要約", error: null });
    expect(h.screen.model()!.upcoming.map((r) => r.left)).toEqual(["あと30分"]);
  });

  it("画面に居ないとき model は null", () => {
    expect(harness().screen.model()).toBeNull();
  });

  it("別の日で enter し直すと取り直し、前の日の遅れて届く応答は反映しない", async () => {
    const h = harness();
    const slow = deferred<{ status: number; json: () => Promise<unknown> }>();
    h.respond = () => slow.promise;
    h.screen.enter("20261016");
    const first = [...h.screen.pending()];
    h.respond = async (nowMs) => ({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: nowMs, summary: "今日", races: [] }) });
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending().filter((p) => !first.includes(p)));
    slow.resolve({ status: 200, json: async () => ({ ok: true, kaisai_date: "20261016", now_ms: BASE, summary: "昨日", races: [] }) });
    await Promise.all(first);
    await h.timers.flush();
    expect(h.calls).toEqual([url("20261016"), url(TODAY)]);
    expect(h.screen.model()!.summary).toBe("今日");
  });
});

describe("残り時間の再描画(取得なし)", () => {
  it("30 秒ごとに onChange が呼ばれ、取得は増えない。時計が進むと残り時間が減る", async () => {
    const h = harness();
    h.rows = [raceRow("202605050811", BASE + 30 * MIN)];
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
    const before = h.changes.count;
    await h.timers.advance(TARGETS_TICK_MS);
    expect(h.changes.count).toBe(before + 1);
    await h.timers.advance(3 * MIN);
    expect(h.screen.model()!.upcoming[0]!.left).toBe("あと26分");
    expect(h.calls).toHaveLength(2); // 3 分(180 秒)の時点で取り直した 1 回 + 最初の 1 回
  });
});

describe("取り直し(3 分ごと・見えている間だけ・発走前が残っている間だけ・回数の上限)", () => {
  async function started(h: Harness, rows: Row[]): Promise<void> {
    h.rows = rows;
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
  }

  it("3 分たつまで取り直さず、3 分で 1 回取り直す(取得の周期は定数 TARGETS_POLL_MS)", async () => {
    expect(TARGETS_POLL_MS).toBe(3 * MIN);
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 120 * MIN)]);
    await h.timers.advance(TARGETS_POLL_MS - TARGETS_TICK_MS);
    expect(h.calls).toHaveLength(1);
    await h.timers.advance(TARGETS_TICK_MS);
    expect(h.calls).toHaveLength(2);
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.calls).toHaveLength(3);
  });

  it("画面が見えていない間は取り直さない・タイマーも張らない。見えるようになったとき、最後の取得から 1 分以上たっていれば取り直す", async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 600 * MIN)]);
    h.visible = false;
    h.screen.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(20 * MIN);
    expect(h.calls).toHaveLength(1);
    h.visible = true;
    h.screen.onVisibilityChange();
    await Promise.all(h.screen.pending());
    expect(h.calls).toHaveLength(2);
    expect(h.timers.pending()).toBe(1); // 再開した
  });

  it("見えるようになったとき、最後の取得から 1 分未満なら取り直さず、再描画だけ行う", async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 600 * MIN)]);
    await h.timers.advance(30_000);
    h.visible = false;
    h.screen.onVisibilityChange();
    await h.timers.advance(10_000);
    h.visible = true;
    const before = h.changes.count;
    h.screen.onVisibilityChange();
    expect(h.calls).toHaveLength(1);
    expect(h.changes.count).toBe(before + 1);
  });

  it("発走前のレースが残っていなければ(すべて発走済み)取り直さない", async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE - 30 * MIN), raceRow("202605050812", BASE - 5 * MIN)]);
    await h.timers.advance(30 * MIN);
    expect(h.calls).toHaveLength(1);
  });

  it("最後の発走前のレースが発走すると、次の周期から取り直さない。「更新」で再開する", async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 2 * MIN)]);
    await h.timers.advance(10 * MIN);
    expect(h.calls).toHaveLength(1); // 3 分の時点では、もう発走済み
    h.rows = [raceRow("202605050811", BASE + 2 * MIN), raceRow("202605050813", BASE + 90 * MIN)];
    h.screen.onRefresh();
    await Promise.all(h.screen.pending());
    expect(h.calls).toHaveLength(2);
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.calls).toHaveLength(3); // 新しい発走前のレースがあるので再開した
  });

  it("すべて発走済みでも、結果待ち(pending・pending_payout)の行が残るあいだは取り直しを続ける。結果待ちが無くなったら止まる(Issue #361)", async () => {
    const h = harness();
    const waiting = (state: string): Row => ({ ...raceRow("202605050811", BASE - 30 * MIN), result_state: state, result: "結果待ち" });
    for (const state of ["pending", "pending_payout"]) {
      h.calls.length = 0;
      h.rows = [waiting(state)];
      h.screen.leave();
      await started(h, h.rows);
      await h.timers.advance(TARGETS_POLL_MS);
      expect(h.calls, state).toHaveLength(2); // 3 分で取り直した
    }
    // 結果が確定したら、次の周期から止まる
    h.rows = [{ ...raceRow("202605050811", BASE - 30 * MIN), result_state: "settled", result: "的中 +1,200円" }];
    await h.timers.advance(TARGETS_POLL_MS);
    const settledCalls = h.calls.length;
    await h.timers.advance(TARGETS_POLL_MS * 5);
    expect(h.calls).toHaveLength(settledCalls);
  });

  it("結果待ちが他の状態(結果なし・確定・集計対象外・提案なし)なら、すべて発走済みで取り直さない", async () => {
    const h = harness();
    const rows = ["settled", "none", "excluded", "no_proposal"].map((state, i) => ({ ...raceRow(`20260505081${i}`, BASE - 30 * MIN), result_state: state, result: "x" }));
    await started(h, rows);
    await h.timers.advance(TARGETS_POLL_MS * 3);
    expect(h.calls).toHaveLength(1);
  });

  it("まだ 1 件も分析されていない朝(races が空)は、取り直しを続ける(これから増える)", async () => {
    const h = harness();
    await started(h, []);
    await h.timers.advance(TARGETS_POLL_MS * 2);
    expect(h.calls).toHaveLength(3);
  });

  it("開催日が今日でなければ(過去・未来の日)、取り直さない", async () => {
    const h = harness();
    h.today = "20261018";
    await started(h, [raceRow("202605050811", BASE + 600 * MIN)]);
    await h.timers.advance(30 * MIN);
    expect(h.calls).toHaveLength(1);
    expect(h.screen.model()!.upcoming).toHaveLength(1); // 前提: 発走前のレースが残っている(止まった理由は日付)
  });

  it("開催日が今日でなければ、画面が見えるようになっても取り直さない(再描画だけ)", async () => {
    const h = harness();
    h.today = "20261018";
    await started(h, [raceRow("202605050811", BASE + 600 * MIN)]);
    h.visible = false;
    h.screen.onVisibilityChange();
    await h.timers.advance(20 * MIN);
    h.visible = true;
    const before = h.changes.count;
    h.screen.onVisibilityChange();
    await h.timers.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.changes.count).toBe(before + 1);
    expect(h.timers.pending()).toBe(1); // 再描画のタイマーは再開する
    // 対照: 今日なら、同じ手順で取り直す(上の「取り直さない」が日付によることを確かめる)
    h.today = TODAY;
    h.visible = false;
    h.screen.onVisibilityChange();
    h.visible = true;
    h.screen.onVisibilityChange();
    await Promise.all(h.screen.pending());
    expect(h.calls).toHaveLength(2);
  });

  it(`取り直しの回数に上限がある(TARGETS_MAX_POLLS = ${TARGETS_MAX_POLLS} 回)`, async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 100_000 * MIN)]);
    for (let i = 0; i < TARGETS_MAX_POLLS + 5; i += 1) {
      await h.timers.advance(TARGETS_POLL_MS);
    }
    expect(h.calls).toHaveLength(1 + TARGETS_MAX_POLLS);
  });

  it("「更新」は上限の数を数え直す(手動の取得は上限に数えず、回数を 0 に戻す)", async () => {
    const h = harness();
    await started(h, [raceRow("202605050811", BASE + 100_000 * MIN)]);
    for (let i = 0; i < TARGETS_MAX_POLLS + 2; i += 1) await h.timers.advance(TARGETS_POLL_MS);
    const stopped = h.calls.length;
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.calls).toHaveLength(stopped); // 前提: 上限で止まっている
    h.screen.onRefresh();
    await Promise.all(h.screen.pending());
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.calls).toHaveLength(stopped + 2);
  });
});

describe("失敗", () => {
  it("最初の取得の失敗はエラー表示(固定の文言)。「更新」で取り直せる", async () => {
    const h = harness();
    h.respond = async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "d1-error" } }) });
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
    expect(h.screen.model()!.error).toContain("サーバでエラー");
    expect(h.screen.model()!.summary).toBeNull();
    h.respond = async (nowMs) => ({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: nowMs, summary: "要約", races: [] }) });
    h.screen.onRefresh();
    await Promise.all(h.screen.pending());
    expect(h.screen.model()).toMatchObject({ error: null, summary: "要約" });
  });

  it("取り直しの失敗は前の表示を残す(エラーの注記だけ出る)。成功するとエラーは消える。3 回続けて失敗したら止める", async () => {
    const h = harness();
    h.rows = [raceRow("202605050811", BASE + 100_000 * MIN)];
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
    h.respond = async () => {
      throw new Error("offline");
    };
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.screen.model()!.error).not.toBeNull();
    expect(h.screen.model()!.upcoming).toHaveLength(1); // 前の表示が残る
    await h.timers.advance(TARGETS_POLL_MS * 3);
    expect(h.calls).toHaveLength(1 + 3); // 失敗は 3 回で止まる
    h.respond = async (nowMs) => ({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: nowMs, summary: "回復", races: h.rows }) });
    h.screen.onRefresh();
    await Promise.all(h.screen.pending());
    expect(h.screen.model()).toMatchObject({ error: null, summary: "回復" });
  });

  it("取得中の「更新」は無視する(同じものを同時に 2 本取らない)", async () => {
    const h = harness();
    const slow = deferred<{ status: number; json: () => Promise<unknown> }>();
    h.respond = () => slow.promise;
    h.screen.enter(TODAY);
    h.screen.onRefresh();
    h.screen.onRefresh();
    expect(h.calls).toHaveLength(1);
    slow.resolve({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: BASE, summary: "x", races: [] }) });
    await Promise.all(h.screen.pending());
  });
});

describe("離れる・時計のずれ", () => {
  it("leave でタイマーが無くなり、遅れて届く応答は反映せず、model は null", async () => {
    const h = harness();
    const slow = deferred<{ status: number; json: () => Promise<unknown> }>();
    h.respond = () => slow.promise;
    h.screen.enter(TODAY);
    const inflight = [...h.screen.pending()];
    h.screen.leave();
    expect(h.timers.pending()).toBe(0);
    const before = h.changes.count;
    slow.resolve({ status: 200, json: async () => ({ ok: true, kaisai_date: TODAY, now_ms: BASE, summary: "遅れて", races: [] }) });
    await Promise.all(inflight);
    await h.timers.flush();
    expect(h.screen.model()).toBeNull();
    expect(h.changes.count).toBe(before);
    expect(h.timers.pending()).toBe(0);
  });

  it("端末の時計がサーバより 5 分遅れていても、サーバの時刻で補正した「今」で残りを出す", async () => {
    const h = harness();
    h.skewMs = 5 * MIN; // サーバは端末より 5 分進んでいる
    h.rows = [raceRow("202605050811", BASE + 5 * MIN + 12 * MIN)]; // サーバの時計で 12 分後
    h.screen.enter(TODAY);
    await Promise.all(h.screen.pending());
    expect(h.screen.model()!.upcoming[0]!.left).toBe("あと12分");
    await h.timers.advance(2 * MIN);
    expect(h.screen.model()!.upcoming[0]!.left).toBe("あと10分");
  });
});
