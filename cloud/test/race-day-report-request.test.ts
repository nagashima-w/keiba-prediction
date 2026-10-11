import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { RaceComboPayoutsSaveInput, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { RaceResultDetail } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #235: 日単位の DO(`RaceDayCore`)が、「その日が静かになった」とき(`isDayQuiet`)に、日報の作成を 1 回だけ依頼する配線。
 * 時刻の決め打ちは無い: 計画・発走前のタスク・結果の取り込みの状態だけで決まる。ゲートは偽(一覧と結果ページはフィクスチャ)、保存先は偽、ストレージは `node:sqlite`。
 * 判定の表は `day-quiet.test.ts`。ここは配線(いつ呼ぶか・1 回だけか・失敗したらどうなるか)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20260927";
const jst = (time: string, date = "2026-09-27"): number => Date.parse(`${date}T${time}:00+09:00`);
const JST_0900 = jst("09:00");

/** 16 頭の確定した結果ページ(中央の実フィクスチャ)。単勝の払戻がある。 */
const FULL = fixture("result_202603020211.html");
const EMPTY_HTML = "<html><body></body></html>";

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

function harness(options: { rows?: readonly ListRow[]; store?: boolean; offset?: number; start?: number; requestReport?: (kaisaiDate: string) => Promise<void> } = {}): Harness {
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
    ...(options.requestReport === undefined ? {} : { requestReport: options.requestReport }),
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
}
const rows = (h: Harness): ResultRow[] => h.sql.exec("SELECT race_id, state FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const planRowStates = (h: Harness): Record<string, string> =>
  Object.fromEntries((h.sql.exec("SELECT race_id, state FROM race_day_plan").toArray() as { race_id: string; state: string }[]).map((r) => [r.race_id, r.state]));
const dumpAllTables = (h: Harness): string => {
  const tables = h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[];
  return tables.map((t) => JSON.stringify(h.sql.exec(`SELECT * FROM ${t.name}`).toArray())).join("\n");
};

// ---------------------------------------------------------------------------

/** 日報の依頼の記録つきの偽(呼び出しの日付を溜める)。 */
function recorder(failures = 0): { calls: string[]; fn: (kaisaiDate: string) => Promise<void> } {
  const calls: string[] = [];
  let remaining = failures;
  return {
    calls,
    fn: async (kaisaiDate) => {
      calls.push(kaisaiDate);
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("SECRET-REPORT-ERROR");
      }
    },
  };
}

describe("日報の依頼の配線(静かになったとき 1 回だけ)", () => {
  it("全レースの発走前の分析が終わり、結果の取り込みが終端になったあとで、開催日を渡して 1 回だけ依頼する。途中では依頼しない", async () => {
    const report = recorder();
    const h = harness({ rows: [central(1, "10:00"), central(2, "11:00")], requestReport: report.fn });
    await planned(h);
    await driveUntil(h, jst("10:20")); // 1 レース目の結果は取り込み済み(10:15)。2 レース目の結果の行は 11:15 まで待ち
    expect(rows(h).map((r) => r.state)).toEqual(["imported", "queued"]); // 前提(空振り防止): 待ちの行が残っている
    expect(report.calls).toEqual([]);
    await driveUntil(h, jst("11:20"));
    expect(rows(h).map((r) => r.state)).toEqual(["imported", "imported"]);
    expect(report.calls).toEqual([DATE]);
  });

  it("まだ分析していない計画中のレース(夜の発走)が残るあいだは、昼の結果が揃っても依頼しない。夜の結果が揃ってから依頼する(時刻の決め打ちが無い)", async () => {
    const report = recorder();
    const h = harness({ rows: [central(1, "10:00"), central(2, "20:50")], requestReport: report.fn });
    await planned(h);
    await driveUntil(h, jst("12:00"));
    expect(rows(h)[0]!.state).toBe("imported"); // 前提: 昼の結果は揃った
    expect(planRowStates(h)[rid(2)]).toBe("planned"); // 前提: 夜のレースはまだ分析されていない
    expect(report.calls).toEqual([]);
    await driveUntil(h, jst("21:30"));
    expect(rows(h).map((r) => r.state)).toEqual(["imported", "imported"]);
    expect(report.calls).toEqual([DATE]);
  });

  it("結果の取り込みを諦めた行(取得できないレース)があっても、その上限に達したあとで依頼する(永久に待たない)", async () => {
    const report = recorder();
    const h = harness({ rows: [central(1, "10:00")], requestReport: report.fn });
    h.gate.script.push(...Array.from({ length: 20 }, () => blocked())); // 結果ページは常に取得できない
    await planned(h);
    await driveUntil(h, jst("12:00"));
    expect(rows(h).map((r) => r.state)).toEqual(["gave_up"]);
    expect(report.calls).toEqual([DATE]);
  });

  it("依頼したあとは、以降の起床で何度動いても、二度目は依頼しない", async () => {
    const report = recorder();
    const h = harness({ rows: [central(1, "10:00")], requestReport: report.fn });
    await planned(h);
    await driveUntil(h, jst("10:30"));
    expect(report.calls).toEqual([DATE]);
    for (let i = 0; i < 3 && h.alarm.at !== null; i += 1) {
      await tick(h); // 掃除専用の起床など
    }
    expect(report.calls).toEqual([DATE]);
  });

  it("依頼が失敗したら、固定の警告だけを残し(例外の本文は出さない)、依頼済みにしない。次の起床(掃除専用)で再び依頼する", async () => {
    const report = recorder(1);
    const h = harness({ rows: [central(1, "10:00")], requestReport: report.fn });
    await planned(h);
    await driveUntil(h, jst("10:30"));
    expect(report.calls).toEqual([DATE]); // 1 回目は失敗
    expect(h.warnings.join("\n")).toContain("日報");
    expect(h.warnings.join("\n")).not.toContain("SECRET-REPORT-ERROR");
    expect(dumpAllTables(h)).not.toContain("SECRET-REPORT-ERROR");
    expect(h.alarm.at).not.toBeNull(); // 掃除専用のアラーム
    await tick(h);
    expect(report.calls).toEqual([DATE, DATE]); // 再依頼(成功)
    await tick(h).catch(() => undefined);
    expect(report.calls).toEqual([DATE, DATE]);
  });

  it("日報の仕組みが無い(requestReport なし)・結果の保存先が無い(結果の行が無い)構成では、依頼しない", async () => {
    const none = harness({ rows: [central(1, "10:00")] });
    await planned(none);
    await driveUntil(none, jst("10:30")); // 落ちない
    const noStore = recorder();
    const h = harness({ rows: [central(1, "10:00")], store: false, requestReport: noStore.fn });
    await planned(h);
    await driveUntil(h, jst("12:00"));
    expect(rows(h)).toEqual([]);
    expect(noStore.calls).toEqual([]);
  });

  it("計画が確定していない日(結果の取り込みの依頼だけを受けた過去日の DO)では、依頼しない", async () => {
    const report = recorder();
    const h = harness({ rows: [], requestReport: report.fn, start: jst("09:00", "2026-09-28") });
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [rid(1)] });
    await driveUntil(h, jst("12:00", "2026-09-28"));
    expect(rows(h).map((r) => r.state)).toEqual(["imported"]); // 前提: 結果は取り込まれた(行がある・待ちが無い)
    expect(report.calls).toEqual([]);
  });
});
