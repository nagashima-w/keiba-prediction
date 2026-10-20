import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { DiscordNotifier } from "../src/notify-send";
import { MAX_ATTEMPTS, RETRY_DELAY_MS, RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import type { SqlLike } from "../src/sql-like";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #399(R-9e の e3): 救済の段階(`rescuePlan`・`rescueVerdictNow`・`rescueJudgeAtMs`・`judgeRescue`・定数 `RESCUE_VERDICT_KEY`)を `RaceDayCore` から切り出す前に、**今の挙動を固定する特性テスト**。
 * 切り出しの前後で、このファイルを書き換えずに緑のままであることが、挙動を変えていないことの根拠になる。
 *
 * 既存の `race-day-rescue.test.ts`(救済の冪等性・失敗の判定と通知の統合)が固定している面(行の状態・通知の本文・多くとも 1 回)に加えて、**値だけでは見えない面**を固定する:
 *  - **SQL の文と順序**(計画の表・会場の表・タスクの表・通知の表・meta への書き込みを読める形で、全体は SHA-1 で固定する。**gate への取得・警告・`setAlarm`・通知の送信も同じ列に挟む**ので、
 *    「記録を書く → 会場を戻す → 確定の印を外す → morning を積み直す」「通知の材料を積む → 判定を永続化する」の順序が見える)
 *  - **ログの文言**(`onWarn` に渡る文面。全文一致。鍵の形は伏せられる)
 *  - **アラームの系列**(`rescueJudgeAtMs` が `rearm` の候補に与える影響。判定が落ち着く〈ok・failed〉なら今、待つ〈wait〉なら判定の期限、判定済み・webhook なし・救済の要求なしなら候補なし)
 *  - **時計・状態が呼ぶたびに読まれること**(`now`・`metaGet`・`getPlanProgress` を値で固定していないこと。時計が進む場面・判定の永続化の前後で結果が変わる場面)
 *  - 通知の材料(`race_day_notify` の `plan-failure` の行。embed の本文は全文)
 *
 * ## 到達不能の場面(【記録】区分)
 * production から到達しない防御の分岐は、SQL で状態を作って固定している(切り出しで壊れても利用者には影響しない。ブロッキングの基準では【記録】):
 *  - 「通知の材料の組み立てが throw して最小の通知に代える」: 組み立ては純関数で、`getPlanProgress` の戻り値は文字列の列から作られるため、通常は throw しない。
 *    計画の行の `race_name` に BLOB を直接書いて(型の破損)throw させている
 *  - 「開催日(`kaisai_date`)が無い」: 依頼が開催日を固定するので、実際には必ず入っている。`?? ""` の分岐を固定している
 *  - 「通知の行(`plan-failure`)が既にある」: 判定は 1 回だけなので、判定の前に同じキーの行は作られない。`putReady` の `ON CONFLICT DO NOTHING` を固定している
 *
 * ハーネスは `race-day-plan-characterization.test.ts` と同じ形(ゲートは偽・保存先は偽・ストレージは `node:sqlite`)。通知の送信(`notifier`)は記録する偽。
 * 期待値の作り直し: `CHAR_DUMP=<ファイル> npx vitest run test/race-day-rescue-characterization.test.ts`(比べずに、実出力を書き出す。通常の実行では使わない)。
 */

const jst = (time: string, date = "2026-09-27"): number => Date.parse(`${date}T${time}:00+09:00`);
const DATE = "20260927";
const MIN = 60_000;
/** 21 時の計画(前日の夜)と 23 時の再実行。 */
const T_2100 = jst("21:00", "2026-09-26");
const T_2300 = jst("23:00", "2026-09-26");
/** 判定を待つ上限(救済の要求から 60 分。`plan-failure.ts` の `RESCUE_WATCH_MS`)。 */
const WATCH = 60 * MIN;

// ---- 一覧の HTML(計画の確定に使う最小の写し)----

interface ListRow {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly name: string;
  readonly time: string | null;
  readonly grade?: string;
  readonly kind: "central" | "nar";
}
function listHtml(rows: readonly ListRow[]): string {
  const venues = [...new Set(rows.map((r) => r.venue))];
  return venues
    .map((venue) => {
      const items = rows
        .filter((r) => r.venue === venue)
        .map((r) => {
          const timeMarkup = r.kind === "central" ? `<span class="RaceList_Itemtime">${r.time ?? ""} </span>` : r.time === null ? "<span></span>" : `<span>${r.time}</span>`;
          const grade = r.grade === undefined ? "" : `<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">${r.grade}</span>`;
          return `<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${r.raceId}&rf=race_list">
<div class="Race_Num"><span>${r.raceNumber}R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">${r.name}</span>${grade}</div>
<div class="RaceData">${timeMarkup}<span class="Dart">ダ1200m</span>16頭</div>
</div>
</a>
</li>`;
        })
        .join("\n");
      return `<dl class="RaceList_DataList">
<dt class="RaceList_DataHeader"><p class="RaceList_DataTitle"><small>1回</small> ${venue} <small>1日目</small></p></dt>
<dd class="RaceList_Data"><ul>
${items}
</ul></dd>
</dl>`;
    })
    .join("\n");
}
const central = (n: number, time: string | null): ListRow => ({ raceId: `2026060409${String(n).padStart(2, "0")}`, venue: "中山", raceNumber: n, name: `中央${n}R`, time, kind: "central" });
const nar = (n: number, time: string | null, grade: string | undefined): ListRow => ({
  raceId: `2026360927${String(n).padStart(2, "0")}`,
  venue: "水沢",
  raceNumber: n,
  name: `地方${n}R`,
  time,
  ...(grade === undefined ? {} : { grade }),
  kind: "nar",
});
const EMPTY_HTML = "<html><body></body></html>";
const rid = (n: number): string => `2026060409${String(n).padStart(2, "0")}`;

// ---- 偽のゲート・保存先 ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });
const queueFull = (): GateResult => ({ kind: "refused", reason: "queue-full", message: "待ち行列が上限" });

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly alarms: number[];
  readonly warnings: string[];
  readonly log: string[];
  /** Discord に送ったペイロード(embeds)。 */
  readonly sent: unknown[];
  /** 一覧の取得の応答を先頭から 1 回ずつ消費する(空になれば HTML を返す)。 */
  readonly script: { central: GateResult[]; nar: GateResult[] };
}

interface HarnessOptions {
  readonly central?: readonly ListRow[];
  readonly nar?: readonly ListRow[];
  /** false なら webhook なし(`notifier` を渡さない)。既定は true。 */
  readonly notifier?: boolean;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

const unusedSink: AnalysisSink = {
  save: async () => {
    throw new Error("保存先は使わない");
  },
  findByAnalyzedAt: async () => null,
  findRecentByRace: async () => [],
  countChildren: async () => ({ horses: 0, bets: 0 }),
};

function harness(options: HarnessOptions = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: T_2100 };
  const alarm: { at: number | null } = { at: null };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const log: string[] = [];
  const sent: unknown[] = [];
  const h = { sql, clock, alarm, alarms, warnings, log, sent, script: { central: [], nar: [] } } as unknown as Harness;
  const centralHtml = listHtml(options.central ?? []);
  const narHtml = listHtml(options.nar ?? []);
  const gate: GateLike = {
    async fetchRaw(url): Promise<GateResult> {
      log.push(`gate.fetch ${url}`);
      await Promise.resolve();
      const which = url.startsWith("https://race.netkeiba.com/top/race_list_sub") ? "central" : url.startsWith("https://nar.netkeiba.com/top/race_list_sub") ? "nar" : null;
      if (which === null) return blocked(); // 事前分析の取得は、このテストの主題ではないので、すぐ(再試行なしの)失敗にする
      const next = h.script[which].shift();
      if (next !== undefined) return next;
      return okPage(which === "central" ? centralHtml : narHtml || EMPTY_HTML);
    },
  };
  const loggedSql: SqlLike = {
    exec(query, ...bindings) {
      log.push(`SQL ${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`);
      return sql.exec(query, ...bindings);
    },
  };
  const notifier: DiscordNotifier = {
    send: async (payload) => {
      log.push(`notifier.send ${JSON.stringify(payload.embeds.map((e) => e.title))}`);
      sent.push(payload.embeds);
    },
  };
  const core = new RaceDayCore({
    sql: loggedSql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      log.push(`setAlarm ${at}`);
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: (message) => {
      log.push(`onWarn ${message}`);
      warnings.push(message);
    },
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.notifier === false ? {} : { notifier }),
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

// ---- 特性テスト本体 ----

/** 実出力を期待値と比べる。`CHAR_DUMP=<ファイル>` のときは比べず、期待値を作るために実出力を書き出す(期待値を作り直す手順。通常の実行では使わない)。 */
function check(name: string, actual: unknown): void {
  const dump = process.env.CHAR_DUMP;
  if (dump !== undefined && dump !== "") {
    appendFileSync(dump, `${JSON.stringify([name, actual])}\n`);
    return;
  }
  expect(EXPECTED[name], `${name} の期待値がある(空振りでない)`).toBeDefined();
  expect(actual).toEqual(EXPECTED[name]);
}

function shortSql(line: string): string {
  const at = line.lastIndexOf(" | ");
  if (at < 0 || !line.startsWith("SQL ")) return line;
  try {
    const bindings = (JSON.parse(line.slice(at + 3)) as unknown[]).map((b) => (typeof b === "string" && b.length > 80 ? `<len=${b.length} sha1=${sha1(b).slice(0, 10)}>` : b));
    return `${line.slice(0, at)} | ${JSON.stringify(bindings)}`;
  } catch {
    return line;
  }
}
function runLength(lines: readonly string[]): string[] {
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    count += 1;
    if (lines[i + 1] !== lines[i]) {
      out.push(count === 1 ? lines[i]! : `${lines[i]} ×${count}`);
      count = 0;
    }
  }
  return out;
}

interface Snapshot {
  venues: unknown[];
  plan: unknown[];
  tasks: unknown[];
  notify: unknown[];
  meta: unknown[];
}
/** 状態の写し(会場・計画の行・タスク・通知の行〈本文は JSON を開く〉・計画と救済の meta)。ハーネスの生の SQL で読む(ログに載せない)。 */
function snapshot(h: Harness): Snapshot {
  return {
    venues: h.sql.exec("SELECT venue, state, attempts, next_try_at, reason, listed, targeted, updated_at FROM race_day_plan_venue ORDER BY venue").toArray(),
    plan: h.sql.exec("SELECT race_id, venue, state, skip_reason, due_ms, planned_at FROM race_day_plan ORDER BY race_id").toArray(),
    tasks: h.sql.exec("SELECT race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error FROM race_day_tasks ORDER BY race_id, mode").toArray(),
    notify: (h.sql.exec("SELECT key, kind, state, payload_json, created_at, updated_at, error_class FROM race_day_notify ORDER BY key").toArray() as { payload_json: string | null }[]).map((r) => ({
      ...r,
      payload_json: r.payload_json === null ? null : JSON.parse(r.payload_json),
    })),
    meta: h.sql.exec("SELECT key, value FROM race_day_meta WHERE key LIKE 'plan_%' OR key = 'kaisai_date' ORDER BY key").toArray(),
  };
}

/**
 * events に残す行: 計画・会場・タスク・通知の表と meta への**書き込み**(INSERT・UPDATE・DELETE)、取得・警告・アラーム・通知の送信。
 * 読み取りの SQL とキャッシュなどの他の SQL は `sqlSha1` だけで固定する(量を抑える。読み取りの順序が変わっても `sqlSha1` が変わる)。
 */
const RELEVANT = /^(SQL (INSERT|UPDATE|DELETE) .*(race_day_plan_venue|race_day_plan|race_day_tasks|race_day_notify|race_day_meta)|gate\.fetch |onWarn |setAlarm |notifier\.send )/;

interface Trace {
  readonly label: string;
  readonly threw: string | null;
  readonly at: number;
  readonly warnings: string[];
  readonly alarms: number[];
  readonly events: string[];
  readonly sqlCount: number;
  readonly sqlSha1: string;
  readonly sent: unknown[];
  readonly state: Snapshot;
}

/** `act` を 1 回動かし、その間に起きたことを集める。reject はメッセージだけ残す。 */
async function capture(h: Harness, act: () => Promise<string>): Promise<Trace> {
  const w = h.warnings.length;
  const a = h.alarms.length;
  const s = h.log.length;
  const n = h.sent.length;
  h.alarm.at = null;
  let outcomeLabel: string;
  let threw: string | null = null;
  try {
    outcomeLabel = await act();
  } catch (error) {
    outcomeLabel = "THROW";
    threw = error instanceof Error ? error.message : String(error);
  }
  const lines = h.log.slice(s);
  const sqlLines = lines.filter((l) => l.startsWith("SQL "));
  return {
    label: outcomeLabel,
    threw,
    at: h.clock.now,
    warnings: h.warnings.slice(w),
    alarms: h.alarms.slice(a),
    events: runLength(lines.filter((l) => RELEVANT.test(l)).map(shortSql)),
    sqlCount: sqlLines.length,
    sqlSha1: sha1(sqlLines.join("\n")),
    sent: h.sent.slice(n),
    state: snapshot(h),
  };
}

/** `at` まで時計を進めて 1 ステップ動かす。 */
function stepTrace(h: Harness, at: number): Promise<Trace> {
  h.clock.now = Math.max(h.clock.now, at);
  return capture(h, async () => label(await h.core.runNextStep()));
}
/** `at` まで時計を進めて計画を依頼する(`rescue` を渡す/渡さない)。 */
function requestTrace(h: Harness, at: number, rescue: boolean | undefined): Promise<Trace> {
  h.clock.now = Math.max(h.clock.now, at);
  return capture(h, async () => JSON.stringify(await h.core.requestPlan({ kaisaiDate: DATE, ...(rescue === undefined ? {} : { rescue }) })));
}
/** アラームの時刻で、`max` 回まで(アラームが無くなれば止める)。`until` を超える時刻のアラームは進めない。 */
async function drive(h: Harness, max: number, until = Number.POSITIVE_INFINITY): Promise<Trace[]> {
  const out: Trace[] = [];
  while (out.length < max && h.alarm.at !== null && h.alarm.at <= until) {
    out.push(await stepTrace(h, h.alarm.at));
  }
  return out;
}

const meta = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};

/** 21 時の計画を、確定の印が付くまで進める(確定のあとの事前分析〈morning〉は動かさない。会場の一覧の失敗は `script` で作る)。 */
async function settle21(h: Harness): Promise<void> {
  h.clock.now = T_2100;
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  for (let i = 0; i < 12 && meta(h, "plan_finalized_at") === null; i += 1) {
    const at = h.alarm.at;
    if (at === null) throw new Error("確定の前にアラームが無くなった");
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    await h.core.runNextStep();
  }
  expect(meta(h, "plan_finalized_at"), "前提: 確定している").not.toBeNull();
}

/** そのレースの morning の状態を直接書く(実行中・失敗・完了を作る)。 */
function setMorning(h: Harness, raceId: string, status: "queued" | "fetched" | "done" | "failed", attempts: number): void {
  h.sql.exec(
    "UPDATE race_day_tasks SET status = ?, attempts = ?, compute_attempts = ?, updated_at = ?, error = ? WHERE race_id = ? AND mode = 'morning'",
    status,
    attempts,
    status === "fetched" ? 1 : 0,
    T_2100,
    status === "failed" ? "テストの失敗" : null,
    raceId,
  );
}
const allMorning = (h: Harness, status: "done" | "failed"): void => {
  h.sql.exec("UPDATE race_day_tasks SET status = ?, attempts = 1, updated_at = ?, error = ? WHERE mode = 'morning'", status, T_2100, status === "failed" ? "テストの失敗" : null);
};

/** まとめ(summary)の通知を送信済みにする(まとめの送信のアラームが、判定のアラームの観測に混ざらないようにする)。 */
function seedSummarySent(h: Harness): void {
  h.sql.exec(
    "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES ('summary', 'summary', 'sent', '{\"title\":\"送信済みのまとめ\"}', NULL, ?, ?, NULL)",
    T_2100,
    T_2100,
  );
}

type Scenario = { readonly options?: HarnessOptions; readonly run: (h: Harness) => Promise<unknown> };

const ONE: HarnessOptions = { central: [central(1, "10:00")] };
const SIX: HarnessOptions = { central: [1, 2, 3, 4, 5, 6].map((n) => central(n, `${String(9 + n).padStart(2, "0")}:00`)) };
const MIXED: HarnessOptions = { central: [central(1, "10:00"), central(2, "10:30")], nar: [nar(1, "11:00", "Jpn3")] };
const NO_WEBHOOK = (base: HarnessOptions): HarnessOptions => ({ ...base, notifier: false });

const SCENARIOS: Record<string, Scenario> = {
  // ---- 救済(rescuePlan。requestPlan の rescue)----
  "救済: 地方の一覧が failed で確定済み → 地方だけを pending に戻し、確定の印を外す(記録 → 会場 → 確定の印の順)。そのあと取り直しと再確定": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request, traces: await drive(h, 6) };
    },
  },
  "救済: 中央も地方も failed で確定済み → 両方を戻す(試行 0・今すぐ)。取り直しの回数は会場ごとに 1 回": {
    options: MIXED,
    run: async (h) => {
      h.script.central.push(blocked());
      h.script.nar.push(blocked());
      await settle21(h);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request, traces: await drive(h, 6) };
    },
  },
  "救済: 会場は失敗していない(failed の morning だけ)→ 確定の印を外さない。planned の failed の morning だけを新しい実行として積み直す(試行 0)": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(1), "failed", 3);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request };
    },
  },
  "救済: planned の failed だけを積み直す。実行中(queued・fetched)・done・スキップ・昇格済み(promoted)の行は触れない": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      setMorning(h, rid(1), "failed", 3); // planned + failed → 積み直す
      setMorning(h, rid(2), "queued", 1); // 実行中 → 触れない
      setMorning(h, rid(3), "fetched", 1); // 実行中 → 触れない
      setMorning(h, rid(4), "done", 1); // 完了 → 触れない
      h.sql.exec("UPDATE race_day_plan SET state = 'skipped', disposition = 'skip', skip_reason = 'manual', due_ms = NULL WHERE race_id = ?", rid(5));
      setMorning(h, rid(5), "failed", 2); // スキップ + failed → 触れない
      h.sql.exec("UPDATE race_day_plan SET state = 'promoted', promoted_at = ? WHERE race_id = ?", T_2100, rid(6));
      setMorning(h, rid(6), "failed", 2); // 昇格済み + failed → 触れない
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request };
    },
  },
  "救済: 会場の失敗と failed の morning の両方 → 会場を戻して確定の印を外し、そのうえで failed の morning を積み直す。続けて取り直しと再確定": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      setMorning(h, rid(1), "failed", 3);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request, traces: await drive(h, 5) };
    },
  },
  "救済: 記録(plan_rescue_at)が既にある → 会場が failed でも morning が failed でも何も変えない(アラームの張り直しだけ)": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      setMorning(h, rid(1), "failed", 3);
      h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_rescue_at', ?)", String(T_2100));
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      return { before, request };
    },
  },
  "救済: rescue を渡さない呼び出し(重複の配信)は、失敗があっても救済しない・記録も付けない": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      setMorning(h, rid(1), "failed", 3);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, undefined);
      const falseRequest = await requestTrace(h, T_2300 + MIN, false);
      return { before, request, falseRequest };
    },
  },
  "救済: 未計画の日への最初の呼び出しが rescue → 通常どおり受理し、救済の記録も付ける(救済する失敗はまだ無い)": {
    options: ONE,
    run: async (h) => {
      const request = await requestTrace(h, T_2300, true);
      return { request, traces: await drive(h, 4) };
    },
  },
  "救済: 2 回目の rescue は何も変えない(1 回目で戻した会場が再び failed になっても、再度は戻さない)": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked(), blocked());
      await settle21(h);
      const first = await requestTrace(h, T_2300, true);
      const drove = await drive(h, 6);
      const before = snapshot(h);
      const second = await requestTrace(h, T_2300 + 5 * MIN, true);
      return { first, drove, before, second };
    },
  },

  // ---- 失敗の判定(judgeRescue)と通知の材料 ----
  "判定: webhook なし(notifier なし)→ 失敗が残っても判定しない・材料も行も積まない・判定のためのアラームも張らない": {
    options: NO_WEBHOOK(MIXED),
    run: async (h) => {
      h.script.nar.push(blocked(), blocked());
      await settle21(h);
      const request = await requestTrace(h, T_2300, true);
      return { request, traces: await drive(h, 8, T_2300 + 3 * WATCH), verdict: meta(h, "plan_rescue_verdict") };
    },
  },
  "判定: 判定済み(plan_rescue_verdict が既にある)→ 再判定しない・材料を積まない・判定のためのアラームも張らない": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked(), blocked());
      await settle21(h);
      h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_rescue_verdict', 'ok')");
      const request = await requestTrace(h, T_2300, true);
      return { request, traces: await drive(h, 8, T_2300 + 3 * WATCH), verdict: meta(h, "plan_rescue_verdict") };
    },
  },
  "判定: 救済の要求が無い(rescue なし。21 時だけ)→ 失敗が残っていても判定しない・材料も積まない・判定のためのアラームも張らない": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      allMorning(h, "failed");
      const request = await requestTrace(h, T_2300, undefined);
      return { request, traces: await drive(h, 8, T_2300 + 3 * WATCH), verdict: meta(h, "plan_rescue_verdict") };
    },
  },
  "判定 ok: 救済しても失敗が無い → verdict = ok を永続化。通知の材料は積まない。落ち着いているので判定のアラームは今": {
    options: MIXED,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 4, T_2300 + 3 * WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict") };
    },
  },
  "判定 failed(F2。会場の失敗が残る): 材料(plan-failure の ready の行)を積んでから verdict = failed を永続化する(この順)。通知が 1 通送られ、そのあとの起床では再判定しない": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked(), blocked());
      await settle21(h);
      allMorning(h, "done");
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 8, T_2300 + 3 * WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 failed(F3 だけ。会場は ok・morning が failed のまま): 「予定どおり」の文面(会場の案内なし)。材料の時刻は判定の時刻": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(2), "failed", 3);
      setMorning(h, rid(5), "failed", 3);
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 8, T_2300 + 3 * WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 failed(F3 だけ。昇格済みの行の morning が failed — 救済では積み直されない): 依頼の直後の起床で判定する(「予定どおり」の文面)": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      h.sql.exec("UPDATE race_day_plan SET state = 'promoted', promoted_at = ? WHERE race_id = ?", T_2100, rid(2));
      setMorning(h, rid(2), "failed", 3);
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 4, T_2300 + WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "アラーム(webhook あり): 落ち着いた日の救済 → 判定のアラームは今(ほかに候補が無い。まとめは送信済み)。判定したあとは候補なし": {
    options: ONE,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      seedSummarySent(h);
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      const step = await stepTrace(h, T_2300);
      return { before, request, step };
    },
  },
  "アラーム(webhook なし): 同じ日の救済 → 判定のアラームを張らない(ほかに候補が無いので、掃除の時刻だけ)": {
    options: NO_WEBHOOK(ONE),
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      const before = snapshot(h);
      const request = await requestTrace(h, T_2300, true);
      const step = await stepTrace(h, T_2300);
      return { before, request, step };
    },
  },
  "判定 wait → 落ち着く: 救済で戻した会場が再試行待ち(pending)のあいだは判定しない(材料も積まない)。再試行が尽きて failed になった起床で判定する": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      allMorning(h, "done");
      h.script.nar.push(queueFull(), queueFull(), queueFull());
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 10, T_2300 + 3 * WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 wait → 期限(F4): 事前分析が実行中のまま。依頼の直後のアラームは再試行の時刻(60 秒後。判定の期限〈rescueAt + 60 分〉ではない)、期限の 10 秒前の張り直しでは判定の期限にアラームを張る。期限の 1 ミリ秒前は判定せず、期限で failed(未完了 1 件)": {
    options: ONE,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(1), "queued", 1);
      seedSummarySent(h);
      const rescue = await requestTrace(h, T_2300, true);
      const deadline = T_2300 + WATCH;
      const early = await requestTrace(h, deadline - 10_000, undefined); // rearm: 判定の期限が再試行(60 秒後)より早い
      const justBefore = await requestTrace(h, deadline - 1, undefined);
      const onTime = await stepTrace(h, deadline);
      const after = await requestTrace(h, deadline + MIN, undefined); // 判定済み: 判定のためのアラームを張らない
      return { rescue, early, justBefore, onTime, after, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定: 期限(rescueAt + 60 分)が来たら、落ち着いていなくても判定する(会場が pending・確定の印が外れたまま。計画が確定していない F1 の failed)。期限の 1 ミリ秒前は判定しない・そのアラームは判定の期限": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked());
      await settle21(h);
      allMorning(h, "done");
      const request = await requestTrace(h, T_2300, true);
      // 取り直しの会場を、期限まで進まないよう直接 pending のまま止める(next_try_at を遠い未来に)
      h.sql.exec("UPDATE race_day_plan_venue SET next_try_at = ? WHERE venue = 'nar'", T_2300 + 5 * WATCH);
      const early = await requestTrace(h, T_2300 + WATCH - 1, undefined);
      const onTime = await stepTrace(h, T_2300 + WATCH);
      return { request, early, onTime, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定: 判定の永続化の前後で状態が変わる(now・metaGet・getPlanProgress は呼ぶたびに読む): 判定のあと、事前分析が failed になっても再判定しない・通知は増えない": {
    options: MIXED,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      const request = await requestTrace(h, T_2300, true);
      const first = await drive(h, 3, T_2300 + WATCH);
      allMorning(h, "failed");
      const later = await requestTrace(h, T_2300 + 10 * MIN, undefined);
      const again = await stepTrace(h, T_2300 + 20 * MIN);
      return { request, first, later, again, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 failed: 時計が進んでから判定する(材料の created_at・updated_at は判定の起床の時刻。依頼の時刻に固定しない)": {
    options: MIXED,
    run: async (h) => {
      h.script.nar.push(blocked(), blocked());
      await settle21(h);
      allMorning(h, "done");
      h.sql.exec("UPDATE race_day_plan_venue SET next_try_at = ? WHERE venue = 'nar'", T_2300 + 20 * MIN);
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 5, T_2300 + WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict") };
    },
  },
  "判定 failed: 材料の組み立てが throw → 警告を出して最小の通知に代える(判定は止めない)【到達不能・記録: 計画の行の race_name に BLOB を直接書いて throw させる】": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(2), "failed", 3);
      h.sql.exec("UPDATE race_day_plan SET race_name = x'00ff' WHERE race_id = ?", rid(2));
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 5, T_2300 + WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 failed: 開催日(kaisai_date)が無い → 日付不明の見出し(?? \"\" の分岐)【到達不能・記録: 開催日は依頼が固定する】": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(2), "failed", 3);
      const request = await requestTrace(h, T_2300, true);
      h.sql.exec("DELETE FROM race_day_meta WHERE key = 'kaisai_date'");
      const traces = await drive(h, 5, T_2300 + WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
  "判定 failed: 同じキーの通知の行(plan-failure)が既にある → 材料は積み直さない(ON CONFLICT DO NOTHING)が、判定は永続化する。再送もしない【到達不能・記録】": {
    options: SIX,
    run: async (h) => {
      await settle21(h);
      allMorning(h, "done");
      setMorning(h, rid(2), "failed", 3);
      h.sql.exec(
        "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES ('plan-failure', 'plan-failure', 'sent', '{\"title\":\"先に積まれた行\"}', NULL, ?, ?, NULL)",
        T_2100,
        T_2100,
      );
      const request = await requestTrace(h, T_2300, true);
      const traces = await drive(h, 5, T_2300 + WATCH);
      return { request, traces, verdict: meta(h, "plan_rescue_verdict"), sent: h.sent };
    },
  },
};

describe("Issue #399(R-9e e3): 救済の段階を切り出す前の挙動(特性テスト)", () => {
  it("前提: 場面を数え直す(期待値の取りこぼしが無い)", () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThanOrEqual(15);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(RETRY_DELAY_MS).toBe(60_000);
    if (process.env.CHAR_DUMP === undefined || process.env.CHAR_DUMP === "") {
      expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(SCENARIOS).sort());
    }
  });
  it.each(Object.keys(SCENARIOS))("%s", async (name) => {
    const def = SCENARIOS[name]!;
    const h = harness(def.options);
    check(name, await def.run(h));
  });
});

/** 切り出す前のコード(63f6163)の実出力。`CHAR_DUMP` で作り直せる。 */
const EXPECTED: Record<string, unknown> = {
 "救済: 地方の一覧が failed で確定済み → 地方だけを pending に戻し、確定の印を外す(記録 → 会場 → 確定の印の順)。そのあと取り直しと再確定": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=153 sha1=9358bdcc35>\",1790431200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 41,
    "sqlSha1": "6cbeed6cdf270973ac6f422d450170e1e827d594",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790431200000,1790431200000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 55,
    "sqlSha1": "27cae006590876eeaf79d184f684b1584336ed41",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "378b3b0fc2424cc631ff2328e11b757fa8c12d69",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "44bc281db13b7947db3d41c6aa696c48426a96e3",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202636092701:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202636092701\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202636092701\",\"morning\"]",
     "gate.fetch https://nar.netkeiba.com/race/shutuba.html?race_id=202636092701",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202636092701\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "1877f6714d0e9364248104dd0a44b9dc7726c39f",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=278 sha1=846b2ff116>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431200000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "779582985abcde481e9299afc449f1c1b8d255ea",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 3 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n水沢 1R 地方1R 11:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 3 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n水沢 1R 地方1R 11:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
 },
 "救済: 中央も地方も failed で確定済み → 両方を戻す(試行 0・今すぐ)。取り直しの回数は会場ごとに 1 回": {
  "before": {
   "venues": [
    {"venue":"central","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
   ],
   "plan": [],
   "tasks": [],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"central\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 33,
   "sqlSha1": "eb269386efe7c10f5723f8d7787223ddc7efe78c",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [],
    "tasks": [],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790431200000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 40,
    "sqlSha1": "ef1822d9b6d8ea122ded882519f8d9c931d4fc89",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":null,"updated_at":1790431200000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [],
     "tasks": [],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=153 sha1=9358bdcc35>\",1790431200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 44,
    "sqlSha1": "d4ca6938f911a0177bae851a554ec08ebc56143e",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":null,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [],
     "tasks": [],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790431200000,1790431200000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 72,
    "sqlSha1": "b684b3edfaa85fe6fe7797af80117a154814bbc2",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":2,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790431200000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "378b3b0fc2424cc631ff2328e11b757fa8c12d69",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":2,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790431200000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "44bc281db13b7947db3d41c6aa696c48426a96e3",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":2,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790431200000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202636092701:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202636092701\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202636092701\",\"morning\"]",
     "gate.fetch https://nar.netkeiba.com/race/shutuba.html?race_id=202636092701",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202636092701\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "1877f6714d0e9364248104dd0a44b9dc7726c39f",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":2,"targeted":2,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790431200000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
  ],
 },
 "救済: 会場は失敗していない(failed の morning だけ)→ 確定の印を外さない。planned の failed の morning だけを新しい実行として積み直す(試行 0)": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
    {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
    {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
    {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 35,
   "sqlSha1": "5082bc982fd079d1b8b926d5e70b117ff535caa1",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
 },
 "救済: planned の failed だけを積み直す。実行中(queued・fetched)・done・スキップ・昇格済み(promoted)の行は触れない": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
    {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
    {"race_id":"202606040905","venue":"central","state":"skipped","skip_reason":"manual","due_ms":null,"planned_at":1790424000000},
    {"race_id":"202606040906","venue":"central","state":"promoted","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040902","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040903","mode":"morning","status":"fetched","attempts":1,"compute_attempts":1,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    {"race_id":"202606040905","mode":"morning","status":"failed","attempts":2,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040906","mode":"morning","status":"failed","attempts":2,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 35,
   "sqlSha1": "5082bc982fd079d1b8b926d5e70b117ff535caa1",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"skipped","skip_reason":"manual","due_ms":null,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"promoted","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"fetched","attempts":1,"compute_attempts":1,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"failed","attempts":2,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040906","mode":"morning","status":"failed","attempts":2,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
 },
 "救済: 会場の失敗と failed の morning の両方 → 会場を戻して確定の印を外し、そのうえで failed の morning を積み直す。続けて取り直しと再確定": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 34,
   "sqlSha1": "bd5196af7b7d0dc1a85d2ff6111f48aa76de33c3",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=153 sha1=9358bdcc35>\",1790431200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 41,
    "sqlSha1": "6cbeed6cdf270973ac6f422d450170e1e827d594",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790431200000,1790431200000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 55,
    "sqlSha1": "27cae006590876eeaf79d184f684b1584336ed41",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "44bc281db13b7947db3d41c6aa696c48426a96e3",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "378b3b0fc2424cc631ff2328e11b757fa8c12d69",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202636092701:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202636092701\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202636092701\",\"morning\"]",
     "gate.fetch https://nar.netkeiba.com/race/shutuba.html?race_id=202636092701",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202636092701\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202636092701。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "1877f6714d0e9364248104dd0a44b9dc7726c39f",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
  ],
 },
 "救済: 記録(plan_rescue_at)が既にある → 会場が failed でも morning が failed でも何も変えない(アラームの張り直しだけ)": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
    {"key":"plan_rescue_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["setAlarm 1790431200000"],
   "sqlCount": 30,
   "sqlSha1": "480281d9e7a394572ae53f435067c1b3f172c446",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790424000000"},
    ],
   },
  },
 },
 "救済: rescue を渡さない呼び出し(重複の配信)は、失敗があっても救済しない・記録も付けない": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["setAlarm 1790431200000"],
   "sqlCount": 23,
   "sqlSha1": "1ed6243c6588ddc768d72df643b8fbf0e9c70bf4",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
    ],
   },
  },
  "falseRequest": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431260000,
   "warnings": [],
   "alarms": [1790431260000],
   "events": ["setAlarm 1790431260000"],
   "sqlCount": 23,
   "sqlSha1": "1ed6243c6588ddc768d72df643b8fbf0e9c70bf4",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
    ],
   },
  },
 },
 "救済: 未計画の日への最初の呼び出しが rescue → 通常どおり受理し、救済の記録も付ける(救済する失敗はまだ無い)": {
  "request": {
   "label": "{\"accepted\":true}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?) | [\"20260927\"]",
    "SQL INSERT INTO race_day_plan_venue (venue, state, attempts, next_try_at, reason, listed, targeted, entries_json, updated_at) VALUES (?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?) ON CONFLICT(venue) DO NOTHING | [\"central\",1790431200000,1790431200000]",
    "SQL INSERT INTO race_day_plan_venue (venue, state, attempts, next_try_at, reason, listed, targeted, entries_json, updated_at) VALUES (?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?) ON CONFLICT(venue) DO NOTHING | [\"nar\",1790431200000,1790431200000]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_requested_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "3c153f47ab33ba197e73e3bc1dc753652a13debe",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [],
    "tasks": [],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_requested_at","value":"1790431200000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790431200000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 40,
    "sqlSha1": "43b022a3d23ea7e32a8ce996836dd6c4f67dd618",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":null,"updated_at":1790431200000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [],
     "tasks": [],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790431200000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790431200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 42,
    "sqlSha1": "9958f242cf7a0e228d26b2ac79784abeecbc99b2",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":null,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":0,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [],
     "tasks": [],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_requested_at","value":"1790431200000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790431200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790431200000,1790431200000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 58,
    "sqlSha1": "f19f911f21f7838403d25c174c7001a326ccc9f0",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":0,"targeted":0,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790431200000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "9ff64a8e7146a291d8d63d625ea61b5bb91cd4dd",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":1,"targeted":1,"updated_at":1790431200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790431200000,"reason":null,"listed":0,"targeted":0,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790431200000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790431200000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
  ],
 },
 "救済: 2 回目の rescue は何も変えない(1 回目で戻した会場が再び failed になっても、再度は戻さない)": {
  "first": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "drove": [
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790431200000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 38,
    "sqlSha1": "41a3baf80586ea06ec7d08c785b77b509ea29527",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 46,
    "sqlSha1": "3d6fec03f9a99b8f4e05213169a1a23df4974c10",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "378b3b0fc2424cc631ff2328e11b757fa8c12d69",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "197027ae17edc7d5d986d837762a8c938990865e",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=309 sha1=f574cadf87>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431200000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "52e9834bc16b258c89d6acf2b83b90209b140c5e",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n事前分析: 失敗 2 件 / 未完了 0 件\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n事前分析: 失敗 2 件 / 未完了 0 件\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=290 sha1=713a3368a6>\",null,1790431201000,1790431201000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "3c596d8979931e55aa1dc7459fd6991f9c9fd92c",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n事前分析: 失敗 2 件 / 未完了 0 件\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
        ],
       },
       "created_at": 1790431201000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
    {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
   ],
   "notify": [
    {
     "key": "plan-failure",
     "kind": "plan-failure",
     "state": "sent",
     "payload_json": {
      "title": "事前分析の失敗 2026/09/27(日)",
      "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n事前分析: 失敗 2 件 / 未完了 0 件\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
      "color": 13639744,
      "fields": [
       {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
      ],
     },
     "created_at": 1790431200000,
     "updated_at": 1790431200000,
     "error_class": null,
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "payload_json": {
      "title": "事前分析 2026/09/27(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
      "color": 13639744,
      "fields": [
       {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
       {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
      ],
     },
     "created_at": 1790431201000,
     "updated_at": 1790431201000,
     "error_class": null,
    },
   ],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790431200000"},
    {"key":"plan_finalized_at","value":"1790431200000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
    {"key":"plan_rescue_at","value":"1790431200000"},
    {"key":"plan_rescue_verdict","value":"failed"},
   ],
  },
  "second": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431500000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["setAlarm 1790468100000"],
   "sqlCount": 23,
   "sqlSha1": "ffbf01d66203de689aa3bc7df5d8f8e148986596",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
    ],
    "notify": [
     {
      "key": "plan-failure",
      "kind": "plan-failure",
      "state": "sent",
      "payload_json": {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n事前分析: 失敗 2 件 / 未完了 0 件\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 事前分析失敗\n中山 2R 中央2R 10:30 事前分析失敗"},
       ],
      },
      "created_at": 1790431200000,
      "updated_at": 1790431200000,
      "error_class": null,
     },
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
      "created_at": 1790431201000,
      "updated_at": 1790431201000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790431200000"},
     {"key":"plan_finalized_at","value":"1790431200000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"failed"},
    ],
   },
  },
 },
 "判定: webhook なし(notifier なし)→ 失敗が残っても判定しない・材料も行も積まない・判定のためのアラームも張らない": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 14,
   "sqlSha1": "6dddaccf7bea1e39a8b914fdcd4e3b4b05911dbf",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790431200000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 20,
    "sqlSha1": "cbbbf21caa929356311a1a219c8a69f57abfa189",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 27,
    "sqlSha1": "b70341e9a5ce187a30c88afa73e3bcb111ec7224",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 24,
    "sqlSha1": "49b7a533b7b6ff1fab0fb5f486e79451f426e43f",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790468100000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 25,
    "sqlSha1": "fb1d2da12b10f99f3336efea2a60b44aab905e9d",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
  ],
  "verdict": null,
 },
 "判定: 判定済み(plan_rescue_verdict が既にある)→ 再判定しない・材料を積まない・判定のためのアラームも張らない": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 25,
   "sqlSha1": "64b8ed22400da2401bf0d01883fcd3cb06a97b29",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"ok"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790431200000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 31,
    "sqlSha1": "a2ae18178b8e888ec48aed3399488fa203e24fc8",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 39,
    "sqlSha1": "b8e786d4d9b3087a6bcc5a10474e7b8b5a7cebb8",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
   {
    "label": "202606040901:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040901\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040901\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040901",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040901\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 48,
    "sqlSha1": "9bd265fb1f147a776063dbb8abf85df016d8fd48",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 49,
    "sqlSha1": "fbdf7a801e3f1abd625f0ee49db146bc592e34f1",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=290 sha1=713a3368a6>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "0a891fcd880bee8c0932e9537e42bbe827ac7918",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
  ],
  "verdict": "ok",
 },
 "判定: 救済の要求が無い(rescue なし。21 時だけ)→ 失敗が残っていても判定しない・材料も積まない・判定のためのアラームも張らない": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["setAlarm 1790431200000"],
   "sqlCount": 23,
   "sqlSha1": "1ed6243c6588ddc768d72df643b8fbf0e9c70bf4",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=290 sha1=713a3368a6>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 52,
    "sqlSha1": "f26ad5eb6129c8d4e81e3fed404bb06bddd17f29",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790424000000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 2 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析失敗\n2R 中央2R 10:30 事前分析失敗"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
     ],
    },
   },
  ],
  "verdict": null,
 },
 "判定 ok: 救済しても失敗が無い → verdict = ok を永続化。通知の材料は積まない。落ち着いているので判定のアラームは今": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790431200000"],
   "sqlCount": 33,
   "sqlSha1": "07c46a6e2126cb190784689e87b236167fbe9a7e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202636092701","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"ok\"]",
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=263 sha1=d88bdc256c>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 58,
    "sqlSha1": "e6c02d8b025a9b1fb1a45d20b7fba9d9873a2d0c",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
       "color": 40563,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
         {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
  ],
  "verdict": "ok",
 },
 "判定 failed(F2。会場の失敗が残る): 材料(plan-failure の ready の行)を積んでから verdict = failed を永続化する(この順)。通知が 1 通送られ、そのあとの起床では再判定しない": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790431200000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 39,
    "sqlSha1": "eb34d4c5dcc98658fa724313c1ebf67cac4b97ce",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 47,
    "sqlSha1": "8715618756c11f4cbb85cdf555897bd6cca23a75",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=205 sha1=f4116ceaea>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431200000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "d44f756c2f321e3a1c0c13f57c81ef2f4ecdbaed",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=290 sha1=2abd7309b0>\",null,1790431201000,1790431201000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "ac721a18c7645cd5093b8135623c3a2b1cbea38d",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
        ],
       },
       "created_at": 1790431201000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
     "color": 13639744,
     "fields": [],
    },
   ],
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
     "color": 13639744,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
      {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
     ],
    },
   ],
  ],
 },
 "判定 failed(F3 だけ。会場は ok・morning が failed のまま): 「予定どおり」の文面(会場の案内なし)。材料の時刻は判定の時刻": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790431200000,1790431200000]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040905\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 37,
   "sqlSha1": "08d3f546a866c4360a83f481ceeeaf3fa2345331",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=357 sha1=3aee9684ae>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "17e6403f244e262c73f48e981d27d8876a6de244",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
       "color": 15113984,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 62,
    "sqlSha1": "44bc281db13b7947db3d41c6aa696c48426a96e3",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040905:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040905。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040905\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040905\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040905",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040905\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040905。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "011396da30240b5b2fb804814ae98ee15c61b4dc",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "idle",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=253 sha1=b7a81e9a14>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "9e403e6308676178aab1f3e6c9eb01c79e6557af",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "ready",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 2 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗\n中山 5R 中央5R 14:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431201000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 44,
    "sqlSha1": "c2fca56970488b9a8282d6e732d6810687449ad9",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 2 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗\n中山 5R 中央5R 14:00 事前分析失敗"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 2 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗\n中山 5R 中央5R 14:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 4 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
     "color": 15113984,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 未完了\n6R 中央6R 15:00 事前分析OK"},
      {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
     ],
    },
   ],
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 2 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
     "color": 13639744,
     "fields": [
      {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗\n中山 5R 中央5R 14:00 事前分析失敗"},
     ],
    },
   ],
  ],
 },
 "判定 failed(F3 だけ。昇格済みの行の morning が failed — 救済では積み直されない): 依頼の直後の起床で判定する(「予定どおり」の文面)": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790431200000"],
   "sqlCount": 33,
   "sqlSha1": "07c46a6e2126cb190784689e87b236167fbe9a7e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"promoted","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=228 sha1=f7280c0e45>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431200000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "235f7a56edd07b877b1a950dde15d43f1f2ad6f7",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"promoted","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=342 sha1=5f8e9d2ec9>\",null,1790431201000,1790431201000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "f286c1bab03d34b08bd870e7b6453c4dca02cb76",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 1 / 未完了 0\n発走の 45 分前に自動で分析します",
       "color": 15113984,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 事前分析失敗\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"promoted","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":3,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 1 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 事前分析失敗\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431201000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
     "color": 13639744,
     "fields": [
      {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
     ],
    },
   ],
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 1 / 未完了 0\n発走の 45 分前に自動で分析します",
     "color": 15113984,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 事前分析失敗\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
      {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
     ],
    },
   ],
  ],
 },
 "アラーム(webhook あり): 落ち着いた日の救済 → 判定のアラームは今(ほかに候補が無い。まとめは送信済み)。判定したあとは候補なし": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "payload_json": {
      "title": "送信済みのまとめ",
     },
     "created_at": 1790424000000,
     "updated_at": 1790424000000,
     "error_class": null,
    },
   ],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790431200000"],
   "sqlCount": 33,
   "sqlSha1": "07c46a6e2126cb190784689e87b236167fbe9a7e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "step": {
   "label": "idle",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"ok\"]","setAlarm 1790468100000"],
   "sqlCount": 52,
   "sqlSha1": "c417422d73ce2c392cf5ced252dd50b87b32a26e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"ok"},
    ],
   },
  },
 },
 "アラーム(webhook なし): 同じ日の救済 → 判定のアラームを張らない(ほかに候補が無いので、掃除の時刻だけ)": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
   ],
   "notify": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790424000000"},
    {"key":"plan_finalized_at","value":"1790424000000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790424000000"},
   ],
  },
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790468100000"],
   "sqlCount": 14,
   "sqlSha1": "0778480597ee76c01ab3b7be0bdd16b21cfdde9a",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "step": {
   "label": "idle",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["setAlarm 1790468100000"],
   "sqlCount": 20,
   "sqlSha1": "f8df92632e1a5c700f2366f7a8f04af411b598be",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
 },
 "判定 wait → 落ち着く: 救済で戻した会場が再試行待ち(pending)のあいだは判定しない(材料も積まない)。再試行が尽きて failed になった起床で判定する": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:retry",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431260000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790431260000,\"busy\",1790431200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431260000",
    ],
    "sqlCount": 34,
    "sqlSha1": "72b43ff649d2332e32169a96788a2030c4202d19",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"pending","attempts":1,"next_try_at":1790431260000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:retry",
    "threw": null,
    "at": 1790431260000,
    "warnings": [],
    "alarms": [1790431320000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790431260000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790431320000,\"busy\",1790431260000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524920000\"]",
     "setAlarm 1790431320000",
    ],
    "sqlCount": 34,
    "sqlSha1": "c5862d8675552e1a9d362d144801b3989f8c7e5a",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"pending","attempts":2,"next_try_at":1790431320000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431260000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431320000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 3 回。理由: busy)"],
    "alarms": [1790431320000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [3,1790431320000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"busy\",1790431320000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 3 回。理由: busy)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431320000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524980000\"]",
     "setAlarm 1790431320000",
    ],
    "sqlCount": 39,
    "sqlSha1": "14ae057842e30c16a588774b90f6ce31cd3c3bb9",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":3,"next_try_at":1790431320000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431320000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431320000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431320000,
    "warnings": [],
    "alarms": [1790431320000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431320000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524980000\"]",
     "setAlarm 1790431320000",
    ],
    "sqlCount": 47,
    "sqlSha1": "dd4c9c3e2e33cebe8e163b6e1f452b0430995578",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":3,"next_try_at":1790431320000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431320000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431320000"},
      {"key":"plan_finalized_at","value":"1790431320000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431320000,
    "warnings": [],
    "alarms": [1790431321000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=202 sha1=e2185e69bc>\",null,1790431320000,1790431320000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431320000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431320000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431321000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524980000\"]",
     "setAlarm 1790431321000",
    ],
    "sqlCount": 60,
    "sqlSha1": "afe8f0889985ca4522d9d51143a618fd027cefc2",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(混雑)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":3,"next_try_at":1790431320000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431320000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(混雑)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431320000,
       "updated_at": 1790431320000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431320000"},
      {"key":"plan_finalized_at","value":"1790431320000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431321000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=284 sha1=0e4bdbe5ef>\",null,1790431321000,1790431321000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431321000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431322000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524981000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "7296c4efbc0efe1a0a35759a18a501174e6047ed",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(混雑)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(混雑)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":3,"next_try_at":1790431320000,"reason":"busy","listed":null,"targeted":null,"updated_at":1790431320000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(混雑)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431320000,
       "updated_at": 1790431320000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(混雑)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(混雑)"},
        ],
       },
       "created_at": 1790431321000,
       "updated_at": 1790431321000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431320000"},
      {"key":"plan_finalized_at","value":"1790431320000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(混雑)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
     "color": 13639744,
     "fields": [],
    },
   ],
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(混雑)\n発走の 45 分前に自動で分析します",
     "color": 13639744,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
      {"name":"地方 交流重賞","value":"一覧を取得できませんでした(混雑)"},
     ],
    },
   ],
  ],
 },
 "判定 wait → 期限(F4): 事前分析が実行中のまま。依頼の直後のアラームは再試行の時刻(60 秒後。判定の期限〈rescueAt + 60 分〉ではない)、期限の 10 秒前の張り直しでは判定の期限にアラームを張る。期限の 1 ミリ秒前は判定せず、期限で failed(未完了 1 件)": {
  "rescue": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431260000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790431260000"],
   "sqlCount": 33,
   "sqlSha1": "07c46a6e2126cb190784689e87b236167fbe9a7e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "early": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790434790000,
   "warnings": [],
   "alarms": [1790434800000],
   "events": ["setAlarm 1790434800000"],
   "sqlCount": 29,
   "sqlSha1": "421605969133d9a85ad70569fe661bfe16df0fb6",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "justBefore": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790434799999,
   "warnings": [],
   "alarms": [1790434800000],
   "events": ["setAlarm 1790434800000"],
   "sqlCount": 29,
   "sqlSha1": "421605969133d9a85ad70569fe661bfe16df0fb6",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "onTime": {
   "label": "plan-failure:notify:send:ok",
   "threw": null,
   "at": 1790434800000,
   "warnings": [],
   "alarms": [1790434860000],
   "events": [
    "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=225 sha1=c60a8730ec>\",null,1790434800000,1790434800000]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
    "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790434800000,\"plan-failure\"]",
    "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
    "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790434800000,\"plan-failure\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790434801000\"]",
    "setAlarm 1790434860000",
   ],
   "sqlCount": 59,
   "sqlSha1": "781b85753ec0c0bae0bc27ea162af308a5e6719b",
   "sent": [
    [
     {
      "title": "事前分析の失敗 2026/09/27(日)",
      "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 0 件 / 未完了 1 件\n発走前の分析は予定どおり行われます。",
      "color": 13639744,
      "fields": [
       {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 未完了"},
      ],
     },
    ],
   ],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "plan-failure",
      "kind": "plan-failure",
      "state": "sent",
      "payload_json": {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 0 件 / 未完了 1 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 未完了"},
       ],
      },
      "created_at": 1790434800000,
      "updated_at": 1790434800000,
      "error_class": null,
     },
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"failed"},
    ],
   },
  },
  "after": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790434860000,
   "warnings": [],
   "alarms": [1790434920000],
   "events": ["setAlarm 1790434920000"],
   "sqlCount": 22,
   "sqlSha1": "cd674bcee6dfe2e5a2b8496eaad5d2f2dfd50235",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "plan-failure",
      "kind": "plan-failure",
      "state": "sent",
      "payload_json": {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 0 件 / 未完了 1 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 未完了"},
       ],
      },
      "created_at": 1790434800000,
      "updated_at": 1790434800000,
      "error_class": null,
     },
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "送信済みのまとめ",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"failed"},
    ],
   },
  },
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n事前分析: 失敗 0 件 / 未完了 1 件\n発走前の分析は予定どおり行われます。",
     "color": 13639744,
     "fields": [
      {"name":"失敗・未完了のレース","value":"中山 1R 中央1R 10:00 未完了"},
     ],
    },
   ],
  ],
 },
 "判定: 期限(rescueAt + 60 分)が来たら、落ち着いていなくても判定する(会場が pending・確定の印が外れたまま。計画が確定していない F1 の failed)。期限の 1 ミリ秒前は判定しない・そのアラームは判定の期限": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "early": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790434799999,
   "warnings": [],
   "alarms": [1790434800000],
   "events": ["setAlarm 1790434800000"],
   "sqlCount": 26,
   "sqlSha1": "e8572304edf2163f5e4dc545ccfc93f6ea68f171",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790449200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "onTime": {
   "label": "plan-failure:notify:send:ok",
   "threw": null,
   "at": 1790434800000,
   "warnings": [],
   "alarms": [1790449200000],
   "events": [
    "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=193 sha1=649ce13299>\",null,1790434800000,1790434800000]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
    "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790434800000,\"plan-failure\"]",
    "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
    "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790434800000,\"plan-failure\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790434801000\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790528460000\"]",
    "setAlarm 1790449200000",
   ],
   "sqlCount": 54,
   "sqlSha1": "f5e9165ab0e8462b606fb18d88776ae55d953f2a",
   "sent": [
    [
     {
      "title": "事前分析の失敗 2026/09/27(日)",
      "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 計画が確定していません\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
      "color": 13639744,
      "fields": [],
     },
    ],
   ],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790449200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "plan-failure",
      "kind": "plan-failure",
      "state": "sent",
      "payload_json": {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 計画が確定していません\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [],
      },
      "created_at": 1790434800000,
      "updated_at": 1790434800000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"failed"},
    ],
   },
  },
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 2026/09/27(日)",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 計画が確定していません\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
     "color": 13639744,
     "fields": [],
    },
   ],
  ],
 },
 "判定: 判定の永続化の前後で状態が変わる(now・metaGet・getPlanProgress は呼ぶたびに読む): 判定のあと、事前分析が failed になっても再判定しない・通知は増えない": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": ["SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]","setAlarm 1790431200000"],
   "sqlCount": 33,
   "sqlSha1": "07c46a6e2126cb190784689e87b236167fbe9a7e",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202636092701","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "first": [
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"ok\"]",
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=263 sha1=d88bdc256c>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 58,
    "sqlSha1": "e6c02d8b025a9b1fb1a45d20b7fba9d9873a2d0c",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
       "color": 40563,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
      {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202636092701","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
         {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"ok"},
     ],
    },
   },
  ],
  "later": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431800000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["setAlarm 1790468100000"],
   "sqlCount": 22,
   "sqlSha1": "cd674bcee6dfe2e5a2b8496eaad5d2f2dfd50235",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
       "color": 40563,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
       ],
      },
      "created_at": 1790431200000,
      "updated_at": 1790431200000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"ok"},
    ],
   },
  },
  "again": {
   "label": "idle",
   "threw": null,
   "at": 1790432400000,
   "warnings": [],
   "alarms": [1790468100000],
   "events": ["setAlarm 1790468100000"],
   "sqlCount": 44,
   "sqlSha1": "6516a85c3ac8463750e2e04dfc5705c5f724144a",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":1,"targeted":1,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     {"race_id":"202636092701","venue":"nar","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
     {"race_id":"202636092701","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":"テストの失敗"},
    ],
    "notify": [
     {
      "key": "summary",
      "kind": "summary",
      "state": "sent",
      "payload_json": {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
       "color": 40563,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
       ],
      },
      "created_at": 1790431200000,
      "updated_at": 1790431200000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
     {"key":"plan_rescue_verdict","value":"ok"},
    ],
   },
  },
  "verdict": "ok",
  "sent": [
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 3 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
     "color": 40563,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
      {"name":"地方 交流重賞","value":"水沢 1R 地方1R 11:00 事前分析OK"},
     ],
    },
   ],
  ],
 },
 "判定 failed: 時計が進んでから判定する(材料の created_at・updated_at は判定の起床の時刻。依頼の時刻に固定しない)": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL UPDATE race_day_plan_venue SET state = 'pending', attempts = 0, next_try_at = ?, reason = NULL, listed = NULL, targeted = NULL, entries_json = NULL, updated_at = ? WHERE venue = ? AND state = 'failed' | [1790431200000,1790431200000,\"nar\"]",
    "SQL DELETE FROM race_day_meta WHERE key IN (?, ?, ?) | [\"plan_finalized_at\",\"plan_finalize_attempts\",\"plan_finalize_next_try_at\"]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 32,
   "sqlSha1": "5f0653e269c3a0ed75dfa4ac42dcab0ca4d4291b",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
     {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790431200000,"reason":null,"listed":null,"targeted":null,"updated_at":1790431200000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790431200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790431200000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790431200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 39,
    "sqlSha1": "eb34d4c5dcc98658fa724313c1ebf67cac4b97ce",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790431200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 47,
    "sqlSha1": "8715618756c11f4cbb85cdf555897bd6cca23a75",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=205 sha1=f4116ceaea>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431200000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "d44f756c2f321e3a1c0c13f57c81ef2f4ecdbaed",
    "sent": [
     [
      {
       "title": "事前分析の失敗 2026/09/27(日)",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
       "color": 13639744,
       "fields": [],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=290 sha1=2abd7309b0>\",null,1790431201000,1790431201000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 50,
    "sqlSha1": "ac721a18c7645cd5093b8135623c3a2b1cbea38d",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
       "color": 13639744,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":2,"targeted":2,"updated_at":1790424000000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790431200000,"reason":"blocked","listed":null,"targeted":null,"updated_at":1790431200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790469900000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": [],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 10:30 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧を取得できませんでした(取得制限中)"},
        ],
       },
       "created_at": 1790431201000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790431200000"},
      {"key":"plan_finalized_at","value":"1790431200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
 },
 "判定 failed: 材料の組み立てが throw → 警告を出して最小の通知に代える(判定は止めない)【到達不能・記録: 計画の行の race_name に BLOB を直接書いて throw させる】": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 35,
   "sqlSha1": "0e2cd847185c6db8c0d2ced02c9478918235e633",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["Discord の通知の内容を作れませんでした(summary): text.replace is not a function"],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",null,null,1790431200000,1790431200000]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"build\",1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "onWarn Discord の通知の内容を作れませんでした(summary): text.replace is not a function",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "f8cc7dbda2e35f37cb8733cdafec70969cf28c22",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {"key":"summary","kind":"summary","state":"failed","payload_json":null,"created_at":1790431200000,"updated_at":1790431200000,"error_class":"build"},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "197027ae17edc7d5d986d837762a8c938990865e",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {"key":"summary","kind":"summary","state":"failed","payload_json":null,"created_at":1790431200000,"updated_at":1790431200000,"error_class":"build"},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "idle",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["事前分析の失敗の通知の材料を組み立てられませんでした(最小の通知に代えます): text.replace is not a function"],
    "alarms": [1790431201000],
    "events": [
     "onWarn 事前分析の失敗の通知の材料を組み立てられませんでした(最小の通知に代えます): text.replace is not a function",
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=130 sha1=0a2385b7bd>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "8ed4d6f21f54a286aff9154280924b85fe28563d",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "ready",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)。画面で確認してください。",
        "color": 13639744,
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "failed",
       "payload_json": null,
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": "build",
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431201000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 2026/09/27(日)\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 44,
    "sqlSha1": "c2fca56970488b9a8282d6e732d6810687449ad9",
    "sent": [
     [
      {"title":"事前分析の失敗 2026/09/27(日)","description":"【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)。画面で確認してください。","color":13639744},
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 2026/09/27(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)。画面で確認してください。",
        "color": 13639744,
       },
       "created_at": 1790431200000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "failed",
       "payload_json": null,
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": "build",
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {"title":"事前分析の失敗 2026/09/27(日)","description":"【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/09/27(日)開催分)。画面で確認してください。","color":13639744},
   ],
  ],
 },
 "判定 failed: 開催日(kaisai_date)が無い → 日付不明の見出し(?? \"\" の分岐)【到達不能・記録: 開催日は依頼が固定する】": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 35,
   "sqlSha1": "0e2cd847185c6db8c0d2ced02c9478918235e633",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["Discord の通知の内容を作れませんでした(summary): 開催日が未確定です"],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",null,null,1790431200000,1790431200000]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"build\",1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "onWarn Discord の通知の内容を作れませんでした(summary): 開催日が未確定です",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 57,
    "sqlSha1": "0df940075787fd6e3cb675c265d89734e03f580d",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {"key":"summary","kind":"summary","state":"failed","payload_json":null,"created_at":1790431200000,"updated_at":1790431200000,"error_class":"build"},
     ],
     "meta": [
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "197027ae17edc7d5d986d837762a8c938990865e",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {"key":"summary","kind":"summary","state":"failed","payload_json":null,"created_at":1790431200000,"updated_at":1790431200000,"error_class":"build"},
     ],
     "meta": [
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "idle",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431201000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=210 sha1=9c4bf2e226>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "setAlarm 1790431201000",
    ],
    "sqlCount": 60,
    "sqlSha1": "ea6afbf5c2026177d16f05f1ff295a50bba53c50",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "ready",
       "payload_json": {
        "title": "事前分析の失敗 日付不明",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 日付不明開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "failed",
       "payload_json": null,
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": "build",
      },
     ],
     "meta": [
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
   {
    "label": "plan-failure:notify:send:ok",
    "threw": null,
    "at": 1790431201000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1790431201000,\"plan-failure\"]",
     "notifier.send [\"事前分析の失敗 日付不明\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431201000,\"plan-failure\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431202000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524861000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 44,
    "sqlSha1": "c2fca56970488b9a8282d6e732d6810687449ad9",
    "sent": [
     [
      {
       "title": "事前分析の失敗 日付不明",
       "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 日付不明開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
       "color": 13639744,
       "fields": [
        {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "事前分析の失敗 日付不明",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 日付不明開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
        "color": 13639744,
        "fields": [
         {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431201000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "failed",
       "payload_json": null,
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": "build",
      },
     ],
     "meta": [
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析の失敗 日付不明",
     "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 日付不明開催分)\n事前分析: 失敗 1 件 / 未完了 0 件\n発走前の分析は予定どおり行われます。",
     "color": 13639744,
     "fields": [
      {"name":"失敗・未完了のレース","value":"中山 2R 中央2R 11:00 事前分析失敗"},
     ],
    },
   ],
  ],
 },
 "判定 failed: 同じキーの通知の行(plan-failure)が既にある → 材料は積み直さない(ON CONFLICT DO NOTHING)が、判定は永続化する。再送もしない【到達不能・記録】": {
  "request": {
   "label": "{\"accepted\":false,\"reason\":\"already-planned\"}",
   "threw": null,
   "at": 1790431200000,
   "warnings": [],
   "alarms": [1790431200000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_rescue_at\",\"1790431200000\"]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790431200000,1790431200000]",
    "setAlarm 1790431200000",
   ],
   "sqlCount": 35,
   "sqlSha1": "0e2cd847185c6db8c0d2ced02c9478918235e633",
   "sent": [],
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
     {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
     {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
     {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
     {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
     {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
     {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
    ],
    "notify": [
     {
      "key": "plan-failure",
      "kind": "plan-failure",
      "state": "sent",
      "payload_json": {
       "title": "先に積まれた行",
      },
      "created_at": 1790424000000,
      "updated_at": 1790424000000,
      "error_class": null,
     },
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790424000000"},
     {"key":"plan_finalized_at","value":"1790424000000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790424000000"},
     {"key":"plan_rescue_at","value":"1790431200000"},
    ],
   },
  },
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790431200000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=360 sha1=889f176b37>\",null,1790431200000,1790431200000]",
     "notifier.send [\"事前分析 2026/09/27(日) 開催分\"]",
     "SQL UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1790431200000,\"summary\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1790431201000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "4ac782cc5194fc5d7e67adef88154edca36b3ebc",
    "sent": [
     [
      {
       "title": "事前分析 2026/09/27(日) 開催分",
       "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 0 / 未完了 1\n※ 未完了 1 件のまま送信しています\n発走の 45 分前に自動で分析します",
       "color": 15113984,
       "fields": [
        {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
        {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
       ],
      },
     ],
    ],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":null},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "先に積まれた行",
       },
       "created_at": 1790424000000,
       "updated_at": 1790424000000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 0 / 未完了 1\n※ 未完了 1 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "threw": null,
    "at": 1790431200000,
    "warnings": ["朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"],
    "alarms": [1790431200000],
    "events": [
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"queued\",1,null,1790431200000,\"202606040902\",\"morning\"]",
     "SQL UPDATE race_day_tasks SET settings_json = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"<len=817 sha1=8332b5aeec>\",1790431200000,\"202606040902\",\"morning\"]",
     "gate.fetch https://race.netkeiba.com/race/shutuba.html?race_id=202606040902",
     "SQL UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ? | [\"failed\",1,\"ゲートが取得を拒否しました(blocked): ブレーカーが開いています\",1790431200000,\"202606040902\",\"morning\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790524860000\"]",
     "setAlarm 1790431200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "197027ae17edc7d5d986d837762a8c938990865e",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "先に積まれた行",
       },
       "created_at": 1790424000000,
       "updated_at": 1790424000000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 0 / 未完了 1\n※ 未完了 1 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
     ],
    },
   },
   {
    "label": "idle",
    "threw": null,
    "at": 1790431200000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=228 sha1=f7280c0e45>\",null,1790431200000,1790431200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_rescue_verdict\",\"failed\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 60,
    "sqlSha1": "ae24bd18a48f2b55b03772d594a6d7a567faf159",
    "sent": [],
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":6,"targeted":6,"updated_at":1790424000000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790424000000,"reason":null,"listed":0,"targeted":0,"updated_at":1790424000000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","state":"planned","skip_reason":null,"due_ms":1790468100000,"planned_at":1790424000000},
      {"race_id":"202606040902","venue":"central","state":"planned","skip_reason":null,"due_ms":1790471700000,"planned_at":1790424000000},
      {"race_id":"202606040903","venue":"central","state":"planned","skip_reason":null,"due_ms":1790475300000,"planned_at":1790424000000},
      {"race_id":"202606040904","venue":"central","state":"planned","skip_reason":null,"due_ms":1790478900000,"planned_at":1790424000000},
      {"race_id":"202606040905","venue":"central","state":"planned","skip_reason":null,"due_ms":1790482500000,"planned_at":1790424000000},
      {"race_id":"202606040906","venue":"central","state":"planned","skip_reason":null,"due_ms":1790486100000,"planned_at":1790424000000},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040902","mode":"morning","status":"failed","attempts":1,"compute_attempts":0,"queued_at":1790431200000,"updated_at":1790431200000,"error":"ゲートが取得を拒否しました(blocked): ブレーカーが開いています"},
      {"race_id":"202606040903","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040904","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040905","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
      {"race_id":"202606040906","mode":"morning","status":"done","attempts":1,"compute_attempts":0,"queued_at":1790424000000,"updated_at":1790424000000,"error":null},
     ],
     "notify": [
      {
       "key": "plan-failure",
       "kind": "plan-failure",
       "state": "sent",
       "payload_json": {
        "title": "先に積まれた行",
       },
       "created_at": 1790424000000,
       "updated_at": 1790424000000,
       "error_class": null,
      },
      {
       "key": "summary",
       "kind": "summary",
       "state": "sent",
       "payload_json": {
        "title": "事前分析 2026/09/27(日) 開催分",
        "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 0 / 未完了 1\n※ 未完了 1 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
         {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
        ],
       },
       "created_at": 1790431200000,
       "updated_at": 1790431200000,
       "error_class": null,
      },
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790424000000"},
      {"key":"plan_finalized_at","value":"1790424000000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790424000000"},
      {"key":"plan_rescue_at","value":"1790431200000"},
      {"key":"plan_rescue_verdict","value":"failed"},
     ],
    },
   },
  ],
  "verdict": "failed",
  "sent": [
   [
    {
     "title": "事前分析 2026/09/27(日) 開催分",
     "description": "対象 6 件(中央 6・地方 交流重賞 0)\n事前分析OK 5 / 失敗 0 / 未完了 1\n※ 未完了 1 件のまま送信しています\n発走の 45 分前に自動で分析します",
     "color": 15113984,
     "fields": [
      {"name":"中山","value":"1R 中央1R 10:00 事前分析OK\n2R 中央2R 11:00 未完了\n3R 中央3R 12:00 事前分析OK\n4R 中央4R 13:00 事前分析OK\n5R 中央5R 14:00 事前分析OK\n6R 中央6R 15:00 事前分析OK"},
      {"name":"地方 交流重賞","value":"一覧が空でした(0件)"},
     ],
    },
   ],
  ],
 },
};
