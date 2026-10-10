import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { DiscordNotifier } from "../src/notify-send";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #249: 日単位の DO の「救済」(`requestPlan({ rescue: true })`。23 時の再実行)。
 * 21 時の計画で一覧の取得に失敗した会場・失敗した事前分析(morning)を、**1 回だけ**救う。冪等性が主題:
 *  - 救済の記録(meta `plan_rescue_at`)は 1 回だけ。2 回目以降は何も変えない(アラームの張り直しだけ)。
 *  - 正常な日の救済は、何も変えない(記録だけが付く)。
 *  - rescue を渡さない呼び出し(21 時・手動)は、記録も救済もしない。
 * ゲートは偽(一覧は HTML を返し、それ以外はブレーカー拒否=事前分析の取得がすぐ失敗する)。ストレージは `node:sqlite`。実 netkeiba には触れない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20260927";
/** 21 時の計画(前日の夜)と 23 時の再実行。 */
const T_2100 = Date.parse("2026-09-26T21:00:00+09:00");
const T_2300 = Date.parse("2026-09-26T23:00:00+09:00");

const CENTRAL_HTML = fixture("race_list_sub_20260927.html");
const NAR_HTML = fixture("synthetic_nar_race_list_sub_20260927_jpn3.html");

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

interface FakeGate extends GateLike {
  /** 先頭から 1 回ずつ消費する失敗(空になれば html を返す)。 */
  readonly failures: { central: GateResult[]; nar: GateResult[] };
  readonly calls: { central: number; nar: number };
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    failures: { central: [], nar: [] },
    calls: { central: 0, nar: 0 },
    async fetchRaw(url): Promise<GateResult> {
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) {
        gate.calls.central += 1;
        return gate.failures.central.shift() ?? ok(CENTRAL_HTML);
      }
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) {
        gate.calls.nar += 1;
        return gate.failures.nar.shift() ?? ok(NAR_HTML);
      }
      return blocked(); // 事前分析の取得は、このテストの主題ではないので、すぐ失敗にする
    },
  };
  return gate;
}

const unusedSink: AnalysisSink = {
  save: async () => {
    throw new Error("保存先は使わない");
  },
  findByAnalyzedAt: async () => {
    throw new Error("保存先は使わない");
  },
  findRecentByRace: async () => {
    throw new Error("保存先は使わない");
  },
  countChildren: async () => {
    throw new Error("保存先は使わない");
  },
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  /** Discord に送ったペイロード(embeds)の記録。 */
  readonly sent: { title?: string; description?: string; color?: number; fields?: { name: string; value: string }[] }[];
  /** 送信の挙動(省略時は成功)。 */
  readonly sendBehavior: { fail: boolean };
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { notifier?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: T_2100 };
  const alarm: { at: number | null } = { at: null };
  const gate = fakeGate();
  const sent: Harness["sent"] = [];
  const sendBehavior = { fail: false };
  const notifier: DiscordNotifier = {
    send: async (payload) => {
      if (sendBehavior.fail) throw new Error("送信の失敗 SECRET-CANARY");
      sent.push(...(payload.embeds as Harness["sent"]));
    },
  };
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: () => undefined,
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.notifier === true ? { notifier } : {}),
  });
  return { core, sql, gate, clock, alarm, sent, sendBehavior };
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

/** 鳴ったアラームの時刻に時計を進め、1 ステップ進める(DO と同じく、鳴ったアラームは空にしてから呼ぶ)。 */
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}

/** 時刻が `until` 以前のアラームを、無くなるまで進める(発走前の期限など、翌日の未来のアラームは進めない)。進めたステップ数を返す。 */
async function runDue(h: Harness, until: number, limit = 500): Promise<string[]> {
  const labels: string[] = [];
  while (h.alarm.at !== null && h.alarm.at <= until) {
    if (labels.length >= limit) throw new Error("ステップが終わらない");
    labels.push(await tick(h));
  }
  return labels;
}

const meta = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};
const venueRows = (h: Harness): { venue: string; state: string; attempts: number; reason: string | null; listed: number | null; targeted: number | null }[] =>
  h.sql.exec("SELECT venue, state, attempts, reason, listed, targeted FROM race_day_plan_venue ORDER BY venue").toArray() as never;
const planRows = (h: Harness): { race_id: string; venue: string; state: string; planned_at: number; offset_minutes: number }[] =>
  h.sql.exec("SELECT race_id, venue, state, planned_at, offset_minutes FROM race_day_plan ORDER BY race_id").toArray() as never;
const morningRows = (h: Harness): { race_id: string; status: string; attempts: number; updated_at: number }[] =>
  h.sql.exec("SELECT race_id, status, attempts, updated_at FROM race_day_tasks WHERE mode = 'morning' ORDER BY race_id").toArray() as never;

/** 状態の写し(救済が何も変えないことの比較用): 計画に関わる表と meta の全行。 */
function snapshot(h: Harness): unknown {
  return {
    venues: h.sql.exec("SELECT * FROM race_day_plan_venue ORDER BY venue").toArray(),
    plan: h.sql.exec("SELECT * FROM race_day_plan ORDER BY race_id").toArray(),
    tasks: h.sql.exec("SELECT * FROM race_day_tasks ORDER BY race_id, mode").toArray(),
    meta: h.sql.exec("SELECT * FROM race_day_meta WHERE key != 'plan_rescue_at' ORDER BY key").toArray(),
  };
}

/** 21 時の計画を、一覧 2 本 + 確定 + 事前分析がすべて終端になるまで進める(翌日の期限のアラームは進めない)。 */
async function plan2100(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  await runDue(h, T_2300 - 1);
}

describe("救済の対象: 一覧の取得に失敗した会場", () => {
  it("21 時に中央の一覧がブレーカーで失敗 → 地方だけで確定。23 時の rescue で中央が pending に戻り、再確定で中央の行と事前分析が足される。地方の行は最初の計画のまま", async () => {
    const h = harness();
    h.gate.failures.central = [blocked()];
    await plan2100(h);
    // 前提: 21 時の時点で、中央は失敗・地方は成功。計画は確定済みで、中央の行は無い
    expect(venueRows(h).map((v) => [v.venue, v.state, v.reason])).toEqual([
      ["central", "failed", "blocked"],
      ["nar", "ok", null],
    ]);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
    const before = planRows(h);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.venue === "nar")).toBe(true);
    expect(h.gate.calls).toEqual({ central: 1, nar: 1 });

    h.clock.now = T_2300;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    // 救済の直後: 中央は pending(試行 0)に戻り、確定の印は外れている(再確定を待つ)。地方は触れない
    expect(venueRows(h).map((v) => [v.venue, v.state, v.attempts])).toEqual([
      ["central", "pending", 0],
      ["nar", "ok", expect.any(Number)],
    ]);
    expect(meta(h, "plan_finalized_at")).toBeNull();
    expect(meta(h, "plan_rescue_at")).toBe(String(T_2300));
    expect(h.core.getPlanProgress().stage).toBe("pending");

    await runDue(h, T_2300 + 60 * 60_000);
    // 中央の一覧を 1 回だけ取り直した(地方は取り直していない)
    expect(h.gate.calls).toEqual({ central: 2, nar: 1 });
    expect(venueRows(h).map((v) => [v.venue, v.state])).toEqual([
      ["central", "ok"],
      ["nar", "ok"],
    ]);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
    expect(h.core.getPlanProgress().stage).toBe("done");
    const after = planRows(h);
    expect(after.filter((r) => r.venue === "central")).toHaveLength(24);
    // 地方の行は、最初の計画のまま(行も計画の時刻も offset も変わらない)
    expect(after.filter((r) => r.venue === "nar")).toEqual(before);
    // 新しい中央の行には、事前分析(morning)が積まれた
    const morning = morningRows(h);
    expect(morning.filter((m) => m.race_id.startsWith("2026")).length).toBe(after.length);
    expect(venueRows(h).find((v) => v.venue === "central")?.targeted).toBe(24);
  });

  it("会場の失敗が両方(中央も地方も)でも救済される。取り直しの回数は会場ごとに 1 回", async () => {
    const h = harness();
    h.gate.failures.central = [blocked()];
    h.gate.failures.nar = [blocked()];
    await plan2100(h);
    expect(venueRows(h).map((v) => v.state)).toEqual(["failed", "failed"]);
    expect(planRows(h)).toEqual([]);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 60 * 60_000);
    expect(h.gate.calls).toEqual({ central: 2, nar: 2 });
    expect(venueRows(h).map((v) => v.state)).toEqual(["ok", "ok"]);
    expect(planRows(h).length).toBeGreaterThan(24);
  });

  it("救済でも取得に失敗した会場は failed のまま終わる(救済は 1 回だけ。無限に取り直さない)。2 回目の rescue は何も変えない", async () => {
    const h = harness();
    h.gate.failures.central = [blocked(), blocked()]; // 21 時と 23 時の両方で失敗
    await plan2100(h);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 60 * 60_000);
    expect(h.gate.calls.central).toBe(2);
    expect(venueRows(h).map((v) => [v.venue, v.state])).toEqual([
      ["central", "failed"],
      ["nar", "ok"],
    ]);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
    const done = snapshot(h);
    const rescueAt = meta(h, "plan_rescue_at");
    expect(rescueAt).toBe(String(T_2300));

    // cron の重複配信(2 回目の rescue)。時刻が違っても、救済の記録は最初のまま・状態は何も変わらない
    h.clock.now = T_2300 + 5 * 60_000;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    expect(snapshot(h)).toEqual(done);
    expect(meta(h, "plan_rescue_at")).toBe(rescueAt);
    expect(h.gate.calls.central).toBe(2); // 取り直しは増えない
    expect(await runDue(h, T_2300 + 2 * 60 * 60_000)).toEqual([]); // 鳴るアラームも仕事を生まない
  });
});

describe("救済の対象: 失敗した事前分析(morning)", () => {
  /** 前提を固める: 全レースの morning が終端で、failed が 1 件以上、done を 1 件(直接書いて)作る。 */
  async function planWithFailedMorning(): Promise<{ h: Harness; failed: string[]; doneId: string }> {
    const h = harness();
    await plan2100(h);
    const rows = morningRows(h);
    expect(rows.length).toBe(25);
    expect(rows.every((m) => m.status === "failed")).toBe(true); // ブレーカー拒否で全件がすぐ失敗
    const doneId = rows[0]!.race_id;
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ? AND mode = 'morning'", doneId);
    return { h, failed: rows.slice(1).map((m) => m.race_id), doneId };
  }

  it("rescue で、計画中(planned)のレースの failed の morning だけが queued に積み直される(試行 0)。done は触れない。会場は失敗していないので確定の印は外さない", async () => {
    const { h, failed, doneId } = await planWithFailedMorning();
    const finalizedAt = meta(h, "plan_finalized_at");
    expect(finalizedAt).not.toBeNull();
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    const morning = morningRows(h);
    expect(morning.find((m) => m.race_id === doneId)?.status).toBe("done");
    expect(morning.filter((m) => failed.includes(m.race_id)).every((m) => m.status === "queued" && m.attempts === 0)).toBe(true);
    expect(failed.length).toBe(24);
    expect(meta(h, "plan_finalized_at")).toBe(finalizedAt);
    expect(h.core.getPlanProgress().stage).toBe("done");
    // 積み直した事前分析が実際に動く(アラームが張られていて、取り直しは再び拒否される=終端に戻る)
    expect(h.alarm.at).not.toBeNull();
    await runDue(h, T_2300 + 60 * 60_000);
    expect(morningRows(h).filter((m) => m.status === "queued" || m.status === "fetched")).toEqual([]);
  });

  it("実行中(queued・fetched)の morning は積み直さない(待つ)。スキップの行にも積まない", async () => {
    const h = harness();
    await plan2100(h);
    const ids = morningRows(h).map((m) => m.race_id);
    h.sql.exec("UPDATE race_day_tasks SET status = 'fetched', attempts = 1 WHERE race_id = ? AND mode = 'morning'", ids[0]);
    h.sql.exec("UPDATE race_day_tasks SET status = 'queued', attempts = 2 WHERE race_id = ? AND mode = 'morning'", ids[1]);
    h.sql.exec("UPDATE race_day_plan SET state = 'skipped' WHERE race_id = ?", ids[2]);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    const byId = new Map(morningRows(h).map((m) => [m.race_id, m]));
    expect(byId.get(ids[0]!)).toMatchObject({ status: "fetched", attempts: 1 });
    expect(byId.get(ids[1]!)).toMatchObject({ status: "queued", attempts: 2 });
    expect(byId.get(ids[2]!)).toMatchObject({ status: "failed" }); // 計画の行がスキップ: 事前分析は積み直さない
    expect(byId.get(ids[3]!)).toMatchObject({ status: "queued", attempts: 0 }); // 対照: ほかの failed は積み直された
  });

  it("2 回目の rescue は事前分析を積み直さない(救済は 1 回だけ。再び failed になったものはそのまま)", async () => {
    const { h } = await planWithFailedMorning();
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 60 * 60_000);
    // 前提: 積み直した事前分析が、再び failed になっている
    expect(morningRows(h).filter((m) => m.status === "failed").length).toBe(24);
    const done = snapshot(h);
    h.clock.now = T_2300 + 10 * 60_000;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    expect(snapshot(h)).toEqual(done);
    expect(morningRows(h).filter((m) => m.status === "failed").length).toBe(24);
  });
});

describe("救済の冪等性: 正常な日・rescue を渡さない呼び出し・未計画", () => {
  it("正常な日(会場が成功・事前分析が done)の rescue は、計画の状態を何も変えない(救済の記録だけが付く)。取り直しもしない", async () => {
    const h = harness();
    await plan2100(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    const before = snapshot(h);
    expect(meta(h, "plan_rescue_at")).toBeNull();
    h.clock.now = T_2300;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    expect(snapshot(h)).toEqual(before);
    expect(meta(h, "plan_rescue_at")).toBe(String(T_2300));
    expect(h.gate.calls).toEqual({ central: 1, nar: 1 });
  });

  it("rescue を渡さない呼び出し(21 時の再試行・重複)は、会場が失敗していても救済しない・記録も付けない(従来の冪等性のまま)", async () => {
    const h = harness();
    h.gate.failures.central = [blocked()];
    await plan2100(h);
    const before = snapshot(h);
    h.clock.now = T_2300;
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: false })).toEqual({ accepted: false, reason: "already-planned" });
    expect(snapshot(h)).toEqual(before);
    expect(meta(h, "plan_rescue_at")).toBeNull();
    expect(venueRows(h).find((v) => v.venue === "central")?.state).toBe("failed");
  });

  it("未計画の日への最初の呼び出しが rescue(21 時の依頼が全滅していた場合)なら、通常どおり受理し、救済の記録も付ける。そのあとの rescue は救済を重ねない", async () => {
    const h = harness();
    h.clock.now = T_2300;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: true });
    expect(meta(h, "plan_rescue_at")).toBe(String(T_2300));
    await runDue(h, T_2300 + 60 * 60_000);
    expect(venueRows(h).map((v) => v.state)).toEqual(["ok", "ok"]);
    const done = snapshot(h);
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    expect(snapshot(h)).toEqual(done);
  });

  it("rescue でも、別の開催日の DO への依頼は従来どおり拒否する(開催日の検査は救済より先)", async () => {
    const h = harness();
    await plan2100(h);
    await expect(h.core.requestPlan({ kaisaiDate: "20260928", rescue: true })).rejects.toThrow();
    expect(meta(h, "plan_rescue_at")).toBeNull();
  });
});

describe("23 時の再実行の後の失敗の判定と Discord 通知(日単位の DO。多くとも 1 回)", () => {
  const failureMessages = (h: Harness) => h.sent.filter((m) => m.title?.startsWith("事前分析の失敗"));
  const verdict = (h: Harness): string | null => meta(h, "plan_rescue_verdict");
  const notifyRow = (h: Harness): { state: string; kind: string; error_class: string | null } | undefined =>
    (h.sql.exec("SELECT state, kind, error_class FROM race_day_notify WHERE key = 'plan-failure'").toArray() as { state: string; kind: string; error_class: string | null }[])[0];

  it("救済しても会場の失敗が残る(F2)→ 判定は failed。固定の見出しの通知を 1 通だけ送る(会場の失敗を ⚠ の行で、手動で実行する案内つき)", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked(), blocked()]; // 21 時と 23 時の両方で失敗
    await plan2100(h);
    expect(failureMessages(h)).toEqual([]); // 21 時の時点では送らない(救済の要求が無い)
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(verdict(h)).toBe("failed");
    const messages = failureMessages(h);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.title).toBe("事前分析の失敗 2026/09/27(日)");
    expect(messages[0]!.description).toContain("⚠ 中央の一覧を取得できませんでした(取得制限中)");
    expect(messages[0]!.description).toContain("画面から手動で実行してください");
    expect(notifyRow(h)).toMatchObject({ state: "sent", kind: "plan-failure", error_class: null });
  });

  it("多くとも 1 回: 判定のあとに何度アラームが鳴っても・rescue が重複しても、通知は増えない", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked(), blocked()];
    await plan2100(h);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(failureMessages(h)).toHaveLength(1);
    // cron の重複配信
    h.clock.now = T_2300 + 3 * 60 * 60_000;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 6 * 60 * 60_000);
    // 再起動に相当する余分な起床
    h.alarm.at = h.clock.now;
    await tick(h);
    expect(failureMessages(h)).toHaveLength(1);
  });

  it("救済で一覧は直ったが、事前分析が failed のまま(F3)→ 判定は failed。「発走前の分析は予定どおり」の通知(会場の案内は出ない)", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked()]; // 21 時だけ失敗。23 時で救済される(事前分析は、この偽ゲートでは常に失敗)
    await plan2100(h);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(verdict(h)).toBe("failed");
    const messages = failureMessages(h);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.description).toContain("事前分析: 失敗");
    expect(messages[0]!.description).toContain("発走前の分析は予定どおり行われます。");
    expect(messages[0]!.description).not.toContain("⚠ 中央の一覧");
  });

  it("すべて成功(会場が ok・事前分析が done)→ 判定は ok。通知は送らない", async () => {
    const h = harness({ notifier: true });
    await plan2100(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(verdict(h)).toBe("ok");
    expect(failureMessages(h)).toEqual([]);
    expect(notifyRow(h)).toBeUndefined();
  });

  it("落ち着くのを待つ: 救済で再取得した一覧が再試行待ち(pending)のあいだは判定しない(通知も送らない)。再試行が尽きて failed になったら判定して送る", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked()]; // 21 時
    await plan2100(h);
    // 23 時の救済: 取り直しは HTTP 500(再試行される失敗)を 3 回続ける
    const http500 = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
    h.gate.failures.central = [http500(), http500(), http500()];
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    // 1 回目の取り直しだけ進める(再試行待ち = pending)
    await tick(h);
    expect(venueRows(h).find((v) => v.venue === "central")?.state).toBe("pending");
    expect(verdict(h)).toBeNull();
    expect(failureMessages(h)).toEqual([]);
    // 再試行を進める: 3 回目で failed → 確定 → 判定
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(venueRows(h).find((v) => v.venue === "central")?.state).toBe("failed");
    expect(verdict(h)).toBe("failed");
    expect(failureMessages(h)).toHaveLength(1);
  });

  it("救済の要求が無い日(21 時だけ。rescue なし)は、失敗が残っていても判定せず、通知も送らない", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked()];
    await plan2100(h);
    await runDue(h, T_2300 + 24 * 60 * 60_000 - 1);
    expect(verdict(h)).toBeNull();
    expect(failureMessages(h)).toEqual([]);
    expect(notifyRow(h)).toBeUndefined();
  });

  it("送信が失敗(例外)しても握る: 通知の行は failed(分類つき)で、再送しない。例外の文面は状態に残さない", async () => {
    const h = harness({ notifier: true });
    h.gate.failures.central = [blocked(), blocked()];
    h.sendBehavior.fail = true;
    await plan2100(h);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(notifyRow(h)).toMatchObject({ state: "failed", kind: "plan-failure" });
    expect(JSON.stringify(notifyRow(h))).not.toContain("SECRET-CANARY");
    h.sendBehavior.fail = false;
    await runDue(h, T_2300 + 6 * 60 * 60_000);
    expect(failureMessages(h)).toEqual([]); // 失敗した通知は再送しない
  });

  it("Webhook が無効(notifier なし)→ 判定しない・材料も行も積まない・そのためのアラームも張らない(通知の仕組み全体が無効)", async () => {
    const h = harness({ notifier: false });
    h.gate.failures.central = [blocked(), blocked()];
    await plan2100(h);
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(verdict(h)).toBeNull();
    expect(notifyRow(h)).toBeUndefined();
    // 以後に鳴るアラームは、発走前の期限(翌日)以降だけ: 判定のための起床は無い
    expect(h.alarm.at === null || h.alarm.at > T_2300 + 2 * 60 * 60_000).toBe(true);
  });

  it("判定の済んだ日は、判定のためのアラームを張らない(鳴ったアラームは必ず仕事をする。空回りしない)", async () => {
    const h = harness({ notifier: true });
    await plan2100(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    h.clock.now = T_2300;
    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    await runDue(h, T_2300 + 2 * 60 * 60_000);
    expect(verdict(h)).toBe("ok");
    // 残るアラームは、発走前の期限(翌日の朝以降)だけ
    expect(h.alarm.at === null || h.alarm.at > Date.parse("2026-09-27T00:00:00+09:00")).toBe(true);
  });
});
