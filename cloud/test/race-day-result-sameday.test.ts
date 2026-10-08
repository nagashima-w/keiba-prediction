import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";

import { parseRaceFieldSize, parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import type { RaceComboPayoutsSaveInput, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { RaceResultDetail } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import {
  MAX_SAME_DAY_ATTEMPTS,
  MAX_SAME_DAY_RESULT_ROWS,
  MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS,
  SAME_DAY_RESULT_DELAY_MS,
  SAME_DAY_RETRY_DELAY_MS,
} from "../src/race-day-result";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #209(#182 から切り出し): 当日中の結果の取り込み(AC-C1〜C3・C6)。計画の確定時に結果の行を積み(発走 + 15 分が最初の試行)、
 * 全頭の着順がそろったページだけを保存し(結果ページ自身の「N頭」と比べる)、今日の DO(期限を待つ planned の行が残る)でも動く。
 * ゲートは偽(一覧と結果ページはフィクスチャ)、保存先は偽(記録つき)、ストレージは `node:sqlite`(本物の SQLite)。実 netkeiba・実 D1 には触れない。
 * 当日傾向を発走前の分析に入れる配線(AC-C4)は `race-day-sameday-trend.test.ts`。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20260927";
const NEXT_DATE = "20260928";
const MIN = 60_000;
const jst = (time: string, date = "2026-09-27"): number => Date.parse(`${date}T${time}:00+09:00`);
const JST_0900 = jst("09:00");

/** 16 頭の確定した結果ページ(中央の実フィクスチャ)。単勝の払戻がある。 */
const FULL = fixture("result_202603020211.html");
const EMPTY_HTML = "<html><body></body></html>";
/** 結果の行が 0 件のページ(地方の発売前の実フィクスチャ)。未確定の模擬。 */
const PRESALE = fixture("nar_result_presale_202642071612.html");

// ---- 結果ページの加工(実物の部分ページのフィクスチャが届くまでの、確定フィクスチャから行を削る合成)----

/** 結果テーブル(#All_Result_Table)の行を先頭 n 行だけにする。払戻のテーブルと「N頭」は残す(払戻が先に出て、上位の数頭だけの着順が出ている状態の模擬)。 */
function withTopRows(html: string, n: number): string {
  const $ = cheerio.load(html);
  $("#All_Result_Table tbody > tr").slice(n).remove();
  return $.html();
}
/** 頭数の span(`<span>16頭</span>`)を消す(「N頭」が取れないページ)。 */
function withoutFieldSize(html: string): string {
  const $ = cheerio.load(html);
  $(".RaceData02 span")
    .filter((_, el) => /頭$/.test($(el).text().trim()))
    .remove();
  return $.html();
}
function withFieldSize(html: string, n: number): string {
  const $ = cheerio.load(html);
  $(".RaceData02 span")
    .filter((_, el) => /頭$/.test($(el).text().trim()))
    .text(`${n}頭`);
  return $.html();
}
/** 払戻のテーブルを丸ごと消した HTML(審議中の暫定の着順を模す)。 */
function withoutPayoutTables(html: string): string {
  return html.replace(/<table[^>]*class="[^"]*Payout_Detail_Table[^"]*"[\s\S]*?<\/table>/g, "");
}

// ---- 一覧の HTML(plan のテストと同じ最小の写し)----

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
const status500 = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
const refused = (reason: "queue-full" | "blocked", blockedUntil?: number): GateResult => ({
  kind: "refused",
  reason,
  message: "拒否(本文は状態に入れない)SECRET-MESSAGE",
  ...(blockedUntil === undefined ? {} : { blockedUntil }),
});
const blocked = (): GateResult => refused("blocked");

const RESULT_URL = /\/race\/result\.html\?race_id=(\d{12})$/;

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** 結果ページの取得だけを数える。 */
  resultUrls(): string[];
  /** 結果ページの応答の上書き(先頭から 1 回ずつ消費)。空になれば `pages` かなければ全頭のページ。 */
  readonly script: GateResult[];
  readonly pages: Map<string, string>;
  centralList: string;
}
function fakeGate(centralList: string): FakeGate {
  const gate: FakeGate = {
    urls: [],
    script: [],
    pages: new Map(),
    centralList,
    resultUrls: () => gate.urls.filter((u) => RESULT_URL.test(u)),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return okPage(gate.centralList);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return okPage(EMPTY_HTML);
      const m = RESULT_URL.exec(url);
      if (m !== null) {
        return gate.script.shift() ?? okPage(gate.pages.get(m[1]!) ?? FULL);
      }
      return blocked(); // 朝の取得・発走前の取得は、このテストの主題ではないので、すぐ(再試行なしの)失敗にする
    },
  };
  return gate;
}

interface SaveCall {
  readonly raceId: string;
  readonly entries: readonly RaceResultEntry[];
  readonly courseType: CourseType | null | undefined;
}
interface FakeStore {
  readonly calls: SaveCall[];
  saveResult(raceId: string, entries: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    async saveResult(raceId, entries, courseType) {
      store.calls.push({ raceId, entries, courseType });
    },
    async getRaceResultDetails() {
      return new Map();
    },
  };
  return store;
}

const noSink: AnalysisSink = {
  save: async () => ({ id: 1, detail: "stored" }),
  findByAnalyzedAt: async () => null,
  findRecentByRace: async () => [],
  countChildren: async () => ({ horses: 0, bets: 0 }),
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly store: FakeStore;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { rows?: readonly ListRow[]; store?: boolean; offset?: number; start?: number } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: options.start ?? JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = fakeGate(listHtml(options.rows ?? []));
  const store = fakeStore();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink: noSink,
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: options.offset ?? DEFAULT_CLOUD_SETTINGS.preRaceOffsetMinutes }),
    ...(options.store === false ? {} : { resultStore: store }),
  });
  return { core, sql, gate, store, clock, alarm, warnings };
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

interface ResultRow {
  race_id: string;
  state: string;
  attempts: number;
  deferrals: number;
  next_try_at: number;
  requested_on: string;
  last_class: string | null;
}
const rows = (h: Harness): ResultRow[] =>
  h.sql.exec("SELECT race_id, state, attempts, deferrals, next_try_at, requested_on, last_class FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const rowOf = (h: Harness, raceId: string): ResultRow => {
  const r = rows(h).find((x) => x.race_id === raceId);
  if (r === undefined) throw new Error(`行が無い: ${raceId}`);
  return r;
};
const planRowStates = (h: Harness): Record<string, string> =>
  Object.fromEntries((h.sql.exec("SELECT race_id, state FROM race_day_plan").toArray() as { race_id: string; state: string }[]).map((r) => [r.race_id, r.state]));
const dumpAllTables = (h: Harness): string => {
  const tables = h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[];
  return tables.map((t) => JSON.stringify(h.sql.exec(`SELECT * FROM ${t.name}`).toArray())).join("\n");
};
const gaveUpWarnings = (h: Harness): string[] => h.warnings.filter((w) => w.includes("結果の取り込みを諦めました"));

// ---------------------------------------------------------------------------

describe("定数(テストで固定する)", () => {
  it("最初の試行は発走 + 15 分・再試行は 5 分おき・最大 10 回(= 発走 + 60 分まで)・「N頭」が取れないときは 2 回・当日に積む行は 100 まで", () => {
    expect(SAME_DAY_RESULT_DELAY_MS).toBe(15 * MIN);
    expect(SAME_DAY_RETRY_DELAY_MS).toBe(5 * MIN);
    expect(MAX_SAME_DAY_ATTEMPTS).toBe(10);
    expect(MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS).toBe(2);
    expect(MAX_SAME_DAY_RESULT_ROWS).toBe(100);
    // 10 回の最後の試行は、最初の試行の 45 分後 = 発走 + 60 分
    expect(SAME_DAY_RESULT_DELAY_MS + (MAX_SAME_DAY_ATTEMPTS - 1) * SAME_DAY_RETRY_DELAY_MS).toBe(60 * MIN);
  });
});

describe("前提: 部分ページの合成", () => {
  it("上位 3 頭だけのページは、結果の行が 3 件・単勝の払戻がある・「N頭」は 16 のまま(= 払戻が先に出て全頭の着順が遅れる状態の模擬)", () => {
    const partial = withTopRows(FULL, 3);
    const parsed = parseRaceResult(partial);
    expect(parsed.horses).toHaveLength(3);
    expect(parsed.winPayouts.length).toBeGreaterThan(0);
    expect(parseRaceFieldSize(partial)).toBe(16);
    expect(parseRaceResult(FULL).horses).toHaveLength(16);
    expect(parseRaceFieldSize(withoutFieldSize(FULL))).toBeNull();
    expect(parseRaceFieldSize(withFieldSize(FULL, 14))).toBe(14);
  });
});

describe("AC-C1: 計画の確定時に、発走時刻のある行ごとに、結果の行を積む", () => {
  it("planned・skip(発走済み)の行に、発走 + 15 分を最初の試行とする queued の行を積む。requested_on は開催日。発走時刻の無い行は積まない", async () => {
    const h = harness({ rows: [central(1, "10:00"), central(2, "10:30"), central(3, "11:00"), central(4, null), central(5, "08:30")] });
    await planned(h);
    const plan = planRowStates(h);
    expect(plan[rid(1)]).toBe("planned"); // 前提: planned の行がある
    expect(plan[rid(5)]).toBe("skipped"); // 前提: 発走済みの skip の行がある
    expect(rows(h).map((r) => r.race_id)).toEqual([rid(1), rid(2), rid(3), rid(5)]); // 時刻の無い 4R は積まない
    expect(rows(h).map((r) => r.next_try_at)).toEqual([jst("10:15"), jst("10:45"), jst("11:15"), jst("08:45")]);
    // 期限がまだ来ていない 3 行は queued のまま。発走済み(08:30。期限 08:45 は過去)の 5R は、確定の直後に取り込まれる(計画の確定が遅れた日の動き)
    for (const r of rows(h).filter((x) => x.race_id !== rid(5))) {
      expect(r).toMatchObject({ state: "queued", attempts: 0, deferrals: 0, requested_on: DATE, last_class: null });
    }
    expect(rowOf(h, rid(5))).toMatchObject({ state: "imported", attempts: 1, requested_on: DATE });
    expect(h.gate.resultUrls()).toEqual([`https://race.netkeiba.com/race/result.html?race_id=${rid(5)}`]); // 取ったのは、期限が過ぎた 5R だけ
  });

  it("期限を待つ planned の行が 1 つも無い日(全レースが発走済み)は、何も積まない。結果ストアが無い構成も何も積まない", async () => {
    const allStarted = harness({ rows: [central(1, "08:00"), central(2, "08:30")] });
    await planned(allStarted);
    expect(Object.values(planRowStates(allStarted))).toEqual(["skipped", "skipped"]); // 前提
    expect(rows(allStarted)).toEqual([]);
    const noStore = harness({ rows: [central(1, "10:00"), central(2, "10:30")], store: false });
    await planned(noStore);
    expect(Object.values(planRowStates(noStore))).toContain("planned"); // 前提
    expect(rows(noStore)).toEqual([]);
  });

  it("当日に積む行は 100 まで(発走の早い順)。確定は落ちない", async () => {
    const many: ListRow[] = Array.from({ length: 110 }, (_, i) => ({
      raceId: `2026${String(1 + Math.floor(i / 12)).padStart(2, "0")}0409${String((i % 12) + 1).padStart(2, "0")}`,
      venue: `場${Math.floor(i / 12)}`,
      raceNumber: (i % 12) + 1,
      name: `R${i}`,
      time: `${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    }));
    const h = harness({ rows: many });
    await planned(h);
    expect(h.core.getPlanProgress().rows).toHaveLength(110); // 前提: 計画の行は 110 件
    expect(rows(h)).toHaveLength(MAX_SAME_DAY_RESULT_ROWS);
    const taken = new Set(rows(h).map((r) => r.race_id));
    expect(taken.has(many[0]!.raceId)).toBe(true); // 最も早い発走は入る
    expect(taken.has(many[109]!.raceId)).toBe(false); // 最も遅い発走は入らない
  });

  it("冪等: 確定をやり直しても(確定の印が無い状態で再実行)、既にある行を作り直さない(取り込み済みのまま)", async () => {
    const h = harness({ rows: [central(1, "10:00"), central(2, "10:30")] });
    await planned(h);
    h.sql.exec("UPDATE race_day_result SET state = 'imported', attempts = 1, last_class = 'imported' WHERE race_id = ?", rid(1));
    const before = rows(h);
    expect(before.map((r) => [r.race_id, r.state])).toEqual([[rid(1), "imported"], [rid(2), "queued"]]); // 前提: 行が実在し、片方は取り込み済みに書き換わっている
    h.sql.exec("DELETE FROM race_day_meta WHERE key = 'plan_finalized_at'");
    h.alarm.at = h.clock.now;
    await tick(h); // 確定のやり直し
    expect(h.core.getPlanProgress().stage).toBe("done");
    expect(rows(h)).toEqual(before);
  });

  it("GET /api/plan の result_import(getResultImportProgress)に当日の行も出る(AC-C6。形は #208 のまま)", async () => {
    const h = harness({ rows: [central(1, "10:00"), central(2, "10:30")] });
    await planned(h);
    const progress = h.core.getResultImportProgress();
    expect(progress).toMatchObject({ total: 2, queued: 2, imported: 0, gaveUp: 0 });
    expect(progress.races[0]).toEqual({
      raceId: rid(1),
      state: "queued",
      attempts: 0,
      deferrals: 0,
      requestedOn: DATE,
      nextTryAt: jst("10:15"),
      lastClass: null,
      updatedAt: expect.any(Number),
    });
  });
});

describe("AC-C2: 全頭の着順がそろってから保存する(当日の行だけ)", () => {
  async function toFirstAttempt(h: Harness): Promise<void> {
    await planned(h);
    await driveUntil(h, jst("10:14")); // 発走前の取得・昇格まで
    expect(h.gate.resultUrls()).toEqual([]); // 前提: まだ結果は取っていない
    expect(h.alarm.at).toBe(jst("10:15"));
  }

  it("全頭のページは、最初の試行(発走 + 15 分)で保存される", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(h.store.calls).toHaveLength(1);
    expect(h.store.calls[0]!.entries).toHaveLength(16);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "imported", attempts: 1, last_class: "imported" });
  });

  it("上位 3 頭だけのページ(払戻あり・N頭 = 16)は保存せず、分類 incomplete・5 分後に再試行。次に全頭がそろえば保存する", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.script.push(okPage(withTopRows(FULL, 3)));
    expect(await tick(h)).toBe(`${rid(1)}:result:import:retry`);
    expect(h.store.calls).toEqual([]);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "queued", attempts: 1, last_class: "incomplete", next_try_at: jst("10:20") });
    expect(h.alarm.at).toBe(jst("10:20"));
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`); // 2 回目は全頭
    expect(h.store.calls).toHaveLength(1);
    expect(h.store.calls[0]!.entries).toHaveLength(16);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "imported", attempts: 2 });
  });

  it("15 頭では足りない(N頭 = 16 に対して 15 行)。保存せず incomplete で再試行する", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), withTopRows(FULL, 15));
    expect(parseRaceResult(h.gate.pages.get(rid(1))!).horses).toHaveLength(15); // 前提
    expect(await tick(h)).toBe(`${rid(1)}:result:import:retry`);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "queued", last_class: "incomplete" });
    expect(h.store.calls).toEqual([]);
  });

  it("結果の行数 ≥ N頭 なら保存する(N頭 が行数より小さいとき = 取消・除外が N頭 に数えられない場合も、判定が止まらない)", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), withFieldSize(FULL, 14)); // 16 行 ≥ 14
    expect(parseRaceFieldSize(h.gate.pages.get(rid(1))!)).toBe(14); // 前提
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(h.store.calls[0]!.entries).toHaveLength(16);
  });

  it("着順が非数値の行(中止など)も 1 行として数える: 16 行のうち 1 行が中止でも保存され、その馬の着順は null", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), FULL.replace('<div class="Rank">16</div>', '<div class="Rank">中</div>'));
    const parsed = parseRaceResult(h.gate.pages.get(rid(1))!);
    expect(parsed.horses).toHaveLength(16); // 前提
    expect(parsed.horses.filter((x) => x.finishPosition === null || x.finishPosition.kind !== "順位")).toHaveLength(1); // 前提: 非数値が 1 行ある
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(h.store.calls[0]!.entries).toHaveLength(16);
    expect(h.store.calls[0]!.entries.filter((e) => e.finishPosition === null)).toHaveLength(1);
  });

  it("10 回(発走 + 15, 20, …, 60 分)試して全頭がそろわなければ諦める(gave_up・分類 incomplete)。保存は 0 回、警告は 1 件(分類と回数だけ)", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), withTopRows(FULL, 3));
    const times: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < MAX_SAME_DAY_ATTEMPTS; i += 1) {
      times.push(h.alarm.at!);
      labels.push(await tick(h));
    }
    expect(times).toEqual(Array.from({ length: 10 }, (_, i) => jst("10:15") + i * 5 * MIN));
    expect(times[9]).toBe(jst("11:00"));
    expect(labels.slice(0, 9).every((l) => l.endsWith(":retry"))).toBe(true);
    expect(labels[9]).toBe(`${rid(1)}:result:import:failed`);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "gave_up", attempts: 10, last_class: "incomplete" });
    expect(h.store.calls).toEqual([]);
    expect(h.gate.resultUrls()).toHaveLength(10);
    expect(gaveUpWarnings(h)).toHaveLength(1);
    expect(gaveUpWarnings(h)[0]).toContain("incomplete");
    expect(gaveUpWarnings(h)[0]).not.toContain("SECRET");
    // 諦めたあとは、結果のためのアラームも取得も無い
    const urlsBefore = h.gate.resultUrls().length;
    await driveUntil(h, jst("23:00"));
    expect(h.gate.resultUrls()).toHaveLength(urlsBefore);
  });

  it("「N頭」が取れないページ(払戻・着順はある)は、2 回試して諦める(判定できないので保存しない)。全行が 10 回ずつ無駄に再試行する事態を避ける", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), withoutFieldSize(FULL));
    expect(parseRaceResult(h.gate.pages.get(rid(1))!).horses).toHaveLength(16); // 前提: 着順は全頭ある(N頭 だけが無い)
    expect(await tick(h)).toBe(`${rid(1)}:result:import:retry`);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "queued", attempts: 1, last_class: "incomplete" });
    expect(await tick(h)).toBe(`${rid(1)}:result:import:failed`);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "gave_up", attempts: MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS, last_class: "incomplete" });
    expect(h.store.calls).toEqual([]);
    expect(h.gate.resultUrls()).toHaveLength(2);
  });

  it("払戻が無いページは、着順が部分でも no-payout(払戻の判定が先)。5 分後に再試行する", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.script.push(okPage(withoutPayoutTables(withTopRows(FULL, 3))));
    expect(await tick(h)).toBe(`${rid(1)}:result:import:retry`);
    expect(rowOf(h, rid(1))).toMatchObject({ last_class: "no-payout", next_try_at: jst("10:20") });
  });

  it("取得の失敗・未確定も、当日の行は 5 分おき・10 回までの予算で再試行する(過去日の 10 分・3 回ではない)", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.script.push(...Array.from({ length: 10 }, status500));
    const times: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      times.push(h.alarm.at!);
      await tick(h);
    }
    expect(times).toEqual(Array.from({ length: 10 }, (_, i) => jst("10:15") + i * 5 * MIN));
    expect(rowOf(h, rid(1))).toMatchObject({ state: "gave_up", attempts: 10, last_class: "fetch-failed" });
  });

  it("★契約は変えない: 過去日の行(翌朝の依頼)は、上位 3 頭だけのページでも従来どおり保存する(完了の判定は当日の行だけ)", async () => {
    const h = harness({ start: jst("09:00", "2026-09-28") });
    h.gate.pages.set(rid(1), withTopRows(FULL, 3));
    expect(await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [rid(1)] })).toMatchObject({ accepted: 1 });
    expect(rowOf(h, rid(1)).requested_on).toBe(NEXT_DATE); // 前提: 過去日の行(requested_on が開催日と違う)
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(h.store.calls[0]!.entries).toHaveLength(3);
  });

  it("当日に諦めた行は、翌朝の依頼で 1 回だけ積み直され(requested_on が翌日になる)、過去日の方式(3 試行・10 分おき)で取り込まれる。重複して取る行は無い", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await toFirstAttempt(h);
    h.gate.pages.set(rid(1), withTopRows(FULL, 3));
    await driveUntil(h, jst("11:00"));
    expect(rowOf(h, rid(1)).state).toBe("gave_up");
    const fetchedToday = h.gate.resultUrls().length;
    h.gate.pages.set(rid(1), FULL); // 翌朝には全頭がそろっている
    h.clock.now = jst("09:00", "2026-09-28");
    expect(await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [rid(1)] })).toMatchObject({ accepted: 1 });
    expect(rowOf(h, rid(1))).toMatchObject({ state: "queued", attempts: 0, requested_on: NEXT_DATE });
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(h.gate.resultUrls().length).toBe(fetchedToday + 1);
    expect(h.store.calls).toHaveLength(1);
  });
});

describe("AC-C3: 今日の DO で動く(期限を待つ planned の行が残っていても)。発走前の分析・朝の準備を押しのけない", () => {
  it("planned の行(午後のレース)が残っていても、午前のレースの結果は発走 + 15 分に取り込まれる。次のアラームは「次の期限」と「次の結果の試行」の早い方", async () => {
    const h = harness({ rows: [central(1, "10:00"), central(2, "14:00")] });
    await planned(h);
    await driveUntil(h, jst("10:14"));
    expect(planRowStates(h)[rid(2)]).toBe("planned"); // 前提: 午後のレースは期限(13:15)を待っている
    expect(h.alarm.at).toBe(jst("10:15"));
    expect(await tick(h)).toBe(`${rid(1)}:result:import:ok`);
    expect(planRowStates(h)[rid(2)]).toBe("planned");
    expect(h.alarm.at).toBe(jst("13:15")); // 2R の期限(14:00 − 45 分)。2R の結果(14:15)より早い
    expect(rowOf(h, rid(2)).next_try_at).toBe(jst("14:15"));
  });

  it("期限が来た planned の行があるステップでは、結果より先に昇格する(結果の取得は出ない)。昇格後のタスクが終わってから結果が動く", async () => {
    // offset 10 分: 1R(10:00)の結果の期限(10:15)と、2R(10:25)の発走前の期限(10:15)が同時に来る
    const h = harness({ rows: [central(1, "10:00"), central(2, "10:25")], offset: 10 });
    await planned(h);
    await driveUntil(h, jst("10:15") - 1);
    expect(h.alarm.at).toBe(jst("10:15"));
    expect(planRowStates(h)[rid(2)]).toBe("planned"); // 前提: 2R はまだ昇格していない
    const resultFetchesBefore = h.gate.resultUrls().length;
    const first = await tick(h);
    expect(first).toBe(`${rid(2)}:pre_race:fetch:failed`); // 昇格して、発走前の取得に進んだ(すぐ失敗するフェイク)
    expect(planRowStates(h)[rid(2)]).toBe("promoted");
    expect(h.gate.resultUrls()).toHaveLength(resultFetchesBefore); // このステップでは結果を取っていない
    const second = await tick(h);
    expect(second).toBe(`${rid(1)}:result:import:ok`);
  });

  it("計画の段階が終わっていない(会場の一覧の再試行待ち)あいだは、結果の行があっても動かない(従来どおり)", async () => {
    const h = harness({ rows: [central(1, "10:00")] });
    await h.core.requestPlan({ kaisaiDate: DATE });
    h.sql.exec("UPDATE race_day_plan_venue SET next_try_at = ?", JST_0900 + 5 * MIN);
    h.sql.exec(
      "INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?)",
      rid(1),
      JST_0900,
      DATE,
      JST_0900,
      JST_0900,
    );
    h.alarm.at = JST_0900;
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" });
    expect(h.gate.resultUrls()).toEqual([]);
    expect(rowOf(h, rid(1))).toMatchObject({ state: "queued", attempts: 0 });
  });
});

describe("fuzz: 今日の DO で、即時ループ・停止が無く、期限・タスクを結果が押しのけない(種 30 通り。1 種あたり約 1.5 秒)", () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("30 通りの乱数(ページの種類・gate の拒否・時計の飛び・手動のタスクの割り込み・offset)で、状態が変わらないのに now 以前へ張り直す起床が 0、止まった時点で queued・planned が 0、タスク・計画の段階があるステップで結果を取らず、結果を取ったステップの後に期限が来た planned の行が残らない", async () => {
    let wakes = 0;
    let resultSteps = 0;
    let resultStepsWithPlanned = 0;
    let interleaved = 0;
    const classes = new Set<string>();
    const finalStates = { queued: 0, imported: 0, gave_up: 0 };
    const startTimes = ["10:00", "10:30", "11:20", "13:00", "14:10", "15:40"];
    for (let seed = 1; seed <= 30; seed += 1) {
      const random = rng(seed);
      const offset = [10, 45, 180, 45 + Math.floor(random() * 60)][Math.floor(random() * 4)]!;
      const h = harness({ rows: startTimes.map((t, i) => central(i + 1, t)), offset });
      h.gate.script.push(
        ...Array.from({ length: 80 }, (): GateResult => {
          const p = random();
          if (p < 0.2) return okPage(withTopRows(FULL, 3));
          if (p < 0.3) return okPage(withoutPayoutTables(FULL));
          if (p < 0.35) return okPage(withoutFieldSize(FULL));
          if (p < 0.4) return okPage(PRESALE);
          if (p < 0.5) return status500();
          if (p < 0.6) return refused("queue-full");
          if (p < 0.65) return refused("blocked", h.clock.now + Math.floor(random() * 40) * MIN);
          return okPage(FULL);
        }),
      );
      await h.core.requestPlan({ kaisaiDate: DATE });
      for (let step = 0; step < 200; step += 1) {
        const at = h.alarm.at;
        if (at === null) break;
        if (at > jst("09:00", "2026-09-30")) break;
        if (random() < 0.1) {
          await h.core.schedule({ raceId: rid(1 + Math.floor(random() * 6)), kaisaiDate: DATE, mode: "pre_race" }).catch(() => undefined);
          interleaved += 1;
        }
        h.clock.now = Math.max(h.clock.now, h.alarm.at ?? 0) + (random() < 0.2 ? Math.floor(random() * 30 * MIN) : 0);
        const before = dumpAllTables(h);
        const finalized = h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'plan_finalized_at'").toArray().length > 0;
        const taskPending = (h.sql.exec("SELECT count(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]!.n > 0;
        const plannedLeft = (h.sql.exec("SELECT count(*) AS n FROM race_day_plan WHERE state = 'planned'").toArray() as { n: number }[])[0]!.n > 0;
        const urlsBefore = h.gate.resultUrls().length;
        h.alarm.at = null;
        const outcome = await h.core.runNextStep();
        wakes += 1;
        const isResult = outcome.kind === "ran" && outcome.mode === "result";
        if (isResult) {
          resultSteps += 1;
          if (plannedLeft) resultStepsWithPlanned += 1;
        }
        if (taskPending || !finalized) {
          expect(h.gate.resultUrls().length, `seed ${seed}: タスク・計画の段階があるのに結果を取った`).toBe(urlsBefore);
        }
        if (isResult) {
          // 結果のステップが動いたなら、そのステップの後に、期限が来た planned の行もタスクも残っていない(昇格が先。昇格がタスクを積んだなら結果は動かない)
          const dueAfter = (h.sql.exec("SELECT count(*) AS n FROM race_day_plan WHERE state = 'planned' AND due_ms <= ?", h.clock.now).toArray() as { n: number }[])[0]!.n;
          const tasksAfter = (h.sql.exec("SELECT count(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]!.n;
          expect(dueAfter, `seed ${seed}: 期限が来た planned の行を昇格せずに結果を取った`).toBe(0);
          expect(tasksAfter, `seed ${seed}: タスクが残っているのに結果を取った`).toBe(0);
        }
        for (const c of h.sql.exec("SELECT DISTINCT last_class AS c FROM race_day_result WHERE last_class IS NOT NULL").toArray() as { c: string }[]) classes.add(c.c);
        const after = dumpAllTables(h);
        if (before === after && h.alarm.at !== null && h.alarm.at <= h.clock.now) {
          throw new Error(`seed ${seed}: 状態が変わらないのに now 以前へ張り直した`);
        }
      }
      if (h.alarm.at === null) {
        expect(rows(h).filter((r) => r.state === "queued"), `seed ${seed}: アラームが無いのに queued が残っている`).toEqual([]);
        expect(Object.values(planRowStates(h)).filter((s) => s === "planned"), `seed ${seed}: アラームが無いのに planned が残っている`).toEqual([]);
      }
      for (const r of rows(h)) {
        finalStates[r.state as keyof typeof finalStates] += 1;
        expect(r.attempts, `seed ${seed}: 当日の行の試行の上限`).toBeLessThanOrEqual(MAX_SAME_DAY_ATTEMPTS);
        expect(r.requested_on).toBe(DATE);
      }
      // 保存したページは、すべて全頭(部分ページは保存されない)
      for (const c of h.store.calls) {
        expect(c.entries.length, `seed ${seed}: 部分ページを保存した`).toBe(16);
      }
    }
    // 空振り防止: 各経路を実際に通った
    expect(wakes).toBeGreaterThan(150);
    expect(resultSteps).toBeGreaterThan(50);
    expect(resultStepsWithPlanned).toBeGreaterThan(10); // planned の行が残るあいだに、結果のステップが動いた(今回の変更)
    expect(interleaved).toBeGreaterThan(5);
    expect(finalStates.imported).toBeGreaterThan(15);
    expect(finalStates.gave_up).toBeGreaterThan(3);
    for (const c of ["incomplete", "no-payout", "fetch-failed", "not-confirmed", "imported"]) {
      expect([...classes], `分類に ${c} が現れる`).toContain(c);
    }
  }, 120_000);
});
