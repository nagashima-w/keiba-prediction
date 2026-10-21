import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "../src/pre-race-time";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { MAX_ATTEMPTS, MAX_TASKS_PER_DAY, RETRY_DELAY_MS, RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import type { SqlLike } from "../src/sql-like";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #399(R-9e の e1): 計画の「一覧と確定」(`runPlanList`・`afterPlanVenueSettled`・`runPlanFinalize`・`buildPlanRow`)を `RaceDayCore` から切り出す前に、**今の挙動を固定する特性テスト**。
 * 切り出しの前後で、このファイルを書き換えずに緑のままであることが、挙動を変えていないことの根拠になる。
 * **切り出しの後の名前**(このヘッダと本文の旧名の読み替え): `runPlanList`→`PlanStage.runList`・`runPlanFinalize`→`PlanStage.runFinalize`(`afterPlanVenueSettled`・`buildPlanRow` は名前のまま `PlanStage` のメソッド)。実装は `cloud/src/race-day-plan-stage.ts`。
 *
 * 既存の `race-day-plan.test.ts` が固定している面(行の状態・期限の値・再試行の回数)に加えて、**値だけでは見えない面**を固定する:
 *  - **SQL の文と順序**(計画の表・会場の表・タスクの表・結果の表・meta への書き込みを読める形で、全体は SHA-1 で固定する。**gate への取得・設定の読み取り・警告・`setAlarm` も同じ列に挟む**ので、
 *    「試行回数を永続化する → 取得する → 結果を書く」「設定を読む → offset を決める → 行を書く → morning を積む → 対象数を書く → 結果の行を積む → 確定の印を書く → 一覧の本体を捨てる」の順序が見える)
 *  - **ログの文言**(`onWarn` に渡る文面。全文一致。鍵の形は伏せられる)
 *  - **await の間に時計・状態が変わること**(取得の間・設定の読み取りの間に時計が進む場面。`now` を値で固定していないこと)
 *  - **確定の末尾の `enqueueSameDayResults` の呼び出し**(結果ストアあり・なし。引数は開催日と確定の時刻)
 *
 * ## 到達不能の場面(【記録】区分)
 * production から到達しない防御の分岐は、SQL で状態を作って固定している(切り出しで壊れても利用者には影響しない。ブロッキングの基準では【記録】):
 *  - 「開催日が未確定」(`kaisai_date` を消す。一覧の取得・確定の両方): 依頼が開催日を固定するので、実際には必ず入っている
 *  - 「確定済みなのに会場が pending に戻る」: 救済は確定の印を外してから会場を戻すので、確定済みで一覧が動くことは無い
 *  - 「一覧の本体の発走時刻が読めない」(`entries_json` を書き換える): パーサが範囲外の時刻を落とすので、読めない時刻は一覧に出ない
 *
 * ハーネスは `race-day-promote-characterization.test.ts` と同じ形(ゲートは偽・保存先は偽・ストレージは `node:sqlite`)。
 * 期待値の作り直し: `CHAR_DUMP=<ファイル> npx vitest run test/race-day-plan-characterization.test.ts`(比べずに、実出力を書き出す。通常の実行では使わない)。
 */

const jst = (time: string, date = "2026-09-27"): number => Date.parse(`${date}T${time}:00+09:00`);
const DATE = "20260927";
const MIN = 60_000;

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

// ---- 偽のゲート・保存先 ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const http500 = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });
const queueFull = (): GateResult => ({ kind: "refused", reason: "queue-full", message: "待ち行列が上限" });

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

type ListStep = GateResult | "throw";

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly alarms: number[];
  readonly warnings: string[];
  readonly log: string[];
  /** 一覧の取得の応答を先頭から 1 回ずつ消費する(空になれば HTML を返す)。 */
  readonly script: { central: ListStep[]; nar: ListStep[] };
  settings: CloudSettings;
  /** 先頭から 1 回ずつ消費する設定の読み取りの失敗の文面(空になれば成功)。 */
  settingsFails: string[];
  /** 一覧の取得の最中(gate の中)に呼ぶ。 */
  onFetch: (() => void) | null;
  /** 設定の読み取りの最中に呼ぶ。 */
  onSettings: (() => void) | null;
}

interface HarnessOptions {
  readonly central?: readonly ListRow[];
  readonly nar?: readonly ListRow[];
  /** false なら結果ストアなし(結果の取り込みの行を積まない構成)。既定は true。 */
  readonly store?: boolean;
  readonly start?: number;
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

/** 結果ストアの偽(存在するだけでよい。計画の確定は存在の有無しか見ない)。 */
const fakeResultStore = {
  async saveResult() {},
  async saveWinOdds() {
    return { rowsWritten: 0 };
  },
  async saveScratched() {
    return { rowsWritten: 0 };
  },
  async getRaceResultDetails() {
    return new Map();
  },
};

function harness(options: HarnessOptions = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: options.start ?? jst("08:00") };
  const alarm: { at: number | null } = { at: null };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const log: string[] = [];
  const h = { sql, clock, alarm, alarms, warnings, log, script: { central: [], nar: [] }, settings: DEFAULT_CLOUD_SETTINGS, settingsFails: [], onFetch: null, onSettings: null } as unknown as Harness;
  const centralHtml = listHtml(options.central ?? []);
  const narHtml = listHtml(options.nar ?? []);
  const gate: GateLike = {
    async fetchRaw(url): Promise<GateResult> {
      log.push(`gate.fetch ${url}`);
      await Promise.resolve();
      h.onFetch?.();
      const which = url.startsWith("https://race.netkeiba.com/top/race_list_sub") ? "central" : url.startsWith("https://nar.netkeiba.com/top/race_list_sub") ? "nar" : null;
      if (which === null) return blocked(); // 発走前の取得は、このテストの主題ではないので、すぐ(再試行なしの)失敗にする
      const next = h.script[which].shift();
      if (next === "throw") throw new Error("gate が想定外に落ちた(テスト)");
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
    loadSettings: async () => {
      log.push("loadSettings");
      await Promise.resolve();
      h.onSettings?.();
      const fail = h.settingsFails.shift();
      if (fail !== undefined) throw new Error(fail);
      return h.settings;
    },
    ...(options.store === false ? {} : { resultStore: fakeResultStore }),
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
  results: unknown[];
  meta: unknown[];
}
/** 状態の写し(会場・計画の行・タスク・結果の行・計画の meta)。ハーネスの生の SQL で読む(ログに載せない)。 */
function snapshot(h: Harness): Snapshot {
  return {
    venues: h.sql.exec("SELECT venue, state, attempts, next_try_at, reason, listed, targeted, LENGTH(entries_json) AS entries_len, updated_at FROM race_day_plan_venue ORDER BY venue").toArray(),
    plan: h.sql.exec("SELECT race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at FROM race_day_plan ORDER BY race_id").toArray(),
    tasks: h.sql.exec("SELECT race_id, mode, status, attempts, queued_at FROM race_day_tasks WHERE race_id NOT LIKE 'FILLER%' ORDER BY race_id, mode").toArray(),
    results: h.sql.exec("SELECT race_id, state, attempts, deferrals, next_try_at, requested_on, queued_at, updated_at FROM race_day_result ORDER BY race_id").toArray(),
    meta: h.sql.exec("SELECT key, value FROM race_day_meta WHERE key LIKE 'plan_%' OR key = 'kaisai_date' ORDER BY key").toArray(),
  };
}
const taskTotal = (h: Harness): number => (h.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]!.n;

/**
 * events に残す行: 計画・会場・タスク・結果の表と meta への**書き込み**(INSERT・UPDATE・DELETE)、取得・設定の読み取り・警告・アラーム。
 * 読み取りの SQL とキャッシュなどの他の SQL は `sqlSha1` だけで固定する(量を抑える。読み取りの順序が変わっても `sqlSha1` が変わる)。
 */
const RELEVANT = /^(SQL (INSERT|UPDATE|DELETE) .*(race_day_plan_venue|race_day_plan|race_day_tasks|race_day_result|race_day_meta)|gate\.fetch |loadSettings|onWarn |setAlarm )/;

interface StepTrace {
  readonly label: string;
  readonly threw: string | null;
  readonly at: number;
  readonly warnings: string[];
  readonly alarms: number[];
  readonly events: string[];
  readonly sqlCount: number;
  readonly sqlSha1: string;
  readonly state: Snapshot;
}

/** `at` まで時計を進めて 1 ステップ動かし、その間に起きたことを集める。reject はメッセージだけ残す。 */
async function stepTrace(h: Harness, at: number): Promise<StepTrace> {
  const w = h.warnings.length;
  const a = h.alarms.length;
  const s = h.log.length;
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  let outcomeLabel: string;
  let threw: string | null = null;
  try {
    outcomeLabel = label(await h.core.runNextStep());
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
    state: snapshot(h),
  };
}
/**
 * 最初のステップは `at`、以降はアラームの時刻で、`max` 回まで(アラームが無くなれば止める)。**確定の成功(`plan:plan:finalize:ok`)か例外で止める**
 * (確定のあとの朝の取得・発走前の取得・結果の取り込みは、この段階の主題ではなく、それぞれの特性テストが固定している)。
 */
async function steps(h: Harness, at: number, max: number): Promise<StepTrace[]> {
  const out: StepTrace[] = [await stepTrace(h, at)];
  while (out.length < max && h.alarm.at !== null && !/^plan:plan:finalize:ok$|^THROW$/.test(out[out.length - 1]!.label)) {
    out.push(await stepTrace(h, h.alarm.at));
  }
  return out;
}

/** 計画を依頼する(アラームが張られる)。以降のステップの記録に、依頼のぶんは入れない。 */
async function request(h: Harness, rescue = false): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE, ...(rescue ? { rescue: true } : {}) })).toMatchObject({ accepted: true });
}

/** 依頼 → `seed` で状態を作る → アラームの時刻から `max` ステップ。 */
async function planRun(h: Harness, max: number, seed: (h: Harness) => void = () => undefined): Promise<unknown> {
  await request(h);
  seed(h);
  const initial = snapshot(h);
  const first = h.alarm.at;
  if (first === null) throw new Error("依頼でアラームが張られていない");
  return { initial, traces: await steps(h, first, max) };
}

/** 全体のタスク数がちょうど `total` になるまで、別のレースの完了済みの行を足す。 */
function fillTasksTo(h: Harness, total: number): void {
  let n = taskTotal(h);
  if (n > total) throw new Error(`すでに ${n} 件ある`);
  let i = 0;
  while (n < total) {
    h.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at) VALUES (?, 'morning', 'done', 1, 1, ?, ?)", `FILLER${String(i).padStart(3, "0")}`, jst("07:00"), jst("07:00"));
    i += 1;
    n += 1;
  }
}

type Scenario = { readonly options?: HarnessOptions; readonly run: (h: Harness) => Promise<unknown> };

const ONE: HarnessOptions = { central: [central(1, "10:00")] };
const TWO: HarnessOptions = { central: [central(1, "10:00"), central(2, "10:30")] };
const THREE: HarnessOptions = { central: [central(1, "10:00"), central(2, "10:30"), central(3, "11:00")] };
/** 混在日: 中央 2 レース + 地方(Jpn3 が 1 つ・オープン〈OP〉と無印は対象外)。 */
const MIXED: HarnessOptions = { central: [central(1, "10:00"), central(2, "10:30")], nar: [nar(1, "11:00", "Jpn3"), nar(2, "11:30", "OP"), nar(3, "12:00", undefined)] };
/** 確定の前に、中央・地方の会場を ok にしておく(2 ステップ)。 */
async function listsOk(h: Harness): Promise<void> {
  await request(h);
  for (let i = 0; i < 2; i += 1) {
    const at = h.alarm.at;
    if (at === null) throw new Error("アラームが無い");
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    await h.core.runNextStep();
  }
}
const planOk = (minutes: number): CloudSettings => ({ ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: minutes });

const SCENARIOS: Record<string, Scenario> = {
  // ---- 一覧(runPlanList・afterPlanVenueSettled)----
  "混在日(中央 2R・地方は Jpn3 と対象外 2R): 一覧 2 本 → 確定。対象は中央全件 + 地方 Jpn だけ(targeted 2 と 1。listed は地方 3)。morning は対象の行ごと": { options: MIXED, run: (h) => planRun(h, 4) },
  "中央・地方とも 0 件(ok): 計画の行なし・対象 0。確定は走り、結果の行は積まない(planned の行が無い)": { options: {}, run: (h) => planRun(h, 4) },
  "一覧が queue-full(busy)で 1 回だけ失敗: retry(RETRY_DELAY_MS 後)→ 再試行で ok。確定は両方終端になってから": { options: ONE, run: (h) => planRun(h, 6, (x) => x.script.central.push(queueFull())) },
  "一覧が queue-full で MAX_ATTEMPTS 回続く(中央): 上限で failed(警告つき)。地方は ok。確定は中央 0 件・地方だけで走る": {
    options: MIXED,
    run: (h) => planRun(h, 8, (x) => x.script.central.push(queueFull(), queueFull(), queueFull())),
  },
  "一覧が blocked(中央): 再試行せず 1 回で failed(警告に理由 blocked)": { options: ONE, run: (h) => planRun(h, 5, (x) => x.script.central.push(blocked())) },
  "一覧が HTTP 500(failed)で 1 回だけ失敗: retry → ok": { options: ONE, run: (h) => planRun(h, 6, (x) => x.script.central.push(http500())) },
  "gate が例外を投げる(中央): 通信の失敗(failed)として扱われ、retry → ok。「想定外の失敗」の警告は出ない(それは getRaceList 自体が投げたときだけ)": { options: ONE, run: (h) => planRun(h, 6, (x) => x.script.central.push("throw")) },
  "【到達不能・記録】開催日(kaisai_date)が無い: 想定外の失敗の警告(取得は呼ばれない)。試行回数は取得の前に永続化される": {
    options: ONE,
    run: (h) =>
      planRun(h, 3, (x) => {
        x.sql.exec("DELETE FROM race_day_meta WHERE key = 'kaisai_date'");
      }),
  },
  "片方だけ終端(中央 ok・地方は queue-full で再試行待ち): 確定を予約しない(plan_finalize_next_try_at を書かない)": { options: ONE, run: (h) => planRun(h, 2, (x) => x.script.nar.push(queueFull())) },
  "【到達不能・記録】確定済みで会場が pending に戻った状態で一覧が ok: 確定を予約しない(確定の印があるので)": {
    options: ONE,
    run: async (h) => {
      await listsOk(h);
      const at = h.alarm.at;
      if (at === null) throw new Error("アラームが無い");
      await stepTrace(h, at); // 確定
      h.sql.exec("UPDATE race_day_plan_venue SET state = 'pending', next_try_at = 0 WHERE venue = 'central'");
      const initial = snapshot(h);
      return { initial, traces: [await stepTrace(h, h.clock.now + MIN)] };
    },
  },
  "救済(rescue)で失敗した会場を戻す: 地方の一覧が failed で確定 → 救済の依頼 → 地方を取り直して ok → 再確定(成功済みの中央は本体が無いので targeted を数え直さない)": {
    options: { central: [central(1, "10:00")], nar: [nar(1, "11:00", "Jpn3")] },
    run: async (h) => {
      h.script.nar.push(blocked());
      await request(h);
      const first: StepTrace[] = [];
      for (let i = 0; i < 3; i += 1) {
        const at = h.alarm.at;
        if (at === null) throw new Error("アラームが無い");
        first.push(await stepTrace(h, at));
      }
      const before = snapshot(h);
      expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toMatchObject({ accepted: false });
      const afterRequest = snapshot(h);
      const at = h.alarm.at;
      if (at === null) throw new Error("救済でアラームが張られていない");
      return { before, afterRequest, firstLabels: first.map((t) => t.label), traces: await steps(h, at, 3) };
    },
  },
  "両方の会場が blocked で failed: 確定は 0 件で走る(targeted は書かない・計画の行なし・結果の行なし)": {
    options: ONE,
    run: (h) =>
      planRun(h, 4, (x) => {
        x.script.central.push(blocked());
        x.script.nar.push(blocked());
      }),
  },
  "取得の最中に時計が進む: 試行回数の永続化は取得の前の時刻、結果の書き込みは取得のあとの時刻(now を値で固定しない)": {
    options: ONE,
    run: (h) =>
      planRun(h, 3, (x) => {
        x.onFetch = () => {
          x.clock.now += 7 * MIN;
        };
      }),
  },
  // ---- 確定(runPlanFinalize)----
  "設定の読み取りが成功(offset 30 分): 設定の値で期限を決める(plan_offset_source = settings)": { options: THREE, run: (h) => planRun(h, 4, (x) => (x.settings = planOk(30))) },
  "設定の読み取りが 1 回目だけ失敗: retry(RETRY_DELAY_MS 後・警告)→ 2 回目で成功": { options: ONE, run: (h) => planRun(h, 5, (x) => x.settingsFails.push("D1 に繋がらない")) },
  "設定の読み取りが MAX_ATTEMPTS 回続けて失敗: 2 回は retry、MAX_ATTEMPTS 回目で既定値(45 分)にフォールバックして確定(警告の文言。鍵の形は伏せる)": {
    options: ONE,
    run: (h) => planRun(h, 7, (x) => x.settingsFails.push("失敗1", "失敗2", "失敗3 sk-ant-api03-ABCDEFGHIJKLMNOP")),
  },
  "offset が決定済み(plan_offset = 20 / settings): 設定を読まない(loadSettings が呼ばれない)": {
    options: ONE,
    run: (h) =>
      planRun(h, 4, (x) => {
        x.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_offset', '20'), ('plan_offset_source', 'settings')");
      }),
  },
  "確定の試行の時刻の前に起きても、確定は走らない(設定が失敗した後、RETRY_DELAY_MS の 1ms 前は確定しない・ちょうどで確定する)": {
    options: ONE,
    run: async (h) => {
      h.settingsFails.push("一時的な失敗");
      await listsOk(h);
      const first = await stepTrace(h, h.alarm.at!); // 確定の試行 1(設定が失敗して retry)
      const retryAt = h.clock.now + RETRY_DELAY_MS;
      const early = await stepTrace(h, retryAt - 1);
      const onTime = await stepTrace(h, retryAt);
      return { first, early, onTime };
    },
  },
  "計画の行の判定(buildPlanRow): scheduled・immediate・too-late・started・no-start-time(時刻なし)を 1 日に並べる。skip の行には morning を積まない。結果の行は発走時刻のある行(skip を含む)だけ": {
    options: {
      central: [central(1, "12:00"), central(2, "09:20"), central(3, "09:05"), central(4, "08:30"), central(5, null)],
    },
    run: (h) => planRun(h, 4, (x) => (x.clock.now = jst("09:00"))),
  },
  "期限と現在の境目 1(now = 09:00:00.000。buildPlanRow): 期限ちょうど(scheduled)・発走まで 10 分ちょうど(immediate)・発走ちょうど(started)・発走の 1 分後(started)": {
    options: { central: [central(1, "09:45"), central(2, "09:10"), central(3, "09:00"), central(4, "08:59")] },
    run: (h) => planRun(h, 4, (x) => (x.clock.now = jst("09:00"))),
  },
  "期限と現在の境目 2(now = 09:00:00.001。buildPlanRow): 期限の 1ms 後(immediate)・発走まで 10 分に 1ms 足りない(too-late)・発走の 59.999 秒前(too-late)・発走ちょうど(started)": {
    options: { central: [central(1, "09:45"), central(2, "09:10"), central(3, "09:01"), central(4, "09:00")] },
    run: (h) => planRun(h, 4, (x) => (x.clock.now = jst("09:00") + 1)),
  },
  "【到達不能・記録】一覧の本体の発走時刻が読めない(99:99): no-start-time でスキップ(start_ms は null)": {
    options: TWO,
    run: async (h) => {
      await listsOk(h);
      h.sql.exec("UPDATE race_day_plan_venue SET entries_json = REPLACE(entries_json, '\"startTime\":\"10:00\"', '\"startTime\":\"99:99\"')");
      const initial = snapshot(h);
      return { initial, traces: await steps(h, h.alarm.at!, 2) };
    },
  },
  "上限(cap): 既存のタスク 96 件 + 3 レース。1・2 レース目は planned(合計がちょうど上限)、3 レース目は cap でスキップ。morning は planned の行だけ": {
    options: THREE,
    run: (h) =>
      planRun(h, 4, (x) => {
        fillTasksTo(x, MAX_TASKS_PER_DAY - 4);
      }),
  },
  "上限(cap): 既存のタスク 97 件 + 3 レース。1 レース目だけ planned(2 レース目は合計 101 で上限を 1 超えるので cap。3 レース目も cap)": {
    options: THREE,
    run: (h) =>
      planRun(h, 4, (x) => {
        fillTasksTo(x, MAX_TASKS_PER_DAY - 3);
      }),
  },
  "上限(cap): 既存のタスク MAX_TASKS_PER_DAY − 1 件: 最初の行から cap(必要数 2 で超える)。planned が無いので結果の行は積まない": {
    options: TWO,
    run: (h) =>
      planRun(h, 4, (x) => {
        fillTasksTo(x, MAX_TASKS_PER_DAY - 1);
      }),
  },
  "上限(cap): morning が既にある行は必要数 1: 既存のタスクが MAX_TASKS_PER_DAY − 1 件(morning を含む)でも planned": {
    options: ONE,
    run: (h) =>
      planRun(h, 4, (x) => {
        x.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at) VALUES ('202606040901', 'morning', 'done', 1, 1, ?, ?)", jst("07:00"), jst("07:00"));
        fillTasksTo(x, MAX_TASKS_PER_DAY - 1);
      }),
  },
  "確定が途中まで書かれていた状態から再実行: 既にある計画の行は変えず(最初の計画のまま)、無い行だけ足す。morning は行がまだ無いときだけ積む(既にあれば積み直さない)": {
    options: TWO,
    run: (h) =>
      planRun(h, 4, (x) => {
        // R1: 計画の行はあるが morning が無い(途中で落ちた)。offset は 99 分で書かれている(再実行は変えない)。
        x.sql.exec(
          `INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at)
           VALUES ('202606040901', 'central', '中山', 1, '中央1R', NULL, '10:00', ?, ?, 99, 'scheduled', NULL, 'planned', ?, NULL)`,
          jst("10:00"),
          jst("10:00") - 99 * MIN,
          jst("07:00"),
        );
        // R2: 計画の行はまだ無いが morning は done(積み直さない)。
        x.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at) VALUES ('202606040902', 'morning', 'done', 1, 1, ?, ?)", jst("07:00"), jst("07:00"));
      }),
  },
  "確定の印だけを外して再実行(一覧の本体は捨て済み): 計画の行・morning・対象数は変わらず、確定の時刻だけが更新される。結果の行は積み直さない": {
    options: TWO,
    run: async (h) => {
      await listsOk(h);
      const first = await stepTrace(h, h.alarm.at!);
      h.sql.exec("DELETE FROM race_day_meta WHERE key = 'plan_finalized_at'");
      h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_finalize_next_try_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(jst("08:30")));
      const again = await stepTrace(h, jst("08:30"));
      return { first, again };
    },
  },
  "結果ストアなしの構成: 確定で結果の取り込みの行を積まない(race_day_result に行が無い)": { options: { ...TWO, store: false }, run: (h) => planRun(h, 4) },
  "結果ストアあり: 発走時刻のある計画の行ごとに、発走 + 15 分を最初の試行とする結果の行を積む(requested_on は開催日・queued_at は確定の時刻)": { options: TWO, run: (h) => planRun(h, 4) },
  "全レースが発走済み(started でスキップ): planned の行が無いので、結果ストアがあっても結果の行を積まない": {
    options: TWO,
    run: (h) => planRun(h, 4, (x) => (x.clock.now = jst("11:00"))),
  },
  "設定の読み取りの最中に時計が進む(10 分): 確定の時刻(planned_at・結果の行の queued_at・確定の印)は読み取りのあとの時刻。期限の判定もそれで行う(発走 08:52・期限 08:07 は、読み取りの前なら scheduled・あとなら immediate)": {
    options: { central: [central(1, "08:52")] },
    run: (h) =>
      planRun(h, 4, (x) => {
        x.onSettings = () => {
          x.clock.now += 10 * MIN;
        };
      }),
  },
  "【到達不能・記録】設定を読む間に開催日が消える: 読み取りのあとに開催日を読み直すので、確定が「未確定」で落ちる(試行回数と offset は書かれたまま)": {
    options: ONE,
    run: (h) =>
      planRun(h, 3, (x) => {
        x.onSettings = () => {
          x.sql.exec("DELETE FROM race_day_meta WHERE key = 'kaisai_date'");
        };
      }),
  },
};

describe("Issue #399(R-9e e1): 計画の一覧と確定を切り出す前の挙動(特性テスト)", () => {
  it("前提: 場面を数え直す(期待値の取りこぼしが無い)", () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThanOrEqual(25);
    expect(DEFAULT_PRE_RACE_OFFSET_MINUTES).toBe(45);
    expect(MAX_ATTEMPTS).toBe(3);
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

/** 切り出す前のコード(57ea0ee)の実出力。`CHAR_DUMP` で作り直せる。 */
const EXPECTED: Record<string, unknown> = {
 "混在日(中央 2R・地方は Jpn3 と対象外 2R): 一覧 2 本 → 確定。対象は中央全件 + 地方 Jpn だけ(targeted 2 と 1。listed は地方 3)。morning は対象の行ごと": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "1d36161d4a97858cd6e4262c85334631f0cf3a31",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [3,\"<len=440 sha1=29b24187df>\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 30,
    "sqlSha1": "30c8be7691ac9cfc5eff4b2202eff70c3138648d",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":440,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202636092701\",1790475300000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 65,
    "sqlSha1": "0d839ddd0c456afe34fd9578df93680aa9654c15",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":1,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202636092701","venue":"nar","venue_name":"水沢","race_number":1,"race_name":"地方1R","grade":"Jpn3","start_time":"11:00","start_ms":1790474400000,"due_ms":1790471700000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202636092701","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "中央・地方とも 0 件(ok): 計画の行なし・対象 0。確定は走り、結果の行は積まない(planned の行が無い)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 23,
    "sqlSha1": "6fb8d52e0c9236b33c0aca2fba83ba07e093b3ae",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790557260000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790557260000",
    ],
    "sqlCount": 38,
    "sqlSha1": "f088a7b8c0a35f99ff0bb3a434f2d25a7f993089",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "一覧が queue-full(busy)で 1 回だけ失敗: retry(RETRY_DELAY_MS 後)→ 再試行で ok。確定は両方終端になってから": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"busy\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 19,
    "sqlSha1": "b1a902d5a79ca0f914df6495f5e382423f853dc3",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 23,
    "sqlSha1": "fe07109c2cfdf13960eae15dc35a298255d7d476",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463660000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 30,
    "sqlSha1": "b4399b4709ff34fee2d7bc4ac2b5ee974b8e5f38",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463660000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463660000,1790463660000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463660000,1790463660000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463660000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 45,
    "sqlSha1": "0eb97005cea621953550d65159758fd4fd9abd2e",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463660000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463660000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463660000,"updated_at":1790463660000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_finalized_at","value":"1790463660000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "一覧が queue-full で MAX_ATTEMPTS 回続く(中央): 上限で failed(警告つき)。地方は ok。確定は中央 0 件・地方だけで走る": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"busy\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 19,
    "sqlSha1": "b1a902d5a79ca0f914df6495f5e382423f853dc3",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [3,\"<len=440 sha1=29b24187df>\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 25,
    "sqlSha1": "3ab6f3df06a8574778ce0b10862cb9d5669a1740",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":440,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463720000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463720000,\"busy\",1790463660000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463720000",
    ],
    "sqlCount": 19,
    "sqlSha1": "07aed1fcebf93aa73d11ac69424721f17409e92a",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":2,"next_try_at":1790463720000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":440,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:failed",
    "threw": null,
    "at": 1790463720000,
    "warnings": ["事前分析の計画: central の一覧を取得できませんでした(試行 3 回。理由: busy)"],
    "alarms": [1790463720000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [3,1790463720000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"busy\",1790463720000,\"central\"]",
     "onWarn 事前分析の計画: central の一覧を取得できませんでした(試行 3 回。理由: busy)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463720000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557380000\"]",
     "setAlarm 1790463720000",
    ],
    "sqlCount": 25,
    "sqlSha1": "0ec68fbb5a00166b441a91c9e732507332e2d890",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":3,"next_try_at":1790463720000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463720000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":440,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463720000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463720000,
    "warnings": [],
    "alarms": [1790463720000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790463720000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790463720000,1790463720000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202636092701\",1790475300000,\"20260927\",1790463720000,1790463720000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463720000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463720000",
    ],
    "sqlCount": 44,
    "sqlSha1": "0528b2c9a27b49a212db5373c04df1dd2d3081cd",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":3,"next_try_at":1790463720000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463720000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":1,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202636092701","venue":"nar","venue_name":"水沢","race_number":1,"race_name":"地方1R","grade":"Jpn3","start_time":"11:00","start_ms":1790474400000,"due_ms":1790471700000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463720000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"queued_at":1790463720000},
     ],
     "results": [
      {"race_id":"202636092701","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463720000,"updated_at":1790463720000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463720000"},
      {"key":"plan_finalized_at","value":"1790463720000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "一覧が blocked(中央): 再試行せず 1 回で failed(警告に理由 blocked)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:failed",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790463600000,\"central\"]",
     "onWarn 事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 20,
    "sqlSha1": "e923ee71b16bd590c88215190c14db84bace35fb",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790557260000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790557260000",
    ],
    "sqlCount": 37,
    "sqlSha1": "4f616be46557b118919caa53ee551609a2e4b9b4",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "一覧が HTTP 500(failed)で 1 回だけ失敗: retry → ok": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"failed\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 19,
    "sqlSha1": "f1edebdf1c03f6c2b8913f7ef222ef6f99d712d3",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 23,
    "sqlSha1": "fe07109c2cfdf13960eae15dc35a298255d7d476",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463660000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 30,
    "sqlSha1": "b4399b4709ff34fee2d7bc4ac2b5ee974b8e5f38",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463660000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463660000,1790463660000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463660000,1790463660000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463660000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 45,
    "sqlSha1": "0eb97005cea621953550d65159758fd4fd9abd2e",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463660000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463660000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463660000,"updated_at":1790463660000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_finalized_at","value":"1790463660000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "gate が例外を投げる(中央): 通信の失敗(failed)として扱われ、retry → ok。「想定外の失敗」の警告は出ない(それは getRaceList 自体が投げたときだけ)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"failed\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 19,
    "sqlSha1": "f1edebdf1c03f6c2b8913f7ef222ef6f99d712d3",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 23,
    "sqlSha1": "fe07109c2cfdf13960eae15dc35a298255d7d476",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463660000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 30,
    "sqlSha1": "b4399b4709ff34fee2d7bc4ac2b5ee974b8e5f38",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463660000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463660000,1790463660000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463660000,1790463660000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463660000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 45,
    "sqlSha1": "0eb97005cea621953550d65159758fd4fd9abd2e",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":1790463660000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463660000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463660000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463660000,"updated_at":1790463660000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_finalized_at","value":"1790463660000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "【到達不能・記録】開催日(kaisai_date)が無い: 想定外の失敗の警告(取得は呼ばれない)。試行回数は取得の前に永続化される": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: central の一覧の取得で想定外の失敗(開催日が未確定です)"],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "onWarn 事前分析の計画: central の一覧の取得で想定外の失敗(開催日が未確定です)",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"failed\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 17,
    "sqlSha1": "65ad169a6aff065b79cd71a4c17856681e47491e",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: nar の一覧の取得で想定外の失敗(開催日が未確定です)"],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧の取得で想定外の失敗(開催日が未確定です)",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"failed\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 17,
    "sqlSha1": "6e7254f72f4a0c1e2c70ff25d2b24a243537b26d",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "central:plan:list:retry",
    "threw": null,
    "at": 1790463660000,
    "warnings": ["事前分析の計画: central の一覧の取得で想定外の失敗(開催日が未確定です)"],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "onWarn 事前分析の計画: central の一覧の取得で想定外の失敗(開催日が未確定です)",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463720000,\"failed\",1790463660000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 17,
    "sqlSha1": "62045f456e2378c91487d602f427f901cd41af6d",
    "state": {
     "venues": [
      {"venue":"central","state":"pending","attempts":2,"next_try_at":1790463720000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463660000},
      {"venue":"nar","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"failed","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "片方だけ終端(中央 ok・地方は queue-full で再試行待ち): 確定を予約しない(plan_finalize_next_try_at を書かない)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ? | [1790463660000,\"busy\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 19,
    "sqlSha1": "2a750f2408a767ac7d8fd0e760ebcc90237b0416",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":1,"next_try_at":1790463660000,"reason":"busy","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "【到達不能・記録】確定済みで会場が pending に戻った状態で一覧が ok: 確定を予約しない(確定の印があるので)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":1,"next_try_at":0,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
   ],
   "results": [
    {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
   ],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790463600000"},
    {"key":"plan_finalized_at","value":"1790463600000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [2,1790463660000,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463660000,\"central\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 23,
    "sqlSha1": "f25d47cb9901dd9b66f95a741446b95710c55375",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":2,"next_try_at":0,"reason":null,"listed":1,"targeted":1,"entries_len":138,"updated_at":1790463660000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "救済(rescue)で失敗した会場を戻す: 地方の一覧が failed で確定 → 救済の依頼 → 地方を取り直して ok → 再確定(成功済みの中央は本体が無いので targeted を数え直さない)": {
  "before": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
   ],
   "results": [
    {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
   ],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_attempts","value":"1"},
    {"key":"plan_finalize_next_try_at","value":"1790463600000"},
    {"key":"plan_finalized_at","value":"1790463600000"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "afterRequest": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
   ],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
   ],
   "results": [
    {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
   ],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_offset","value":"45"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790463600000"},
    {"key":"plan_rescue_at","value":"1790463600000"},
   ],
  },
  "firstLabels": ["central:plan:list:ok","nar:plan:list:failed","plan:plan:finalize:ok"],
  "traces": [
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=153 sha1=9358bdcc35>\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 24,
    "sqlSha1": "c7a53f1339a15d04adafc112aab2add14cf489e8",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":153,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
      {"key":"plan_rescue_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202636092701\",\"nar\",\"水沢\",1,\"地方1R\",\"Jpn3\",\"11:00\",1790474400000,1790471700000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202636092701\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202636092701\",1790475300000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 43,
    "sqlSha1": "265a6e5000c740ab9272823ce34c0e098693d8eb",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202636092701","venue":"nar","venue_name":"水沢","race_number":1,"race_name":"地方1R","grade":"Jpn3","start_time":"11:00","start_ms":1790474400000,"due_ms":1790471700000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202636092701","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202636092701","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
      {"key":"plan_rescue_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "両方の会場が blocked で failed: 確定は 0 件で走る(targeted は書かない・計画の行なし・結果の行なし)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:failed",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790463600000,\"central\"]",
     "onWarn 事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 20,
    "sqlSha1": "e923ee71b16bd590c88215190c14db84bace35fb",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:failed",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ? | [\"blocked\",1790463600000,\"nar\"]",
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "37525540b32cb3b950dd4f55b7c799857a05df0c",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790557260000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790557260000",
    ],
    "sqlCount": 36,
    "sqlSha1": "294e5c06c2c38b0b21417f2f1268cc305612572e",
    "state": {
     "venues": [
      {"venue":"central","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"failed","attempts":1,"next_try_at":1790463600000,"reason":"blocked","listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "取得の最中に時計が進む: 試行回数の永続化は取得の前の時刻、結果の書き込みは取得のあとの時刻(now を値で固定しない)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790464020000,
    "warnings": [],
    "alarms": [1790464020000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790464020000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557680000\"]",
     "setAlarm 1790464020000",
    ],
    "sqlCount": 25,
    "sqlSha1": "82bd8167780f3d35586650da711e77317e354fab",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790464020000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790464440000,
    "warnings": [],
    "alarms": [1790464440000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790464020000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790464440000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790464440000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790558100000\"]",
     "setAlarm 1790464440000",
    ],
    "sqlCount": 28,
    "sqlSha1": "51235d425462a37488e11697eabfe70a3bd54455",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790464020000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790464440000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790464440000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790464440000,
    "warnings": [],
    "alarms": [1790464440000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790464440000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790464440000,1790464440000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790464440000,1790464440000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790464440000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790464440000",
    ],
    "sqlCount": 45,
    "sqlSha1": "230c5225c95ddfc89fa0102d35248dbd14fdc712",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790464020000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790464440000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790464440000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790464440000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790464440000,"updated_at":1790464440000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790464440000"},
      {"key":"plan_finalized_at","value":"1790464440000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "設定の読み取りが成功(offset 30 分): 設定の値で期限を決める(plan_offset_source = settings)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [3,\"<len=412 sha1=c5c86f88cb>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "8b5b6f00a4e5f005ba81117cbf5e1b8d56d96fc0",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"30\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790469000000,30,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790470800000,30,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"11:00\",1790474400000,1790472600000,30,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040903\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [3,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790475300000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 65,
    "sqlSha1": "b1b7f0583583cbdd4c9a1735068485ee6d01b3a7",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":3,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790469000000,"offset_minutes":30,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790470800000,"offset_minutes":30,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"11:00","start_ms":1790474400000,"due_ms":1790472600000,"offset_minutes":30,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040903","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"30"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "設定の読み取りが 1 回目だけ失敗: retry(RETRY_DELAY_MS 後・警告)→ 2 回目で成功": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): D1 に繋がらない"],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
     "onWarn 事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): D1 に繋がらない",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 24,
    "sqlSha1": "cc8ab656acc71756a6eb2ae853e582b356238701",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463660000,
    "warnings": [],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"2\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463660000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463660000,1790463660000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463660000,1790463660000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463660000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 45,
    "sqlSha1": "ddfd5d00ba1a59efcce3f7269aa5bbbb76c755b0",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463660000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463660000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463660000,"updated_at":1790463660000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"2"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_finalized_at","value":"1790463660000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "設定の読み取りが MAX_ATTEMPTS 回続けて失敗: 2 回は retry、MAX_ATTEMPTS 回目で既定値(45 分)にフォールバックして確定(警告の文言。鍵の形は伏せる)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:retry",
    "threw": null,
    "at": 1790463600000,
    "warnings": ["事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): 失敗1"],
    "alarms": [1790463660000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
     "onWarn 事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): 失敗1",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463660000",
    ],
    "sqlCount": 24,
    "sqlSha1": "cc8ab656acc71756a6eb2ae853e582b356238701",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463660000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:retry",
    "threw": null,
    "at": 1790463660000,
    "warnings": ["事前分析の計画: 設定を読めませんでした(試行 2 回。再試行します): 失敗2"],
    "alarms": [1790463720000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"2\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463720000\"]",
     "onWarn 事前分析の計画: 設定を読めませんでした(試行 2 回。再試行します): 失敗2",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557320000\"]",
     "setAlarm 1790463720000",
    ],
    "sqlCount": 24,
    "sqlSha1": "8ee8b4c38ba245dd83b2c593a6bc34a06787a045",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"2"},
      {"key":"plan_finalize_next_try_at","value":"1790463720000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463720000,
    "warnings": ["事前分析の計画: 設定を読めなかったため、既定の 45 分で計画しました(試行 3 回): 失敗3 sk-ant-***"],
    "alarms": [1790463720000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"3\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"default-fallback\"]",
     "onWarn 事前分析の計画: 設定を読めなかったため、既定の 45 分で計画しました(試行 3 回): 失敗3 sk-ant-***",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463720000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463720000,1790463720000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463720000,1790463720000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463720000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463720000",
    ],
    "sqlCount": 45,
    "sqlSha1": "30f87c51b745c481818042cb5711204d78a84084",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463720000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463720000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463720000,"updated_at":1790463720000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"3"},
      {"key":"plan_finalize_next_try_at","value":"1790463720000"},
      {"key":"plan_finalized_at","value":"1790463720000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"default-fallback"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "offset が決定済み(plan_offset = 20 / settings): 設定を読まない(loadSettings が呼ばれない)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_offset","value":"20"},
    {"key":"plan_offset_source","value":"settings"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_offset","value":"20"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_offset","value":"20"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790469600000,20,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 43,
    "sqlSha1": "e5e3c7b31fb13a4d21622371f95e7165c2ae7087",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790469600000,"offset_minutes":20,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"20"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "確定の試行の時刻の前に起きても、確定は走らない(設定が失敗した後、RETRY_DELAY_MS の 1ms 前は確定しない・ちょうどで確定する)": {
  "first": {
   "label": "plan:plan:finalize:retry",
   "threw": null,
   "at": 1790463600000,
   "warnings": ["事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): 一時的な失敗"],
   "alarms": [1790463660000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
    "loadSettings",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463660000\"]",
    "onWarn 事前分析の計画: 設定を読めませんでした(試行 1 回。再試行します): 一時的な失敗",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
    "setAlarm 1790463660000",
   ],
   "sqlCount": 24,
   "sqlSha1": "cc8ab656acc71756a6eb2ae853e582b356238701",
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
    ],
    "plan": [],
    "tasks": [],
    "results": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790463660000"},
     {"key":"plan_requested_at","value":"1790463600000"},
    ],
   },
  },
  "early": {
   "label": "idle",
   "threw": null,
   "at": 1790463659999,
   "warnings": [],
   "alarms": [1790463660000],
   "events": ["setAlarm 1790463660000"],
   "sqlCount": 28,
   "sqlSha1": "196abe83033bb1c8d68f553de4a9cb5382c24dd9",
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
    ],
    "plan": [],
    "tasks": [],
    "results": [],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790463660000"},
     {"key":"plan_requested_at","value":"1790463600000"},
    ],
   },
  },
  "onTime": {
   "label": "plan:plan:finalize:ok",
   "threw": null,
   "at": 1790463660000,
   "warnings": [],
   "alarms": [1790463660000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"2\"]",
    "loadSettings",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
    "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463660000,null]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463660000,1790463660000]",
    "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
    "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
    "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463660000,1790463660000]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463660000\"]",
    "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
    "setAlarm 1790463660000",
   ],
   "sqlCount": 45,
   "sqlSha1": "ddfd5d00ba1a59efcce3f7269aa5bbbb76c755b0",
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463660000,"promoted_at":null},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463660000},
    ],
    "results": [
     {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463660000,"updated_at":1790463660000},
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"2"},
     {"key":"plan_finalize_next_try_at","value":"1790463660000"},
     {"key":"plan_finalized_at","value":"1790463660000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790463600000"},
    ],
   },
  },
 },
 "計画の行の判定(buildPlanRow): scheduled・immediate・too-late・started・no-start-time(時刻なし)を 1 日に並べる。skip の行には morning を積まない。結果の行は発走時刻のある行(skip を含む)だけ": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [5,\"<len=666 sha1=5fb378ad4c>\",1790467200000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860000\"]",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 25,
    "sqlSha1": "ea3ac80af18936e49aad45ddb3af70037a43b981",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":5,"targeted":null,"entries_len":666,"updated_at":1790467200000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790467200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790467200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860000\"]",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 28,
    "sqlSha1": "bbe458511d2f3748c2e5074627e03df323901650",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":5,"targeted":null,"entries_len":666,"updated_at":1790467200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790467200000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790467200000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"12:00\",1790478000000,1790475300000,45,\"scheduled\",null,\"planned\",1790467200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"09:20\",1790468400000,1790465700000,45,\"immediate\",null,\"planned\",1790467200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"09:05\",1790467500000,null,45,\"skip\",\"too-late\",\"skipped\",1790467200000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040904\",\"central\",\"中山\",4,\"中央4R\",null,\"08:30\",1790465400000,null,45,\"skip\",\"started\",\"skipped\",1790467200000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040905\",\"central\",\"中山\",5,\"中央5R\",null,null,null,null,45,\"skip\",\"no-start-time\",\"skipped\",1790467200000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [5,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040904\",1790466300000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790468400000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790469300000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790478900000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790467200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 65,
    "sqlSha1": "a99d1ae2a41dd7c00cc4dedebb94866f836afd66",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":5,"targeted":5,"entries_len":null,"updated_at":1790467200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790467200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"12:00","start_ms":1790478000000,"due_ms":1790475300000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"09:20","start_ms":1790468400000,"due_ms":1790465700000,"offset_minutes":45,"disposition":"immediate","skip_reason":null,"state":"planned","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"09:05","start_ms":1790467500000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"too-late","state":"skipped","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040904","venue":"central","venue_name":"中山","race_number":4,"race_name":"中央4R","grade":null,"start_time":"08:30","start_ms":1790465400000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040905","venue":"central","venue_name":"中山","race_number":5,"race_name":"中央5R","grade":null,"start_time":null,"start_ms":null,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"no-start-time","state":"skipped","planned_at":1790467200000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790467200000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790467200000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790478900000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790469300000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468400000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040904","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790466300000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790467200000"},
      {"key":"plan_finalized_at","value":"1790467200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "期限と現在の境目 1(now = 09:00:00.000。buildPlanRow): 期限ちょうど(scheduled)・発走まで 10 分ちょうど(immediate)・発走ちょうど(started)・発走の 1 分後(started)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [4,\"<len=549 sha1=70d08bfb1d>\",1790467200000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860000\"]",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 25,
    "sqlSha1": "89341574652c1c6b49644f7de56e4d15cf56a0fd",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":null,"entries_len":549,"updated_at":1790467200000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790467200000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790467200000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860000\"]",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 28,
    "sqlSha1": "bbe458511d2f3748c2e5074627e03df323901650",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":null,"entries_len":549,"updated_at":1790467200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790467200000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790467200000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790467200000,
    "warnings": [],
    "alarms": [1790467200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"09:45\",1790469900000,1790467200000,45,\"scheduled\",null,\"planned\",1790467200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"09:10\",1790467800000,1790465100000,45,\"immediate\",null,\"planned\",1790467200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"09:00\",1790467200000,null,45,\"skip\",\"started\",\"skipped\",1790467200000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040904\",\"central\",\"中山\",4,\"中央4R\",null,\"08:59\",1790467140000,null,45,\"skip\",\"started\",\"skipped\",1790467200000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [4,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040904\",1790468040000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790468100000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790468700000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790470800000,\"20260927\",1790467200000,1790467200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790467200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790467200000",
    ],
    "sqlCount": 63,
    "sqlSha1": "df416662a05f7251fda31c54ccef2b6e1defc54e",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":4,"entries_len":null,"updated_at":1790467200000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790467200000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"09:45","start_ms":1790469900000,"due_ms":1790467200000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"09:10","start_ms":1790467800000,"due_ms":1790465100000,"offset_minutes":45,"disposition":"immediate","skip_reason":null,"state":"planned","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"09:00","start_ms":1790467200000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790467200000,"promoted_at":null},
      {"race_id":"202606040904","venue":"central","venue_name":"中山","race_number":4,"race_name":"中央4R","grade":null,"start_time":"08:59","start_ms":1790467140000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790467200000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790467200000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790467200000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790470800000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468700000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468100000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
      {"race_id":"202606040904","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468040000,"requested_on":"20260927","queued_at":1790467200000,"updated_at":1790467200000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790467200000"},
      {"key":"plan_finalized_at","value":"1790467200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "期限と現在の境目 2(now = 09:00:00.001。buildPlanRow): 期限の 1ms 後(immediate)・発走まで 10 分に 1ms 足りない(too-late)・発走の 59.999 秒前(too-late)・発走ちょうど(started)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790467200001,
    "warnings": [],
    "alarms": [1790467200001],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200001,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [4,\"<len=549 sha1=05411d0d34>\",1790467200001,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860001\"]",
     "setAlarm 1790467200001",
    ],
    "sqlCount": 25,
    "sqlSha1": "2104b69e30369034610e97f3db32c4cafe4503cc",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":null,"entries_len":549,"updated_at":1790467200001},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790467200001,
    "warnings": [],
    "alarms": [1790467200001],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790467200001,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790467200001,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790467200001\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790560860001\"]",
     "setAlarm 1790467200001",
    ],
    "sqlCount": 28,
    "sqlSha1": "c5736de8a686303f6300a471e3490cc916f16c09",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":null,"entries_len":549,"updated_at":1790467200001},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790467200001},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790467200001"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790467200001,
    "warnings": [],
    "alarms": [1790467200001],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"09:45\",1790469900000,1790467200000,45,\"immediate\",null,\"planned\",1790467200001,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790467200001,1790467200001]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"09:10\",1790467800000,null,45,\"skip\",\"too-late\",\"skipped\",1790467200001,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"09:01\",1790467260000,null,45,\"skip\",\"too-late\",\"skipped\",1790467200001,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040904\",\"central\",\"中山\",4,\"中央4R\",null,\"09:00\",1790467200000,null,45,\"skip\",\"started\",\"skipped\",1790467200001,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [4,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040904\",1790468100000,\"20260927\",1790467200001,1790467200001]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790468160000,\"20260927\",1790467200001,1790467200001]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790468700000,\"20260927\",1790467200001,1790467200001]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790470800000,\"20260927\",1790467200001,1790467200001]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790467200001\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790467200001",
    ],
    "sqlCount": 57,
    "sqlSha1": "ad60212e0443fe51672688e310a48492b693bbd9",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":4,"targeted":4,"entries_len":null,"updated_at":1790467200001},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790467200001},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"09:45","start_ms":1790469900000,"due_ms":1790467200000,"offset_minutes":45,"disposition":"immediate","skip_reason":null,"state":"planned","planned_at":1790467200001,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"09:10","start_ms":1790467800000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"too-late","state":"skipped","planned_at":1790467200001,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"09:01","start_ms":1790467260000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"too-late","state":"skipped","planned_at":1790467200001,"promoted_at":null},
      {"race_id":"202606040904","venue":"central","venue_name":"中山","race_number":4,"race_name":"中央4R","grade":null,"start_time":"09:00","start_ms":1790467200000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790467200001,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790467200001},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790470800000,"requested_on":"20260927","queued_at":1790467200001,"updated_at":1790467200001},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468700000,"requested_on":"20260927","queued_at":1790467200001,"updated_at":1790467200001},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468160000,"requested_on":"20260927","queued_at":1790467200001,"updated_at":1790467200001},
      {"race_id":"202606040904","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790468100000,"requested_on":"20260927","queued_at":1790467200001,"updated_at":1790467200001},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790467200001"},
      {"key":"plan_finalized_at","value":"1790467200001"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "【到達不能・記録】一覧の本体の発走時刻が読めない(99:99): no-start-time でスキップ(start_ms は null)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
    {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_finalize_next_try_at","value":"1790463600000"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"99:99\",null,null,45,\"skip\",\"no-start-time\",\"skipped\",1790463600000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 47,
    "sqlSha1": "573f43ba97a614353eeb442884b750253bea0af7",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"99:99","start_ms":null,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"no-start-time","state":"skipped","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "上限(cap): 既存のタスク 96 件 + 3 レース。1・2 レース目は planned(合計がちょうど上限)、3 レース目は cap でスキップ。morning は planned の行だけ": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [3,\"<len=412 sha1=c5c86f88cb>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "8b5b6f00a4e5f005ba81117cbf5e1b8d56d96fc0",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"11:00\",1790474400000,null,45,\"skip\",\"cap\",\"skipped\",1790463600000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [3,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790475300000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 62,
    "sqlSha1": "1e750d073b5d0b0d17ca1078d58bd2b0fcfd65dc",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":3,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"11:00","start_ms":1790474400000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"cap","state":"skipped","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "上限(cap): 既存のタスク 97 件 + 3 レース。1 レース目だけ planned(2 レース目は合計 101 で上限を 1 超えるので cap。3 レース目も cap)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [3,\"<len=412 sha1=c5c86f88cb>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "8b5b6f00a4e5f005ba81117cbf5e1b8d56d96fc0",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":null,"entries_len":412,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,null,45,\"skip\",\"cap\",\"skipped\",1790463600000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040903\",\"central\",\"中山\",3,\"中央3R\",null,\"11:00\",1790474400000,null,45,\"skip\",\"cap\",\"skipped\",1790463600000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [3,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040903\",1790475300000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 59,
    "sqlSha1": "12473f103e3812953a13d93c549fecda4f98ba5c",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":3,"targeted":3,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"cap","state":"skipped","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040903","venue":"central","venue_name":"中山","race_number":3,"race_name":"中央3R","grade":null,"start_time":"11:00","start_ms":1790474400000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"cap","state":"skipped","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040903","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790475300000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "上限(cap): 既存のタスク MAX_TASKS_PER_DAY − 1 件: 最初の行から cap(必要数 2 で超える)。planned が無いので結果の行は積まない": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "1d36161d4a97858cd6e4262c85334631f0cf3a31",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790557260000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,null,45,\"skip\",\"cap\",\"skipped\",1790463600000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,null,45,\"skip\",\"cap\",\"skipped\",1790463600000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790557260000",
    ],
    "sqlCount": 48,
    "sqlSha1": "648e6707e46969f4caf4b28e3896eaf6eb895884",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"cap","state":"skipped","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"cap","state":"skipped","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "上限(cap): morning が既にある行は必要数 1: 既存のタスクが MAX_TASKS_PER_DAY − 1 件(morning を含む)でも planned": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [
    {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
   ],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790468100000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790468100000",
    ],
    "sqlCount": 48,
    "sqlSha1": "9a0a77e8efc4b12b506c5deedc4ba5678bd8bcf1",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "確定が途中まで書かれていた状態から再実行: 既にある計画の行は変えず(最初の計画のまま)、無い行だけ足す。morning は行がまだ無いときだけ積む(既にあれば積み直さない)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [
    {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790464860000,"offset_minutes":99,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790460000000,"promoted_at":null},
   ],
   "tasks": [
    {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
   ],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "1d36161d4a97858cd6e4262c85334631f0cf3a31",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790464860000,"offset_minutes":99,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790460000000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790464860000,"offset_minutes":99,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790460000000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 49,
    "sqlSha1": "6039dee1509a384f1d4ece8c79b3f73b7ff68e4b",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790464860000,"offset_minutes":99,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790460000000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"done","attempts":1,"queued_at":1790460000000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "確定の印だけを外して再実行(一覧の本体は捨て済み): 計画の行・morning・対象数は変わらず、確定の時刻だけが更新される。結果の行は積み直さない": {
  "first": {
   "label": "plan:plan:finalize:ok",
   "threw": null,
   "at": 1790463600000,
   "warnings": [],
   "alarms": [1790463600000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
    "loadSettings",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
    "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
    "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
    "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
    "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
    "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
    "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
    "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
    "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
    "setAlarm 1790463600000",
   ],
   "sqlCount": 55,
   "sqlSha1": "a3b64f47bef4ee37b962162b8d29baf6e0ffaebc",
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
    ],
    "results": [
     {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"1"},
     {"key":"plan_finalize_next_try_at","value":"1790463600000"},
     {"key":"plan_finalized_at","value":"1790463600000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790463600000"},
    ],
   },
  },
  "again": {
   "label": "plan:plan:finalize:ok",
   "threw": null,
   "at": 1790465400000,
   "warnings": [],
   "alarms": [1790465400000],
   "events": [
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"2\"]",
    "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790465400000\"]",
    "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
    "setAlarm 1790465400000",
   ],
   "sqlCount": 33,
   "sqlSha1": "92cca9cb8fae61d128a2b33e372d7215a695fd62",
   "state": {
    "venues": [
     {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
     {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
    ],
    "plan": [
     {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
    ],
    "tasks": [
     {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
    ],
    "results": [
     {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
    ],
    "meta": [
     {"key":"kaisai_date","value":"20260927"},
     {"key":"plan_finalize_attempts","value":"2"},
     {"key":"plan_finalize_next_try_at","value":"1790465400000"},
     {"key":"plan_finalized_at","value":"1790465400000"},
     {"key":"plan_offset","value":"45"},
     {"key":"plan_offset_source","value":"settings"},
     {"key":"plan_requested_at","value":"1790463600000"},
    ],
   },
  },
 },
 "結果ストアなしの構成: 確定で結果の取り込みの行を積まない(race_day_result に行が無い)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 22,
    "sqlSha1": "03e3e8f2565fed3188ed91111e490c38b2ebe9d3",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 24,
    "sqlSha1": "a552cd8744d1bf78f332447b1a222700a9cf6038",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 47,
    "sqlSha1": "ea938fa3753d7e6b4ae8200f8ca3201312299139",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "結果ストアあり: 発走時刻のある計画の行ごとに、発走 + 15 分を最初の試行とする結果の行を積む(requested_on は開催日・queued_at は確定の時刻)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "1d36161d4a97858cd6e4262c85334631f0cf3a31",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,1790468100000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,1790469900000,45,\"scheduled\",null,\"planned\",1790463600000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040902\",\"morning\",1790463600000,1790463600000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790471700000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040902\",1790473500000,\"20260927\",1790463600000,1790463600000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790463600000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 55,
    "sqlSha1": "a3b64f47bef4ee37b962162b8d29baf6e0ffaebc",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":1790468100000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":1790469900000,"offset_minutes":45,"disposition":"scheduled","skip_reason":null,"state":"planned","planned_at":1790463600000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
      {"race_id":"202606040902","mode":"morning","status":"queued","attempts":0,"queued_at":1790463600000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790471700000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
      {"race_id":"202606040902","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790473500000,"requested_on":"20260927","queued_at":1790463600000,"updated_at":1790463600000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "全レースが発走済み(started でスキップ): planned の行が無いので、結果ストアがあっても結果の行を積まない": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790474400000,
    "warnings": [],
    "alarms": [1790474400000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790474400000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [2,\"<len=275 sha1=42330ecd58>\",1790474400000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790568060000\"]",
     "setAlarm 1790474400000",
    ],
    "sqlCount": 25,
    "sqlSha1": "dd79fd75617e8f3b1a2947c7f98bbde3cb867fa1",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790474400000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790474400000,
    "warnings": [],
    "alarms": [1790474400000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790474400000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790474400000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790474400000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790568060000\"]",
     "setAlarm 1790474400000",
    ],
    "sqlCount": 28,
    "sqlSha1": "e468712a2dbcf99fed1496fe5211be9e429977db",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":null,"entries_len":275,"updated_at":1790474400000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790474400000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790474400000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790474400000,
    "warnings": [],
    "alarms": [1790568060000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"10:00\",1790470800000,null,45,\"skip\",\"started\",\"skipped\",1790474400000,null]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040902\",\"central\",\"中山\",2,\"中央2R\",null,\"10:30\",1790472600000,null,45,\"skip\",\"started\",\"skipped\",1790474400000,null]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [2,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790474400000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790568060000\"]",
     "setAlarm 1790568060000",
    ],
    "sqlCount": 42,
    "sqlSha1": "27c880b6bea8d5cc8c6dd9f1e8e3bc0826534e8c",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":2,"targeted":2,"entries_len":null,"updated_at":1790474400000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790474400000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"10:00","start_ms":1790470800000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790474400000,"promoted_at":null},
      {"race_id":"202606040902","venue":"central","venue_name":"中山","race_number":2,"race_name":"中央2R","grade":null,"start_time":"10:30","start_ms":1790472600000,"due_ms":null,"offset_minutes":45,"disposition":"skip","skip_reason":"started","state":"skipped","planned_at":1790474400000,"promoted_at":null},
     ],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790474400000"},
      {"key":"plan_finalized_at","value":"1790474400000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "設定の読み取りの最中に時計が進む(10 分): 確定の時刻(planned_at・結果の行の queued_at・確定の印)は読み取りのあとの時刻。期限の判定もそれで行う(発走 08:52・期限 08:07 は、読み取りの前なら scheduled・あとなら immediate)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=f56fdb3afb>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "b6332e50aa5778ff77af587da14d2765f16637a8",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "plan:plan:finalize:ok",
    "threw": null,
    "at": 1790464200000,
    "warnings": [],
    "alarms": [1790464200000],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
     "SQL INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING | [\"202606040901\",\"central\",\"中山\",1,\"中央1R\",null,\"08:52\",1790466720000,1790464020000,45,\"immediate\",null,\"planned\",1790464200000,null]",
     "SQL INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok) VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL) ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL | [\"202606040901\",\"morning\",1790464200000,1790464200000]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [1,\"central\"]",
     "SQL UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ? | [0,\"nar\"]",
     "SQL INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?) ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at, requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at | [\"202606040901\",1790467620000,\"20260927\",1790464200000,1790464200000]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalized_at\",\"1790464200000\"]",
     "SQL UPDATE race_day_plan_venue SET entries_json = NULL | []",
     "setAlarm 1790464200000",
    ],
    "sqlCount": 45,
    "sqlSha1": "247b4ec3afa8856f7b5bce5b9d6f7d5cb3353df5",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":1,"entries_len":null,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":0,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [
      {"race_id":"202606040901","venue":"central","venue_name":"中山","race_number":1,"race_name":"中央1R","grade":null,"start_time":"08:52","start_ms":1790466720000,"due_ms":1790464020000,"offset_minutes":45,"disposition":"immediate","skip_reason":null,"state":"planned","planned_at":1790464200000,"promoted_at":null},
     ],
     "tasks": [
      {"race_id":"202606040901","mode":"morning","status":"queued","attempts":0,"queued_at":1790464200000},
     ],
     "results": [
      {"race_id":"202606040901","state":"queued","attempts":0,"deferrals":0,"next_try_at":1790467620000,"requested_on":"20260927","queued_at":1790464200000,"updated_at":1790464200000},
     ],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_finalized_at","value":"1790464200000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
 "【到達不能・記録】設定を読む間に開催日が消える: 読み取りのあとに開催日を読み直すので、確定が「未確定」で落ちる(試行回数と offset は書かれたまま)": {
  "initial": {
   "venues": [
    {"venue":"central","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
    {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
   ],
   "plan": [],
   "tasks": [],
   "results": [],
   "meta": [
    {"key":"kaisai_date","value":"20260927"},
    {"key":"plan_requested_at","value":"1790463600000"},
   ],
  },
  "traces": [
   {
    "label": "central:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"central\"]",
     "gate.fetch https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [1,\"<len=138 sha1=b1ef4c32f0>\",1790463600000,\"central\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 25,
    "sqlSha1": "19498cc7826a150401d44c17299499f2cb90c1ad",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"pending","attempts":0,"next_try_at":1790463600000,"reason":null,"listed":null,"targeted":null,"entries_len":null,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "nar:plan:list:ok",
    "threw": null,
    "at": 1790463600000,
    "warnings": [],
    "alarms": [1790463600000],
    "events": [
     "SQL UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ? | [1,1790463600000,\"nar\"]",
     "gate.fetch https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260927",
     "SQL UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ? | [0,\"[]\",1790463600000,\"nar\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_next_try_at\",\"1790463600000\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"purge_due_at\",\"1790557260000\"]",
     "setAlarm 1790463600000",
    ],
    "sqlCount": 28,
    "sqlSha1": "4b8011b4a45f6ef21f2f59ef16dde5ceff912697",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"kaisai_date","value":"20260927"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
   {
    "label": "THROW",
    "threw": "開催日または offset が未確定です",
    "at": 1790463600000,
    "warnings": [],
    "alarms": [],
    "events": [
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"plan_finalize_attempts\",\"1\"]",
     "loadSettings",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset\",\"45\"]",
     "SQL INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING | [\"plan_offset_source\",\"settings\"]",
    ],
    "sqlCount": 14,
    "sqlSha1": "d140908a8f6a09e37cdf60b0e1da55bffa6fb6a4",
    "state": {
     "venues": [
      {"venue":"central","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":1,"targeted":null,"entries_len":138,"updated_at":1790463600000},
      {"venue":"nar","state":"ok","attempts":1,"next_try_at":1790463600000,"reason":null,"listed":0,"targeted":null,"entries_len":2,"updated_at":1790463600000},
     ],
     "plan": [],
     "tasks": [],
     "results": [],
     "meta": [
      {"key":"plan_finalize_attempts","value":"1"},
      {"key":"plan_finalize_next_try_at","value":"1790463600000"},
      {"key":"plan_offset","value":"45"},
      {"key":"plan_offset_source","value":"settings"},
      {"key":"plan_requested_at","value":"1790463600000"},
     ],
    },
   },
  ],
 },
};
