import { describe, expect, it } from "vitest";
import { BUDGET_MS, FAST_INTERVAL_MS, FAST_POLLS, MAX_FAILURES, SLOW_INTERVAL_MS, createTracker, trackingMessage, type CycleResult, type TrackerDeps } from "../client/tracker";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #186 段階2: 追跡(ポーリング)の状態機械。偽のタイマー・偽の取得(cycle)・可視状態を注入する。
 * 守ること: 間隔(3 秒 × 10 回 → 5 秒)・タイマーは取得の完了後に張る(setInterval でない)・停止の条件(全部終わる・5 分・失敗 3 回連続)・
 * 非表示で止まり、表示で即時に 1 回取って再開(非表示の時間は 5 分に数えない)・世代(古い取得の完了が新しい状態を壊さない)。
 */

interface Harness {
  readonly timers: ReturnType<typeof createFakeTimers>;
  /** cycle の呼び出し時刻(偽の現在時刻)。 */
  readonly calls: number[];
  readonly tracker: ReturnType<typeof createTracker>;
  readonly changes: { count: number };
  visible: boolean;
  /** 次の cycle の結果(既定は成功・まだ実行中が 1 日分)。 */
  next: () => Promise<CycleResult>;
}

function harness(): Harness {
  const timers = createFakeTimers();
  const calls: number[] = [];
  const changes = { count: 0 };
  const h: Harness = {
    timers,
    calls,
    changes,
    visible: true,
    next: async () => ({ ok: true, remaining: 1 }),
    tracker: undefined as never,
  };
  const deps: TrackerDeps = {
    now: () => timers.now(),
    setTimer: (fn, ms) => timers.set(fn, ms),
    clearTimer: (handle) => timers.clear(handle),
    isVisible: () => h.visible,
    cycle: () => {
      calls.push(timers.now());
      return h.next();
    },
    onChange: () => void (changes.count += 1),
  };
  (h as { tracker: Harness["tracker"] }).tracker = createTracker(deps);
  return h;
}

describe("定数(ブリーフの値)", () => {
  it("3 秒 × 10 回 → 5 秒・5 分・失敗 3 回連続", () => {
    expect([FAST_INTERVAL_MS, FAST_POLLS, SLOW_INTERVAL_MS, BUDGET_MS, MAX_FAILURES]).toEqual([3000, 10, 5000, 300_000, 3]);
  });
});

describe("間隔", () => {
  it("開始(遅延)から 3 秒で最初の取得。10 回目まで 3 秒間隔、11 回目からは 5 秒間隔", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    expect(h.tracker.state()).toEqual({ kind: "running" });
    await h.timers.advance(2999);
    expect(h.calls).toEqual([]); // 前提: 3 秒たつまで取らない
    await h.timers.advance(1);
    expect(h.calls).toEqual([3000]);
    await h.timers.advance(200_000);
    expect(h.calls.slice(0, 10)).toEqual([3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000, 30000]); // 10 回は 3 秒間隔
    expect(h.calls.slice(10, 14)).toEqual([35000, 40000, 45000, 50000]); // 11 回目からは 5 秒間隔(10 回目の 5 秒後)
    expect(h.calls.length).toBeGreaterThanOrEqual(14);
  });

  it("即時の開始は、すぐ 1 回取る(これが 1 回目)。その後 3 秒間隔で、全部で 10 回目までが 3 秒間隔", async () => {
    const h = harness();
    h.tracker.begin({ immediate: true });
    await h.timers.flush();
    expect(h.calls).toEqual([0]);
    await h.timers.advance(40_000);
    expect(h.calls.slice(0, 10)).toEqual([0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000]);
    expect(h.calls.slice(10, 12)).toEqual([32000, 37000]); // 10 回目(27000)の 5 秒後
  });

  it("タイマーは取得の完了後に張る(取得が終わらない間は次の取得が出ない=setInterval でない)。完了から 3 秒後に次が出る", async () => {
    const h = harness();
    const gate = deferred<CycleResult>();
    h.next = () => gate.promise;
    h.tracker.begin({ immediate: false });
    await h.timers.advance(3000);
    expect(h.calls).toEqual([3000]);
    await h.timers.advance(60_000); // 取得が保留のまま 1 分
    expect(h.calls).toEqual([3000]);
    expect(h.timers.pending()).toBe(0); // 前提: 次のタイマーはまだ無い
    h.next = async () => ({ ok: true, remaining: 1 });
    gate.resolve({ ok: true, remaining: 1 });
    await h.timers.flush();
    expect(h.timers.nextIn()).toBe(3000); // 完了(63000)から 3 秒後
    await h.timers.advance(3000);
    expect(h.calls).toEqual([3000, 66000]);
  });

  it("開始を 2 回続けても、取得の連鎖は 1 本(世代で古いタイマーを捨てる)", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    h.tracker.begin({ immediate: false });
    expect(h.timers.pending()).toBe(1);
    await h.timers.advance(3000);
    expect(h.calls).toEqual([3000]);
    await h.timers.advance(3000);
    expect(h.calls).toEqual([3000, 6000]);
  });
});

describe("停止の条件", () => {
  it("全部終わった(cycle の remaining が 0)ら、idle に戻り、タイマーも残さない。通知(onChange)が出る", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    h.changes.count = 0;
    h.next = async () => ({ ok: true, remaining: 0 });
    await h.timers.advance(3000);
    expect(h.tracker.state()).toEqual({ kind: "idle" });
    expect(h.timers.pending()).toBe(0);
    expect(h.changes.count).toBeGreaterThanOrEqual(1);
    await h.timers.advance(60_000);
    expect(h.calls).toEqual([3000]);
  });

  it("失敗が 3 回続いたら停止(reason: failures)。2 回では止まらない。成功が挟まれば連続は数え直し", async () => {
    const h = harness();
    h.next = async () => ({ ok: false, remaining: 1 });
    h.tracker.begin({ immediate: false });
    await h.timers.advance(3000);
    await h.timers.advance(3000);
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 2 回の失敗では止まらない
    expect(h.calls).toHaveLength(2);
    await h.timers.advance(3000);
    expect(h.calls).toHaveLength(3);
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "failures" });
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(60_000);
    expect(h.calls).toHaveLength(3);

    const g = harness();
    const results = [false, false, true, false, false, true].map((ok) => ({ ok, remaining: 1 }));
    let i = 0;
    g.next = async () => results[i++] ?? { ok: true, remaining: 1 };
    g.tracker.begin({ immediate: false });
    await g.timers.advance(3000 * 6);
    expect(g.calls).toHaveLength(6);
    expect(g.tracker.state()).toEqual({ kind: "running" }); // 失敗は通算で 4 回あるが、連続は 2 回まで
  });

  it("cycle が例外で終わっても、失敗 1 回として数える(追跡が止まったまま固まらない)", async () => {
    const h = harness();
    h.next = async () => {
      throw new Error("boom");
    };
    h.tracker.begin({ immediate: false });
    await h.timers.advance(3000 * 3);
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "failures" });
  });

  it("5 分たつと停止(reason: timeout)。5 分より前に取った回数は 63 回(3 秒 × 10 回 + 5 秒間隔で 295 秒まで)で、5 分ちょうどには取らない", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    await h.timers.advance(299_999);
    expect(h.tracker.state()).toEqual({ kind: "running" });
    expect(h.calls).toHaveLength(10 + (295_000 - 30_000) / 5000);
    expect(h.calls[h.calls.length - 1]).toBe(295_000);
    await h.timers.advance(1);
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "timeout" });
    expect(h.calls).toHaveLength(63);
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(60_000);
    expect(h.calls).toHaveLength(63);
  });

  it("取得が長引いて 5 分を過ぎて終わったら、その場で停止する(次のタイマーを張らない)", async () => {
    const h = harness();
    h.tracker.begin({ immediate: true });
    await h.timers.advance(250_000);
    const gate = deferred<CycleResult>();
    h.next = () => gate.promise;
    await h.timers.advance(50_000); // 次の取得(保留)が出る
    await h.timers.advance(60_000); // 保留のまま、5 分を超える
    expect(h.tracker.state()).toEqual({ kind: "running" });
    gate.resolve({ ok: true, remaining: 1 });
    await h.timers.flush();
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "timeout" });
    expect(h.timers.pending()).toBe(0);
  });

  it("停止後の再開(即時の開始)は、予算を新しくする: すぐ 1 回取り、新しい 5 分の間は続く。失敗の連続も数え直す", async () => {
    const h = harness();
    h.next = async () => ({ ok: false, remaining: 1 });
    h.tracker.begin({ immediate: false });
    await h.timers.advance(9000);
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "failures" }); // 前提
    const before = h.calls.length;
    h.next = async () => ({ ok: true, remaining: 1 });
    h.tracker.begin({ immediate: true });
    await h.timers.flush();
    expect(h.tracker.state()).toEqual({ kind: "running" });
    expect(h.calls.length).toBe(before + 1); // すぐ 1 回
    await h.timers.advance(290_000);
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 古い開始から 5 分を過ぎていても、新しい予算で続く
    await h.timers.advance(20_000); // 新しい開始から 5 分を過ぎる(次のタイマーの時刻に確認されるので、余裕を見る)
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "timeout" });
    // 失敗の連続も数え直し(再開後の失敗 2 回では止まらない)
    const g = harness();
    g.next = async () => ({ ok: false, remaining: 1 });
    g.tracker.begin({ immediate: false });
    await g.timers.advance(9000);
    expect(g.tracker.state().kind).toBe("stopped");
    g.tracker.begin({ immediate: true });
    await g.timers.advance(3000);
    expect(g.tracker.state()).toEqual({ kind: "running" }); // 再開後の失敗は 2 回(即時 + 3 秒後)
  });
});

describe("世代(古い取得の完了が、新しい状態を壊さない)", () => {
  it("再開より前に出した取得が、再開の後に失敗で終わっても、失敗の連続に数えない・タイマーを張らない", async () => {
    const h = harness();
    const old = deferred<CycleResult>();
    h.next = () => old.promise;
    h.tracker.begin({ immediate: true }); // 取得 1(保留)
    await h.timers.flush();
    expect(h.calls).toHaveLength(1);
    h.next = async () => ({ ok: false, remaining: 1 });
    h.tracker.begin({ immediate: true }); // 世代を進めて取得 2(失敗)
    await h.timers.flush();
    expect(h.calls).toHaveLength(2);
    old.resolve({ ok: false, remaining: 1 }); // 古い取得が(失敗で)届く
    await h.timers.flush();
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 失敗は新しい世代の 1 回だけ(古いものを足して 2 回にならない)
    expect(h.timers.pending()).toBe(1); // 新しい世代のタイマー 1 本だけ(古い完了が張っていない)
    await h.timers.advance(3000);
    expect(h.calls).toHaveLength(3);
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 失敗は 2 回目(古い 1 回を足していれば、ここで 3 回=停止になる)
  });

  it("古い取得が「全部終わった(remaining 0)」で届いても、新しい世代を idle にしない", async () => {
    const h = harness();
    const old = deferred<CycleResult>();
    h.next = () => old.promise;
    h.tracker.begin({ immediate: true });
    await h.timers.flush();
    h.next = async () => ({ ok: true, remaining: 1 });
    h.tracker.begin({ immediate: true });
    await h.timers.flush();
    old.resolve({ ok: true, remaining: 0 });
    await h.timers.flush();
    expect(h.tracker.state()).toEqual({ kind: "running" });
    expect(h.timers.pending()).toBe(1);
  });
});

describe("可視状態(非表示で止まり、表示で即時に 1 回取って再開する)", () => {
  it("非表示にするとタイマーが無くなる。非表示の間は取らない。表示に戻ると即時に 1 回取り、その後も間隔で続く", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    await h.timers.advance(3000); // 取得 1
    expect(h.timers.pending()).toBe(1); // 前提: 次のタイマーが張られている
    h.visible = false;
    h.tracker.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 停止ではなく一時停止
    await h.timers.advance(120_000);
    expect(h.calls).toEqual([3000]);
    h.visible = true;
    h.tracker.onVisibilityChange();
    await h.timers.flush();
    expect(h.calls).toEqual([3000, 123_000]); // 即時に 1 回
    await h.timers.advance(3000);
    expect(h.calls).toEqual([3000, 123_000, 126_000]); // 再開(間隔は 3 回目まで 3 秒のまま)
  });

  it("非表示の間に届いた取得は処理するが、次のタイマーは張らない(表示で即時に再開するまで)", async () => {
    const h = harness();
    const gate = deferred<CycleResult>();
    h.next = () => gate.promise;
    h.tracker.begin({ immediate: false });
    await h.timers.advance(3000);
    h.visible = false;
    h.tracker.onVisibilityChange();
    h.next = async () => ({ ok: true, remaining: 1 });
    gate.resolve({ ok: true, remaining: 1 });
    await h.timers.flush();
    expect(h.timers.pending()).toBe(0);
    expect(h.tracker.state()).toEqual({ kind: "running" });
    h.visible = true;
    h.tracker.onVisibilityChange();
    await h.timers.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.timers.pending()).toBe(1);
  });

  it("非表示の時間は 5 分に数えない。表示に戻ってすぐ止まらず、見ていた時間の合計が 5 分になったところで止まる", async () => {
    const h = harness();
    h.tracker.begin({ immediate: false });
    await h.timers.advance(290_000); // 見ていた時間 290 秒
    expect(h.tracker.state()).toEqual({ kind: "running" });
    h.visible = false;
    h.tracker.onVisibilityChange();
    await h.timers.advance(3_600_000); // 1 時間、非表示
    expect(h.tracker.state()).toEqual({ kind: "running" });
    h.visible = true;
    h.tracker.onVisibilityChange();
    await h.timers.flush();
    expect(h.tracker.state()).toEqual({ kind: "running" }); // 実時間なら 5 分を超えている。数えないので止まらない
    await h.timers.advance(9999);
    expect(h.tracker.state()).toEqual({ kind: "running" });
    await h.timers.advance(1);
    expect(h.tracker.state()).toEqual({ kind: "stopped", reason: "timeout" }); // 見ていた時間が 300 秒に達した
  });

  it("非表示で開始したときは、取らずに待つ。表示になったら即時に 1 回取る", async () => {
    const h = harness();
    h.visible = false;
    h.tracker.begin({ immediate: true });
    await h.timers.advance(60_000);
    expect(h.calls).toEqual([]);
    expect(h.timers.pending()).toBe(0);
    expect(h.tracker.state()).toEqual({ kind: "running" });
    h.visible = true;
    h.tracker.onVisibilityChange();
    await h.timers.flush();
    expect(h.calls).toEqual([60_000]);
  });

  it("追跡していない(idle・stopped)ときの表示・非表示の変化は、何も起こさない。表示のままの(非表示を経ない)通知も何もしない", async () => {
    const idle = harness();
    idle.tracker.onVisibilityChange();
    idle.visible = false;
    idle.tracker.onVisibilityChange();
    idle.visible = true;
    idle.tracker.onVisibilityChange();
    await idle.timers.flush();
    expect(idle.calls).toEqual([]);
    expect(idle.timers.pending()).toBe(0);

    const stopped = harness();
    stopped.next = async () => ({ ok: false, remaining: 1 });
    stopped.tracker.begin({ immediate: false });
    await stopped.timers.advance(9000);
    expect(stopped.tracker.state().kind).toBe("stopped"); // 前提
    const n = stopped.calls.length;
    stopped.visible = false;
    stopped.tracker.onVisibilityChange();
    stopped.visible = true;
    stopped.tracker.onVisibilityChange();
    await stopped.timers.flush();
    expect(stopped.calls).toHaveLength(n);

    const running = harness();
    running.tracker.begin({ immediate: false });
    running.tracker.onVisibilityChange(); // 表示のままの通知(非表示を経ていない)
    await running.timers.flush();
    expect(running.calls).toEqual([]); // 余計な即時の取得をしない
    expect(running.timers.pending()).toBe(1);
  });
});

describe("停止の注記の文言", () => {
  it("理由ごとに異なる文言で、「状態を更新」を示す", () => {
    const timeout = trackingMessage("timeout");
    const failures = trackingMessage("failures");
    expect(timeout).not.toBe(failures);
    for (const m of [timeout, failures]) {
      expect(m).toContain("状態を更新");
    }
    expect(timeout).toContain("5分");
    expect(failures).toContain("通信");
  });
});
