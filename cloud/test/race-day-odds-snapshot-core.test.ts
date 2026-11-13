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

function harness(rows: readonly Row[], overrides: { jra?: boolean; sink?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: JST_0900 };
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

describe("計画の確定が予定を積む", () => {
  it("中央の発走時刻のあるレースごとに 10 分前・5 分前の 2 行を積む(分析するかどうかによらない)。時刻の無い中央のレース・地方は積まない", async () => {
    const h = harness(ROWS);
    await planThrough(h);
    expect(snapRows(h).map((r) => [r.race_id, r.lead_min, r.due_ms, r.start_ms, r.state])).toEqual([
      ["202606040901", 10, jst("10:05") - ODDS_SNAPSHOT_EARLY_LEAD_MS, jst("10:05"), "pending"],
      ["202606040901", 5, jst("10:05") - ODDS_SNAPSHOT_LEAD_MS, jst("10:05"), "pending"],
      ["202606040902", 10, jst("10:35") - ODDS_SNAPSHOT_EARLY_LEAD_MS, jst("10:35"), "pending"],
      ["202606040902", 5, jst("10:35") - ODDS_SNAPSHOT_LEAD_MS, jst("10:35"), "pending"],
    ]);
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
  it("10 分前の時刻に 10 分前の行、5 分前の時刻に 5 分前の行が動き、保存先へ渡る。1 ステップは 1 行だけ。取った頁は 1 レース・1 時点で 1 本", async () => {
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
    expect(h.jra.fetched).toHaveLength(2);
    expect(snapRows(h).map((r) => [r.race_id, r.lead_min, r.state])).toEqual([
      ["202606040901", 10, "done"], ["202606040901", 5, "done"], ["202606040902", 10, "pending"], ["202606040902", 5, "pending"],
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
    expect(h.jra.fetched).toHaveLength(1);
  });
});
