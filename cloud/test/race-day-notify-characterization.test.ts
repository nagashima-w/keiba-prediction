import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { CLIP_VARIANTS } from "../../packages/core/src/analyzer/clip-variants";
import { DiscordNotifyError, type DiscordPayload } from "../../packages/core/src/notify/discord";
import type { RecentAnalysis } from "../src/analysis-save-extra";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { DiscordNotifier } from "../src/notify-send";
import { FAILURE_COOLDOWN_MS, SEND_SPACING_MS } from "../src/notify-plan";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import type { SqlLike } from "../src/sql-like";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #399(R-9c): 通知の段階(`notifyPlan`・`runNotifyStep`・`withAnalysisLink`・`putAnalysisMaterial`)を `RaceDayCore` から切り出す前に、**今の挙動を固定する特性テスト**。
 * 切り出しの前後で、このファイルを書き換えずに緑のままであることが、挙動を変えていないことの根拠になる。
 *
 * 既存の `race-day-notify.test.ts` が固定している面(送信の回数・行の状態・embed の主な部分・リンクの有無)に加えて、**値だけでは見えない面**を固定する:
 *  - **送った中身そのもの**(`notifier.send` に渡った payload の全文。embed の JSON・リンクを含む)
 *  - **SQL の文と順序**(通知の表と `notify_pace_until` に触れた文を読める形で、全体は SHA-1 で固定する。**`notifier.send` の呼び出しも同じ列に挟む**ので、
 *    「`sending` を書く → 送る → `sent`・`failed` を書く → 間隔を置く」の順序が見える)
 *  - **ログの文言**(`onWarn` に渡る文面。全文一致)
 *  - **アラームの張り方**(`setAlarm` の呼び出しの系列。通知の候補〈`notifyAtMs`〉が入る場面と入らない場面)と、各ステップ後の通知の計画(`peekNotifyPlan`)
 *  - 例外の扱い(材料の読み出し・結果の探索・開催日の読み出しが落ちたときの `build` の失敗。送信の失敗の分類)
 *
 * **固定していない面**(計画の判定が候補にしない状態でだけ通る、production から到達しない分岐): 分析の通知の材料の行が無い・材料が空、まとめの開催日が未確定、失敗・スキップの通知の結果が見つからない、
 * `begin` が false を返す、分析の通知の `analysisId` が null。これらは例外を使った場面(読み出しが落ちる)で「送る内容を作れなかった」経路だけを固定している。
 * なお `withAnalysisLink` の `item.kind !== "analysis"` の判定は `analysisId === null` の判定と重なる(分析以外の通知は `analysisId` を持たない)ので、外しても結果は変わらない。
 *
 * 期待値は、切り出す前のコード(35f2780)の実出力から作った。ハーネスは `race-day-notify.test.ts` と同じ(ゲートは偽・保存先は偽・送信は偽・ストレージは `node:sqlite`)。
 * 期待値の作り直し: `CHAR_DUMP=<ファイル> npx vitest run test/race-day-notify-characterization.test.ts`(比べずに、実出力を書き出す。通常の実行では使わない)。
 */
const DATE = "20260628";
const RACE = "202603020211";
const jst = (time: string): number => Date.parse(`2026-06-28T${time}:00+09:00`);
const MIN = 60_000;
const EMPTY_HTML = "<html><body></body></html>";
/** 文書用のダミー(実在しない ID とトークン)。状態・ログ・応答のどこにも出てはいけない値。 */
const SECRET_URL = "https://discord.com/api/webhooks/123456789012345678/dummy-token-for-tests_ABC";
/** 文書用のダミー(example.test は実在しないホスト)。 */
const BASE = "https://keiba.example.test";

// ---- 一覧の HTML ----

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

const central = (n: number, time: string | null, extra: Partial<ListRow> = {}): ListRow => ({
  raceId: `2026060409${String(n).padStart(2, "0")}`,
  venue: "中山",
  raceNumber: n,
  name: `中央${n}R`,
  time,
  kind: "central",
  ...extra,
});
const nar = (n: number, time: string | null, grade: string | undefined, extra: Partial<ListRow> = {}): ListRow => ({
  raceId: `2026360628${String(n).padStart(2, "0")}`,
  venue: "水沢",
  raceNumber: n,
  name: `地方${n}R`,
  time,
  ...(grade === undefined ? {} : { grade }),
  kind: "nar",
  ...extra,
});
/** 実フィクスチャのあるレース(福島 11R)。 */
const fixtureRace = (time: string, extra: Partial<ListRow> = {}): ListRow => central(11, time, { raceId: RACE, venue: "福島", name: "福島記念テスト", ...extra });

const R1 = "202606040901";

// ---- 偽のゲート・保存先・送信 ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

interface FakeGate extends GateLike {
  readonly urls: string[];
  central: { html: string; failures: GateResult[] };
  nar: { html: string; failures: GateResult[] };
  /** 一覧以外: blocked(取得ステップが即失敗)か、実フィクスチャ。 */
  others: "blocked" | "fixture";
}

function fakeGate(centralHtml: string, narHtml: string): FakeGate {
  const gate: FakeGate = {
    urls: [],
    central: { html: centralHtml, failures: [] },
    nar: { html: narHtml, failures: [] },
    others: "blocked",
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const list = url.startsWith("https://race.netkeiba.com/top/race_list_sub") ? gate.central : url.startsWith("https://nar.netkeiba.com/top/race_list_sub") ? gate.nar : null;
      if (list !== null) {
        return list.failures.shift() ?? ok(list.html);
      }
      if (gate.others === "blocked") return blocked();
      const text = fixtureForUrl(url);
      return text === null ? { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 } : ok(text);
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  /** save をこの回数だけ「保存してから例外」にする(D1 へ書いたあと、応答を受け取る前にクラッシュした状況)。 */
  crashAfterSave: number;
  /** 保存の直前に、record を書き換える(材料の構築に失敗する状況の再現)。 */
  mutate: ((record: AnalysisRecord) => void) | null;
  /** `findRecentByRace` が返す行(手動の分析)。 */
  recent: RecentAnalysis[];
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    crashAfterSave: 0,
    mutate: null,
    recent: [],
    async save(record) {
      sink.mutate?.(record);
      sink.saved.push(record);
      if (sink.crashAfterSave > 0) {
        sink.crashAfterSave -= 1;
        throw new Error("保存後のクラッシュ");
      }
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return sink.recent;
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}


interface FakeNotifier extends DiscordNotifier {
  readonly sent: DiscordPayload[];
  /** 呼ばれた時刻(時計の値)。 */
  readonly at: number[];
  /** 次の送信の振る舞い(先頭から1回ずつ消費。空なら成功)。 */
  script: (Error | "ok")[];
}

function fakeNotifier(clock: { now: number }, onCall: (payload: DiscordPayload) => void): FakeNotifier {
  const n: FakeNotifier = {
    sent: [],
    at: [],
    script: [],
    async send(payload) {
      onCall(payload); // 呼ばれた時点(結果が出る前)で、SQL の列に挟む
      n.at.push(clock.now);
      const next = n.script.shift() ?? "ok";
      if (next instanceof Error) {
        throw next;
      }
      n.sent.push(payload);
    },
  };
  return n;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly notifier: FakeNotifier;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  /** `setAlarm` の呼び出しの系列(全部)。 */
  readonly alarms: number[];
  readonly warnings: string[];
  /** 実行した SQL の全部(文を空白で詰めたもの + 束縛値の JSON)に、`notifier.send` の呼び出しと警告(`onWarn <文面>`)を実行順に挟んだもの。 */
  readonly sqlLog: string[];
  settings: CloudSettings;
  /** 真を返した文は例外を投げる(SQL の読み書きの失敗の模擬)。 */
  fault: ((query: string, bindings: readonly unknown[]) => boolean) | null;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

interface HarnessOptions {
  readonly nar?: string;
  /** false なら notifier を渡さない(webhook が無効)。 */
  readonly notifier?: boolean;
  readonly appBaseUrl?: string;
}
function harness(rows: readonly ListRow[], options: HarnessOptions = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: jst("08:00") };
  const alarm: { at: number | null } = { at: null };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const sqlLog: string[] = [];
  const gate = fakeGate(rows.length === 0 ? EMPTY_HTML : listHtml(rows), options.nar ?? EMPTY_HTML);
  const sink = fakeSink();
  const notifier = fakeNotifier(clock, (payload) => sqlLog.push(`notifier.send ${JSON.stringify(payload)}`));
  const h = { sql, gate, sink, notifier, clock, alarm, alarms, warnings, sqlLog, settings: DEFAULT_CLOUD_SETTINGS, fault: null } as Harness;
  const loggedSql: SqlLike = {
    exec(query, ...bindings) {
      if (h.fault !== null && h.fault(query, bindings)) {
        sqlLog.push(`FAULT ${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`);
        throw new Error("SQL の故障");
      }
      sqlLog.push(`${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`);
      return sql.exec(query, ...bindings);
    },
  };
  const core = new RaceDayCore({
    sql: loggedSql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: (message) => {
      warnings.push(message);
      sqlLog.push(`onWarn ${message}`);
    },
    sink,
    loadSettings: async () => h.settings,
    ...(options.notifier === false ? {} : { notifier }),
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}
/** アラームの時刻が `until` 以前のあいだ、1 ステップずつ進める(トレースなし。準備に使う)。 */
async function drive(h: Harness, until: number, max = 120): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await tick(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}
/** 計画(一覧 2 つ + 確定)まで進める。morning は done にして(このテストの主題ではない)、発走前だけを動かす。 */
async function planned(h: Harness, doneMorning = true): Promise<void> {
  h.clock.now = jst("08:00");
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  for (let i = 0; i < 3; i += 1) await tick(h);
  if (doneMorning) h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
}

interface NotifyRowView {
  key: string;
  kind: string;
  state: string;
  error_class: string | null;
  analysis_id: number | null;
  created_at: number;
  updated_at: number;
  payload: unknown;
}
const notifyRows = (h: Harness): NotifyRowView[] =>
  (h.sql.exec("SELECT * FROM race_day_notify ORDER BY key").toArray() as { key: string; kind: string; state: string; error_class: string | null; analysis_id: number | null; created_at: number; updated_at: number; payload_json: string | null }[]).map(
    (r) => ({ key: r.key, kind: r.kind, state: r.state, error_class: r.error_class, analysis_id: r.analysis_id, created_at: r.created_at, updated_at: r.updated_at, payload: r.payload_json === null ? null : JSON.parse(r.payload_json) }),
  );
const metaValue = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};

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

/** 束縛値のうち長い文字列(embed の JSON)は、長さと SHA-1 に詰める(本文は送信した payload と最後の `payload_json` で固定する)。 */
function shortSql(line: string): string {
  const at = line.lastIndexOf(" | ");
  if (at < 0 || line.startsWith("notifier.send ") || line.startsWith("onWarn ")) return line;
  try {
    const bindings = (JSON.parse(line.slice(at + 3)) as unknown[]).map((b) => (typeof b === "string" && b.length > 80 ? `<len=${b.length} sha1=${sha1(b).slice(0, 10)}>` : b));
    return `${line.slice(0, at)} | ${JSON.stringify(bindings)}`;
  } catch {
    return line;
  }
}
/** 同じ行の連続を `×n` に詰める(通知の表の読みは、計画の判定のたびに繰り返される)。 */
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

/** 1 ステップの間に起きたこと。 */
interface StepTrace {
  readonly label: string;
  readonly at: number;
  readonly warnings: string[];
  readonly alarms: number[];
  /** 送った payload(`notifier.send` に渡ったもの。失敗した送信を含む)。 */
  readonly calls: unknown[];
  /** 通知の表・間隔の meta に触れた文と、`notifier.send`・警告(順序どおり。連続する同じ行は ×n)。 */
  readonly notifySql: string[];
  readonly sqlCount: number;
  readonly sqlSha1: string;
  /** ステップの後の通知の計画(`peekNotifyPlan`)。 */
  readonly planAfter: unknown;
}

/** アラームの時刻(`forceAt` なら指定の時刻)まで時計を進めて 1 ステップ動かし、その間に起きたことを集める。 */
async function stepTrace(h: Harness, forceAt?: number): Promise<StepTrace> {
  const w = h.warnings.length;
  const a = h.alarms.length;
  const s = h.sqlLog.length;
  const c = h.notifier.at.length;
  const at = forceAt ?? h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  const outcome = await h.core.runNextStep();
  const sqlLines = h.sqlLog.slice(s);
  const sendLines = sqlLines.filter((line) => line.startsWith("notifier.send ")).map((line) => JSON.parse(line.slice("notifier.send ".length)) as unknown);
  expect(sendLines.length).toBe(h.notifier.at.length - c); // 前提: 列に挟んだ呼び出しと、偽の送信の記録が一致する
  return {
    label: label(outcome),
    at: h.clock.now,
    warnings: h.warnings.slice(w),
    alarms: h.alarms.slice(a),
    calls: sendLines,
    notifySql: runLength(
      sqlLines.filter((line) => /race_day_notify|notify_pace_until|^notifier\.send |^onWarn |^FAULT /.test(line)).map((line) => (line.startsWith("notifier.send ") ? "notifier.send" : shortSql(line))),
    ),
    sqlCount: sqlLines.length,
    sqlSha1: sha1(sqlLines.join("\n")),
    planAfter: h.core.peekNotifyPlan(),
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
/** 最後の状態(通知の表・間隔・一覧・アラーム・警告)。 */
function finalState(h: Harness): unknown {
  return {
    rows: notifyRows(h),
    paceUntil: metaValue(h, "notify_pace_until"),
    notifications: h.core.getNotifications(),
    sendTimes: h.notifier.at,
    sentCount: h.notifier.sent.length,
    alarm: h.alarm.at,
    allAlarms: h.alarms,
    allWarnings: h.warnings,
  };
}

/**
 * 通知を送るステップの中で、**計画の判定が終わった後**(`notify_pace_until` の読みの後)の最初の `pattern` に合う文を、1 回だけ例外にする(送る内容を作る処理の失敗の模擬)。
 * 計画の判定(`planNotifications` の入力を作る読み)は先に終わっているので、落ちるのは送る内容を作る処理(`runNotifyStep` の最初の try)の中だけ。
 */
function failBuildOnce(h: Harness, pattern: RegExp): void {
  let pastPlan = false;
  let fired = false;
  h.fault = (query, bindings) => {
    const line = `${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`;
    if (!pastPlan) {
      pastPlan = line.includes('"notify_pace_until"') && line.startsWith("SELECT value FROM race_day_meta");
      return false;
    }
    if (!fired && pattern.test(line)) {
      fired = true;
      return true;
    }
    return false;
  };
}
/** 通知の行(`race:` で始まるもの)が、`state` になるまで(トレースなしで)進める。次の起床がその通知を送るステップになる。 */
async function driveUntilRaceRow(h: Harness, state: string, until: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (notifyRows(h).some((r) => r.key.startsWith("race:") && r.state === state)) return;
    if (h.alarm.at === null || h.alarm.at > until) break;
    await tick(h);
  }
  expect(notifyRows(h).some((r) => r.key.startsWith("race:") && r.state === state), `前提: race: の行が ${state} になった`).toBe(true);
}

const failing = (): Error => new DiscordNotifyError(`拒否されました ${SECRET_URL}`, { status: 404, responseBody: SECRET_URL });

/** 福島 11R(15:35 発走。実フィクスチャで発走前の分析まで通る)を計画 → 14:50 に昇格 → 取得 → 計算・保存 → 通知まで、16:00 まで進める。 */
const analysisDay = (mutate?: (h: Harness) => void) => async (h: Harness): Promise<unknown> => {
  h.gate.others = "fixture";
  await planned(h);
  mutate?.(h);
  return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
};

type Scenario = (h: Harness) => Promise<unknown>;
interface ScenarioDef {
  readonly rows: readonly ListRow[];
  readonly options?: HarnessOptions;
  readonly run: Scenario;
}

const SCENARIOS: Record<string, ScenarioDef> = {
  // ---- 分析の通知(材料: putAnalysisMaterial → 送信: runNotifyStep)と、リンク(withAnalysisLink)----
  "分析の通知の一連(リンクなし)": { rows: [fixtureRace("15:35")], run: analysisDay() },
  "分析の通知(APP_BASE_URL あり・中央のリンク)": { rows: [fixtureRace("15:35")], options: { appBaseUrl: BASE }, run: analysisDay() },
  "分析の通知(APP_BASE_URL あり・計画の行が地方のリンク)": {
    rows: [fixtureRace("15:35")],
    options: { appBaseUrl: BASE },
    run: analysisDay((h) => h.sql.exec("UPDATE race_day_plan SET venue = 'nar'")),
  },
  "分析の通知(配分あり: 買い目の field・APP_BASE_URL あり)": {
    rows: [fixtureRace("15:35")],
    options: { appBaseUrl: BASE },
    run: analysisDay((h) => {
      h.settings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 100000, perRaceCap: 10000 };
    }),
  },
  "材料の embed の構築に失敗: 最小の embed に代える": {
    rows: [fixtureRace("15:35")],
    run: analysisDay((h) => {
      h.sink.mutate = (record) => {
        (record.raceSnapshot as { race?: unknown }).race = undefined;
      };
    }),
  },
  "手動の pre_race: 材料も通知の行も作らない": {
    rows: [],
    run: async (h) => {
      h.gate.others = "fixture";
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      return { traces: await traceUntil(h, jst("23:00"), 20), final: finalState(h) };
    },
  },
  "webhook が無効(notifier なし): 材料も行も積まず、通知のアラームも張らない": {
    rows: [fixtureRace("15:35")],
    options: { notifier: false },
    run: analysisDay(),
  },
  "webhook が無効(notifier なし)・失敗の結果": {
    rows: [central(1, "15:35")],
    options: { notifier: false },
    run: async (h) => {
      await planned(h);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  // ---- 送信の失敗と間隔 ----
  "送信の失敗(http-404): 分析の通知。再送しない": {
    rows: [fixtureRace("15:35")],
    run: analysisDay((h) => {
      h.notifier.script = ["ok", failing()];
    }),
  },
  "送信の失敗(network): 事前分析のまとめ。クールダウンのあとに分析の通知": {
    rows: [fixtureRace("15:35")],
    run: analysisDay((h) => {
      h.notifier.script = [new Error(`fetch failed ${SECRET_URL}`)];
    }),
  },
  "送信の失敗のクールダウンと成功の間隔(同じ発走の 2 レース)": {
    rows: [central(1, "15:35"), central(2, "15:35")],
    run: async (h) => {
      h.notifier.script = ["ok", failing(), "ok"];
      await planned(h);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "送信の間隔(成功のあとは 1 秒空ける。同じ発走の 2 レース)": {
    rows: [central(1, "15:35"), central(2, "15:35")],
    run: async (h) => {
      await planned(h);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  // ---- 送る内容を作れなかった(build の失敗)と、材料の積み方の失敗----
  "build の失敗(analysis): 材料の行の読み出しが例外。failed(build)にして送らない": {
    rows: [fixtureRace("15:35")],
    run: async (h) => {
      h.gate.others = "fixture";
      await planned(h);
      await drive(h, jst("14:49")); // 事前分析のまとめを送り終える(期限 14:50 の前)
      await driveUntilRaceRow(h, "ready", jst("16:00"));
      failBuildOnce(h, /^SELECT \* FROM race_day_notify WHERE key = \? \| \["race:/);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "build の失敗(summary): 開催日の読み出しが例外。failed(build)にして送らない": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      await planned(h);
      failBuildOnce(h, /^SELECT value FROM race_day_meta WHERE key = \? \| \["kaisai_date"\]/);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "build の失敗(failed): 結果の探索が例外。failed(build)にして送らない": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      await planned(h);
      await drive(h, jst("14:49")); // 事前分析のまとめを送り終える(期限 14:50 の前)
      await tick(h); // 14:50 の起床(昇格 + 取得が failed)
      failBuildOnce(h, /^SELECT p\.\*, t\.status AS pre_status/);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "保存の後、応答を受け取る前に落ちた: 再試行が保存済みを検出し、そのときに材料を積む": {
    rows: [fixtureRace("15:35")],
    run: analysisDay((h) => {
      h.sink.crashAfterSave = 1;
    }),
  },
  "材料の INSERT が例外: analysis_id は永続されず、再試行が材料を書き直す": {
    rows: [fixtureRace("15:35")],
    run: analysisDay((h) => {
      let thrown = false;
      h.fault = (query) => {
        if (!thrown && query.includes("INSERT INTO race_day_notify") && query.includes("'ready'")) {
          thrown = true;
          return true;
        }
        return false;
      };
    }),
  },
  "材料の embed の構築に失敗(計画の行の会場名・グレードが raceId や分析と違う): 最小の embed はラベルを計画の行から取る": {
    rows: [fixtureRace("15:35", { grade: "G1" })],
    run: analysisDay((h) => {
      h.sql.exec("UPDATE race_day_plan SET venue_name = '試験場', grade = 'G2'");
      h.sink.mutate = (record) => {
        (record.raceSnapshot as { race?: unknown }).race = undefined;
      };
    }),
  },
  "failed(blocked): グレードつきのレース(ラベルの会場名・グレードは計画の行から)": {
    rows: [central(1, "15:35", { grade: "G3" })],
    run: async (h) => {
      await planned(h);
      h.sql.exec("UPDATE race_day_plan SET venue_name = '試験場'");
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "skipped(manual): グレードつきのレース": {
    rows: [central(1, "15:35", { grade: "G3" })],
    run: async (h) => {
      await planned(h);
      h.sql.exec(
        "INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, analyzed_at, analysis_id, detail) VALUES (?, 'pre_race', 'done', 1, 1, ?, ?, ?, 3, 'stored')",
        R1,
        jst("14:40"),
        jst("14:41"),
        jst("14:40"),
      );
      h.sink.recent = [{ id: 1, analyzedAt: new Date(jst("14:45")).toISOString(), promptVersion: CLIP_VARIANTS.default.promptVersion, model: "m" } satisfies RecentAnalysis];
      h.sql.exec("UPDATE race_day_plan SET venue_name = '試験場'");
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "送信の間隔の境界: 成功の 1 秒後の 1ms 前は送らず、ちょうどで送る": {
    rows: [central(1, "15:35"), central(2, "15:35")],
    run: async (h) => {
      await planned(h);
      await drive(h, jst("14:49"));
      const T = jst("14:50");
      const first = [await stepTrace(h), await stepTrace(h), await stepTrace(h)]; // 昇格 + 1R の取得 → 1R の通知(成功。間隔は T + 1 秒)→ 2R の取得(2R の通知が間隔待ちで残る)
      const early = await stepTrace(h, T + SEND_SPACING_MS - 1);
      const exact = await stepTrace(h, T + SEND_SPACING_MS);
      return { first, early, exact, rest: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "失敗のクールダウンの境界: 失敗の 60 秒後の 1ms 前は送らず、ちょうどで送る": {
    rows: [central(1, "15:35"), central(2, "15:35")],
    run: async (h) => {
      h.notifier.script = ["ok", failing(), "ok"];
      await planned(h);
      await drive(h, jst("14:49"));
      const T = jst("14:50");
      const first = [await stepTrace(h), await stepTrace(h), await stepTrace(h)]; // 昇格 + 1R の取得 → 1R の通知(失敗。クールダウンは T + 60 秒)→ 2R の取得
      const early = await stepTrace(h, T + FAILURE_COOLDOWN_MS - 1);
      const exact = await stepTrace(h, T + FAILURE_COOLDOWN_MS);
      return { first, early, exact, rest: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  // ---- 失敗・スキップ・まとめ(送るときに内容を作る種類)----
  "failed(blocked): 赤の通知": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      await planned(h);
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "昇格の時点の skipped(started): 赤の通知": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      await planned(h);
      await drive(h, jst("14:49"));
      const woke = await stepTrace(h, jst("15:35"));
      return { woke, traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "昇格の時点の skipped(manual): 灰色の通知": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      await planned(h);
      h.sql.exec(
        "INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, analyzed_at, analysis_id, detail) VALUES (?, 'pre_race', 'done', 1, 1, ?, ?, ?, 3, 'stored')",
        R1,
        jst("14:40"),
        jst("14:41"),
        jst("14:40"),
      );
      h.sink.recent = [{ id: 1, analyzedAt: new Date(jst("14:45")).toISOString(), promptVersion: CLIP_VARIANTS.default.promptVersion, model: "m" } satisfies RecentAnalysis];
      return { traces: await traceUntil(h, jst("16:00")), final: finalState(h) };
    },
  },
  "事前分析のまとめ(中央 2 レース + 地方の交流重賞。morning は失敗で終端)": {
    rows: [central(1, "15:35"), central(2, "15:40")],
    options: { nar: listHtml([nar(11, "20:10", "Jpn3")]) },
    run: async (h) => {
      await planned(h, false);
      return { traces: await traceUntil(h, jst("14:00")), final: finalState(h) };
    },
  },
  "事前分析のまとめ(保険の時刻。未完了のまま)": {
    rows: [central(1, "15:35"), central(2, "15:40")],
    run: async (h) => {
      await planned(h, false);
      h.gate.others = "blocked";
      // morning を終端にしないまま、保険の時刻(確定 + 60 分)まで進める
      h.sql.exec("UPDATE race_day_tasks SET status = 'running' WHERE mode = 'morning'");
      return { traces: await traceUntil(h, jst("10:30")), final: finalState(h) };
    },
  },
  "全会場の一覧の取得に失敗した日のまとめ": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      h.gate.central.failures = [blocked()];
      h.gate.nar.failures = [blocked()];
      h.clock.now = jst("08:00");
      await h.core.requestPlan({ kaisaiDate: DATE });
      return { traces: await traceUntil(h, jst("12:00")), final: finalState(h) };
    },
  },
  // ---- 23 時の再実行の後の失敗の通知(plan-failure。材料は judgeRescue が積み、送るのはこの段階)----
  "23 時の再実行の後も会場の失敗が残る: plan-failure の通知": {
    rows: [central(1, "15:35")],
    run: async (h) => {
      const t2100 = Date.parse("2026-06-27T21:00:00+09:00");
      const t2300 = Date.parse("2026-06-27T23:00:00+09:00");
      h.gate.central.failures = [blocked(), blocked()];
      h.clock.now = t2100;
      await h.core.requestPlan({ kaisaiDate: DATE });
      await drive(h, t2300 - 1, 200);
      h.clock.now = t2300;
      await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
      return { traces: await traceUntil(h, t2300 + 2 * 60 * MIN, 100), final: finalState(h) };
    },
  },
};

describe("Issue #399(R-9c): 通知の段階を切り出す前の挙動(特性テスト)", () => {
  it("前提: 場面を数え直す(期待値の取りこぼしが無い)", () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThan(15);
    if (process.env.CHAR_DUMP === undefined || process.env.CHAR_DUMP === "") {
      expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(SCENARIOS).sort());
    }
  });
  it.each(Object.keys(SCENARIOS))("%s", async (name) => {
    const def = SCENARIOS[name]!;
    const h = harness(def.rows, def.options);
    check(name, await def.run(h));
  });
});

/** 切り出す前のコード(35f2780)の実出力。`CHAR_DUMP` で作り直せる。 */
const EXPECTED: Record<string, unknown> = {
 "分析の通知の一連(リンクなし)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "a34249184a23b03783d332e541f9d137eca47aa7",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "b8bb9360d4952356609cd6fdf49e097a26804e68",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "分析の通知(APP_BASE_URL あり・中央のリンク)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "a34249184a23b03783d332e541f9d137eca47aa7",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ],
        "url": "https://keiba.example.test/#date=20260628&venue=central&race=202603020211&analysis=1"
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "33f2259a859c12430b3902fed9377930bf94e379",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "分析の通知(APP_BASE_URL あり・計画の行が地方のリンク)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 0・地方 交流重賞 1)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "中央",
          "value": "一覧が空でした(0件)"
         },
         {
          "name": "地方 交流重賞",
          "value": "福島 11R 福島記念テスト 15:35 事前分析OK"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=236 sha1=56368118c6>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "9843162f57aefa928febcab5dc581c43c73b7d9b",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "a34249184a23b03783d332e541f9d137eca47aa7",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ],
        "url": "https://keiba.example.test/#date=20260628&venue=nar&race=202603020211&analysis=1"
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "beb64e55a236e2286b5af45b8eb2bc2342235df4",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 0・地方 交流重賞 1)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中央",
        "value": "一覧が空でした(0件)"
       },
       {
        "name": "地方 交流重賞",
        "value": "福島 11R 福島記念テスト 15:35 事前分析OK"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "分析の通知(配分あり: 買い目の field・APP_BASE_URL あり)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "1ff97a68183b7e39538c1ec2877c216e74d69597",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=569 sha1=d608c31de8>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "1d21aa0bf65cd1c4d824f457b3fad8214b20e007",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目(6点・合計9,800円)",
          "value": "複勝 1番 3,700円\n複勝 4番 1,800円\n複勝 10番 1,400円\n複勝 3番 1,300円\n複勝 7番 1,000円\n複勝 11番 600円"
         }
        ],
        "url": "https://keiba.example.test/#date=20260628&venue=central&race=202603020211&analysis=1"
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "4ff678025b2a655ed1620541b4b3099d7f06428d",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目(6点・合計9,800円)",
        "value": "複勝 1番 3,700円\n複勝 4番 1,800円\n複勝 10番 1,400円\n複勝 3番 1,300円\n複勝 7番 1,000円\n複勝 11番 600円"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "材料の embed の構築に失敗: 最小の embed に代える": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=118 sha1=0e33cbc349>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 124,
    "sqlSha1": "6037865c4afb564a6e37e087b22a3c1b9f0c9ed4",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R 福島記念テスト",
        "description": "発走 15:35\n\n分析が完了しました。詳細は画面で確認してください。\n(通知の詳細を組み立てられませんでした)",
        "color": 9807270
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "02e192feb53ea35b8357f61d4cfe87779d0f4862",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R 福島記念テスト",
      "description": "発走 15:35\n\n分析が完了しました。詳細は画面で確認してください。\n(通知の詳細を組み立てられませんでした)",
      "color": 9807270
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
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
   ]
  }
 },
 "手動の pre_race: 材料も通知の行も作らない": {
  "traces": [
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782601200000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 127,
    "sqlSha1": "b6927ff2e30c2dc10d34e64f9a0d004be29ca04f",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782601200000,
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
     1782694860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 114,
    "sqlSha1": "82d1dc6e036adaed8dcc18f8b01768bd816e9a9e",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [],
   "paceUntil": null,
   "notifications": [],
   "sendTimes": [],
   "sentCount": 0,
   "alarm": 1782694860000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782694860000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "webhook が無効(notifier なし): 材料も行も積まず、通知のアラームも張らない": {
  "traces": [
   {
    "label": "idle",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [],
    "sqlCount": 20,
    "sqlSha1": "46bc91406654242ed9e74c8e91d1ff717ab3787d",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "sqlCount": 118,
    "sqlSha1": "3711437e16786e8a1ded1eaab97af378202983b8",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782719460000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
    ],
    "sqlCount": 94,
    "sqlSha1": "00623859484d8eb21ad8abcae1ff512215d378f8",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [],
   "paceUntil": null,
   "notifications": [],
   "sendTimes": [],
   "sentCount": 0,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "webhook が無効(notifier なし)・失敗の結果": {
  "traces": [
   {
    "label": "idle",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [],
    "sqlCount": 20,
    "sqlSha1": "46bc91406654242ed9e74c8e91d1ff717ab3787d",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782719460000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "sqlCount": 41,
    "sqlSha1": "f37eefebf795ccef14e8c735987a80651ea68d98",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [],
   "paceUntil": null,
   "notifications": [],
   "sendTimes": [],
   "sentCount": 0,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "送信の失敗(http-404): 分析の通知。再送しない": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "a34249184a23b03783d332e541f9d137eca47aa7",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:failed",
    "at": 1782625800000,
    "warnings": [
     "Discord への通知に失敗しました(race:202603020211。分類: http-404。再送しません)"
    ],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"http-404\",1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625860000\"]",
     "onWarn Discord への通知に失敗しました(race:202603020211。分類: http-404。再送しません)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 48,
    "sqlSha1": "2accef6a5265b41cf5c970bac1acb03a43720776",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "failed",
     "error_class": "http-404",
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625860000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "failed",
     "analysisId": 1,
     "errorClass": "http-404",
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 1,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "Discord への通知に失敗しました(race:202603020211。分類: http-404。再送しません)"
   ]
  }
 },
 "送信の失敗(network): 事前分析のまとめ。クールダウンのあとに分析の通知": {
  "traces": [
   {
    "label": "summary:notify:send:failed",
    "at": 1782601200000,
    "warnings": [
     "Discord への通知に失敗しました(summary。分類: network。再送しません)"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"network\",1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601260000\"]",
     "onWarn Discord への通知に失敗しました(summary。分類: network。再送しません)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 54,
    "sqlSha1": "85e32a2faa530360949ca65eea291aee4a4788d4",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 123,
    "sqlSha1": "a34249184a23b03783d332e541f9d137eca47aa7",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601260000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "b8bb9360d4952356609cd6fdf49e097a26804e68",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "failed",
     "error_class": "network",
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "failed",
     "analysisId": null,
     "errorClass": "network",
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 1,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "Discord への通知に失敗しました(summary。分類: network。再送しません)",
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "送信の失敗のクールダウンと成功の間隔(同じ発走の 2 レース)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=251 sha1=01b43012f3>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "a6ad4d6f89ee1658a40037a055ccaa314297b6cf",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 76,
    "sqlSha1": "78df974940067acd3fd6a68177923681b43b9733",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:failed",
    "at": 1782625800000,
    "warnings": [
     "Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"http-404\",1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625860000\"]",
     "onWarn Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "3ded5f647fbcf239032956488b0671902d35c3bb",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040902:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 57,
    "sqlSha1": "ce4687046e56c35cfb6197dc4bbe1b486d69bcc5",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782625860000
    }
   },
   {
    "label": "202606040902:notify:send:ok",
    "at": 1782625860000,
    "warnings": [],
    "alarms": [
     1782719520000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 2R 中央2R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040902\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040902\",\"failed\",\"<len=121 sha1=605da263b9>\",null,1782625860000,1782625860000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625860000,\"race:202606040902\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625861000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "bbd8dc090d35edbe9693c5e272b9ea49cb1d5290",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "error_class": "http-404",
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625860000,
     "updated_at": 1782625860000,
     "payload": {
      "title": "中山 2R 中央2R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625861000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "analysisId": null,
     "errorClass": "http-404",
     "updatedAt": 1782625800000
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625860000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000,
    1782625860000
   ],
   "sentCount": 2,
   "alarm": 1782719520000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782625860000,
    1782719520000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)",
    "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "送信の間隔(成功のあとは 1 秒空ける。同じ発走の 2 レース)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=251 sha1=01b43012f3>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "a6ad4d6f89ee1658a40037a055ccaa314297b6cf",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 76,
    "sqlSha1": "78df974940067acd3fd6a68177923681b43b9733",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 48,
    "sqlSha1": "ba8a7e6d49bae6f4f8a0f1079ea97474388e0b38",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040902:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625801000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 57,
    "sqlSha1": "ce4687046e56c35cfb6197dc4bbe1b486d69bcc5",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782625801000
    }
   },
   {
    "label": "202606040902:notify:send:ok",
    "at": 1782625801000,
    "warnings": [],
    "alarms": [
     1782719461000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 2R 中央2R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040902\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040902\",\"failed\",\"<len=121 sha1=605da263b9>\",null,1782625801000,1782625801000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625801000,\"race:202606040902\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625802000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "04702a0cb8ca66f12b43526e9f47e67b0edb56ad",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625801000,
     "updated_at": 1782625801000,
     "payload": {
      "title": "中山 2R 中央2R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625802000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625801000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000,
    1782625801000
   ],
   "sentCount": 3,
   "alarm": 1782719461000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782625801000,
    1782719461000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "build の失敗(analysis): 材料の行の読み出しが例外。failed(build)にして送らない": {
  "traces": [
   {
    "label": "202603020211:notify:send:failed",
    "at": 1782625800000,
    "warnings": [
     "Discord の通知の内容を作れませんでした(race:202603020211): SQL の故障"
    ],
    "alarms": [
     1782719460000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "FAULT SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"]",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"build\",1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "onWarn Discord の通知の内容を作れませんでした(race:202603020211): SQL の故障",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "efb6c942e6b2dbc0d07e36f96836cfcc205da2e3",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "failed",
     "error_class": "build",
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "failed",
     "analysisId": 1,
     "errorClass": "build",
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000
   ],
   "sentCount": 1,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
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
    "Discord の通知の内容を作れませんでした(race:202603020211): SQL の故障"
   ]
  }
 },
 "build の失敗(summary): 開催日の読み出しが例外。failed(build)にして送らない": {
  "traces": [
   {
    "label": "summary:notify:send:failed",
    "at": 1782601200000,
    "warnings": [
     "Discord の通知の内容を作れませんでした(summary): SQL の故障"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "FAULT SELECT value FROM race_day_meta WHERE key = ? | [\"kaisai_date\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",null,null,1782601200000,1782601200000]",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"build\",1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "onWarn Discord の通知の内容を作れませんでした(summary): SQL の故障",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "549ed03a96b69820b4c694e6f308cf7923cf19f9",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 67,
    "sqlSha1": "c3983ec559318299ac7befd137de107fa32578d6",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "9d796edb85ff19e045669d97f5eb8a2b9cd19610",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "failed",
     "error_class": "build",
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": null
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "failed",
     "analysisId": null,
     "errorClass": "build",
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782625800000
   ],
   "sentCount": 1,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "Discord の通知の内容を作れませんでした(summary): SQL の故障",
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "build の失敗(failed): 結果の探索が例外。failed(build)にして送らない": {
  "traces": [
   {
    "label": "202606040901:notify:send:failed",
    "at": 1782625800000,
    "warnings": [
     "Discord の通知の内容を作れませんでした(race:202606040901): SQL の故障"
    ],
    "alarms": [
     1782719460000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "FAULT SELECT p.*, t.status AS pre_status, t.queued_at AS pre_queued_at, t.analysis_id AS pre_analysis_id, t.detail AS pre_detail, t.error AS pre_error, a.enqueued_at AS auto_enqueued_at, a.fail_reason AS auto_fail_reason FROM race_day_plan p LEFT JOIN race_day_tasks t ON t.race_id = p.race_id AND t.mode = 'pre_race' LEFT JOIN race_day_auto_pre_race a ON a.race_id = p.race_id ORDER BY p.race_id | []",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",null,null,1782625800000,1782625800000]",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"build\",1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "onWarn Discord の通知の内容を作れませんでした(race:202606040901): SQL の故障",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "2f9c0c9244787086257c50f748dc6907748fb15e",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "error_class": "build",
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": null
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "analysisId": null,
     "errorClass": "build",
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000
   ],
   "sentCount": 1,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "Discord の通知の内容を作れませんでした(race:202606040901): SQL の故障"
   ]
  }
 },
 "保存の後、応答を受け取る前に落ちた: 再試行が保存済みを検出し、そのときに材料を積む": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:retry",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 103,
    "sqlSha1": "38023469dfe7bddab724a1c69f97c50a00a07205",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625860000,
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
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625860000,1782625860000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 122,
    "sqlSha1": "73e43cf4b62ac2b4f1665151ab362ebb18da7af6",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625860000,
    "warnings": [],
    "alarms": [
     1782719520000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625860000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625860000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625861000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "1cb85af03050de608d70d6f9b20d44ed981a9435",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625860000,
     "updated_at": 1782625860000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625861000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625860000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625860000
   ],
   "sentCount": 2,
   "alarm": 1782719520000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625860000,
    1782625860000,
    1782719520000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "材料の INSERT が例外: analysis_id は永続されず、再試行が材料を書き直す": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "福島",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=233 sha1=83f897f494>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "c747597a5c5d94acf9fa70d5ad520c0e389693da",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:retry",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "FAULT INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625800000,1782625800000]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 106,
    "sqlSha1": "1780cbe1ddc074a3cfe2fb748734c5c4ef17ecbb",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625860000,
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
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=505 sha1=cbb59c76b3>\",1,1782625860000,1782625860000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 122,
    "sqlSha1": "73e43cf4b62ac2b4f1665151ab362ebb18da7af6",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625860000,
    "warnings": [],
    "alarms": [
     1782719520000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "福島 11R ラジオNIKKEI賞(G3)",
        "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
        "color": 40563,
        "fields": [
         {
          "name": "印",
          "value": "印の付いた馬はありません"
         },
         {
          "name": "買い目",
          "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625860000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625860000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625861000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "1cb85af03050de608d70d6f9b20d44ed981a9435",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625860000,
     "updated_at": 1782625860000,
     "payload": {
      "title": "福島 11R ラジオNIKKEI賞(G3)",
      "description": "発走 15:35\n\n2026/06/28 / 福島 / 芝1800m\n\n1番 ルージュボヤージュ AI補正後51.6% 複勝下限3.1 EV1.60\n3番 ジーネキング AI補正後35.5% 複勝下限3.2 EV1.14\n4番 サイモンシャリオ AI補正後22.8% 複勝下限9.5 EV2.16\n7番 ショウナンガルフ AI補正後13.5% 複勝下限15.4 EV2.07\n10番 ガリレア AI補正後15.1% 複勝下限21.2 EV3.19\n11番 コロナドブリッジ AI補正後15.2% 複勝下限8.3 EV1.26\n\nLLM補正: スキップ\nLLM補正の注記: LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました",
      "color": 40563,
      "fields": [
       {
        "name": "印",
        "value": "印の付いた馬はありません"
       },
       {
        "name": "買い目",
        "value": "総資金と1レースの上限が未設定のため、配分の提案は出ていません"
       }
      ]
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "福島",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625861000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625860000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625860000
   ],
   "sentCount": 2,
   "alarm": 1782719520000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625860000,
    1782625860000,
    1782719520000
   ],
   "allWarnings": [
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
    "発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)"
   ]
  }
 },
 "材料の embed の構築に失敗(計画の行の会場名・グレードが raceId や分析と違う): 最小の embed はラベルを計画の行から取る": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "試験場",
          "value": "11R 福島記念テスト 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=234 sha1=9f3e3f6901>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "e5fd56888ea77d7d7492e283d21daab6568bdcb1",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:fetch:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 144,
    "sqlSha1": "50f034a0b3b261638d188cecf4b899af0b71c62a",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202603020211:pre_race:compute:ok",
    "at": 1782625800000,
    "warnings": [
     "発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
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
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"race:202603020211\",\"analysis\",\"<len=123 sha1=818d4fdfcc>\",1,1782625800000,1782625800000]",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01205 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01105 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01124 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01079 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01080 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01087 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01185 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01141 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01071 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01092 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "onWarn 発走前の分析(202603020211): 調教師: 調教師ID 01175 の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 124,
    "sqlSha1": "f68cb9bfa920173276112cdb61e160d06035d6b8",
    "planAfter": {
     "sendNow": {
      "key": "race:202603020211",
      "kind": "analysis",
      "raceId": "202603020211"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202603020211:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "試験場 11R 福島記念テスト(G2)",
        "description": "発走 15:35\n\n分析が完了しました。詳細は画面で確認してください。\n(通知の詳細を組み立てられませんでした)",
        "color": 9807270
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202603020211\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782625800000,\"race:202603020211\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202603020211\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "54c9b3dcb30f37296069a40ae43e3a41de228fb4",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "error_class": null,
     "analysis_id": 1,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "試験場 11R 福島記念テスト(G2)",
      "description": "発走 15:35\n\n分析が完了しました。詳細は画面で確認してください。\n(通知の詳細を組み立てられませんでした)",
      "color": 9807270
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "試験場",
        "value": "11R 福島記念テスト 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202603020211",
     "kind": "analysis",
     "state": "sent",
     "analysisId": 1,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得(202603020211): 調教師: この取得の呼び出しが上限(40本)に達したため、調教師 11 人の成績は取得せず、補正なしで続行します",
    "発走前の分析(202603020211): 通知の材料を組み立てられませんでした(最小の通知に代えます): レース情報のスナップショットが想定の形ではありません",
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
   ]
  }
 },
 "failed(blocked): グレードつきのレース(ラベルの会場名・グレードは計画の行から)": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "試験場",
          "value": "1R 中央1R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=230 sha1=04b58b8582>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "a1f75029be734c000b39970d04c3deb07e41c461",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 67,
    "sqlSha1": "c3983ec559318299ac7befd137de107fa32578d6",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "試験場 1R 中央1R(G3)",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=126 sha1=4851e466fd>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "02cefbab001160386dfb2a0e6c44b831aadd51ea",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "試験場 1R 中央1R(G3)",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "試験場",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "skipped(manual): グレードつきのレース": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "試験場",
          "value": "1R 中央1R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=230 sha1=04b58b8582>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "a1f75029be734c000b39970d04c3deb07e41c461",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "試験場 1R 中央1R(G3)",
        "description": "発走 15:35\n\n手動の分析があるため、自動の分析は行いませんでした",
        "color": 9807270
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"skipped-manual\",\"<len=97 sha1=f7a8403326>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "902a8da5935e55e76cb99996df93e186fece2fa5",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "skipped-manual",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "試験場 1R 中央1R(G3)",
      "description": "発走 15:35\n\n手動の分析があるため、自動の分析は行いませんでした",
      "color": 9807270
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "試験場",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "skipped-manual",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": []
  }
 },
 "送信の間隔の境界: 成功の 1 秒後の 1ms 前は送らず、ちょうどで送る": {
  "first": [
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 76,
    "sqlSha1": "78df974940067acd3fd6a68177923681b43b9733",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 48,
    "sqlSha1": "ba8a7e6d49bae6f4f8a0f1079ea97474388e0b38",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040902:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625801000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 57,
    "sqlSha1": "ce4687046e56c35cfb6197dc4bbe1b486d69bcc5",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782625801000
    }
   }
  ],
  "early": {
   "label": "idle",
   "at": 1782625800999,
   "warnings": [],
   "alarms": [
    1782625801000
   ],
   "calls": [],
   "notifySql": [
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
   ],
   "sqlCount": 46,
   "sqlSha1": "fe085373fdf26585ea052f14f719449bc550b089",
   "planAfter": {
    "sendNow": null,
    "nextAtMs": 1782625801000
   }
  },
  "exact": {
   "label": "202606040902:notify:send:ok",
   "at": 1782625801000,
   "warnings": [],
   "alarms": [
    1782719461000
   ],
   "calls": [
    {
     "embeds": [
      {
       "title": "中山 2R 中央2R",
       "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
       "color": 13639744
      }
     ]
    }
   ],
   "notifySql": [
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
    "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040902\"]",
    "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040902\",\"failed\",\"<len=121 sha1=605da263b9>\",null,1782625801000,1782625801000]",
    "notifier.send",
    "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625801000,\"race:202606040902\"]",
    "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625802000\"]",
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
   ],
   "sqlCount": 49,
   "sqlSha1": "04702a0cb8ca66f12b43526e9f47e67b0edb56ad",
   "planAfter": {
    "sendNow": null,
    "nextAtMs": null
   }
  },
  "rest": [],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625801000,
     "updated_at": 1782625801000,
     "payload": {
      "title": "中山 2R 中央2R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625802000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625801000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000,
    1782625801000
   ],
   "sentCount": 3,
   "alarm": 1782719461000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782625801000,
    1782625801000,
    1782719461000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "失敗のクールダウンの境界: 失敗の 60 秒後の 1ms 前は送らず、ちょうどで送る": {
  "first": [
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 76,
    "sqlSha1": "78df974940067acd3fd6a68177923681b43b9733",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:failed",
    "at": 1782625800000,
    "warnings": [
     "Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"failed\",\"http-404\",1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625860000\"]",
     "onWarn Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "3ded5f647fbcf239032956488b0671902d35c3bb",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040902:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625860000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 57,
    "sqlSha1": "ce4687046e56c35cfb6197dc4bbe1b486d69bcc5",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782625860000
    }
   }
  ],
  "early": {
   "label": "idle",
   "at": 1782625859999,
   "warnings": [],
   "alarms": [
    1782625860000
   ],
   "calls": [],
   "notifySql": [
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
   ],
   "sqlCount": 46,
   "sqlSha1": "f1e1067e9f3c7fa0078b3659ec751e5b8a532312",
   "planAfter": {
    "sendNow": null,
    "nextAtMs": 1782625860000
   }
  },
  "exact": {
   "label": "202606040902:notify:send:ok",
   "at": 1782625860000,
   "warnings": [],
   "alarms": [
    1782719520000
   ],
   "calls": [
    {
     "embeds": [
      {
       "title": "中山 2R 中央2R",
       "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
       "color": 13639744
      }
     ]
    }
   ],
   "notifySql": [
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
    "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040902\"]",
    "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040902\",\"failed\",\"<len=121 sha1=605da263b9>\",null,1782625860000,1782625860000]",
    "notifier.send",
    "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625860000,\"race:202606040902\"]",
    "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625861000\"]",
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
   ],
   "sqlCount": 49,
   "sqlSha1": "bbd8dc090d35edbe9693c5e272b9ea49cb1d5290",
   "planAfter": {
    "sendNow": null,
    "nextAtMs": null
   }
  },
  "rest": [],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "error_class": "http-404",
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625860000,
     "updated_at": 1782625860000,
     "payload": {
      "title": "中山 2R 中央2R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 2 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK\n2R 中央2R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625861000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "failed",
     "analysisId": null,
     "errorClass": "http-404",
     "updatedAt": 1782625800000
    },
    {
     "key": "race:202606040902",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625860000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000,
    1782625860000
   ],
   "sentCount": 2,
   "alarm": 1782719520000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782625800000,
    1782625860000,
    1782625860000,
    1782719520000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "Discord への通知に失敗しました(race:202606040901。分類: http-404。再送しません)",
    "発走前の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "failed(blocked): 赤の通知": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=229 sha1=e4caa01488>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "906a18587fee10687f4b5f06155eba509c5a95ea",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:pre_race:fetch:failed",
    "at": 1782625800000,
    "warnings": [
     "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782625800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 67,
    "sqlSha1": "c3983ec559318299ac7befd137de107fa32578d6",
    "planAfter": {
     "sendNow": {
      "key": "race:202606040901",
      "kind": "failed",
      "raceId": "202606040901"
     },
     "nextAtMs": 1782601201000
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
        "color": 13639744
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=121 sha1=258ec045c2>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 49,
    "sqlSha1": "9d796edb85ff19e045669d97f5eb8a2b9cd19610",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\nnetkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": [
    "発走前の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "昇格の時点の skipped(started): 赤の通知": {
  "woke": {
   "label": "202606040901:notify:send:ok",
   "at": 1782628500000,
   "warnings": [],
   "alarms": [
    1782722160000
   ],
   "calls": [
    {
     "embeds": [
      {
       "title": "中山 1R 中央1R",
       "description": "発走 15:35\n\n発走済みのため、自動の分析を実行できませんでした",
       "color": 13639744
      }
     ]
    }
   ],
   "notifySql": [
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
    "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
    "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"failed\",\"<len=92 sha1=e1373f8787>\",null,1782628500000,1782628500000]",
    "notifier.send",
    "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782628500000,\"race:202606040901\"]",
    "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782628501000\"]",
    "SELECT * FROM race_day_notify ORDER BY key | []",
    "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
   ],
   "sqlCount": 53,
   "sqlSha1": "ef7ce59933be7e35a33a0b1f8c65c3237af9fea7",
   "planAfter": {
    "sendNow": null,
    "nextAtMs": null
   }
  },
  "traces": [],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782628500000,
     "updated_at": 1782628500000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\n発走済みのため、自動の分析を実行できませんでした",
      "color": 13639744
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782628501000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "failed",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782628500000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782628500000
   ],
   "sentCount": 2,
   "alarm": 1782722160000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782722160000
   ],
   "allWarnings": []
  }
 },
 "昇格の時点の skipped(manual): 灰色の通知": {
  "traces": [
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 40563,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 事前分析OK"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=229 sha1=e4caa01488>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "906a18587fee10687f4b5f06155eba509c5a95ea",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "202606040901:notify:send:ok",
    "at": 1782625800000,
    "warnings": [],
    "alarms": [
     1782719460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "中山 1R 中央1R",
        "description": "発走 15:35\n\n手動の分析があるため、自動の分析は行いませんでした",
        "color": 9807270
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"race:202606040901\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"race:202606040901\",\"skipped-manual\",\"<len=92 sha1=e17d1c61ac>\",null,1782625800000,1782625800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782625800000,\"race:202606040901\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782625801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "4bd7283e7c1e8b64e3828287162dbb6cc95e327b",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "race:202606040901",
     "kind": "skipped-manual",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782625800000,
     "updated_at": 1782625800000,
     "payload": {
      "title": "中山 1R 中央1R",
      "description": "発走 15:35\n\n手動の分析があるため、自動の分析は行いませんでした",
      "color": 9807270
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 1 件(中央 1・地方 交流重賞 0)\n事前分析OK 1 / 失敗 0 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 40563,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析OK"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782625801000",
   "notifications": [
    {
     "key": "race:202606040901",
     "kind": "skipped-manual",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782625800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000,
    1782625800000
   ],
   "sentCount": 2,
   "alarm": 1782719460000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000,
    1782719460000
   ],
   "allWarnings": []
  }
 },
 "事前分析のまとめ(中央 2 レース + 地方の交流重賞。morning は失敗で終端)": {
  "traces": [
   {
    "label": "202606040901:morning:fetch:failed",
    "at": 1782601200000,
    "warnings": [
     "朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 51,
    "sqlSha1": "c06ddf01708eb3850dc61fc65ff61a4c8f0603ce",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782604800000
    }
   },
   {
    "label": "202606040902:morning:fetch:failed",
    "at": 1782601200000,
    "warnings": [
     "朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 51,
    "sqlSha1": "b4dad0aea7c9166d03fcc2bb68a3b91e8e5b75f2",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782604800000
    }
   },
   {
    "label": "202636062811:morning:fetch:failed",
    "at": 1782601200000,
    "warnings": [
     "朝の取得に失敗しました(202636062811。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "onWarn 朝の取得に失敗しました(202636062811。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 52,
    "sqlSha1": "b3cdaf0319c19f84b9202ff551efdc05c216d8ee",
    "planAfter": {
     "sendNow": {
      "key": "summary",
      "kind": "summary"
     },
     "nextAtMs": 0
    }
   },
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 0 / 失敗 3 / 未完了 0\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 事前分析失敗\n2R 中央2R 15:40 事前分析失敗"
         },
         {
          "name": "地方 交流重賞",
          "value": "水沢 11R 地方11R 20:10 事前分析失敗"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=268 sha1=1fbfa300a2>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "1af1cfd2156885b950b7601af03cf3912e257f56",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 3 件(中央 2・地方 交流重賞 1)\n事前分析OK 0 / 失敗 3 / 未完了 0\n発走の 45 分前に自動で分析します",
      "color": 13639744,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 事前分析失敗\n2R 中央2R 15:40 事前分析失敗"
       },
       {
        "name": "地方 交流重賞",
        "value": "水沢 11R 地方11R 20:10 事前分析失敗"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782601201000",
   "notifications": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000
   ],
   "sentCount": 1,
   "alarm": 1782625800000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782625800000
   ],
   "allWarnings": [
    "朝の取得に失敗しました(202606040901。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "朝の取得に失敗しました(202606040902。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています",
    "朝の取得に失敗しました(202636062811。試行 1 回): ゲートが取得を拒否しました(blocked): ブレーカーが開いています"
   ]
  }
 },
 "事前分析のまとめ(保険の時刻。未完了のまま)": {
  "traces": [
   {
    "label": "idle",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782604800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 46,
    "sqlSha1": "a591f607a0a11bba51b4a9948513f967853a2b47",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": 1782604800000
    }
   },
   {
    "label": "summary:notify:send:ok",
    "at": 1782604800000,
    "warnings": [],
    "alarms": [
     1782625800000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
        "color": 15113984,
        "fields": [
         {
          "name": "中山",
          "value": "1R 中央1R 15:35 未完了\n2R 中央2R 15:40 未完了"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧が空でした(0件)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=269 sha1=b6be91c18a>\",null,1782604800000,1782604800000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782604800000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782604801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "329277216d2a200c939e99dd57559f0690bb83b3",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782604800000,
     "updated_at": 1782604800000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 2 件(中央 2・地方 交流重賞 0)\n事前分析OK 0 / 失敗 0 / 未完了 2\n※ 未完了 2 件のまま送信しています\n発走の 45 分前に自動で分析します",
      "color": 15113984,
      "fields": [
       {
        "name": "中山",
        "value": "1R 中央1R 15:35 未完了\n2R 中央2R 15:40 未完了"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782604801000",
   "notifications": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782604800000
    }
   ],
   "sendTimes": [
    1782604800000
   ],
   "sentCount": 1,
   "alarm": 1782625800000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782604800000,
    1782625800000
   ],
   "allWarnings": []
  }
 },
 "全会場の一覧の取得に失敗した日のまとめ": {
  "traces": [
   {
    "label": "central:plan:list:failed",
    "at": 1782601200000,
    "warnings": [
     "事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 30,
    "sqlSha1": "b03d49604ff91cecb77486af9566141ef6acfeb1",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "nar:plan:list:failed",
    "at": 1782601200000,
    "warnings": [
     "事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"
    ],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 34,
    "sqlSha1": "3642900de1c33b6d55b0d99321367aca69461ad3",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "plan:plan:finalize:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782601200000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 43,
    "sqlSha1": "4511186560cbcf727ec570824b22aba0a19d1406",
    "planAfter": {
     "sendNow": {
      "key": "summary",
      "kind": "summary"
     },
     "nextAtMs": 0
    }
   },
   {
    "label": "summary:notify:send:ok",
    "at": 1782601200000,
    "warnings": [],
    "alarms": [
     1782694860000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析 2026/06/28(日) 開催分",
        "description": "対象 0 件(中央 0・地方 交流重賞 0)\n事前分析OK 0 / 失敗 0 / 未完了 0\n⚠ 中央の一覧を取得できませんでした(取得制限中)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
        "color": 13639744,
        "fields": [
         {
          "name": "中央",
          "value": "一覧を取得できませんでした(取得制限中)"
         },
         {
          "name": "地方 交流重賞",
          "value": "一覧を取得できませんでした(取得制限中)"
         }
        ]
       }
      ]
     }
    ],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"summary\"]",
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL) | [\"summary\",\"summary\",\"<len=295 sha1=a99074ffad>\",null,1782601200000,1782601200000]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782601200000,\"summary\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782601201000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 53,
    "sqlSha1": "14b7d25e8081df791052f46df4684036f7ea9931",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782601200000,
     "updated_at": 1782601200000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 0 件(中央 0・地方 交流重賞 0)\n事前分析OK 0 / 失敗 0 / 未完了 0\n⚠ 中央の一覧を取得できませんでした(取得制限中)\n⚠ 地方の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
      "color": 13639744,
      "fields": [
       {
        "name": "中央",
        "value": "一覧を取得できませんでした(取得制限中)"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧を取得できませんでした(取得制限中)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782601201000",
   "notifications": [
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782601200000
    }
   ],
   "sendTimes": [
    1782601200000
   ],
   "sentCount": 1,
   "alarm": 1782694860000,
   "allAlarms": [
    1782601200000,
    1782601200000,
    1782601200000,
    1782601200000,
    1782694860000
   ],
   "allWarnings": [
    "事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
    "事前分析の計画: nar の一覧を取得できませんでした(試行 1 回。理由: blocked)"
   ]
  }
 },
 "23 時の再実行の後も会場の失敗が残る: plan-failure の通知": {
  "traces": [
   {
    "label": "central:plan:list:failed",
    "at": 1782568800000,
    "warnings": [
     "事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)"
    ],
    "alarms": [
     1782568800000
    ],
    "calls": [],
    "notifySql": [
     "onWarn 事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 40,
    "sqlSha1": "659b69ec10895f48e5798a57535a3a50ec1842bb",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "plan:plan:finalize:ok",
    "at": 1782568800000,
    "warnings": [],
    "alarms": [
     1782568800000
    ],
    "calls": [],
    "notifySql": [
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 47,
    "sqlSha1": "cfda76b8357a919c2f173e983d98edfd4a8f92fb",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   },
   {
    "label": "plan-failure:notify:send:ok",
    "at": 1782568800000,
    "warnings": [],
    "alarms": [
     1782662460000
    ],
    "calls": [
     {
      "embeds": [
       {
        "title": "事前分析の失敗 2026/06/28(日)",
        "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/06/28(日)開催分)\n⚠ 中央の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
        "color": 13639744,
        "fields": []
       }
      ]
     }
    ],
    "notifySql": [
     "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING | [\"plan-failure\",\"plan-failure\",\"<len=205 sha1=8a623c7df9>\",null,1782568800000,1782568800000]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]",
     "SELECT * FROM race_day_notify WHERE key = ? | [\"plan-failure\"] ×2",
     "UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready' | [1782568800000,\"plan-failure\"]",
     "notifier.send",
     "UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending' | [\"sent\",null,1782568800000,\"plan-failure\"]",
     "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value | [\"notify_pace_until\",\"1782568801000\"]",
     "SELECT * FROM race_day_notify ORDER BY key | []",
     "SELECT value FROM race_day_meta WHERE key = ? | [\"notify_pace_until\"]"
    ],
    "sqlCount": 61,
    "sqlSha1": "ed2fa0e22beba45335779da99df933b33f17e9f0",
    "planAfter": {
     "sendNow": null,
     "nextAtMs": null
    }
   }
  ],
  "final": {
   "rows": [
    {
     "key": "plan-failure",
     "kind": "plan-failure",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782568800000,
     "updated_at": 1782568800000,
     "payload": {
      "title": "事前分析の失敗 2026/06/28(日)",
      "description": "【失敗】23 時の再実行後も、事前分析が完了していません(対象: 2026/06/28(日)開催分)\n⚠ 中央の一覧を取得できませんでした(取得制限中)\n一覧を取得できなかった会場のレースは、自動では分析されません。画面から手動で実行してください。",
      "color": 13639744,
      "fields": []
     }
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "error_class": null,
     "analysis_id": null,
     "created_at": 1782561600000,
     "updated_at": 1782561600000,
     "payload": {
      "title": "事前分析 2026/06/28(日) 開催分",
      "description": "対象 0 件(中央 0・地方 交流重賞 0)\n事前分析OK 0 / 失敗 0 / 未完了 0\n⚠ 中央の一覧を取得できませんでした(取得制限中)\n発走の 45 分前に自動で分析します",
      "color": 13639744,
      "fields": [
       {
        "name": "中央",
        "value": "一覧を取得できませんでした(取得制限中)"
       },
       {
        "name": "地方 交流重賞",
        "value": "一覧が空でした(0件)"
       }
      ]
     }
    }
   ],
   "paceUntil": "1782568801000",
   "notifications": [
    {
     "key": "plan-failure",
     "kind": "plan-failure",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782568800000
    },
    {
     "key": "summary",
     "kind": "summary",
     "state": "sent",
     "analysisId": null,
     "errorClass": null,
     "updatedAt": 1782561600000
    }
   ],
   "sendTimes": [
    1782561600000,
    1782568800000
   ],
   "sentCount": 2,
   "alarm": 1782662460000,
   "allAlarms": [
    1782561600000,
    1782561600000,
    1782561600000,
    1782561600000,
    1782655260000,
    1782568800000,
    1782568800000,
    1782568800000,
    1782662460000
   ],
   "allWarnings": [
    "事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)",
    "事前分析の計画: central の一覧を取得できませんでした(試行 1 回。理由: blocked)"
   ]
  }
 }
};
