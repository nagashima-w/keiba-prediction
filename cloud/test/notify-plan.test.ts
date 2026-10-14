import { describe, expect, it } from "vitest";

import type { AutoRunOutcome } from "../src/auto-run-result";
import {
  FAILURE_COOLDOWN_MS,
  notifyKindFor,
  planNotifications,
  SEND_SPACING_MS,
  SUMMARY_INSURANCE_MS,
  summaryEligibility,
  type NotifyRowState,
  type PlanNotificationsInput,
} from "../src/notify-plan";
import type { AutoRunResults, PlanProgress } from "../src/race-day-core";

/**
 * Issue #205(#166-D) G-D2: 通知の計画(純関数)。「いま何を送るか(sendNow)」と「次にアラームを張る時刻(nextAtMs)」を、同じ関数が同じ状態から返す。
 * 不変条件: I1 nextAtMs ≤ now なら sendNow がある / I2 webhook が無効なら両方 null / I3 送り終えた(sending・sent・failed)ものは候補にならない
 * (実行すると状態が変わる、I4 は race-day-notify.test.ts の fuzz が実際の実行で固定する)。
 */

const NOW = 1_000_000_000;
const MIN = 60_000;

type Result = AutoRunResults["results"][number];
const result = (raceId: string, outcome: AutoRunOutcome, over: Partial<Result> = {}): Result => ({
  raceId,
  venue: "central",
  venueName: "中山",
  raceNumber: 1,
  raceName: "R",
  grade: null,
  startTime: "10:00",
  dueMs: NOW - MIN,
  outcome,
  ...over,
});

const FIN = NOW - 30 * MIN;
function progress(over: Partial<PlanProgress> = {}): PlanProgress {
  return {
    stage: "done",
    requestedAt: FIN - MIN,
    finalizedAt: FIN,
    offsetMinutes: 45,
    offsetSource: "settings",
    venues: [
      { venue: "central", state: "ok", attempts: 1, reason: null, listed: 12, targeted: 12 },
      { venue: "nar", state: "ok", attempts: 1, reason: null, listed: 0, targeted: 0 },
    ],
    rows: [
      { raceId: "r1", venue: "central", venueName: "中山", raceNumber: 1, raceName: "R", grade: null, startTime: "10:00", dueMs: 1, disposition: "scheduled", skipReason: null, state: "promoted", morning: "queued" },
    ],
    morningAllTerminal: false,
    ...over,
  };
}

const input = (over: Partial<PlanNotificationsInput> = {}): PlanNotificationsInput => ({
  enabled: true,
  nowMs: NOW,
  auto: { stage: "done", finalizedAt: FIN, results: [] },
  // 既定は「対象 0 件で、取得に失敗した会場も無い日」(事前分析のまとめの資格が無い)。まとめを見るテストは、自分で progress を渡す。
  progress: progress({ rows: [] }),
  rows: new Map(),
  paceUntilMs: 0,
  ...over,
});
const withResults = (...results: Result[]): AutoRunResults => ({ stage: "done", finalizedAt: FIN, results });

describe("notifyKindFor(結果 → 送る通知の種類。G-D3 の表)", () => {
  const cases: readonly { name: string; r: Result; expected: ReturnType<typeof notifyKindFor> }[] = [
    { name: "failed(started)→ 赤", r: result("a", { kind: "failed", reason: "started", message: null }), expected: "failed" },
    { name: "failed(blocked)→ 赤", r: result("a", { kind: "failed", reason: "blocked", message: null }), expected: "failed" },
    { name: "failed(fetch-exhausted)→ 赤", r: result("a", { kind: "failed", reason: "fetch-exhausted", message: null }), expected: "failed" },
    { name: "failed(compute-exhausted)→ 赤", r: result("a", { kind: "failed", reason: "compute-exhausted", message: null }), expected: "failed" },
    { name: "failed(unknown)→ 赤(読めなかった失敗も黙らない)", r: result("a", { kind: "failed", reason: "unknown", message: null }), expected: "failed" },
    { name: "昇格の時点の skipped(started)→ 赤", r: result("a", { kind: "skipped", reason: "started" }, { dueMs: 5 }), expected: "failed" },
    { name: "昇格の時点の skipped(cap)→ 赤", r: result("a", { kind: "skipped", reason: "cap" }, { dueMs: 5 }), expected: "failed" },
    { name: "昇格の時点の skipped(manual)→ 灰色", r: result("a", { kind: "skipped", reason: "manual" }, { dueMs: 5 }), expected: "skipped-manual" },
    { name: "計画の時点の skipped(started)→ 送らない(まとめにだけ載る)", r: result("a", { kind: "skipped", reason: "started" }, { dueMs: null }), expected: null },
    { name: "計画の時点の skipped(cap)→ 送らない", r: result("a", { kind: "skipped", reason: "cap" }, { dueMs: null }), expected: null },
    { name: "計画の時点の skipped(too-late・no-start-time)→ 送らない", r: result("a", { kind: "skipped", reason: "too-late" }, { dueMs: null }), expected: null },
    { name: "superseded → 送らない(利用者が自分で再実行している)", r: result("a", { kind: "superseded" }), expected: null },
    { name: "waiting → まだ送らない", r: result("a", { kind: "waiting" }), expected: null },
    { name: "running → まだ送らない", r: result("a", { kind: "running" }), expected: null },
    { name: "completed → ここでは決めない(材料の行〈ready〉があるときだけ送る)", r: result("a", { kind: "completed", analysisId: 1, detail: "stored" }), expected: null },
  ];
  it.each(cases)("$name", ({ r, expected }) => {
    expect(notifyKindFor(r)).toBe(expected);
  });
});

describe("summaryEligibility(AC-D3・G-D5: 事前分析のまとめを送る時点)", () => {
  const FIN_AT = 5_000_000;
  const base = (over: Partial<PlanProgress> = {}): PlanProgress => progress({ finalizedAt: FIN_AT, ...over });

  it("確定の前(stage が pending・none)は、送る資格がなく、保険の時刻も無い", () => {
    expect(summaryEligibility(base({ stage: "pending", finalizedAt: null }), FIN_AT + 1)).toEqual({ eligibleNow: false, dueMs: null });
    expect(summaryEligibility(base({ stage: "none", finalizedAt: null }), FIN_AT + 1)).toEqual({ eligibleNow: false, dueMs: null });
  });

  it("確定済みで morning がすべて終端(morningAllTerminal)なら、確定の直後でも送る", () => {
    expect(summaryEligibility(base({ morningAllTerminal: true }), FIN_AT)).toEqual({ eligibleNow: true, dueMs: FIN_AT + SUMMARY_INSURANCE_MS });
  });

  it("未完了があるあいだは、保険の時刻(確定 + 60 分)の 1ms 前まで送らず、その時刻ちょうどから送る", () => {
    expect(SUMMARY_INSURANCE_MS).toBe(60 * MIN);
    const p = base({ morningAllTerminal: false });
    expect(summaryEligibility(p, FIN_AT + SUMMARY_INSURANCE_MS - 1)).toMatchObject({ eligibleNow: false, dueMs: FIN_AT + SUMMARY_INSURANCE_MS });
    expect(summaryEligibility(p, FIN_AT + SUMMARY_INSURANCE_MS)).toMatchObject({ eligibleNow: true });
  });

  it("対象が 0 件で、全会場の一覧が取れている日は送らない(空の every に頼らず、明示の規則)。morningAllTerminal が真でも", () => {
    const empty = base({ rows: [], morningAllTerminal: true });
    expect(empty.morningAllTerminal).toBe(true); // 前提: 空の every は true になる
    expect(summaryEligibility(empty, FIN_AT + SUMMARY_INSURANCE_MS * 2)).toEqual({ eligibleNow: false, dueMs: null });
  });

  it("対象が 0 件でも、一覧の取得に失敗した会場がある日は送る(自動実行が壊れていることを知らせる)", () => {
    const failed = base({
      rows: [],
      morningAllTerminal: true,
      venues: [
        { venue: "central", state: "failed", attempts: 3, reason: "failed", listed: null, targeted: null },
        { venue: "nar", state: "ok", attempts: 1, reason: null, listed: 0, targeted: 0 },
      ],
    });
    expect(summaryEligibility(failed, FIN_AT)).toMatchObject({ eligibleNow: true });
  });
});

describe("planNotifications(いま送るもの・次に起きる時刻)", () => {
  const row = (key: string, kind: NotifyRowState["kind"], state: NotifyRowState["state"]): [string, NotifyRowState] => [key, { kind, state }];

  it("webhook が無効(enabled=false)なら、どんな状態でも何も送らず、アラームの候補も出さない(I2。材料を積み上げずに終端する)", () => {
    const failed = result("a", { kind: "failed", reason: "blocked", message: null });
    const plan = planNotifications(input({ enabled: false, auto: withResults(failed), progress: progress({ morningAllTerminal: true }) }));
    expect(plan).toEqual({ sendNow: null, nextAtMs: null });
    // 対照(空振り防止): 有効なら同じ状態で送る
    expect(planNotifications(input({ auto: withResults(failed) })).sendNow).toMatchObject({ key: "race:a", kind: "failed" });
  });

  it("送るものが無く、保険の時刻も無ければ (null, null)。確定の前も同じ", () => {
    expect(planNotifications(input({ auto: { stage: "pending", finalizedAt: null, results: [] }, progress: progress({ stage: "pending", finalizedAt: null }) }))).toEqual({ sendNow: null, nextAtMs: null });
  });

  it("failed の結果は kind=failed・key=race:<raceId> の項目になり、nextAtMs は送れる時刻(ペース制御の時刻)", () => {
    const plan = planNotifications(input({ auto: withResults(result("a", { kind: "failed", reason: "started", message: null })), paceUntilMs: 0 }));
    expect(plan.sendNow).toEqual({ key: "race:a", kind: "failed", raceId: "a" });
    expect(plan.nextAtMs).toBeLessThanOrEqual(NOW);
  });

  it("completed は、材料の行(ready)があるときだけ送る。材料が無い completed(webhook を後から登録した場合など)は送らない", () => {
    const completed = result("a", { kind: "completed", analysisId: 7, detail: "stored" });
    expect(planNotifications(input({ auto: withResults(completed) }))).toEqual({ sendNow: null, nextAtMs: null });
    const plan = planNotifications(input({ auto: withResults(completed), rows: new Map([row("race:a", "analysis", "ready")]) }));
    expect(plan.sendNow).toEqual({ key: "race:a", kind: "analysis", raceId: "a" });
  });

  it("材料の行(ready)があっても、結果が completed でなくなった(手動の再実行で superseded)ら送らない", () => {
    const plan = planNotifications(input({ auto: withResults(result("a", { kind: "superseded" })), rows: new Map([row("race:a", "analysis", "ready")]) }));
    expect(plan).toEqual({ sendNow: null, nextAtMs: null });
  });

  it.each(["sending", "sent", "failed"] as const)("行が %s のレースは、二度と候補にならない(at-most-once。sending のまま落ちたものも再送しない)", (state) => {
    const failed = result("a", { kind: "failed", reason: "started", message: null });
    expect(planNotifications(input({ auto: withResults(failed), rows: new Map([row("race:a", "failed", state)]) }))).toEqual({ sendNow: null, nextAtMs: null });
  });

  it("複数あるときは、結果の並び(レースID 順)の先頭を送る。1回に1件だけ", () => {
    const plan = planNotifications(
      input({ auto: withResults(result("a", { kind: "failed", reason: "started", message: null }), result("b", { kind: "failed", reason: "blocked", message: null })) }),
    );
    expect(plan.sendNow?.key).toBe("race:a");
    const second = planNotifications(
      input({ auto: withResults(result("a", { kind: "failed", reason: "started", message: null }), result("b", { kind: "failed", reason: "blocked", message: null })), rows: new Map([row("race:a", "failed", "sent")]) }),
    );
    expect(second.sendNow?.key).toBe("race:b");
  });

  it("レースごとの通知が先、事前分析のまとめは後(両方送れるとき)", () => {
    const plan = planNotifications(input({ auto: withResults(result("a", { kind: "failed", reason: "started", message: null })), progress: progress({ morningAllTerminal: true }) }));
    expect(plan.sendNow?.key).toBe("race:a");
    const after = planNotifications(input({ auto: withResults(result("a", { kind: "failed", reason: "started", message: null })), progress: progress({ morningAllTerminal: true }), rows: new Map([row("race:a", "failed", "sent")]) }));
    expect(after.sendNow).toEqual({ key: "summary", kind: "summary" });
  });

  it("事前分析のまとめは1日に1回: summary の行があれば(sending・sent・failed のどれでも)送らず、保険の時刻も出さない", () => {
    for (const state of ["sending", "sent", "failed"] as const) {
      const plan = planNotifications(input({ progress: progress({ morningAllTerminal: true }), rows: new Map([row("summary", "summary", state)]) }));
      expect(plan, state).toEqual({ sendNow: null, nextAtMs: null });
    }
  });

  it("未完了のあいだは、まとめの保険の時刻(確定 + 60 分)が nextAtMs になる(sendNow は無い)", () => {
    const plan = planNotifications(input({ progress: progress({ morningAllTerminal: false }) }));
    expect(plan.sendNow).toBeNull();
    expect(plan.nextAtMs).toBe(FIN + SUMMARY_INSURANCE_MS);
    expect(FIN + SUMMARY_INSURANCE_MS).toBeGreaterThan(NOW); // 前提: 保険の時刻は未来(NOW は確定の 30 分後)
  });

  it("保険の時刻を過ぎたら、まとめを送る", () => {
    const plan = planNotifications(input({ nowMs: FIN + SUMMARY_INSURANCE_MS, progress: progress({ morningAllTerminal: false }) }));
    expect(plan.sendNow).toEqual({ key: "summary", kind: "summary" });
  });

  describe("ペース制御(送信の間隔・失敗のクールダウン)", () => {
    const failed = result("a", { kind: "failed", reason: "started", message: null });

    it("間隔・クールダウンの定数: 間隔 1 秒・失敗の後 60 秒", () => {
      expect(SEND_SPACING_MS).toBe(1000);
      expect(FAILURE_COOLDOWN_MS).toBe(60_000);
    });

    it("ペースの時刻が未来なら送らず(sendNow=null)、nextAtMs はその時刻。時刻ちょうどになれば送る", () => {
      const waiting = planNotifications(input({ auto: withResults(failed), paceUntilMs: NOW + 500 }));
      expect(waiting.sendNow).toBeNull();
      expect(waiting.nextAtMs).toBe(NOW + 500);
      expect(planNotifications(input({ auto: withResults(failed), paceUntilMs: NOW })).sendNow).not.toBeNull();
    });

    it("保険の時刻がペースの時刻より前でも、ペースの時刻を待つ(まとめもペースに従う)", () => {
      const plan = planNotifications(input({ nowMs: FIN + SUMMARY_INSURANCE_MS, paceUntilMs: FIN + SUMMARY_INSURANCE_MS + 5000, progress: progress({ morningAllTerminal: false }) }));
      expect(plan.sendNow).toBeNull();
      expect(plan.nextAtMs).toBe(FIN + SUMMARY_INSURANCE_MS + 5000);
    });
  });

  it("不変条件 I1(網羅): ペース・時刻・行の状態を振った 数百の組み合わせで、nextAtMs ≤ now なら必ず sendNow がある。sendNow があれば nextAtMs ≤ now", () => {
    const failed = result("a", { kind: "failed", reason: "started", message: null });
    const completed = result("b", { kind: "completed", analysisId: 1, detail: "stored" });
    let checked = 0;
    let sent = 0;
    for (const paceUntilMs of [0, NOW - 1, NOW, NOW + 1, NOW + MIN]) {
      for (const nowOffset of [-2 * MIN, 0, 40 * MIN, 90 * MIN]) {
        for (const rowAState of [null, "sending", "sent", "failed"] as const) {
          for (const rowBState of [null, "ready", "sent"] as const) {
            for (const summaryState of [null, "sent"] as const) {
              for (const morningAllTerminal of [false, true]) {
                const rows = new Map<string, NotifyRowState>();
                if (rowAState !== null) rows.set("race:a", { kind: "failed", state: rowAState });
                if (rowBState !== null) rows.set("race:b", { kind: "analysis", state: rowBState });
                if (summaryState !== null) rows.set("summary", { kind: "summary", state: summaryState });
                const nowMs = NOW + nowOffset;
                const plan = planNotifications(input({ nowMs, paceUntilMs, rows, auto: withResults(failed, completed), progress: progress({ morningAllTerminal }) }));
                checked += 1;
                if (plan.nextAtMs !== null && plan.nextAtMs <= nowMs) {
                  expect(plan.sendNow, JSON.stringify({ nowOffset, paceUntilMs, rowAState, rowBState, summaryState, morningAllTerminal })).not.toBeNull();
                }
                if (plan.sendNow !== null) {
                  expect(plan.nextAtMs).not.toBeNull();
                  expect(plan.nextAtMs!).toBeLessThanOrEqual(nowMs);
                  sent += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(5 * 4 * 4 * 3 * 2 * 2); // 前提: 組み合わせの数
    expect(sent).toBeGreaterThan(50); // 空振り防止: 送る側の組み合わせも多数ある
    expect(sent).toBeLessThan(checked); // 空振り防止: 送らない側もある
  });
});
