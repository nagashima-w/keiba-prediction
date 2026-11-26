import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { JraOddsRaceLinks, JraOddsVenueLink } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { JraOddsFetcher, JraOddsSession } from "../src/jra-odds-fetch";
import type { OddsSnapshotSink } from "../src/odds-snapshot-repository";
import { ODDS_SNAPSHOT_EARLY_LEAD_MS, ODDS_SNAPSHOT_LEAD_MS, type OddsSnapshotPayload } from "../src/race-day-odds-snapshot";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";
import type { SqlLike } from "../src/sql-like";

/**
 * Issue #732: 計画の確定が、中央のレースごと(分析するかどうかによらない)に、発走の 10 分前・5 分前の予定を積み、時刻が来たら記録する(DO の単位)。
 * ゲート・JRA の取得口・保存先は偽、ストレージは `node:sqlite`。実 netkeiba・実 JRA には触れない。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TANPUKU = new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", "jra_odds_tanpuku_1342_202605050208.html")))); 
const DATE = "20260927";
const JST_0900 = Date.parse("2026-09-27T09:00:00+09:00");
const jst = (time: string): number => Date.parse(`2026-09-27T${time}:00+09:00`);

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okRes = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

interface Row {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly time: string | null;
  readonly kind: "central" | "nar";
  readonly grade?: string;
}
function listHtml(rows: readonly Row[]): string {
  const venues = [...new Set(rows.map((r) => r.venue))];
  return venues
    .map((venue) => {
      const items = rows
        .filter((r) => r.venue === venue)
        .map((r) => {
          const timeMarkup = r.kind === "central" ? `<span class="RaceList_Itemtime">${r.time ?? ""} </span>` : r.time === null ? "<span></span>" : `<span>${r.time}</span>`;
          const grade = r.grade === undefined ? "" : `<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">${r.grade}</span>`;
          return `<li class="RaceList_DataItem"><a href="../race/shutuba.html?race_id=${r.raceId}&rf=race_list"><div class="Race_Num"><span>${r.raceNumber}R</span></div><div class="RaceList_ItemContent"><div class="RaceList_ItemTitle"><span class="ItemTitle">${r.venue}${r.raceNumber}R</span>${grade}</div><div class="RaceData">${timeMarkup}<span class="Dart">ダ1200m</span>16頭</div></div></a></li>`;
        })
        .join("\n");
      return `<dl class="RaceList_DataList"><dt class="RaceList_DataHeader"><p class="RaceList_DataTitle"><small>1回</small> ${venue} <small>1日目</small></p></dt><dd class="RaceList_Data"><ul>${items}</ul></dd></dl>`;
    })
    .join("\n");
}
const central = (n: number, time: string | null): Row => ({ raceId: `2026060409${String(n).padStart(2, "0")}`, venue: "中山", raceNumber: n, time, kind: "central" });
const nar = (n: number, time: string): Row => ({ raceId: `2026360927${String(n).padStart(2, "0")}`, venue: "水沢", raceNumber: n, time, kind: "nar", grade: "Jpn3" });

const PAGES = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
const DIGIT: Record<string, string> = { tanpuku: "1", wakuren: "3", umaren: "4", wide: "5", umatan: "6", sanrenpuku: "7", sanrentan: "8" };
const linksOf = (raceId: string): JraOddsRaceLinks => ({
  raceId,
  race: raceId.slice(10, 12),
  cnames: Object.fromEntries(PAGES.map((p) => [p, `pw15${DIGIT[p]}ouS3${raceId.slice(4, 6)}${raceId.slice(0, 4)}${raceId.slice(6, 8)}${raceId.slice(8, 10)}${raceId.slice(10, 12)}${DATE}Z/AA`])) as unknown as JraOddsRaceLinks["cnames"],
});
const VENUE: JraOddsVenueLink = { venueCode: "06", year: "2026", kai: "04", day: "09", date: DATE, racesCname: `pw15orl000620260409${DATE}/AA` };
function fakeJra(raceIds: readonly string[]): JraOddsFetcher & { fetched: string[] } {
  const jra = {
    fetched: [] as string[],
    open(): JraOddsSession {
      return {
        requestCount: 0,
        async listVenues() {
          return { status: "ok", value: [VENUE] };
        },
        async listRaces() {
          return { status: "ok", value: raceIds.map(linksOf) };
        },
        async fetchOdds(cname: string) {
          jra.fetched.push(cname);
          return { status: "ok", value: TANPUKU };
        },
      };
    },
  };
  return jra;
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
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  readonly saved: OddsSnapshotPayload[];
  readonly jra: ReturnType<typeof fakeJra>;
  fault: ((query: string) => void) | null;
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(rows: readonly Row[], overrides: { jra?: boolean; sink?: boolean; now?: number; modelHook?: RaceDayDeps["modelHook"] } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: overrides.now ?? JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const saved: OddsSnapshotPayload[] = [];
  const jra = fakeJra(rows.filter((r) => r.kind === "central").map((r) => r.raceId));
  const centralHtml = listHtml(rows.filter((r) => r.kind === "central"));
  const narHtml = listHtml(rows.filter((r) => r.kind === "nar"));
  const gate: GateLike = {
    async fetchRaw(url): Promise<GateResult> {
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return okRes(centralHtml);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return okRes(narHtml);
      return blocked();
    },
  };
  const h = { sql, clock, alarm, warnings, saved, jra, fault: null } as Harness;
  const faultingSql: SqlLike = {
    exec(query, ...bindings) {
      h.fault?.(query);
      return sql.exec(query, ...bindings);
    },
  };
  const sink: OddsSnapshotSink = { save: async (p) => void saved.push(p) };
  const deps: RaceDayDeps = {
    sql: faultingSql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (m) => warnings.push(m),
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(overrides.jra === false ? {} : { fetchJraOdds: jra }),
    ...(overrides.sink === false ? {} : { oddsSnapshotSink: sink }),
    ...(overrides.modelHook === undefined ? {} : { modelHook: overrides.modelHook }),
  };
  (h as { core: RaceDayCore }).core = new RaceDayCore(deps);
  return h;
}
async function planThrough(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true });
  for (let i = 0; i < 3; i += 1) {
    h.clock.now = Math.max(h.clock.now, h.alarm.at ?? h.clock.now);
    h.alarm.at = null;
    await h.core.runNextStep();
  }
}
const snapRows = (h: Harness): { race_id: string; lead_min: number; due_ms: number; start_ms: number; state: string }[] =>
  h.sql.exec("SELECT race_id, lead_min, due_ms, start_ms, state FROM race_day_odds_snap ORDER BY race_id, lead_min DESC").toArray() as never;

const ROWS: Row[] = [central(1, "10:05"), central(2, "10:35"), central(3, null), nar(1, "15:00")];

describe("別の Worker への依頼(odds。Issue #796)", () => {
  it("core の配線: 10 分前・5 分前の記録を保存した後に、その時点の分数で依頼する(保存より後。前日の夜・当日の朝では呼ばない)", async () => {
    const calls: { raceId: string; minutes: number; savedAtCall: number }[] = [];
    let hh!: Harness;
    const modelHook = {
      card: async () => undefined,
      odds: async (raceId: string, minutes: 5 | 10) => void calls.push({ raceId, minutes, savedAtCall: hh.saved.length }),
    };
    hh = harness([central(1, "09:25")], { modelHook });
    await planThrough(hh);
    for (let i = 0; i < 30; i += 1) {
      const next = hh.alarm.at;
      if (next === null) break;
      hh.clock.now = Math.max(hh.clock.now, next);
      hh.alarm.at = null;
      if ((await hh.core.runNextStep()).kind === "idle" && calls.length >= 2) break;
    }
    expect(hh.saved.filter((p) => p.status === "ok").map((p) => p.leadMin).sort((a, b) => a - b), "前提: 10・5 分前が ok で保存された").toEqual(expect.arrayContaining([5, 10]));
    expect(calls.map((c) => c.minutes).sort((a, b) => a - b)).toEqual([5, 10]);
    expect(calls.every((c) => c.savedAtCall >= 1)).toBe(true);
    expect(calls.every((c) => c.raceId === hh.saved[0]!.raceId)).toBe(true);
  });
});

describe("計画の確定が予定を積む", () => {
  it("中央の発走時刻のあるレースごとに 10 分前・5 分前の行を積む(分析するかどうかによらない)。時刻の無い中央のレース・地方は積まない。開催日の 09:00 に確定したときは、前日の夜(-1)は最後の時刻を過ぎているので積まず、当日の朝(-2。09:30)は積む(#787)", async () => {
    const h = harness(ROWS);
    await planThrough(h);
    expect(snapRows(h).map((r) => [r.race_id, r.lead_min, r.due_ms, r.start_ms, r.state])).toEqual([
      ["202606040901", 10, jst("10:05") - ODDS_SNAPSHOT_EARLY_LEAD_MS, jst("10:05"), "pending"],
      ["202606040901", 5, jst("10:05") - ODDS_SNAPSHOT_LEAD_MS, jst("10:05"), "pending"],
      ["202606040901", -2, jst("09:30"), jst("10:05"), "pending"],
      ["202606040902", 10, jst("10:35") - ODDS_SNAPSHOT_EARLY_LEAD_MS, jst("10:35"), "pending"],
      ["202606040902", 5, jst("10:35") - ODDS_SNAPSHOT_LEAD_MS, jst("10:35"), "pending"],
      ["202606040902", -2, jst("09:30"), jst("10:35"), "pending"],
    ]);
  });
  it("#787: 前日の 21:10 JST に確定すると、前日の夜(-1。due は 21:00)と当日の朝(-2。due は翌 09:30)も積む。時刻の無い中央のレース・地方は積まない", async () => {
    const h = harness(ROWS, { now: jst("21:10") - 86_400_000 });
    await planThrough(h);
    const rows = snapRows(h);
    expect(rows.filter((r) => r.lead_min < 0).map((r) => [r.race_id, r.lead_min, r.due_ms])).toEqual([
      ["202606040901", -1, jst("21:00") - 86_400_000],
      ["202606040901", -2, jst("09:30")],
      ["202606040902", -1, jst("21:00") - 86_400_000],
      ["202606040902", -2, jst("09:30")],
    ]);
    expect(new Set(rows.map((r) => r.race_id))).toEqual(new Set(["202606040901", "202606040902"]));
  });
  it("次のアラームの候補に、記録の予定の時刻(最も早い pending の行)が入る(core のアラームの配線。#756)", async () => {
    const h = harness([central(1, "09:25"), central(2, "11:35")]); // 1 レース目の 10 分前(9:15)が、他の候補(9:20 ごろ)より早い
    await planThrough(h);
    // 時計を進めずに、いま動ける仕事(アラームが now 以前)を片付ける。以降の候補は未来だけになる
    for (let i = 0; i < 20 && h.alarm.at !== null && h.alarm.at <= h.clock.now; i += 1) {
      h.alarm.at = null;
      await h.core.runNextStep();
    }
    const pending = snapRows(h).filter((r) => r.state === "pending").map((r) => r.due_ms);
    expect(pending).toHaveLength(6); // 前提: 予定が積まれている(2 レース × 10 分前・5 分前・当日の朝〈-2。#787〉)
    expect(pending).toContain(jst("09:25") - ODDS_SNAPSHOT_EARLY_LEAD_MS);
    const earliest = Math.min(...pending);
    expect(earliest, "前提: 予定の時刻は、いま(朝 9 時)より先").toBeGreaterThan(h.clock.now);
    expect(h.alarm.at, "他に早い候補が無いので、アラームは記録の予定の時刻").toBe(earliest);
  });
  it("JRA の取得口か保存先が無い構成(JRA_ODDS_ENABLED=0 など)では、何も積まない(表も作らない)", async () => {
    for (const overrides of [{ jra: false }, { sink: false }]) {
      const h = harness(ROWS, overrides);
      await planThrough(h);
      expect(h.sql.exec("SELECT name FROM sqlite_master WHERE name = 'race_day_odds_snap'").toArray()).toEqual([]);
    }
  });
  it("積むのに失敗しても計画の確定は止まらない(警告だけ。計画の行は積まれる)", async () => {
    const h = harness(ROWS);
    h.fault = (q) => {
      if (q.startsWith("INSERT INTO race_day_odds_snap")) throw new Error("表が壊れた");
    };
    await planThrough(h);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_plan").toArray()).toEqual([{ n: 4 }]);
    expect(h.warnings.some((w) => w.includes("発走前のオッズの記録の予定を積めませんでした"))).toBe(true);
  });
});

describe("時刻が来たら記録する", () => {
  it("10 分前の時刻に 10 分前の行、5 分前の時刻に 5 分前の行が動き、保存先へ渡る。1 ステップは 1 行だけ。取った頁は 10 分前が 6 本・5 分前が 7 本(単勝・複勝 → 馬連 → 枠連 → ワイド → 3連複 → 馬単 → 三連単〔5 分前だけ〕)", async () => {
    const h = harness(ROWS);
    await planThrough(h);
    h.clock.now = jst("09:55") + 1_000; // 1R の 10 分前
    const first = await h.core.runNextStep();
    expect(first).toMatchObject({ kind: "ran", raceId: "202606040901", mode: "odds-snapshot", step: "record", leadMin: 10, result: "ok" });
    expect(h.saved.map((p) => [p.raceId, p.leadMin, p.status])).toEqual([["202606040901", 10, "ok"]]);
    expect(h.saved[0]).toMatchObject({ dueMs: jst("09:55"), takenAtMs: jst("09:55") + 1_000, startMs: jst("10:05"), kaisaiDate: DATE });
    expect(h.saved[0]!.horses).toHaveLength(14);
    h.clock.now = jst("10:00") + 2_000;
    const second = await h.core.runNextStep();
    expect(second).toMatchObject({ raceId: "202606040901", mode: "odds-snapshot", leadMin: 5, result: "ok" });
    expect(h.saved.map((p) => [p.raceId, p.leadMin])).toEqual([["202606040901", 10], ["202606040901", 5]]);
    expect(h.jra.fetched).toHaveLength(13); // 10 分前 6 頁 + 5 分前 7 頁
    expect(h.saved[0]!.combos, "この偽の取得口は、どの頁にも単勝・複勝の頁を返す = 組合せの表が読めない").toEqual({ umaren: { err: "unavailable" }, wakuren: { err: "unavailable" }, wide: { err: "unavailable" }, sanrenpuku: { err: "unavailable" }, umatan: { err: "unavailable" } }); // 10 分前の行(三連単のキーは無い)
    expect(snapRows(h).map((r) => [r.race_id, r.lead_min, r.state])).toEqual([
      ["202606040901", 10, "done"], ["202606040901", 5, "done"], ["202606040901", -2, "pending"], ["202606040902", 10, "pending"], ["202606040902", 5, "pending"], ["202606040902", -2, "pending"],
    ]);
  });
  it("5 分前の時刻まで気づかなかったとき、5 分前を先に記録し、10 分前は取らずに too-late で終える", async () => {
    const h = harness(ROWS);
    await planThrough(h);
    h.clock.now = jst("10:00") + 1_000;
    const a = await h.core.runNextStep();
    const b = await h.core.runNextStep();
    expect([a, b].map((o) => (o.kind === "ran" && o.mode === "odds-snapshot" ? [o.leadMin, o.result] : "other"))).toEqual([[5, "ok"], [10, "failed"]]);
    expect(h.saved.map((p) => [p.leadMin, p.status, p.reason])).toEqual([[5, "ok", null], [10, "skipped", "too-late"]]);
    expect(h.jra.fetched).toHaveLength(7); // 5 分前の 1 時点 × 7 頁(10 分前は取らない)
  });
});

describe("#787: 前日の夜(-1)・当日の朝(-2)の記録", () => {
  const step = async (h: Harness) => {
    const o = await h.core.runNextStep();
    return o.kind === "ran" && o.mode === "odds-snapshot" ? ([o.raceId, o.leadMin, o.result] as const) : (["other"] as const);
  };
  it("前日の夜の時刻が来ていれば、事前分析のタスクより前に 1 起床 1 行ずつ記録する(単勝・複勝 1 本。組合せは取らない)。2 レース分が済むまで他の段には進まない", async () => {
    const h = harness(ROWS, { now: jst("21:10") - 86_400_000 });
    await planThrough(h);
    const before = h.saved.length;
    expect(await step(h)).toEqual(["202606040901", -1, "ok"]);
    expect(await step(h)).toEqual(["202606040902", -1, "ok"]);
    expect(h.saved.slice(before).map((p) => [p.raceId, p.leadMin, p.status, p.combos])).toEqual([
      ["202606040901", -1, "ok", null],
      ["202606040902", -1, "ok", null],
    ]);
    expect(h.jra.fetched.filter((c) => !c.startsWith("pw151"))).toEqual([]); // 単勝・複勝の頁だけ
    const outcome = await h.core.runNextStep();
    expect(outcome.kind === "ran" && outcome.mode === "odds-snapshot" && outcome.leadMin === -1, "-1 の行はもう無い").toBe(false);
  });
  it("当日の朝(-2)は 09:30 JST から 1 起床 1 行ずつ。5 分前・10 分前の行が同時に動けるなら、そちらが先で -2 は後(lead_min の昇順なら -2 が先に来てしまう)", async () => {
    const h = harness([central(1, "10:05"), central(2, "10:35")], { now: jst("21:10") - 86_400_000 });
    await planThrough(h);
    expect(await step(h)).toEqual(["202606040901", -1, "ok"]);
    expect(await step(h)).toEqual(["202606040902", -1, "ok"]);
    h.clock.now = jst("09:30") + 1_000;
    expect(await step(h)).toEqual(["202606040901", -2, "ok"]);
    h.clock.now = jst("10:00") + 30_000; // 1R の 5 分前(10:00)が来ている。10 分前(09:55)の最後の時刻(10:00)は過ぎている。2R の -2 はまだ残っている
    expect(snapRows(h).find((r) => r.race_id === "202606040902" && r.lead_min === -2)!.state, "前提: 2R の -2 は pending").toBe("pending");
    expect(await step(h)).toEqual(["202606040901", 5, "ok"]);
    expect(await step(h)).toEqual(["202606040901", 10, "failed"]);
    expect(await step(h)).toEqual(["202606040902", -2, "ok"]);
  });
  it("当日の朝(-2)の時刻に 1R の 10 分前を過ぎていれば、-2 は too-late(skipped)で、JRA に出ない", async () => {
    const h = harness([central(1, "09:38")], { now: jst("21:10") - 86_400_000 });
    await planThrough(h);
    expect(await step(h)).toEqual(["202606040901", -1, "ok"]);
    h.clock.now = jst("09:35"); // 発走 09:38 の 10 分前は 09:28 を過ぎている
    const o = await h.core.runNextStep();
    expect(o).toMatchObject({ mode: "odds-snapshot", leadMin: 5 }); // 5 分前(09:33)が先
    const fetched = h.jra.fetched.length;
    expect(await step(h)).toEqual(["202606040901", 10, "failed"]); // 10 分前は too-late
    expect(await step(h)).toEqual(["202606040901", -2, "failed"]);
    expect(h.jra.fetched).toHaveLength(fetched);
    expect(h.saved.filter((p) => p.leadMin === -2)).toMatchObject([{ status: "skipped", reason: "too-late" }]);
  });
});
