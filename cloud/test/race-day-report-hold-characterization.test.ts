import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { MAX_ATTEMPTS, RaceDayCore, REPORT_HOLD_KEY, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #399(R-9b): 日報の時刻の下限の段階(`reportHoldAt`・`afterReportHold`・`pendingReportHoldAt`・`reportJudgePending`・`markReportHoldJudged`・`recordReportHold`)を
 * `RaceDayCore` から切り出す前に、**今の挙動を固定する特性テスト**。切り出しの前後で、このファイルを書き換えずに緑のままであることが、挙動を変えていないことの根拠になる。
 *
 * 既存の `race-day-report-hold.test.ts` が固定している面(記録の値・回数・skip 条件・依頼の時刻)に加えて、**値だけでは見えない面**を固定する:
 *  - **ログの文言**(`onWarn` に渡る文面。全文一致)
 *  - **アラームの張り方**(`setAlarm` の呼び出しの系列。`reportHoldAtMs`〈下限の候補〉と `reportJudgePending`〈判定の即時の候補〉が入る場面と入らない場面)
 *  - **SQL の文と順序**(各ステップが DO の SQLite に出す文と束縛値。下限・依頼済み・判定済みの印の読み書きは読める形で、全体は SHA-1 で固定する)
 *  - **gate への取得**(一覧の呼び出しの引数と回数、ゲートに出た URL の系列)
 *  - 例外の扱い(`getRaceList` の例外・SQL の書き込みの例外を外へ漏らさない)
 *
 * **Issue #400 R-10b で、SQL の SHA-1 の期待値を 5 か所更新した**: DO に保存する朝の prior の JSON から `AnalysisResult.dateApproximate` が消えたため(差は `sqlSha1` の値だけ。`buildAnalysisResult` に `dateApproximate: false` を足し戻すと、更新前の値で 30 件が通ることを確認した)。
 * 期待値は、切り出す前のコード(31b5c4e)の実出力から作った。ハーネスは `race-day-report-hold.test.ts` と同じ(ゲートは偽・保存先は偽・ストレージは `node:sqlite`)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20261013";
const jst = (time: string, date = "2026-10-13"): number => Date.parse(`${date}T${time}:00+09:00`);
const JST_0900 = jst("09:00");
const MIN = 60_000;

/** 地方の結果ページ(実フィクスチャ。12 頭・単勝の払戻あり。どの地方のレースにも使い回す)。 */
const NAR_RESULT = fixture("nar_result_202654071210.html");
/** 中央の 16 頭の確定した結果ページ。 */
const CENTRAL_RESULT = fixture("result_202603020211.html");

interface ListRow {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly name: string;
  readonly time: string | null;
}
function listHtml(rows: readonly ListRow[]): string {
  const venues = [...new Set(rows.map((r) => r.venue))];
  return venues
    .map((venue) => {
      const items = rows
        .filter((r) => r.venue === venue)
        .map(
          (r) => `<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${r.raceId}&rf=race_list">
<div class="Race_Num"><span>${r.raceNumber}R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">${r.name}</span></div>
<div class="RaceData"><span class="RaceList_Itemtime">${r.time ?? ""} </span><span class="Dart">ダ1200m</span>16頭</div>
</div>
</a>
</li>`,
        )
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

/** 地方の race_id: 場コード 45(川崎)・44(大井)+ 月日 1013 + レース番号。 */
const kawasaki = (n: number): string => `2026451013${String(n).padStart(2, "0")}`;
const ooi = (n: number): string => `2026441013${String(n).padStart(2, "0")}`;
const nar = (id: string, venue: string, n: number, time: string | null): ListRow => ({ raceId: id, venue, raceNumber: n, name: `${venue}${n}R`, time });
const KAWASAKI_ROWS: readonly ListRow[] = [nar(kawasaki(9), "川崎", 9, "19:05"), nar(kawasaki(10), "川崎", 10, "19:40"), nar(kawasaki(11), "川崎", 11, "20:15"), nar(kawasaki(12), "川崎", 12, "20:50")];
const KAWASAKI_LAST = jst("20:50");
/** 中央の手動の対象 202603020211 と同じ開催(先頭 10 桁 2026030202)の一覧。11R が手動の対象で、最終は 12R 16:25。 */
const CENTRAL_ROWS: readonly ListRow[] = [
  { raceId: "202603020211", venue: "福島", raceNumber: 11, name: "福島11R", time: "15:45" },
  { raceId: "202603020212", venue: "福島", raceNumber: 12, name: "福島12R", time: "16:25" },
];

// ---- 偽のゲート ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "拒否(本文は状態・警告に入れない)SECRET-MESSAGE" });

const RESULT_URL = /\/race\/result\.html\?race_id=(\d{12})$/;

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** 一覧の URL だけを数える(中央・地方別)。 */
  listUrls(kind: "central" | "nar"): string[];
  /** 出馬表などの分析用のページを返すか(false のあいだは、分析の取得を拒否する)。 */
  analysis: boolean;
  centralList: string;
  narList: string;
  /** 地方の一覧を拒否する(失敗の模擬)。 */
  narListRefused: boolean;
  /** 地方の出馬表の発走時刻(race_id → HH:MM)。一覧の時刻と揃える。 */
  readonly narStart: Map<string, string>;
}
function fakeGate(centralList: string, narList: string, narRows: readonly ListRow[]): FakeGate {
  const gate: FakeGate = {
    urls: [],
    analysis: false,
    centralList,
    narList,
    narListRefused: false,
    narStart: new Map(narRows.filter((r) => r.time !== null).map((r) => [r.raceId, r.time!])),
    listUrls: (kind) => gate.urls.filter((u) => u.startsWith(kind === "central" ? "https://race.netkeiba.com/top/race_list_sub" : "https://nar.netkeiba.com/top/race_list_sub")),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return okPage(gate.centralList);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return gate.narListRefused ? blocked() : okPage(gate.narList);
      const m = RESULT_URL.exec(url);
      if (m !== null) return okPage(Number(m[1]!.slice(4, 6)) >= 30 ? NAR_RESULT : CENTRAL_RESULT);
      if (!gate.analysis) return blocked();
      try {
        if (url.includes("nar.netkeiba.com")) {
          if (url.includes("shutuba.html")) {
            const id = /race_id=(\d{12})/.exec(url)![1]!;
            return okPage(fixture("nar_shutuba_202654071210.html").replace("20:50発走", `${gate.narStart.get(id) ?? "20:50"}発走`));
          }
          if (url.includes("type=b1&")) return okPage(fixture("nar_odds_b1_202654071210.html"));
          throw new Error(`未知のURL(NAR): ${url}`);
        }
        return okPage(fixtureForUrl(url));
      } catch {
        return blocked();
      }
    },
  };
  return gate;
}

interface FakeStore {
  readonly saved: string[];
  saveResult(raceId: string, entries: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  saveWinOdds(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  saveScratched(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    saved: [],
    async saveResult(raceId) {
      store.saved.push(raceId);
    },
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
  return store;
}

interface RecordingSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
}
function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    saved: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt() {
      return null;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly store: FakeStore;
  readonly sink: RecordingSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  /** 日報の依頼の開催日と、依頼したときの時計。 */
  readonly reports: string[];
  readonly reportTimes: number[];
  /** `setAlarm` の呼び出しの系列(全部)。 */
  readonly alarms: number[];
  /** 実行した SQL の全部(文を空白で詰めたもの + 束縛値の JSON)に、警告(`onWarn <文面>`)を実行順に挟んだもの。`sql`(テスト自身の問い合わせ用)には出ない。 */
  readonly sqlLog: string[];
  /** `getRaceList` の呼び出し(引数)。 */
  readonly listSpy: MockInstance<RaceDayCore["getRaceList"]>;
  /** 真を返した文は例外を投げる(SQL の書き込みの失敗の模擬)。 */
  sqlFail: ((query: string, bindings: readonly unknown[]) => boolean) | null;
}
const opened: NodeSql[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sql of opened.splice(0)) sql.close();
});

interface HarnessOptions {
  readonly narRows?: readonly ListRow[];
  readonly centralRows?: readonly ListRow[];
  readonly start?: number;
  /** false なら結果ストアを渡さない(結果の仕組みが無効)。 */
  readonly resultStore?: boolean;
  /** false なら日報の依頼先を渡さない。 */
  readonly requestReport?: boolean;
  /** true なら日報の依頼先が常に例外を投げる(依頼の失敗の模擬)。呼び出しの開催日は `reports` に残る。 */
  readonly failReport?: boolean;
}
function harness(options: HarnessOptions = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const sqlLog: string[] = [];
  const alarms: number[] = [];
  const failBox: { fn: Harness["sqlFail"] } = { fn: null };
  const loggedSql: NodeSql = {
    get statements() {
      return sql.statements;
    },
    exec(query: string, ...bindings: unknown[]) {
      if (failBox.fn !== null && failBox.fn(query, bindings)) {
        throw new Error("SQL の失敗の模擬");
      }
      sqlLog.push(`${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`);
      return sql.exec(query, ...bindings);
    },
    close() {
      sql.close();
    },
  };
  const narRows = options.narRows ?? KAWASAKI_ROWS;
  const clock = { now: options.start ?? JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const reports: string[] = [];
  const reportTimes: number[] = [];
  const gate = fakeGate(listHtml(options.centralRows ?? []), listHtml(narRows), narRows);
  const store = fakeStore();
  const sink = recordingSink();
  const core = new RaceDayCore({
    sql: loggedSql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
      alarms.push(at);
    },
    onWarn: (message) => {
      warnings.push(message);
      sqlLog.push(`onWarn ${message}`); // SQL との前後(書き込みと警告の順序)も SHA-1 に含める
    },
    sink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.resultStore === false ? {} : { resultStore: store }),
    ...(options.requestReport === false
      ? {}
      : {
          requestReport: async (kaisaiDate: string) => {
            reports.push(kaisaiDate);
            reportTimes.push(clock.now);
            if (options.failReport === true) {
              throw new Error("依頼先の失敗(本文は警告に出さない)SECRET-REPORT");
            }
          },
        }),
  });
  const listSpy = vi.spyOn(core, "getRaceList");
  return {
    core,
    sql,
    gate,
    store,
    sink,
    clock,
    alarm,
    warnings,
    reports,
    reportTimes,
    alarms,
    sqlLog,
    listSpy,
    get sqlFail() {
      return failBox.fn;
    },
    set sqlFail(fn) {
      failBox.fn = fn;
    },
  };
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}
/** アラームの時刻が `until` 以前のあいだ、1 ステップずつ進める。 */
async function driveUntil(h: Harness, until: number, max = 400): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await tick(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}
/** 計画を依頼して、確定まで進める(自動の対象は中央だけ・地方は Jpn だけ。この一覧には無いので、手動の分析だけの日)。 */
async function planned(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true });
  await driveUntil(h, JST_0900);
  expect(h.core.getPlanProgress().stage).toBe("done"); // 前提: 確定した
}
/** 時刻を `at` にして分析用のページを返すようにし、手動の発走前の分析を予約して、`until` まで進める。 */
async function manualPreRace(h: Harness, at: number, until: number, raceId: string): Promise<string[]> {
  h.clock.now = at;
  h.gate.analysis = true;
  await h.core.schedule({ raceId, kaisaiDate: DATE, mode: "pre_race" });
  return driveUntil(h, until);
}

interface ResultRow {
  race_id: string;
  state: string;
  next_try_at: number;
}
const resultRows = (h: Harness): ResultRow[] => h.sql.exec("SELECT race_id, state, next_try_at FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const resultRowOf = (h: Harness, raceId: string): ResultRow | undefined => resultRows(h).find((r) => r.race_id === raceId);

// ---------------------------------------------------------------------------
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
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** 下限・依頼済み・判定済みの印に触れる文を短い記号にする(`R:<キー>` = 読み、`W:<キー>=<値>` = 書き。他の文は SHA-1 の全体で固定する)。 */
function shortSql(line: string): string {
  const read = /^SELECT value FROM race_day_meta WHERE key = \? \| \["(\w+)"\]$/.exec(line);
  if (read !== null) return `R:${read[1]}`;
  const write = /^INSERT INTO race_day_meta \(key, value\) VALUES \(\?, \?\) ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value \| \["(\w+)",(.*)\]$/.exec(line);
  if (write !== null) return `W:${write[1]}=${write[2]}`;
  return line;
}

/** 1 ステップの間に起きたこと。 */
interface StepTrace {
  readonly label: string;
  readonly at: number;
  readonly warnings: string[];
  readonly alarms: number[];
  /** 下限・依頼済み・判定済みの印を読み書きした文(順序どおり)。 */
  readonly reportSql: string[];
  readonly sqlCount: number;
  readonly sqlSha1: string;
  readonly listCalls: unknown[][];
  readonly gateListUrls: string[];
  readonly newReports: string[];
}

/** アラームの時刻(`forceAt` なら指定の時刻)まで時計を進めて 1 ステップ動かし、その間に起きたことを集める。 */
async function stepTrace(h: Harness, forceAt?: number): Promise<StepTrace> {
  const w = h.warnings.length;
  const a = h.alarms.length;
  const s = h.sqlLog.length;
  const l = h.listSpy.mock.calls.length;
  const u = h.gate.urls.length;
  const r = h.reports.length;
  const at = forceAt ?? h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  const outcome = await h.core.runNextStep();
  const sqlLines = h.sqlLog.slice(s);
  return {
    label: label(outcome),
    at: h.clock.now,
    warnings: h.warnings.slice(w),
    alarms: h.alarms.slice(a),
    reportSql: sqlLines.filter((line) => /"report_(hold|requested|hold_judged)"/.test(line)).map(shortSql),
    sqlCount: sqlLines.length,
    sqlSha1: sha1(sqlLines.join("\n")),
    listCalls: h.listSpy.mock.calls.slice(l).map((c) => [...c]),
    gateListUrls: h.gate.urls.slice(u).filter((x) => x.includes("race_list_sub")),
    newReports: h.reports.slice(r),
  };
}
/** アラームの時刻が `until` 以前のあいだ、1 ステップずつ進めて集める。 */
async function traceUntil(h: Harness, until: number, max = 60): Promise<StepTrace[]> {
  const out: StepTrace[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await stepTrace(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}
/** 最後の状態(印の値・依頼・アラーム)。 */
function finalState(h: Harness): unknown {
  return {
    hold: metaValue(h, REPORT_HOLD_KEY),
    requested: metaValue(h, "report_requested"),
    judged: metaValue(h, JUDGED_KEY),
    reports: h.reports,
    reportTimes: h.reportTimes,
    alarm: h.alarm.at,
    allAlarms: h.alarms,
    allWarnings: h.warnings,
  };
}
const JUDGED_KEY = "report_hold_judged";
const metaValue = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};
async function scheduleAt(h: Harness, at: number, raceId: string, mode: "pre_race" | "morning" = "pre_race"): Promise<void> {
  h.clock.now = at;
  h.gate.analysis = true;
  await h.core.schedule({ raceId, kaisaiDate: DATE, mode });
}
/** 10R だけを分析し、10R の結果の取り込み(19:55)まで進めた状態(アラームは下限の 20:50 だけ)。 */
async function onlyTenAnalyzed(h: Harness): Promise<void> {
  await planned(h);
  await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
  await driveUntil(h, jst("19:59"));
  expect(resultRowOf(h, kawasaki(10))!.state).toBe("imported"); // 前提
  expect(h.reports).toEqual([]); // 前提
  expect(h.alarm.at).toBe(KAWASAKI_LAST); // 前提: 下限のアラームだけ
}

type Scenario = (h: Harness) => Promise<unknown>;
interface ScenarioDef {
  readonly options?: HarnessOptions;
  readonly run: Scenario;
}

const SCENARIOS: Record<string, ScenarioDef> = {
  // 成功: 10R だけを分析 → 下限(12R の発走 20:50)を記録 → 結果の取り込み → 下限のアラームで起きて依頼
  "成功の一連(10R だけ)": {
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "下限の 1 ミリ秒前とちょうど": {
    run: async (h) => {
      await onlyTenAnalyzed(h);
      const before = await stepTrace(h, KAWASAKI_LAST - 1);
      const at = await stepTrace(h, KAWASAKI_LAST);
      const after = await traceUntil(h, jst("23:59"));
      return { before, at, after, final: finalState(h) };
    },
  },
  "一覧がゲートに拒否される": {
    run: async (h) => {
      await planned(h);
      h.gate.narListRefused = true;
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "getRaceList が例外を投げる": {
    run: async (h) => {
      await planned(h);
      h.listSpy.mockRejectedValue(new Error("想定外の例外 SECRET-THROWN"));
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "該当の開催が一覧に無い": {
    options: { narRows: [nar(ooi(12), "大井", 12, "18:30")] },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      h.gate.narStart.set(kawasaki(10), "19:40");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "時刻が読めない": {
    options: { narRows: [nar(kawasaki(10), "川崎", 10, null), nar(kawasaki(12), "川崎", 12, null)] },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      h.gate.narStart.set(kawasaki(10), "19:40");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "一部の行の時刻が読めない": {
    options: { narRows: [nar(kawasaki(10), "川崎", 10, "19:40"), nar(kawasaki(11), "川崎", 11, "20:15"), nar(kawasaki(12), "川崎", 12, null)] },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "失敗が上限に達したらもう引かない(同じ開催の 5 レース)": {
    run: async (h) => {
      await planned(h);
      h.gate.narListRefused = true;
      const traces: StepTrace[] = [];
      for (let n = 1; n <= MAX_ATTEMPTS + 2; n += 1) {
        await scheduleAt(h, jst("19:30") + n * MIN, kawasaki(n));
        traces.push(...(await traceUntil(h, h.clock.now)));
      }
      return { traces, final: finalState(h) };
    },
  },
  "上限は開催ごと。失敗のあとに取れたら記録に置き換わる": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")] },
    run: async (h) => {
      await planned(h);
      h.gate.narListRefused = true;
      const traces: StepTrace[] = [];
      for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
        await scheduleAt(h, jst("19:30") + n * MIN, kawasaki(n));
        traces.push(...(await traceUntil(h, h.clock.now)));
      }
      h.gate.narListRefused = false;
      await scheduleAt(h, jst("19:40"), ooi(12));
      traces.push(...(await traceUntil(h, h.clock.now)));
      return { traces, final: finalState(h) };
    },
  },
  "複数の開催(大井が先・川崎があと)は最大が下限": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(11), "大井", 11, "17:55"), nar(ooi(12), "大井", 12, "18:30")] },
    run: async (h) => {
      await planned(h);
      const traces: StepTrace[] = [];
      await scheduleAt(h, jst("17:00"), ooi(11));
      traces.push(...(await traceUntil(h, jst("17:20"))));
      await scheduleAt(h, jst("17:30"), kawasaki(10));
      traces.push(...(await traceUntil(h, jst("23:59"))));
      return { traces, final: finalState(h) };
    },
  },
  "あとから早い開催を分析しても下限を下げない": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")] },
    run: async (h) => {
      await planned(h);
      const traces: StepTrace[] = [];
      await scheduleAt(h, jst("17:00"), kawasaki(10));
      traces.push(...(await traceUntil(h, jst("17:20"))));
      await scheduleAt(h, jst("17:30"), ooi(12));
      traces.push(...(await traceUntil(h, jst("23:59"))));
      return { traces, final: finalState(h) };
    },
  },
  "中央(福島 11R の開催の最終 12R)": {
    options: { centralRows: CENTRAL_ROWS },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("15:00"), "202603020211");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "同じ開催の 3 レースは一覧を 1 回だけ。別の開催でもう 1 回": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")] },
    run: async (h) => {
      await planned(h);
      const traces: StepTrace[] = [];
      for (const [t, id] of [[jst("17:00"), kawasaki(10)], [jst("17:02"), kawasaki(11)], [jst("17:04"), kawasaki(12)], [jst("17:06"), ooi(12)]] as const) {
        await scheduleAt(h, t, id);
        traces.push(...(await traceUntil(h, h.clock.now + MIN)));
      }
      return { traces, final: finalState(h) };
    },
  },
  "前夜に翌日の開催を手動で分析する(一覧の開催日は分析した日ではなく開催日)": {
    options: { start: jst("21:00", "2026-10-12") },
    run: async (h) => {
      await scheduleAt(h, jst("21:00", "2026-10-12"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "結果ストアが無い構成": {
    options: { resultStore: false },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "日報の依頼先が無い構成": {
    options: { requestReport: false },
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "過去の開催日": {
    options: { start: jst("09:00", "2026-10-14") },
    run: async (h) => {
      await scheduleAt(h, jst("09:00", "2026-10-14"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59", "2026-10-14")), final: finalState(h) };
    },
  },
  "朝の分析は下限を記録しない": {
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("10:00"), "202603020211", "morning");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "出馬表の取得が失敗した試行では引かない": {
    run: async (h) => {
      await planned(h);
      h.clock.now = jst("19:30");
      h.gate.analysis = false;
      await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
      return { traces: [await stepTrace(h)], final: finalState(h) };
    },
  },
  "依頼済みの日は引かない(別の開催の分析でも)": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "21:30")] },
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await driveUntil(h, jst("20:55"));
      expect(h.reports).toEqual([DATE]); // 前提
      await scheduleAt(h, jst("21:00"), ooi(12));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "meta が壊れている": {
    run: async (h) => {
      await planned(h);
      h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", REPORT_HOLD_KEY, '{"2026451013":"abc","2026441013":{"failures":-1}}');
      const traces: StepTrace[] = [await stepTrace(h, h.clock.now)];
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      traces.push(...(await traceUntil(h, jst("23:59"))));
      return { traces, final: finalState(h) };
    },
  },
  "下限の meta の書き込みが例外": {
    run: async (h) => {
      await planned(h);
      h.sqlFail = (query, bindings) => /INSERT INTO race_day_meta/.test(query) && bindings[0] === REPORT_HOLD_KEY;
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "下限の読みが 1 回だけ例外(取得ステップの中)": {
    run: async (h) => {
      await planned(h);
      await scheduleAt(h, jst("19:30"), kawasaki(10));
      let armed = true;
      h.sqlFail = (query, bindings) => {
        if (armed && /^SELECT value FROM race_day_meta/.test(query.trim()) && bindings[0] === REPORT_HOLD_KEY) {
          armed = false;
          return true;
        }
        return false;
      };
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "#298: 下限に朝のタスクが重なる": {
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await scheduleAt(h, KAWASAKI_LAST, "202603020211", "morning");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "#298: 下限が後から伸びる(依頼は失敗する構成)": {
    options: { narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "21:30")], failReport: true },
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await scheduleAt(h, KAWASAKI_LAST, "202603020211", "morning");
      const traces = await traceUntil(h, KAWASAKI_LAST + 2 * MIN);
      await scheduleAt(h, jst("21:00"), ooi(12));
      traces.push(...(await traceUntil(h, jst("23:59"))));
      return { traces, final: finalState(h) };
    },
  },
  "#298: 静かでない(12R の結果が待ち)": {
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await manualPreRace(h, jst("20:45"), jst("20:49"), kawasaki(12));
      await scheduleAt(h, KAWASAKI_LAST, "202603020211", "morning");
      return { traces: await traceUntil(h, jst("23:59")), final: finalState(h) };
    },
  },
  "#298: 依頼が失敗し続ける": {
    options: { failReport: true },
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await scheduleAt(h, KAWASAKI_LAST, "202603020211", "morning");
      const traces = await traceUntil(h, KAWASAKI_LAST + 2 * MIN);
      traces.push(await stepTrace(h, jst("21:00")));
      return { traces, final: finalState(h) };
    },
  },
  "#298: 再試行待ちのタスクだけが残る": {
    run: async (h) => {
      await onlyTenAnalyzed(h);
      await scheduleAt(h, KAWASAKI_LAST, "202603020211", "morning");
      h.gate.fetchRaw = async () => {
        throw new Error("通信の失敗(非致命)");
      };
      return { traces: [await stepTrace(h)], final: finalState(h) };
    },
  },
  "中央の自動の日(下限は記録されるが依頼は結果がそろった時点)": {
    options: {
      narRows: [],
      centralRows: [
        { raceId: "202606040901", venue: "中山", raceNumber: 1, name: "中央1R", time: "10:00" },
        { raceId: "202606040902", venue: "中山", raceNumber: 2, name: "中央2R", time: "10:35" },
      ],
    },
    run: async (h) => {
      h.gate.analysis = true;
      await planned(h);
      return { traces: await traceUntil(h, jst("11:30"), 120), final: finalState(h) };
    },
  },
};

describe("Issue #399(R-9b): 日報の時刻の下限の段階を切り出す前の挙動(特性テスト)", () => {
  it("前提: 場面を数え直す(期待値の取りこぼしが無い)", () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThan(20);
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

/** 切り出す前のコード(31b5c4e)の実出力。`CHAR_DUMP` で作り直せる。 */
const EXPECTED: Record<string, unknown> = {
 "成功の一連(10R だけ)": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "034af783dfb075ef9773b1d1d0883363e76583bd",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "be3ab9eb75548821cdbfc80970cf9cc161ed1212",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791892200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "下限の 1 ミリ秒前とちょうど": {
  "before": {
   "label": "idle",
   "at": 1791892199999,
   "warnings": [],
   "alarms": [
    1791892200000
   ],
   "reportSql": [
    "R:report_requested",
    "R:report_hold",
    "R:report_hold",
    "R:report_requested",
    "R:report_hold",
    "R:report_requested",
    "R:report_hold"
   ],
   "sqlCount": 42,
   "sqlSha1": "b429b614aa4b7013dfcdf71b06e2b510a3429c58",
   "listCalls": [],
   "gateListUrls": [],
   "newReports": []
  },
  "at": {
   "label": "idle",
   "at": 1791892200000,
   "warnings": [],
   "alarms": [
    1791982560000
   ],
   "reportSql": [
    "R:report_requested",
    "R:report_hold",
    "W:report_hold_judged=\"1791892200000\"",
    "R:report_hold",
    "W:report_requested=\"1791892200000\"",
    "R:report_requested",
    "R:report_requested"
   ],
   "sqlCount": 42,
   "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
   "listCalls": [],
   "gateListUrls": [],
   "newReports": [
    "20261013"
   ]
  },
  "after": [],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "一覧がゲートに拒否される": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 91,
    "sqlSha1": "b8b23213b70d976950f5e356b95db6372bc19017",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":{\"failures\":1}}",
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "getRaceList が例外を投げる": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 89,
    "sqlSha1": "96ec5063f5a95bf0e16c85f7041e8ca9a4a0bb4a",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":{\"failures\":1}}",
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "該当の開催が一覧に無い": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 94,
    "sqlSha1": "d47e82b80b1e417bd4971d19eac618cd48896db4",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":{\"failures\":1}}",
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "時刻が読めない": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 94,
    "sqlSha1": "8be87b08f6cd3b6749e9bb3f872e18d683ca2a4c",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":{\"failures\":1}}",
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "一部の行の時刻が読めない": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791890100000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "744eed332cdc3afed80274ea56363394f38bc0e5",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791890100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "be3ab9eb75548821cdbfc80970cf9cc161ed1212",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791890100000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791890100000\"",
     "R:report_hold",
     "W:report_requested=\"1791890100000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "b88e9483167d5596935f5eb46e8b40c876e24c2a",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791890100000}",
   "requested": "1791890100000",
   "judged": "1791890100000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791890100000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791890100000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "失敗が上限に達したらもう引かない(同じ開催の 5 レース)": {
  "traces": [
   {
    "label": "202645101301:pre_race:fetch:ok",
    "at": 1791887460000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101301)。待たずに続けます"
    ],
    "alarms": [
     1791887460000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 91,
    "sqlSha1": "f45199c35bfa9f4f80e88e78576fb154c34ed0f7",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101301:pre_race:compute:ok",
    "at": 1791887460000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "88fffc367d2ca06dc3581e8d69f48186626dfa8d",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101302:pre_race:fetch:ok",
    "at": 1791887520000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101302)。待たずに続けます"
    ],
    "alarms": [
     1791887520000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":2}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 67,
    "sqlSha1": "673147dfe8e8ef627a29738885b685058848bfed",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101302:pre_race:compute:ok",
    "at": 1791887520000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "b0656db794bf74ec4322d4bd9ec273f1aa12695e",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101303:pre_race:fetch:ok",
    "at": 1791887580000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101303)。待たずに続けます"
    ],
    "alarms": [
     1791887580000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":3}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 67,
    "sqlSha1": "84b13a208de52c61537eedd55b588b2b3dd0bb51",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101303:pre_race:compute:ok",
    "at": 1791887580000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "6d41a7c8112d3c7b6f4d3dbde7bf11150e244b61",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101304:pre_race:fetch:ok",
    "at": 1791887640000,
    "warnings": [],
    "alarms": [
     1791887640000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 62,
    "sqlSha1": "ec645a78ff5766b885e2a2b44e404cd99423ba1b",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101304:pre_race:compute:ok",
    "at": 1791887640000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "77f7bff62ec03cc2427ea57b61e11f9f78c6f0f1",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101305:pre_race:fetch:ok",
    "at": 1791887700000,
    "warnings": [],
    "alarms": [
     1791887700000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 62,
    "sqlSha1": "be24cba8fef8bf1593b44011dd860030e196c058",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101305:pre_race:compute:ok",
    "at": 1791887700000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "e0a5a39f1f3f15aa33121ff8c02ae11949379be4",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026451013\":{\"failures\":3}}",
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791893100000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887460000,
    1791887460000,
    1791893100000,
    1791887520000,
    1791887520000,
    1791893100000,
    1791887580000,
    1791887580000,
    1791893100000,
    1791887640000,
    1791887640000,
    1791893100000,
    1791887700000,
    1791887700000,
    1791893100000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101301)。待たずに続けます",
    "日報の時刻の下限を求められませんでした(202645101302)。待たずに続けます",
    "日報の時刻の下限を求められませんでした(202645101303)。待たずに続けます"
   ]
  }
 },
 "上限は開催ごと。失敗のあとに取れたら記録に置き換わる": {
  "traces": [
   {
    "label": "202645101301:pre_race:fetch:ok",
    "at": 1791887460000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101301)。待たずに続けます"
    ],
    "alarms": [
     1791887460000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":1}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 91,
    "sqlSha1": "f45199c35bfa9f4f80e88e78576fb154c34ed0f7",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101301:pre_race:compute:ok",
    "at": 1791887460000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "88fffc367d2ca06dc3581e8d69f48186626dfa8d",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101302:pre_race:fetch:ok",
    "at": 1791887520000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101302)。待たずに続けます"
    ],
    "alarms": [
     1791887520000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":2}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 67,
    "sqlSha1": "673147dfe8e8ef627a29738885b685058848bfed",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101302:pre_race:compute:ok",
    "at": 1791887520000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "b0656db794bf74ec4322d4bd9ec273f1aa12695e",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101303:pre_race:fetch:ok",
    "at": 1791887580000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101303)。待たずに続けます"
    ],
    "alarms": [
     1791887580000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":{\\\"failures\\\":3}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 67,
    "sqlSha1": "84b13a208de52c61537eedd55b588b2b3dd0bb51",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101303:pre_race:compute:ok",
    "at": 1791887580000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "6d41a7c8112d3c7b6f4d3dbde7bf11150e244b61",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:fetch:ok",
    "at": 1791888000000,
    "warnings": [],
    "alarms": [
     1791888000000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791883800000,\\\"2026451013\\\":{\\\"failures\\\":3}}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 69,
    "sqlSha1": "18311a55d51d181b6892940fd7326c1f4e121239",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:compute:ok",
    "at": 1791888000000,
    "warnings": [],
    "alarms": [
     1791888000000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 67,
    "sqlSha1": "69842e7c4707fe83c9c70c5c4b17b07a195b99a7",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:result:import:ok",
    "at": 1791888000000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791883800000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 49,
    "sqlSha1": "e1d21920f780cbd763f61db2fe55009d260c2d76",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026441013\":1791883800000,\"2026451013\":{\"failures\":3}}",
   "requested": null,
   "judged": "1791883800000",
   "reports": [],
   "reportTimes": [],
   "alarm": 1791893100000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887460000,
    1791887460000,
    1791893100000,
    1791887520000,
    1791887520000,
    1791893100000,
    1791887580000,
    1791887580000,
    1791893100000,
    1791888000000,
    1791888000000,
    1791888000000,
    1791893100000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101301)。待たずに続けます",
    "日報の時刻の下限を求められませんでした(202645101302)。待たずに続けます",
    "日報の時刻の下限を求められませんでした(202645101303)。待たずに続けます"
   ]
  }
 },
 "複数の開催(大井が先・川崎があと)は最大が下限": {
  "traces": [
   {
    "label": "202644101311:pre_race:fetch:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791878400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791883800000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "15c3ee03fbd1daddd26c9396bb15ac713f5c94c5",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202644101311:pre_race:compute:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791882600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "26653303064654ec8607a2977bcf7210552bae5e",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791880200000,
    "warnings": [],
    "alarms": [
     1791880200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791883800000,\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 68,
    "sqlSha1": "b1d558fe119fb30c766658b6804174681d09953d",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791880200000,
    "warnings": [],
    "alarms": [
     1791882600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "4c325ca562daf9a5c3af04efb02d6520cf0573cb",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101311:result:import:ok",
    "at": 1791882600000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "5bf7eb3f12f13f2bff6833d0b0c16d93cd566255",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "be3ab9eb75548821cdbfc80970cf9cc161ed1212",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791892200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026441013\":1791883800000,\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791878400000,
    1791878400000,
    1791882600000,
    1791880200000,
    1791880200000,
    1791882600000,
    1791888900000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "あとから早い開催を分析しても下限を下げない": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791878400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "b0a0b9c4c511e2247544fec68398ffd98f80d165",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "8b906d1eaaa0b0eb5e84dcd8dfce0b0418cc21aa",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:fetch:ok",
    "at": 1791880200000,
    "warnings": [],
    "alarms": [
     1791880200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791883800000,\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 68,
    "sqlSha1": "e9ce608aa64584eafccf7da1649ec081ad39a2b2",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:compute:ok",
    "at": 1791880200000,
    "warnings": [],
    "alarms": [
     1791884700000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "2ffb5c151256c86b602f7b34c3753a10de4a282a",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:result:import:ok",
    "at": 1791884700000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "c5e9ceee1827b083f2d6f4f88a446b010e0ee73c",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "be3ab9eb75548821cdbfc80970cf9cc161ed1212",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791892200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026441013\":1791883800000,\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791878400000,
    1791878400000,
    1791888900000,
    1791880200000,
    1791880200000,
    1791884700000,
    1791888900000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "中央(福島 11R の開催の最終 12R)": {
  "traces": [
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1791871200000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791871200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026030202\\\":1791876300000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 124,
    "sqlSha1": "a73f199ab859ba2f10f64b01c62240c7269ed413",
    "listCalls": [
     [
      "20261013",
      "central"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1791871200000,
    "warnings": [
     "発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
    ],
    "alarms": [
     1791873600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 102,
    "sqlSha1": "e6e08d7941434f08658b12da5bbcfe892415546b",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020212:pre_race:fetch:ok",
    "at": 1791873600000,
    "warnings": [
     "発走前の取得(202603020212): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791873600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 87,
    "sqlSha1": "0394ffc7d90a8f9bbb8a8869d87e337a7cfc52a5",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020212:pre_race:compute:ok",
    "at": 1791873600000,
    "warnings": [
     "発走前の分析(202603020212): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202603020212): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
    ],
    "alarms": [
     1791874800000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 103,
    "sqlSha1": "27abd3b1e332c3844efe7d2dc99e0362ac3df7a2",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:result:import:ok",
    "at": 1791874800000,
    "warnings": [],
    "alarms": [
     1791876300000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "c0375ffb665f3921ad5041b7ada77b848734fa62",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791876300000,
    "warnings": [],
    "alarms": [
     1791877200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791876300000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 44,
    "sqlSha1": "86788a8345a7093b2a7d1760aec3a8e7ad8b9fe7",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020212:result:import:ok",
    "at": 1791877200000,
    "warnings": [],
    "alarms": [
     1791970860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791876300000\"",
     "R:report_hold",
     "W:report_requested=\"1791877200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 47,
    "sqlSha1": "28599f9e75edf7c30a720bc6bb271aeab5556c42",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026030202\":1791876300000}",
   "requested": "1791877200000",
   "judged": "1791876300000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791877200000
   ],
   "alarm": 1791970860000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791871200000,
    1791871200000,
    1791871200000,
    1791873600000,
    1791873600000,
    1791874800000,
    1791876300000,
    1791877200000,
    1791970860000
   ],
   "allWarnings": [
    "朝の取得に失敗しました(202603020211。試行 1 回): ゲートが取得を拒否しました(blocked): 拒否(本文は状態・警告に入れない)SECRET-MESSAGE",
    "朝の取得に失敗しました(202603020212。試行 1 回): ゲートが取得を拒否しました(blocked): 拒否(本文は状態・警告に入れない)SECRET-MESSAGE",
    "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の取得(202603020212): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202603020212): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202603020212): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "同じ開催の 3 レースは一覧を 1 回だけ。別の開催でもう 1 回": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791878400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "b0a0b9c4c511e2247544fec68398ffd98f80d165",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791878400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "8b906d1eaaa0b0eb5e84dcd8dfce0b0418cc21aa",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101311:pre_race:fetch:ok",
    "at": 1791878520000,
    "warnings": [],
    "alarms": [
     1791878520000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 62,
    "sqlSha1": "942c3164c16596c7cd6e6f78f35f6858836458df",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101311:pre_race:compute:ok",
    "at": 1791878520000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "c36a0ed68dfc9488670d76b00566b8a08962ef5f",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101312:pre_race:fetch:ok",
    "at": 1791878640000,
    "warnings": [],
    "alarms": [
     1791878640000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 62,
    "sqlSha1": "3848456f2eb1a909552f5419dffc3e32d900b7cb",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101312:pre_race:compute:ok",
    "at": 1791878640000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "860170e772e638ec8e811453c994c88a141fe854",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:fetch:ok",
    "at": 1791878760000,
    "warnings": [],
    "alarms": [
     1791878760000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791883800000,\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 68,
    "sqlSha1": "4c53d6e19a7e6f9a37e5cddc2ef43cd5244d16ae",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:compute:ok",
    "at": 1791878760000,
    "warnings": [],
    "alarms": [
     1791884700000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "7fa3e28c5ba4e163d422f7831f4ae89284652a29",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026441013\":1791883800000,\"2026451013\":1791892200000}",
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791884700000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791878400000,
    1791878400000,
    1791888900000,
    1791878520000,
    1791878520000,
    1791888900000,
    1791878640000,
    1791878640000,
    1791888900000,
    1791878760000,
    1791878760000,
    1791884700000
   ],
   "allWarnings": []
  }
 },
 "前夜に翌日の開催を手動で分析する(一覧の開催日は分析した日ではなく開催日)": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791806400000,
    "warnings": [],
    "alarms": [
     1791806400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 89,
    "sqlSha1": "517b2c51612644b465e80c032a7a3fcaa44f8c43",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791806400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 60,
    "sqlSha1": "f87ade7bc66fbe08f83cd5696851586cfb4b6a48",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 39,
    "sqlSha1": "00ceb5c95db36098c2a6b4b1e6cbad52aefa69f7",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 36,
    "sqlSha1": "020c0d5b31bc9bc6a77a4aa3c00666ef858f0c1d",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": null,
   "judged": "1791892200000",
   "reports": [],
   "reportTimes": [],
   "alarm": 1791982560000,
   "allAlarms": [
    1791806400000,
    1791806400000,
    1791888900000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "結果ストアが無い構成": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 80,
    "sqlSha1": "3fb6adceceaf8618243e1ed621fda2b5685ecbab",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791981060000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 61,
    "sqlSha1": "00fe2c9d48896cfca8d3d11bb444ea9f2b06495e",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": null,
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791981060000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791981060000
   ],
   "allWarnings": []
  }
 },
 "日報の依頼先が無い構成": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791887400000
    ],
    "reportSql": [],
    "sqlCount": 82,
    "sqlSha1": "1134758e9c9aa4427df732c9a915415459606db1",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [],
    "sqlCount": 62,
    "sqlSha1": "b11c832c135d196a4031f3424d38fe98f7fac345",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [],
    "sqlCount": 35,
    "sqlSha1": "900e28fd41224b266dd4076678f1e869b9686e8e",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": null,
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "過去の開催日": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791936000000,
    "warnings": [],
    "alarms": [
     1791936000000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 77,
    "sqlSha1": "85d0792360b5005a2d48495a87302d9f244d3c9a",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791936000000,
    "warnings": [],
    "alarms": [
     1792029660000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 60,
    "sqlSha1": "53d9ed09b96bd1bec6e0f939d4c41ae7aef83afb",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": null,
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1792029660000,
   "allAlarms": [
    1791936000000,
    1791936000000,
    1792029660000
   ],
   "allWarnings": []
  }
 },
 "朝の分析は下限を記録しない": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:ok",
    "at": 1791853200000,
    "warnings": [
     "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791853200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 107,
    "sqlSha1": "de9e98ce7cb0d53e68e57367dd8a4f6212f1ee23",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:morning:compute:ok",
    "at": 1791853200000,
    "warnings": [],
    "alarms": [
     1791946860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 83,
    "sqlSha1": "897d87502144dca50fecaabcb67ccad92017d7f7",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": null,
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791946860000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791853200000,
    1791853200000,
    1791946860000
   ],
   "allWarnings": [
    "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
   ]
  }
 },
 "出馬表の取得が失敗した試行では引かない": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:failed",
    "at": 1791887400000,
    "warnings": [
     "発走前の取得に失敗しました(202645101310。試行 1 回): ゲートが取得を拒否しました(blocked): 拒否(本文は状態・警告に入れない)SECRET-MESSAGE"
    ],
    "alarms": [
     1791981060000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 38,
    "sqlSha1": "1cc16e19acacfb0fd1166ff85cf6a3e69571c96a",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": null,
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791981060000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791981060000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202645101310。試行 1 回): ゲートが取得を拒否しました(blocked): 拒否(本文は状態・警告に入れない)SECRET-MESSAGE"
   ]
  }
 },
 "依頼済みの日は引かない(別の開催の分析でも)": {
  "traces": [
   {
    "label": "202644101312:pre_race:fetch:ok",
    "at": 1791892800000,
    "warnings": [],
    "alarms": [
     1791892800000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 60,
    "sqlSha1": "8e4c623da386a4c01122542e322a5765406cb6f1",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:compute:ok",
    "at": 1791892800000,
    "warnings": [],
    "alarms": [
     1791895500000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 64,
    "sqlSha1": "09f70018e2f8ad4d44258cace634f37d7bb1c9d9",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:result:import:ok",
    "at": 1791895500000,
    "warnings": [],
    "alarms": [
     1791989160000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 38,
    "sqlSha1": "d131e84d93568273b64593bdade79fdcb33edebf",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791989160000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791982560000,
    1791892800000,
    1791892800000,
    1791895500000,
    1791989160000
   ],
   "allWarnings": []
  }
 },
 "meta が壊れている": {
  "traces": [
   {
    "label": "idle",
    "at": 1791849600000,
    "warnings": [],
    "alarms": [
     1791943260000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 42,
    "sqlSha1": "2bf2651e41adf4999100524b23a1f09d1485ff3a",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "034af783dfb075ef9773b1d1d0883363e76583bd",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "be3ab9eb75548821cdbfc80970cf9cc161ed1212",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791892200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791982560000
   ],
   "allWarnings": []
  }
 },
 "下限の meta の書き込みが例外": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 93,
    "sqlSha1": "be98d909fe99b43432a598f3acf00547ba3ac86b",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [
     "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20261013"
    ],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": null,
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "下限の読みが 1 回だけ例外(取得ステップの中)": {
  "traces": [
   {
    "label": "202645101310:pre_race:fetch:ok",
    "at": 1791887400000,
    "warnings": [
     "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
    ],
    "alarms": [
     1791887400000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 86,
    "sqlSha1": "5c75cbc1cef07ee5ed429b1d0143ad46f591aca5",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:pre_race:compute:ok",
    "at": 1791887400000,
    "warnings": [],
    "alarms": [
     1791888900000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "f067560faad338b88920a3fe61c9b0d42a61f369",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101310:result:import:ok",
    "at": 1791888900000,
    "warnings": [],
    "alarms": [
     1791982560000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_requested=\"1791888900000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 46,
    "sqlSha1": "6a31bb4fa57007c4bc8d07c7a6418fda36140274",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": null,
   "requested": "1791888900000",
   "judged": null,
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791888900000
   ],
   "alarm": 1791982560000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791982560000
   ],
   "allWarnings": [
    "日報の時刻の下限を求められませんでした(202645101310)。待たずに続けます"
   ]
  }
 },
 "#298: 下限に朝のタスクが重なる": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:ok",
    "at": 1791892200000,
    "warnings": [
     "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 107,
    "sqlSha1": "406c0950dcfdf2c97939a83647985dbac59a6b37",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:morning:compute:ok",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 84,
    "sqlSha1": "3afb6cf4077a21dc664fd2e5c9fc0e0c633586ca",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791985860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791892200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 42,
    "sqlSha1": "148ba856b3d608e61e48c15b4ad146c3e1812aa8",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791892200000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791892200000
   ],
   "alarm": 1791985860000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791985860000
   ],
   "allWarnings": [
    "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
   ]
  }
 },
 "#298: 下限が後から伸びる(依頼は失敗する構成)": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:ok",
    "at": 1791892200000,
    "warnings": [
     "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 107,
    "sqlSha1": "406c0950dcfdf2c97939a83647985dbac59a6b37",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:morning:compute:ok",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 84,
    "sqlSha1": "3afb6cf4077a21dc664fd2e5c9fc0e0c633586ca",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [
     "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
    ],
    "alarms": [
     1791985860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 45,
    "sqlSha1": "db08f172087b73c8b537fdc2d9621e5b6e81beb3",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   },
   {
    "label": "202644101312:pre_race:fetch:ok",
    "at": 1791892800000,
    "warnings": [],
    "alarms": [
     1791892800000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026441013\\\":1791894600000,\\\"2026451013\\\":1791892200000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 68,
    "sqlSha1": "6febc677a877c2e9e98266b4713c253566775999",
    "listCalls": [
     [
      "20261013",
      "nar"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:pre_race:compute:ok",
    "at": 1791892800000,
    "warnings": [],
    "alarms": [
     1791894600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 66,
    "sqlSha1": "0e1ceee2521d5604dba468467115285ebae084c4",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791894600000,
    "warnings": [],
    "alarms": [
     1791895500000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791894600000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 44,
    "sqlSha1": "d30c594d0dddbe7cea7251748d3e5b4127a5c9e5",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202644101312:result:import:ok",
    "at": 1791895500000,
    "warnings": [
     "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
    ],
    "alarms": [
     1791989160000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791894600000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 50,
    "sqlSha1": "8c832f0f0c7dc82bacf929f219857eb4a17e4a26",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026441013\":1791894600000,\"2026451013\":1791892200000}",
   "requested": null,
   "judged": "1791894600000",
   "reports": [
    "20261013",
    "20261013"
   ],
   "reportTimes": [
    1791892200000,
    1791895500000
   ],
   "alarm": 1791989160000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791985860000,
    1791892800000,
    1791892800000,
    1791894600000,
    1791895500000,
    1791989160000
   ],
   "allWarnings": [
    "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)",
    "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
   ]
  }
 },
 "#298: 静かでない(12R の結果が待ち)": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:ok",
    "at": 1791892200000,
    "warnings": [
     "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 107,
    "sqlSha1": "406c0950dcfdf2c97939a83647985dbac59a6b37",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:morning:compute:ok",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 84,
    "sqlSha1": "3afb6cf4077a21dc664fd2e5c9fc0e0c633586ca",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791893100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 44,
    "sqlSha1": "7787befa4c00096e51287daa1d775eb1197d81a3",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202645101312:result:import:ok",
    "at": 1791893100000,
    "warnings": [],
    "alarms": [
     1791986760000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "W:report_requested=\"1791893100000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 47,
    "sqlSha1": "7014cc4d6cf1a22faebfc6e4a1fad784c2d821a9",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": "1791893100000",
   "judged": "1791892200000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791893100000
   ],
   "alarm": 1791986760000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791891900000,
    1791891900000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791893100000,
    1791986760000
   ],
   "allWarnings": [
    "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
   ]
  }
 },
 "#298: 依頼が失敗し続ける": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:ok",
    "at": 1791892200000,
    "warnings": [
     "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 107,
    "sqlSha1": "406c0950dcfdf2c97939a83647985dbac59a6b37",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202603020211:morning:compute:ok",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791892200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 84,
    "sqlSha1": "3afb6cf4077a21dc664fd2e5c9fc0e0c633586ca",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791892200000,
    "warnings": [
     "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
    ],
    "alarms": [
     1791985860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 45,
    "sqlSha1": "db08f172087b73c8b537fdc2d9621e5b6e81beb3",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   },
   {
    "label": "idle",
    "at": 1791892800000,
    "warnings": [
     "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
    ],
    "alarms": [
     1791985860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791892200000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 45,
    "sqlSha1": "b6dc63946afc2cec54c26c83bb528dfbbadb1ff4",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": null,
   "judged": "1791892200000",
   "reports": [
    "20261013",
    "20261013"
   ],
   "reportTimes": [
    1791892200000,
    1791892800000
   ],
   "alarm": 1791985860000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791892200000,
    1791985860000,
    1791985860000
   ],
   "allWarnings": [
    "朝の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)",
    "日報の作成の依頼に失敗しました(20261013。次の起床で再び依頼します)"
   ]
  }
 },
 "#298: 再試行待ちのタスクだけが残る": {
  "traces": [
   {
    "label": "202603020211:morning:fetch:retry",
    "at": 1791892200000,
    "warnings": [],
    "alarms": [
     1791892260000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 27,
    "sqlSha1": "e5548199688ac6e125a0d75206ec9e7fea50a9fc",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   }
  ],
  "final": {
   "hold": "{\"2026451013\":1791892200000}",
   "requested": null,
   "judged": null,
   "reports": [],
   "reportTimes": [],
   "alarm": 1791892260000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791943260000,
    1791887400000,
    1791887400000,
    1791888900000,
    1791892200000,
    1791892200000,
    1791892260000
   ],
   "allWarnings": []
  }
 },
 "中央の自動の日(下限は記録されるが依頼は結果がそろった時点)": {
  "traces": [
   {
    "label": "202606040901:pre_race:fetch:ok",
    "at": 1791850500000,
    "warnings": [
     "発走前の取得(202606040901): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791850500000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "W:report_hold=\"{\\\"2026060409\\\":1791855300000}\"",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 92,
    "sqlSha1": "98e51dac0817079fcc894e253990361d394e3e04",
    "listCalls": [
     [
      "20261013",
      "central"
     ]
    ],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202606040901:pre_race:compute:ok",
    "at": 1791850500000,
    "warnings": [
     "発走前の分析(202606040901): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040901): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
    ],
    "alarms": [
     1791852600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 103,
    "sqlSha1": "c8b359207da29bb2bc631b04c68a9f363831586d",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202606040902:pre_race:fetch:ok",
    "at": 1791852600000,
    "warnings": [
     "発走前の取得(202606040902): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1791852600000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 86,
    "sqlSha1": "f2aa247df06124d4a953e23073ae4b15338c939f",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202606040902:pre_race:compute:ok",
    "at": 1791852600000,
    "warnings": [
     "発走前の分析(202606040902): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "発走前の分析(202606040902): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
    ],
    "alarms": [
     1791854100000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 103,
    "sqlSha1": "333d1033ad1f01f6d7af262d23f53cf6349dad7c",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202606040901:result:import:ok",
    "at": 1791854100000,
    "warnings": [],
    "alarms": [
     1791855300000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold"
    ],
    "sqlCount": 47,
    "sqlSha1": "7a40fadc7503f31aa6093b114480553b93a97534",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "idle",
    "at": 1791855300000,
    "warnings": [],
    "alarms": [
     1791856200000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791855300000\"",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_requested",
     "R:report_hold",
     "R:report_hold_judged"
    ],
    "sqlCount": 44,
    "sqlSha1": "28bb07c4e2204eadeadbebeca99a0054b7ba5710",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": []
   },
   {
    "label": "202606040902:result:import:ok",
    "at": 1791856200000,
    "warnings": [],
    "alarms": [
     1791949860000
    ],
    "reportSql": [
     "R:report_requested",
     "R:report_hold",
     "W:report_hold_judged=\"1791855300000\"",
     "R:report_hold",
     "W:report_requested=\"1791856200000\"",
     "R:report_requested",
     "R:report_requested"
    ],
    "sqlCount": 47,
    "sqlSha1": "fd3dcb21ecade4e0867964074b8f560b40e16501",
    "listCalls": [],
    "gateListUrls": [],
    "newReports": [
     "20261013"
    ]
   }
  ],
  "final": {
   "hold": "{\"2026060409\":1791855300000}",
   "requested": "1791856200000",
   "judged": "1791855300000",
   "reports": [
    "20261013"
   ],
   "reportTimes": [
    1791856200000
   ],
   "alarm": 1791949860000,
   "allAlarms": [
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791849600000,
    1791850500000,
    1791850500000,
    1791852600000,
    1791852600000,
    1791854100000,
    1791855300000,
    1791856200000,
    1791949860000
   ],
   "allWarnings": [
    "朝の取得(202606040901): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "朝の取得(202606040902): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の取得(202606040901): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202606040901): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040901): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の取得(202606040902): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202606040902): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
    "発走前の分析(202606040902): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 }
};
