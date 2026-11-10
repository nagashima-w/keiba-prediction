import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "../src/gate-core";
import { RaceArchiveFetchCore, type ArchiveFetchOptions, type ArchiveNotice } from "../src/race-archive-fetch-core";
import { historyCalendarUrl, historyListUrl } from "../../packages/core/src/scraper/history-pages";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record";
import { raceResultUrl } from "../../packages/core/src/scraper/urls";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { pathFromMeta } from "./meta-path.js";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #635: 地方の交流重賞(Jpn)の過去の結果を取る(`RaceArchiveFetchCore` を `kind: "nar"` で動かす)。
 * 時計・アラーム・gate・保存・通知は偽物、状態は本物の SQLite。実サイトには出ない。中央の挙動は `race-archive-fetch-core.test.ts` が固定している(こちらは地方だけ)。
 */

const loadFixture = (name: string): string => readFileSync(pathFromMeta(`../../fixtures/${name}`, import.meta.url), "utf-8");
const JST = 9 * 3600_000;
const HOUR = 3600_000;
/** JST の時刻 → epoch ミリ秒(年を指定できる。地方の試験は 2021 年の実物のフィクスチャを使うため)。 */
const jst = (y: number, month: number, day: number, hour: number, minute = 0): number => Date.UTC(y, month - 1, day, hour, minute) - JST;
/** 既定の「今」: 2021-12-02(木)0:00 JST。フィクスチャの 2021-11-03 より後。 */
const T0 = jst(2021, 12, 2, 0);

const NAR_LIST = loadFixture("history_nar_list_20211103.html");
const NAR_CAL = loadFixture("history_nar_calendar_2021_11.html");
const NAR_RESULT = loadFixture("history_nar_result_202146110310.html");
const JPN_IDS = ["202130110305", "202146110308", "202146110309", "202146110310"];
const EMPTY_CAL = (dates: string[]): string =>
  `<html><div class="Race_Calendar_Main"><table class="Calendar_Table"><tbody><tr>${dates.map((d) => `<td><a href="../top/race_list.html?kaisai_date=${d}">x</a></td>`).join("")}</tr></tbody></table></div></html>`;
const EMPTY_LIST = `<div class="RaceList_Body"></div>`;

const enc = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};
const ok = (html: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html", body: enc(html), queuedMs: 0, elapsedMs: 1 });

class World {
  now = T0;
  alarm: number | null = null;
  readonly sql: NodeSql = openNodeSql();
  readonly fetchLog: string[] = [];
  readonly savedRecords: RaceRecord[] = [];
  readonly notices: ArchiveNotice[] = [];
  readonly routes = new Map<string, GateResult>();
  gateStatusCalls = 0;
  planCalls = 0;
  core: RaceArchiveFetchCore;

  constructor(options: ArchiveFetchOptions = {}) {
    this.core = new RaceArchiveFetchCore(
      {
        sql: { exec: (q: string, ...b: unknown[]) => { const c = this.sql.exec(q, ...b); return { toArray: () => c.toArray() }; } },
        now: () => this.now,
        setAlarm: (at) => { this.alarm = at; },
        getAlarm: async () => this.alarm,
        gate: {
          status: async () => { this.gateStatusCalls += 1; return { blockedUntil: null, consecutiveRefusals: 0, lastStartAt: null, pending: 0 }; },
          fetchRaw: async (url) => { this.fetchLog.push(url); return this.routes.get(url) ?? { kind: "response", status: 404, contentType: "text/html", body: enc(""), queuedMs: 0, elapsedMs: 1 }; },
        },
        planProgress: async () => { this.planCalls += 1; return { stage: "done", venues: [{ venue: "central", state: "ok", listed: 36 }] }; },
        archive: {
          saveRaceArchive: async ({ record }) => { this.savedRecords.push(record); return { status: "saved", key: `race-results/${record.raceId}.json.gz`, dbSizeBytes: 24_000_000 }; },
          getCatalogEntry: async () => null,
        },
        notify: async (n) => { this.notices.push(n); },
        log: () => undefined,
      },
      // 開始時刻は外す(2021 年の時計で動かす)。間隔は小さくして、試験が長くならないようにする。
      { kind: "nar", fromMonth: "2021-11", notBeforeMs: 0, intervalMs: 1500, ...options },
    );
  }

  /** 標準の筋書き: 2021-11 のカレンダー(30 日。実物)、11/03 だけ実物の一覧、ほかの日は空の一覧。結果は 202146110310 だけ実物。 */
  standardSite(): void {
    this.routes.set(historyCalendarUrl("nar", "2021-12"), ok(EMPTY_CAL([])));
    this.routes.set(historyCalendarUrl("nar", "2021-11"), ok(NAR_CAL));
    for (const d of [...NAR_CAL.matchAll(/kaisai_date=(\d{8})/g)].map((m) => m[1]!)) this.routes.set(historyListUrl("nar", d), ok(EMPTY_LIST));
    this.routes.set(historyListUrl("nar", "20211103"), ok(NAR_LIST));
    this.routes.set(raceResultUrl(parseRaceId("202146110310")), ok(NAR_RESULT));
  }

  async runUntil(untilMs: number, maxSteps = 3000): Promise<void> {
    let steps = 0;
    while (this.alarm !== null && this.alarm <= untilMs && steps < maxSteps) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    expect(steps, "ステップ数の暴走がない").toBeLessThan(maxSteps);
  }
  raceRows(): { race_id: string; status: string }[] {
    return this.sql.exec("SELECT race_id, status FROM ra_race ORDER BY race_id").toArray() as { race_id: string; status: string }[];
  }
  dayStatus(date: string): string | undefined {
    return (this.sql.exec("SELECT status FROM ra_day WHERE date = ?", date).toArray() as { status: string }[])[0]?.status;
  }
}

const worlds: World[] = [];
const mk = (options?: ArchiveFetchOptions): World => {
  const w = new World(options);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.sql.close();
});

describe("地方の交流重賞(kind: nar)の通し(カレンダー → 一覧 → 結果 → 保存)", () => {
  it("一覧から Jpn の 4 件だけを ra_race に入れ、結果を取って、kind=nar の記録を保存する。URL はすべて nar.netkeiba.com", async () => {
    const w = mk();
    w.standardSite();
    await w.core.kick();
    await w.runUntil(T0 + 8 * HOUR);

    // 一覧 40 件のうち ra_race に入るのは Jpn の 4 件だけ(Jpn の絞り込みを外すと 40 件になる)
    expect(w.raceRows().map((r) => r.race_id)).toEqual(JPN_IDS);
    // 結果ページは Jpn の 4 件だけ取る(地方のホスト)
    const resultFetches = w.fetchLog.filter((u) => u.includes("/race/result.html"));
    expect(resultFetches).toHaveLength(4);
    expect(resultFetches.every((u) => u.startsWith("https://nar.netkeiba.com/"))).toBe(true);
    // 取ったすべての URL が地方のホスト(kind を central に戻すと race.netkeiba.com になる)
    expect(w.fetchLog.length).toBeGreaterThan(30);
    expect(w.fetchLog.every((u) => u.startsWith("https://nar.netkeiba.com/"))).toBe(true);
    // 実物の結果ページ(202146110310)は読めて、地方の記録として保存される(通過順は空配列)
    expect(w.savedRecords.map((r) => r.raceId)).toEqual(["202146110310"]);
    expect(w.savedRecords[0]!.kind).toBe("nar");
    expect(w.savedRecords[0]!.horses.length).toBe(12);
    expect(w.savedRecords[0]!.horses.every((h) => h.passing.length === 0)).toBe(true);
    // 残りの 3 件は実物の結果ページを用意していない(404)ので、その晩は取り直さず pending のまま失敗に数える
    expect(w.raceRows().filter((r) => r.status === "done").map((r) => r.race_id)).toEqual(["202146110310"]);
    // gate の確認を、リクエストごとに通っている
    expect(w.gateStatusCalls).toBeGreaterThanOrEqual(w.fetchLog.length);
  });

  it("地方は開催日の朝を休まない: 計画の判定(中央の行)は呼ばず、既定でも取る", async () => {
    const w = mk(); // skipCentralRaceDay は既定(true)のまま
    w.standardSite();
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.planCalls).toBe(0);
    expect(w.fetchLog.length).toBeGreaterThan(0);
  });

  it("Jpn が 0 件の日(ra_day は listed を経て done になり、ra_race は増えず、結果は取らない)", async () => {
    const w = mk();
    w.routes.set(historyCalendarUrl("nar", "2021-12"), ok(EMPTY_CAL([])));
    w.routes.set(historyCalendarUrl("nar", "2021-11"), ok(EMPTY_CAL(["20211104"])));
    // Jpn の表記を「重賞」に置き換えた一覧(Jpn が 0 件。レースは 40 件ある)
    w.routes.set(historyListUrl("nar", "20211104"), ok(NAR_LIST.replaceAll(">Jpn1<", ">重賞<").replaceAll(">Jpn3<", ">重賞<")));
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.fetchLog).toContain(historyListUrl("nar", "20211104"));
    expect(w.raceRows()).toEqual([]);
    expect(w.dayStatus("20211104")).toBe("done");
    expect(w.fetchLog.some((u) => u.includes("/race/result.html"))).toBe(false);
  });

  it("ローマ数字の表記(JpnⅠ・JpnⅢ)の日も Jpn の 4 件を拾う", async () => {
    const w = mk();
    w.routes.set(historyCalendarUrl("nar", "2021-12"), ok(EMPTY_CAL([])));
    w.routes.set(historyCalendarUrl("nar", "2021-11"), ok(EMPTY_CAL(["20211103"])));
    w.routes.set(historyListUrl("nar", "20211103"), ok(NAR_LIST.replaceAll(">Jpn1<", ">JpnⅠ<").replaceAll(">Jpn3<", ">JpnⅢ<")));
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.raceRows().map((r) => r.race_id)).toEqual(JPN_IDS);
  });
});

describe("地方の取得の時間帯・1 晩の上限・今日以降を取らない", () => {
  it("時間帯(JST 0:00〜8:30)の外では取らない: 9:00 に起きても何も取らず、アラームは翌日の 0:00", async () => {
    const w = mk();
    w.standardSite();
    w.now = jst(2021, 12, 2, 9, 0);
    await w.core.kick();
    expect(w.alarm).toBe(jst(2021, 12, 3, 0, 0));
    await w.core.runNextStep();
    expect(w.fetchLog).toEqual([]);
    expect(w.alarm).toBe(jst(2021, 12, 3, 0, 0));
  });

  it("時間帯の最後(8:29)までは取り、8:30 を過ぎたら止まって翌日の 0:00 に張る", async () => {
    const w = mk({ intervalMs: 20_000 });
    w.standardSite();
    await w.core.kick();
    await w.runUntil(jst(2021, 12, 2, 8, 29) + 59_000);
    const before = w.fetchLog.length;
    expect(before).toBeGreaterThan(0);
    w.now = jst(2021, 12, 2, 8, 30);
    w.alarm = w.now;
    await w.core.runNextStep();
    expect(w.fetchLog.length).toBe(before);
    expect(w.alarm).toBe(jst(2021, 12, 3, 0, 0));
  });

  it("1 晩の件数の上限(nightlyLimit)は無視されない: 上限 5 ならその晩は 5 リクエストで止まり、次の晩に続く", async () => {
    const w = mk({ nightlyLimit: 5 });
    w.standardSite();
    await w.core.kick();
    await w.runUntil(jst(2021, 12, 2, 23, 59));
    expect(w.fetchLog).toHaveLength(5);
    await w.runUntil(jst(2021, 12, 3, 23, 59));
    expect(w.fetchLog).toHaveLength(10);
  });

  it("今日以降の開催日の一覧は取らない(当日の結果は途中のことがある)", async () => {
    const w = mk();
    w.routes.set(historyCalendarUrl("nar", "2021-12"), ok(EMPTY_CAL(["20211201", "20211202", "20211203"])));
    w.routes.set(historyCalendarUrl("nar", "2021-11"), ok(EMPTY_CAL([])));
    for (const d of ["20211201", "20211202", "20211203"]) w.routes.set(historyListUrl("nar", d), ok(EMPTY_LIST));
    await w.core.kick();
    await w.runUntil(T0 + 3 * HOUR);
    expect(w.fetchLog).toContain(historyListUrl("nar", "20211201"));
    expect(w.fetchLog).not.toContain(historyListUrl("nar", "20211202")); // 今日(12/02)
    expect(w.fetchLog).not.toContain(historyListUrl("nar", "20211203")); // 明日
  });
});

describe("地方の取得の通知には地方であることを示す印が付く", () => {
  it("HTTP 429 で止められたとき、通知に scope=nar が付く(中央の通知には付かない)", async () => {
    const w = mk();
    w.standardSite();
    w.routes.set(historyCalendarUrl("nar", "2021-12"), { kind: "response", status: 429, contentType: "text/html", body: enc(""), queuedMs: 0, elapsedMs: 1 });
    await w.core.kick();
    await w.runUntil(T0 + HOUR);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.kind).toBe("refused");
    expect(w.notices[0]!.scope).toBe("nar");
  });
});

// buildRaceRecord を直接使う: 実物の結果ページが nar の記録に読めること(試験の前提)
describe("前提の確認", () => {
  it("実物の結果ページ 202146110310 は kind=nar の記録に読める", () => {
    const built = buildRaceRecord(NAR_RESULT, "202146110310", "nar");
    expect(built.ok).toBe(true);
  });
});
