import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { MAX_SAME_DAY_RESULT_ROWS, SAME_DAY_RESULT_DELAY_MS } from "../src/race-day-result";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #277: 当日に手動で分析したレース(発走は後)の結果を待たずに日報が作られる不具合。
 * 手動の発走前の分析(`pre_race`)でも、開催日が今日(JST)なら、自動の計画のレースと同じく結果の取り込みの行(発走 + 15 分が最初の試行)を積み、
 * 日報(`isDayQuiet`)がそのレースの結果を待つようにする。ゲートは偽(一覧・結果ページ・出馬表などはフィクスチャ)、保存先は偽、ストレージは `node:sqlite`。
 * 手動の対象は 202603020211(出馬表の発走時刻 15:45。フィクスチャ)。自動の計画のレースは中山の 202606040901(10:00 発走)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20260628";
const NEXT_DATE = "20260629";
const MIN = 60_000;
const jst = (time: string, date = "2026-06-28"): number => Date.parse(`${date}T${time}:00+09:00`);
const JST_0900 = jst("09:00");
/** 手動の分析の対象(出馬表のフィクスチャの発走時刻は 15:45)。 */
const MANUAL = "202603020211";
const MANUAL_START = jst("15:45");

/** 16 頭の確定した結果ページ(中央の実フィクスチャ。MANUAL の実物)。単勝の払戻がある。 */
const FULL = fixture("result_202603020211.html");
const EMPTY_HTML = "<html><body></body></html>";
/** 結果の行が 0 件のページ(未確定の模擬)。 */
const PRESALE = fixture("nar_result_presale_202642071612.html");

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
const rid = (n: number): string => `2026060409${String(n).padStart(2, "0")}`;
const central = (n: number, time: string | null): ListRow => ({ raceId: rid(n), venue: "中山", raceNumber: n, name: `中央${n}R`, time });

// ---- 偽のゲート ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "拒否(本文は状態に入れない)SECRET-MESSAGE" });

const RESULT_URL = /\/race\/result\.html\?race_id=(\d{12})$/;

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** 結果ページの取得だけを数える。 */
  resultUrls(): string[];
  /** 結果ページのレースごとの応答(なければ全頭のページ)。 */
  readonly pages: Map<string, string>;
  /** 出馬表などの分析用のページを返すか(false のあいだは、自動の計画のレースの朝・発走前の取得をすぐ失敗させる)。 */
  analysis: boolean;
  /** 出馬表の本文の加工(発走時刻の欠落などの模擬)。 */
  shutuba: (html: string) => string;
  centralList: string;
}
function fakeGate(centralList: string): FakeGate {
  const gate: FakeGate = {
    urls: [],
    pages: new Map(),
    analysis: false,
    shutuba: (html) => html,
    centralList,
    resultUrls: () => gate.urls.filter((u) => RESULT_URL.test(u)),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return okPage(gate.centralList);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return okPage(EMPTY_HTML);
      const m = RESULT_URL.exec(url);
      if (m !== null) return okPage(gate.pages.get(m[1]!) ?? FULL);
      if (!gate.analysis) return blocked();
      try {
        const body = fixtureForUrl(url);
        return okPage(url.includes("shutuba.html") ? gate.shutuba(body) : body);
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
  /** Issue #270 で結果ストアの型に加わった保存(過去分の補完)。このファイルの主題ではないので何もしない。 */
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
  readonly reports: string[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { rows?: readonly ListRow[]; start?: number } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: options.start ?? JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const reports: string[] = [];
  const gate = fakeGate(listHtml(options.rows ?? []));
  const store = fakeStore();
  const sink = recordingSink();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    resultStore: store,
    requestReport: async (kaisaiDate) => {
      reports.push(kaisaiDate);
    },
  });
  return { core, sql, gate, store, sink, clock, alarm, warnings, reports };
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
/** 計画を依頼して、確定・朝の取得(すぐ失敗する)・今 (09:00) 期限の昇格まで進める。 */
async function planned(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true });
  await driveUntil(h, JST_0900);
  expect(h.core.getPlanProgress().stage).toBe("done"); // 前提: 確定した
}
/** 時刻を `at` にして分析用のページを返すようにし、手動の発走前の分析を予約して、`until` まで進める。 */
async function manualPreRace(h: Harness, at: number, until: number, raceId = MANUAL): Promise<void> {
  h.clock.now = at;
  h.gate.analysis = true;
  await h.core.schedule({ raceId, kaisaiDate: DATE, mode: "pre_race" });
  await driveUntil(h, until);
}

interface ResultRow {
  race_id: string;
  state: string;
  next_try_at: number;
  requested_on: string;
  attempts: number;
}
const rows = (h: Harness): ResultRow[] =>
  h.sql.exec("SELECT race_id, state, next_try_at, requested_on, attempts FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const rowOf = (h: Harness, raceId: string): ResultRow | undefined => rows(h).find((r) => r.race_id === raceId);
const taskStatus = (h: Harness, raceId: string, mode: string): string | undefined =>
  (h.sql.exec("SELECT status FROM race_day_tasks WHERE race_id = ? AND mode = ?", raceId, mode).toArray() as { status: string }[])[0]?.status;

// ---------------------------------------------------------------------------

describe("手動の発走前の分析(当日)が積む結果の取り込みの行(Issue #277)", () => {
  it("再現: 自動の計画のレースの結果が揃っても、手動で分析した当日のレース(発走 15:45)の結果が取り込まれるまで日報を依頼しない。取り込まれた後に 1 回だけ依頼する", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await planned(h);
    await driveUntil(h, jst("10:04")); // 自動のレース(10:00 発走)の結果の行は 10:15 まで待ち
    expect(rows(h).map((r) => [r.race_id, r.state])).toEqual([[rid(1), "queued"]]); // 前提: 自動のレースの結果はまだ
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 手動の分析は終わっている
    expect(h.sink.saved.map((r) => r.raceId)).toEqual([MANUAL]); // 前提: 分析は保存された
    await driveUntil(h, jst("10:20")); // 自動のレースの結果が取り込まれる(10:15)
    expect(rowOf(h, rid(1))!.state).toBe("imported"); // 前提: 自動のレースの結果は揃った
    expect(h.reports).toEqual([]); // 手動のレースの結果を待つ(不具合の修正前は、ここで [DATE] になる)
    await driveUntil(h, jst("16:10")); // 手動のレースの結果が取り込まれる(15:45 + 15 分)
    expect(h.store.saved).toContain(MANUAL);
    expect(rowOf(h, MANUAL)!.state).toBe("imported");
    expect(h.reports).toEqual([DATE]);
  });

  it("行は発走 + 15 分を最初の試行とし、開催日を依頼の日にする(自動の計画の行と同じ)。手動のタスクの完了より前(取得ステップ)に積まれる", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await planned(h);
    h.clock.now = jst("10:05");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: MANUAL, kaisaiDate: DATE, mode: "pre_race" });
    expect(rowOf(h, MANUAL)).toBeUndefined(); // 前提: 予約しただけでは積まない(発走時刻は出馬表を取るまで分からない)
    await tick(h); // 取得ステップ
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("fetched"); // 前提: 取得だけが済んだ(計算は未了 = タスクはまだ未了)
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "queued", requested_on: DATE, attempts: 0, next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS });
  });

  it("自動の計画にもあるレースを手動で分析しても、行は増えず、既存の行(最初の試行の時刻・状態)を変えない。取り込み済みの行を積み直さない", async () => {
    const h = harness({ rows: [{ raceId: MANUAL, venue: "福島", raceNumber: 11, name: "福島11R", time: "15:45" }] });
    await planned(h);
    const before = rows(h);
    expect(before).toHaveLength(1); // 前提: 自動の行がある
    expect(before[0]).toMatchObject({ race_id: MANUAL, state: "queued", next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS });
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 手動の分析が走った
    expect(rows(h)).toEqual(before);
    await driveUntil(h, jst("16:10"));
    expect(rowOf(h, MANUAL)!.state).toBe("imported"); // 前提: 取り込み済み
    const fetchesBefore = h.gate.resultUrls().length;
    await manualPreRace(h, jst("16:30"), jst("16:40")); // 分析し直し
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done");
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "imported", attempts: rowOf(h, MANUAL)!.attempts });
    expect(h.gate.resultUrls()).toHaveLength(fetchesBefore); // 結果を取り直さない
    expect(rows(h)).toHaveLength(1);
  });

  it("日報の依頼の後に手動で分析したレース: 日報は作り直さない(依頼は 1 回のまま)が、結果の行は積まれて取り込まれる", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await planned(h);
    await driveUntil(h, jst("10:20"));
    expect(h.reports).toEqual([DATE]); // 前提: 日報は依頼済み
    await manualPreRace(h, jst("10:30"), jst("10:40"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 手動の分析は終わっている
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "queued", next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS }); // 行は積まれる
    await driveUntil(h, jst("16:10"));
    expect(h.store.saved).toContain(MANUAL); // 結果は取り込まれる(検証画面などに反映される)
    expect(h.reports).toEqual([DATE]); // 日報は作り直さない(管理者のボタンだけ。#268)
  });

  it("待ちは有限: 手動のレースの結果が出ないままでも、当日の取り込みの上限(10 回)で諦めて、そのあとで日報を依頼する", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    h.gate.pages.set(MANUAL, PRESALE); // 結果が出ない(未確定の模擬)
    await planned(h);
    await driveUntil(h, jst("10:04"));
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    await driveUntil(h, jst("10:20"));
    expect(rowOf(h, rid(1))!.state).toBe("imported"); // 前提: 自動のレースは揃った
    expect(h.reports).toEqual([]); // 前提: 手動のレースの結果を待っている
    await driveUntil(h, jst("23:00"));
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "gave_up", attempts: 10 });
    expect(h.store.saved).not.toContain(MANUAL);
    expect(h.reports).toEqual([DATE]);
  });

  it("過去の日(開催日 < 今日)の手動の分析では、行を積まない(従来どおり)。結果の取得にも出ない", async () => {
    const h = harness({ start: jst("09:00", "2026-06-29") });
    expect(NEXT_DATE > DATE).toBe(true); // 前提: 今日(06-29)は開催日(06-28)より後
    await manualPreRace(h, jst("09:00", "2026-06-29"), jst("09:30", "2026-06-29"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は走った
    expect(rows(h)).toEqual([]);
    expect(h.gate.resultUrls()).toEqual([]);
  });

  it("前日の夜に手動で分析したレース(計画外)も同じ: 当日に自動の計画のレースの結果が揃っても、そのレースの結果が取り込まれるまで日報を依頼しない", async () => {
    const h = harness({ rows: [central(1, "10:00")], start: jst("20:00", "2026-06-27") });
    await manualPreRace(h, jst("20:00", "2026-06-27"), jst("20:10", "2026-06-27"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 前日の夜に分析は終わっている
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "queued", requested_on: DATE, next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS }); // 未来の queued
    h.gate.analysis = false; // 以降、自動のレースの取得はすぐ失敗させる
    h.clock.now = jst("21:00", "2026-06-27");
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true }); // 前日の夜の計画の依頼(cron の 21 時)
    await driveUntil(h, jst("10:20"));
    expect(h.core.getPlanProgress().stage).toBe("done"); // 前提: 計画は確定している
    expect(rows(h).map((r) => [r.race_id, r.state])).toEqual([
      [MANUAL, "queued"],
      [rid(1), "imported"],
    ]); // 前提: 自動のレースの結果は揃い、手動のレースの結果は待ち(確定が既存の行を巻き戻していない)
    expect(rowOf(h, MANUAL)!.next_try_at).toBe(MANUAL_START + SAME_DAY_RESULT_DELAY_MS);
    expect(h.reports).toEqual([]);
    await driveUntil(h, jst("16:10"));
    expect(h.store.saved).toContain(MANUAL);
    expect(h.reports).toEqual([DATE]);
  });

  it("開催日が何日も先(1 週間後のレース)の手動の分析でも、行は未来の queued として積まれるだけ。アラームは永続し、その日の発走 + 15 分に取り込まれる", async () => {
    const h = harness({ start: jst("20:00", "2026-06-21") });
    await manualPreRace(h, jst("20:00", "2026-06-21"), jst("20:10", "2026-06-21"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は終わっている
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "queued", requested_on: DATE, attempts: 0, next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS });
    expect(h.gate.resultUrls()).toEqual([]); // 前提: 今は結果を取りに行かない
    expect(h.alarm.at).not.toBeNull();
    expect(h.alarm.at!).toBeLessThanOrEqual(MANUAL_START + SAME_DAY_RESULT_DELAY_MS); // 掃除専用などの早い起床があっても、結果の時刻より後には張らない
    await driveUntil(h, jst("16:10")); // 掃除専用の起床を挟んで、結果の時刻まで進む
    expect(h.gate.resultUrls()).toHaveLength(1);
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "imported" });
    expect(h.store.saved).toEqual([MANUAL]);
  });

  it("計画が確定していない日でも行を積み、結果を取り込む。ただしその日の DO は日報を依頼しない(補完の cron の経路のまま)", async () => {
    const h = harness();
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は走った
    expect(h.core.getPlanProgress().stage).toBe("none"); // 前提: 計画は依頼されていない
    expect(rowOf(h, MANUAL)).toMatchObject({ state: "queued", next_try_at: MANUAL_START + SAME_DAY_RESULT_DELAY_MS });
    await driveUntil(h, jst("16:10"));
    expect(rowOf(h, MANUAL)!.state).toBe("imported");
    expect(h.reports).toEqual([]);
  });

  it("計画は確定したが自動の対象が 0 件の日(手動の分析だけの日)は、手動のレースの結果が揃った時点で、その日の DO が日報を依頼する", async () => {
    const h = harness({ rows: [] });
    await planned(h);
    expect(rows(h)).toEqual([]); // 前提: 自動の行は無い
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は走った
    expect(h.reports).toEqual([]); // 前提: 結果が揃うまでは依頼しない
    await driveUntil(h, jst("16:10"));
    expect(rowOf(h, MANUAL)!.state).toBe("imported");
    expect(h.reports).toEqual([DATE]);
  });

  it("朝(morning)の手動の分析では、行を積まない(朝の prior は保存されず、日報の対象外)", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await planned(h);
    h.clock.now = jst("10:05");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: MANUAL, kaisaiDate: DATE, mode: "morning" });
    await driveUntil(h, jst("10:10"));
    expect(taskStatus(h, MANUAL, "morning")).toBe("done"); // 前提: 朝の分析は終わっている
    expect(rowOf(h, MANUAL)).toBeUndefined();
  });

  it("出馬表に発走時刻が無いときは、行を積まない(分析は続ける)。1 桁の時間(9:50)は 2 桁にそろえて読む", async () => {
    const none = harness({ rows: [central(1, "10:00")] });
    none.gate.shutuba = (html) => html.replace("15:45発走", "発走");
    await planned(none);
    await manualPreRace(none, jst("10:05"), jst("10:10"));
    expect(taskStatus(none, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は走った
    expect(rowOf(none, MANUAL)).toBeUndefined();

    const short = harness({ rows: [central(1, "10:00")] });
    short.gate.shutuba = (html) => html.replace("15:45発走", "9:50発走");
    await planned(short);
    await manualPreRace(short, jst("10:05"), jst("10:10"));
    expect(taskStatus(short, MANUAL, "pre_race")).toBe("done");
    expect(rowOf(short, MANUAL)!.next_try_at).toBe(jst("09:50") + SAME_DAY_RESULT_DELAY_MS);
  });

  it(`当日の行が上限(${MAX_SAME_DAY_RESULT_ROWS})に達しているときは積まない(分析は続ける。翌日以降の cron の依頼のための枠を残す)`, async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await planned(h);
    for (let i = 0; i < MAX_SAME_DAY_RESULT_ROWS - 1; i += 1) {
      h.sql.exec(
        "INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'imported', 1, 0, 0, ?, 'imported', 0, 0)",
        `20260101${String(i).padStart(4, "0")}`,
        DATE,
      );
    }
    expect(rows(h)).toHaveLength(MAX_SAME_DAY_RESULT_ROWS); // 前提: 自動の 1 行 + 埋めた行 = 上限ちょうど
    await manualPreRace(h, jst("10:05"), jst("10:10"));
    expect(taskStatus(h, MANUAL, "pre_race")).toBe("done"); // 前提: 分析は走った
    expect(rowOf(h, MANUAL)).toBeUndefined();
    expect(rows(h)).toHaveLength(MAX_SAME_DAY_RESULT_ROWS);
  });
});
