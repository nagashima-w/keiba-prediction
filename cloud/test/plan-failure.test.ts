import { describe, expect, it } from "vitest";

import { buildPlanFailureEmbed } from "../src/notify-embeds";
import { planNotifications, type NotifyRowState } from "../src/notify-plan";
import { RESCUE_WATCH_MS, judgePlanRescue, type PlanVerdict } from "../src/plan-failure";
import { DISCORD_COLORS } from "../src/palette";
import type { PlanProgress } from "../src/race-day-core";

/**
 * Issue #249: 23 時の再実行(救済)の後に、翌日の事前分析が失敗しているかの判定(純関数)と、その通知の文面。
 * 失敗の定義(利用者の決定の範囲):
 *  - F1: 計画が確定していない / F2: 一覧の取得に失敗した会場がある / F3: 事前分析(morning)が failed のレースがある(上限超過のスキップを含む)/ F4: 判定の期限で事前分析が未完了。
 *  - 実行中(queued・fetched)は、期限までは失敗ではない(落ち着くのを待つ)。スキップ(時刻不明など)・対象 0 件・会場が ok で 0 件は失敗ではない。
 */

type Row = PlanProgress["rows"][number];
type Venue = PlanProgress["venues"][number];

const row = (over: Partial<Row> & { raceId: string }): Row => ({
  venue: "central",
  venueName: "中山",
  raceNumber: 1,
  raceName: "R",
  grade: null,
  startTime: "10:00",
  dueMs: 1,
  disposition: "scheduled",
  skipReason: null,
  state: "planned",
  morning: "done",
  ...over,
});
const venue = (over: Partial<Venue> & { venue: Venue["venue"] }): Venue => ({ state: "ok", attempts: 1, reason: null, listed: 12, targeted: 12, ...over });

function progress(over: Partial<PlanProgress> = {}): PlanProgress {
  const rows = over.rows ?? [row({ raceId: "202606040901" })];
  return {
    stage: "done",
    requestedAt: 1,
    finalizedAt: 2,
    offsetMinutes: 45,
    offsetSource: "settings",
    venues: [venue({ venue: "central" }), venue({ venue: "nar", listed: 0, targeted: 0 })],
    rows,
    morningAllTerminal: rows.every((r) => r.state === "skipped" || r.morning === "done" || r.morning === "failed"),
    ...over,
  };
}

const RESCUE_AT = Date.parse("2026-09-26T23:00:00+09:00");
const judge = (p: PlanProgress, nowMs = RESCUE_AT + 5 * 60_000, rescueAtMs: number | null = RESCUE_AT): PlanVerdict => judgePlanRescue({ progress: p, rescueAtMs, nowMs });

describe("judgePlanRescue: 判定の期限", () => {
  it("待つ上限は救済の要求から 60 分(利用者の決定)", () => {
    expect(RESCUE_WATCH_MS).toBe(60 * 60_000);
  });
});

describe("judgePlanRescue: 救済の要求が無い日は判定しない", () => {
  it("rescueAtMs が null → none(21 時だけの日・手動の日は、失敗の通知の対象外)", () => {
    expect(judge(progress({ venues: [venue({ venue: "central", state: "failed", reason: "blocked" })] }), RESCUE_AT, null)).toEqual({ kind: "none" });
  });
});

describe("judgePlanRescue: 落ち着いている(確定済み・会場が終端・事前分析に実行中が無い)ときの判定", () => {
  it("全部成功 → ok", () => {
    expect(judge(progress())).toEqual({ kind: "ok" });
  });

  it("対象 0 件(会場は ok で 0 件、開催なしの日)→ ok(失敗ではない)", () => {
    expect(judge(progress({ rows: [], venues: [venue({ venue: "central", listed: 0, targeted: 0 }), venue({ venue: "nar", listed: 0, targeted: 0 })] }))).toEqual({ kind: "ok" });
  });

  it("スキップ(時刻不明・発走済み・間に合わない・手動の分析あり)は失敗ではない → ok", () => {
    const skip = (raceId: string, reason: Row["skipReason"]): Row => row({ raceId, state: "skipped", skipReason: reason, disposition: "skip", dueMs: null, morning: null });
    expect(judge(progress({ rows: [skip("a", "no-start-time"), skip("b", "started"), skip("c", "too-late"), skip("d", "manual")] }))).toEqual({ kind: "ok" });
  });

  it.each([
    ["F2: 中央の一覧の取得が失敗", { venues: [venue({ venue: "central", state: "failed", reason: "blocked", listed: null, targeted: null }), venue({ venue: "nar" })] }, { venueFailures: [{ venue: "central", reason: "blocked" }], morningFailed: 0, capSkipped: 0, morningIncomplete: 0 }],
    ["F2: 地方の一覧の取得が失敗", { venues: [venue({ venue: "central" }), venue({ venue: "nar", state: "failed", reason: "busy", listed: null, targeted: null })] }, { venueFailures: [{ venue: "nar", reason: "busy" }], morningFailed: 0, capSkipped: 0, morningIncomplete: 0 }],
    ["F2: 両方の一覧が失敗", { venues: [venue({ venue: "central", state: "failed", reason: "failed" }), venue({ venue: "nar", state: "failed", reason: null })] }, { venueFailures: [{ venue: "central", reason: "failed" }, { venue: "nar", reason: null }], morningFailed: 0, capSkipped: 0, morningIncomplete: 0 }],
    ["F3: 事前分析が failed のレースがある(2 件)", { rows: [row({ raceId: "a", morning: "failed" }), row({ raceId: "b", morning: "failed" }), row({ raceId: "c", morning: "done" })] }, { venueFailures: [], morningFailed: 2, capSkipped: 0, morningIncomplete: 0 }],
    ["F3: 上限超過(cap)のスキップも失敗に数える", { rows: [row({ raceId: "a", state: "skipped", skipReason: "cap", disposition: "skip", dueMs: null, morning: null }), row({ raceId: "b", morning: "done" })] }, { venueFailures: [], morningFailed: 0, capSkipped: 1, morningIncomplete: 0 }],
  ] as const)("%s → failed(理由を件数で返す)", (_name, over, expected) => {
    const verdict = judge(progress(over as Partial<PlanProgress>));
    expect(verdict).toEqual({ kind: "failed", reasons: { planNotFinal: false, ...expected } });
  });

  it("複数の理由が重なっても、理由は全部返す(F2 + F3)", () => {
    const verdict = judge(
      progress({
        venues: [venue({ venue: "central", state: "failed", reason: "blocked" }), venue({ venue: "nar" })],
        rows: [row({ raceId: "a", venue: "nar", morning: "failed" })],
      }),
    );
    expect(verdict).toEqual({ kind: "failed", reasons: { planNotFinal: false, venueFailures: [{ venue: "central", reason: "blocked" }], morningFailed: 1, capSkipped: 0, morningIncomplete: 0 } });
  });
});

describe("judgePlanRescue: 落ち着いていないときは待つ(実行中は失敗ではない)。期限を過ぎたら判定する(F1・F4)", () => {
  const running = progress({ rows: [row({ raceId: "a", morning: "queued" }), row({ raceId: "b", morning: "failed" })] });
  const deadline = RESCUE_AT + RESCUE_WATCH_MS;

  it("事前分析が実行中(queued)で期限前 → wait(期限の時刻を返す)。他に failed があっても、まだ判定しない", () => {
    expect(judge(running, deadline - 1)).toEqual({ kind: "wait", dueMs: deadline });
  });

  it("fetched も実行中として待つ", () => {
    expect(judge(progress({ rows: [row({ raceId: "a", morning: "fetched" })] }), deadline - 1)).toEqual({ kind: "wait", dueMs: deadline });
  });

  it("期限ちょうど(now = 要求 + 60 分)で判定する: F4(未完了)と F3(失敗)を返す", () => {
    expect(judge(running, deadline)).toEqual({ kind: "failed", reasons: { planNotFinal: false, venueFailures: [], morningFailed: 1, capSkipped: 0, morningIncomplete: 1 } });
  });

  it("期限の 1 ミリ秒前と期限で、wait → failed に切り替わる(境界)", () => {
    expect(judge(running, deadline - 1).kind).toBe("wait");
    expect(judge(running, deadline).kind).toBe("failed");
  });

  it("F4 だけが原因の失敗: 事前分析が実行中のまま期限を過ぎ、ほかに失敗(会場・failed・cap・未確定)が無いとき → failed(未完了の件数だけが立つ)。期限の 1 ミリ秒前は wait", () => {
    const only = progress({ rows: [row({ raceId: "a", morning: "queued" }), row({ raceId: "b", morning: "fetched" }), row({ raceId: "c", morning: "done" })] });
    // 前提: 実行中以外の失敗の材料が無い(あれば、F4 だけの検査にならない)
    expect(only.rows.some((r) => r.morning === "failed")).toBe(false);
    expect(only.venues.every((v) => v.state === "ok")).toBe(true);
    expect(only.stage).toBe("done");
    expect(judge(only, deadline - 1)).toEqual({ kind: "wait", dueMs: deadline });
    expect(judge(only, deadline)).toEqual({ kind: "failed", reasons: { planNotFinal: false, venueFailures: [], morningFailed: 0, capSkipped: 0, morningIncomplete: 2 } });
    expect(judge(only, deadline + 60_000).kind).toBe("failed"); // 期限を過ぎたあとも同じ
  });

  it("確定が再試行待ち(stage = pending)で、会場はすべて ok・事前分析に実行中も無い → 期限前は wait(落ち着いたと誤認して、F1 の失敗を早く返さない)。期限後に初めて F1 の failed", () => {
    const waiting = progress({ stage: "pending", finalizedAt: null, rows: [row({ raceId: "a", morning: "done" })] });
    // 前提: 会場は終端で、実行中の事前分析が無い(この 2 つだけでは settled にならないことを固定する)
    expect(waiting.venues.every((v) => v.state === "ok")).toBe(true);
    expect(waiting.rows.some((r) => r.morning === "queued" || r.morning === "fetched")).toBe(false);
    expect(judge(waiting, RESCUE_AT + 5 * 60_000)).toEqual({ kind: "wait", dueMs: deadline });
    expect(judge(waiting, deadline - 1)).toEqual({ kind: "wait", dueMs: deadline });
    expect(judge(waiting, deadline)).toEqual({ kind: "failed", reasons: { planNotFinal: true, venueFailures: [], morningFailed: 0, capSkipped: 0, morningIncomplete: 0 } });
  });

  it("実行中でも、期限の前に落ち着けば(全部 done)ok になる", () => {
    expect(judge(progress({ rows: [row({ raceId: "a", morning: "done" })] }), RESCUE_AT + 10 * 60_000)).toEqual({ kind: "ok" });
  });

  it("計画が確定していない(stage = pending)・期限前 → wait。期限後 → F1 つきの failed", () => {
    const pending = progress({ stage: "pending", finalizedAt: null, venues: [venue({ venue: "central", state: "pending", reason: null, listed: null, targeted: null }), venue({ venue: "nar" })], rows: [] });
    expect(judge(pending, deadline - 1)).toEqual({ kind: "wait", dueMs: deadline });
    expect(judge(pending, deadline)).toEqual({ kind: "failed", reasons: { planNotFinal: true, venueFailures: [], morningFailed: 0, capSkipped: 0, morningIncomplete: 0 } });
  });

  it("計画の依頼がまだ無い(stage = none)・期限後 → F1(計画が確定していない)の failed", () => {
    const none = progress({ stage: "none", requestedAt: null, finalizedAt: null, venues: [], rows: [] });
    expect(judge(none, deadline)).toMatchObject({ kind: "failed", reasons: { planNotFinal: true } });
  });

  it("morning を積んでいない計画の行(morning = null で skipped でない)は、実行中にも失敗にも数えない", () => {
    expect(judge(progress({ rows: [row({ raceId: "a", morning: null })] }))).toEqual({ kind: "ok" });
  });
});

describe("buildPlanFailureEmbed(23 時の再実行後も事前分析が失敗しているときの通知。色に頼らず文字で伝える)", () => {
  const reasons = (over: Partial<Extract<PlanVerdict, { kind: "failed" }>["reasons"]> = {}) => ({ planNotFinal: false, venueFailures: [], morningFailed: 0, capSkipped: 0, morningIncomplete: 0, ...over });

  it("タイトルと帯: 「事前分析の失敗 2026/09/27(日)」・失敗色。本文の先頭は【失敗】", () => {
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress(), reasons: reasons({ morningFailed: 1 }) });
    expect(e.title).toBe("事前分析の失敗 2026/09/27(日)");
    expect(e.color).toBe(DISCORD_COLORS.fail);
    expect(e.description?.startsWith("【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)")).toBe(true);
  });

  it("F2: 会場の失敗を ⚠ の行で出す(理由は日本語の語)。影響として、手動で実行する案内を出す", () => {
    const e = buildPlanFailureEmbed({
      kaisaiDate: "20260927",
      progress: progress({ venues: [venue({ venue: "central", state: "failed", reason: "blocked" }), venue({ venue: "nar" })] }),
      reasons: reasons({ venueFailures: [{ venue: "central", reason: "blocked" }] }),
    });
    expect(e.description).toContain("⚠ 中央の一覧を取得できませんでした(取得制限中)");
    expect(e.description).toContain("一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。");
    expect(e.description).not.toContain("発走前の分析は予定どおり行われます");
  });

  it("F3(上限超過を含む)・F4 だけ: 件数の行(うち上限超過)を出す。会場の案内は出さない。上限超過があるので「予定どおり」は出さず、cap の案内を出す", () => {
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress({ rows: [row({ raceId: "202606040901", morning: "failed" })] }), reasons: reasons({ morningFailed: 3, capSkipped: 1, morningIncomplete: 2 }) });
    expect(e.description).toContain("事前分析: 失敗 4 件(うち上限超過 1) / 未完了 2 件");
    expect(e.description).toContain("上限超過でスキップされたレースは、自動では分析されません。");
    expect(e.description).not.toContain("一覧を取得できなかった会場");
  });

  it("上限超過(cap)のスキップがあるとき: 「発走前の分析は予定どおり行われます」を出さない(cap のレースは分析されない)。事実に合う文で、手動の案内を出す", () => {
    for (const r of [reasons({ capSkipped: 1 }), reasons({ capSkipped: 2, morningFailed: 3, morningIncomplete: 1 })]) {
      const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress({ rows: [row({ raceId: "202606040901", state: "skipped", skipReason: "cap", disposition: "skip", dueMs: null, morning: null })] }), reasons: r });
      expect(e.description).not.toContain("発走前の分析は予定どおり行われます");
      expect(e.description).toContain("上限超過でスキップされたレースは、自動では分析されません。画面から手動で実行してください。");
    }
  });

  it("cap が無い F3 だけのときは、従来どおり「予定どおり」の文を出す(対照: 上の検査が、文を常に消しているだけでない)", () => {
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress(), reasons: reasons({ morningFailed: 1 }) });
    expect(e.description).toContain("発走前の分析は予定どおり行われます。");
    expect(e.description).not.toContain("上限超過でスキップ");
  });

  it("F1: 計画が確定していないことを出し、手動の案内を出す", () => {
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress({ stage: "pending", finalizedAt: null, rows: [] }), reasons: reasons({ planNotFinal: true }) });
    expect(e.description).toContain("⚠ 計画が確定していません");
    expect(e.description).toContain("画面から手動で実行してください");
  });

  it("失敗と未完了のレースを fields に出す(失敗・未完了のものだけ。成功したレースは出さない)", () => {
    const e = buildPlanFailureEmbed({
      kaisaiDate: "20260927",
      progress: progress({ rows: [row({ raceId: "202606040901", raceNumber: 1, morning: "done" }), row({ raceId: "202606040902", raceNumber: 2, morning: "failed" }), row({ raceId: "202606040903", raceNumber: 3, morning: "queued" })] }),
      reasons: reasons({ morningFailed: 1, morningIncomplete: 1 }),
    });
    const lines = (e.fields ?? []).flatMap((f) => f.value.split("\n"));
    expect(lines.filter((l) => l.includes("2R"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("3R"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("1R"))).toHaveLength(0);
    expect((e.fields ?? []).every((f) => f.name.length > 0)).toBe(true);
  });

  it("レースが多くても Discord の上限に収まる(fitEmbed)", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ raceId: `2026060409${String(i).padStart(2, "0")}`, raceNumber: (i % 12) + 1, raceName: "あ".repeat(30), morning: "failed" }));
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress({ rows }), reasons: reasons({ morningFailed: 60 }) });
    const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect((e.fields ?? []).every((f) => f.value.length <= 1024)).toBe(true);
  });

  it("URL・secret を含まない", () => {
    const e = buildPlanFailureEmbed({ kaisaiDate: "20260927", progress: progress(), reasons: reasons({ morningFailed: 1 }) });
    expect(JSON.stringify(e)).not.toMatch(/https?:|webhook/i);
  });
});

describe("planNotifications: 失敗の通知(plan-failure)の候補(多くとも 1 回)", () => {
  const base = (rows: [string, NotifyRowState][], over: { enabled?: boolean; progress?: PlanProgress } = {}) =>
    planNotifications({
      enabled: over.enabled ?? true,
      nowMs: 1000,
      auto: { stage: "done", finalizedAt: 2, results: [] },
      progress: over.progress ?? progress({ rows: [] }),
      rows: new Map(rows),
      paceUntilMs: 0,
    });

  it("材料(ready)があれば、その場で送る候補になる", () => {
    expect(base([["plan-failure", { kind: "plan-failure", state: "ready" }]]).sendNow).toEqual({ key: "plan-failure", kind: "plan-failure" });
  });

  it.each([["sending"], ["sent"], ["failed"]] as const)("%s の行は二度と候補にならない(再送しない)", (state) => {
    const plan = base([["plan-failure", { kind: "plan-failure", state }]]);
    expect(plan.sendNow).toBeNull();
    expect(plan.nextAtMs).toBeNull();
  });

  it("行が無ければ候補にならない(材料は判定が積む。計画は作らない)", () => {
    expect(base([]).sendNow).toBeNull();
  });

  it("webhook が無効なら、材料があっても送らない・アラームの候補も無い(I2)", () => {
    const plan = base([["plan-failure", { kind: "plan-failure", state: "ready" }]], { enabled: false });
    expect(plan).toEqual({ sendNow: null, nextAtMs: null });
  });

  it("ペースの時刻より前は送らず、その時刻を候補にする(連続する通知の間隔を守る)", () => {
    const plan = planNotifications({
      enabled: true,
      nowMs: 1000,
      auto: { stage: "done", finalizedAt: 2, results: [] },
      progress: progress({ rows: [] }),
      rows: new Map([["plan-failure", { kind: "plan-failure", state: "ready" } as NotifyRowState]]),
      paceUntilMs: 5000,
    });
    expect(plan).toEqual({ sendNow: null, nextAtMs: 5000 });
  });

  it("まとめと同時に送れるときは、失敗の通知が先(まとめは最後)", () => {
    const withContent = progress({ rows: [row({ raceId: "202606040901", morning: "done" })] });
    const plan = base([["plan-failure", { kind: "plan-failure", state: "ready" }]], { progress: withContent });
    expect(plan.sendNow).toEqual({ key: "plan-failure", kind: "plan-failure" });
  });
});
