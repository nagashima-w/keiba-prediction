import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "../src/gate-core";
import {
  ARCHIVE_CONSECUTIVE_FAILURE_LIMIT,
  ARCHIVE_NOT_BEFORE_MS,
  ARCHIVE_REQUEST_INTERVAL_MS,
  classifyCentralDay,
  inArchiveWindow,
  isArchiveFetchDisabled,
  RaceArchiveFetchCore,
  type ArchiveNotice,
  type ArchiveFetchOptions,
  type PlanProgressLike,
} from "../src/race-archive-fetch-core";
import type { SaveRaceArchiveResult } from "../src/race-archive-repository";
import { historyCalendarUrl, historyListUrl, parseCalendarKaisaiDates, parseListRaceIds } from "../../packages/core/src/scraper/history-pages";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { RACE_RECORD_PARSER_VERSION, type BuildResult } from "../../packages/core/src/scraper/race-record";
import { raceResultUrl } from "../../packages/core/src/scraper/urls";
import { readFileSync } from "node:fs";
import { pathFromMeta } from "./meta-path.js";
import { openNodeSql, type NodeSql } from "./node-sql";
import { checkDoStatements, type DoPlanException } from "./sql-plan";

/**
 * Issue #554(#549-A3-2): 過去の結果を毎晩取得する状態機械(`RaceArchiveFetchCore`)。時計・アラーム・gate・計画・保存・通知は偽物。
 * 状態(DO の SQLite)は本物の SQLite(`node:sqlite`)。実サイトには出ない。
 */

/** リポジトリ直下の `fixtures/` の実物のページ(UTF-8)。 */
const loadFixture = (name: string): string => readFileSync(pathFromMeta(`../../fixtures/${name}`, import.meta.url), "utf-8");

const JST = 9 * 3600_000;
const MIN = 60_000;
const HOUR = 3600_000;
/** JST の時刻 → epoch ミリ秒。 */
const jst = (month: number, day: number, hour: number, minute = 0, second = 0): number => Date.UTC(2026, month - 1, day, hour, minute, second) - JST;
/** 既定の「今」: 2026-11-05(木)0:00 JST(開始時刻の後・時間帯の最初)。 */
const T0 = jst(11, 5, 0);

const rid = (nichi: number, race: number): string => `20260504${String(nichi).padStart(2, "0")}${String(race).padStart(2, "0")}`;
const resultUrlOf = (id: string): string => raceResultUrl(parseRaceId(id));
const calUrl = (month: string): string => historyCalendarUrl("central", month);
const listUrl = (date: string): string => historyListUrl("central", date);

const mkCalendar = (dates: string[]): string =>
  `<html><div class="Race_Calendar_Main"><table class="Calendar_Table"><tbody><tr>${dates.map((d) => `<td><a href="../top/race_list.html?kaisai_date=${d}">x</a></td>`).join("")}</tr></tbody></table></div></html>`;
const mkList = (ids: string[]): string =>
  `<div class="RaceList_Body"><ul>${ids.map((id) => `<li class="RaceList_DataItem"><a href="../race/result.html?race_id=${id}">x</a></li>`).join("")}</ul></div>`;
const RESULT_OK = `<div class="RaceData02"><span>1頭</span></div><table id="All_Result_Table"><tbody><tr><td>1</td></tr></tbody></table>`;

const enc = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};
const ok = (html: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html", body: enc(html), queuedMs: 0, elapsedMs: 1 });
const httpStatus = (status: number): GateResult => ({ kind: "response", status, contentType: "text/html", body: enc(""), queuedMs: 0, elapsedMs: 1 });
const refusedBy = (reason: "blocked" | "queue-full" | "network-error" | "timeout" | "bad-response" | "disallowed-url", extra: { status?: number; blockedUntil?: number } = {}): GateResult => ({
  kind: "refused",
  reason,
  message: "x",
  ...extra,
});

type Route = GateResult | "ok" | readonly GateResult[];
const NOT_KAISAI: PlanProgressLike = { stage: "done", venues: [{ venue: "central", state: "ok", listed: 0 }, { venue: "nar", state: "ok", listed: 8 }] };
const KAISAI: PlanProgressLike = { stage: "done", venues: [{ venue: "central", state: "ok", listed: 36 }, { venue: "nar", state: "ok", listed: 0 }] };

class World {
  now = T0;
  alarm: number | null = null;
  readonly sql: NodeSql = openNodeSql();
  readonly fetchLog: { url: string; at: number }[] = [];
  readonly saved: string[] = [];
  readonly notices: ArchiveNotice[] = [];
  readonly logs: string[] = [];
  routes = new Map<string, Route>();
  gateStatus: { blockedUntil: number | null; consecutiveRefusals: number; lastStartAt: number | null; pending: number } = { blockedUntil: null, consecutiveRefusals: 0, lastStartAt: null, pending: 0 };
  gateStatusCalls = 0;
  plan: PlanProgressLike | Error = NOT_KAISAI;
  /** 日付(YYYYMMDD)ごとの計画(あればそちらを返す)。 */
  planByDate = new Map<string, PlanProgressLike>();
  throwOnRace = new Set<string>();
  throwOnMonth = new Set<string>();
  throwOnDay = new Set<string>();
  lastListDate = "";
  /** 一覧の読み取りが返す race_id を差し替える(不正な ID を返す読み取りの再現)。 */
  listIdsOverride: string[] | null = null;
  planCalls = 0;
  catalog = new Set<string>();
  saveResults: SaveRaceArchiveResult[] = [];
  notifyFailures = 0;
  saveThrows = 0;
  notifyCalls = 0;
  rejectRace = new Set<string>();
  /** 文ごとの `rowsRead` を偽る(省略は 0)。呼ばれた文の回数(0 始まり)も渡す。 */
  rowsReadOf: ((query: string, nth: number) => number) | null = null;
  private readonly execCounts = new Map<string, number>();
  core!: RaceArchiveFetchCore;

  constructor(readonly options: ArchiveFetchOptions = { fromMonth: "2026-11" }) {
    this.core = this.makeCore();
  }

  makeCore(): RaceArchiveFetchCore {
    return new RaceArchiveFetchCore(
      {
        sql: {
          exec: (query: string, ...bindings: unknown[]) => {
            const cursor = this.sql.exec(query, ...bindings);
            const nth = this.execCounts.get(query) ?? 0;
            this.execCounts.set(query, nth + 1);
            return { toArray: () => cursor.toArray(), rowsRead: this.rowsReadOf === null ? undefined : this.rowsReadOf(query, nth) };
          },
        },
        now: () => this.now,
        setAlarm: (at) => {
          this.alarm = at;
        },
        getAlarm: async () => this.alarm,
        gate: {
          status: async () => {
            this.gateStatusCalls += 1;
            return this.gateStatus;
          },
          fetchRaw: async (url) => {
            this.fetchLog.push({ url, at: this.now });
            const listDate = /kaisai_date=(\d{8})/.exec(url)?.[1];
            if (listDate !== undefined) this.lastListDate = listDate;
            const route = this.routes.get(url) ?? (url.includes("/race/result.html") ? "ok" : httpStatus(404));
            if (route === "ok") return ok(RESULT_OK);
            if (Array.isArray(route)) {
              const list = this.routes.get(url) as GateResult[];
              const first = list[0]!;
              if (list.length > 1) list.shift();
              return first;
            }
            return route as GateResult;
          },
        },
        planProgress: async (date) => {
          this.planCalls += 1;
          const dated = this.planByDate.get(date);
          if (dated !== undefined) return dated;
          if (this.plan instanceof Error) throw this.plan;
          return this.plan;
        },
        archive: {
          saveRaceArchive: async ({ record }) => {
            if (this.saveThrows > 0) {
              this.saveThrows -= 1;
              throw new Error("r2 down");
            }
            const next = this.saveResults.length > 0 ? this.saveResults.shift()! : ({ status: "saved", key: `race-results/${record.raceId}.json.gz`, dbSizeBytes: 24_000_000 } as SaveRaceArchiveResult);
            if (next.status === "saved" || next.status === "unchanged") this.saved.push(record.raceId);
            return next;
          },
          getCatalogEntry: async (id) => (this.catalog.has(id) ? ({ raceId: id } as never) : null),
        },
        notify: async (notice) => {
          this.notifyCalls += 1;
          if (this.notifyFailures > 0) {
            this.notifyFailures -= 1;
            throw new Error("discord down");
          }
          this.notices.push(notice);
        },
        log: (line) => this.logs.push(line),
        parseCalendarDates: (html, month) => {
          if (this.throwOnMonth.has(month)) throw new TypeError("想定外の例外(カレンダー)");
          return parseCalendarKaisaiDates(html, month);
        },
        parseListIds: (html) => {
          const ids = parseListRaceIds(html, "central");
          const date = [...this.throwOnDay].find((d) => this.lastListDate === d);
          if (date !== undefined) throw new TypeError("想定外の例外(一覧)");
          return this.listIdsOverride ?? ids;
        },
        buildRecord: (_html, raceId): BuildResult =>
          this.throwOnRace.has(raceId)
            ? (() => {
                throw new TypeError("想定外の例外(結果)");
              })()
            : this.rejectRace.has(raceId)
            ? { ok: false, category: "結果未確定", detail: "x" }
            : ({ ok: true, record: { raceId, date: "2026-11-03", kind: "central", parserVersion: 2 } } as unknown as BuildResult),
      },
      this.options,
    );
  }

  site(input: { calendars?: Record<string, string[]>; lists?: Record<string, string[]>; results?: Record<string, Route> }): void {
    for (const [month, dates] of Object.entries(input.calendars ?? {})) this.routes.set(calUrl(month), ok(mkCalendar(dates)));
    for (const [date, ids] of Object.entries(input.lists ?? {})) this.routes.set(listUrl(date), ok(mkList(ids)));
    for (const [id, route] of Object.entries(input.results ?? {})) this.routes.set(resultUrlOf(id), Array.isArray(route) ? [...route] : route);
  }

  /** アラームを 1 回だけ発火する(時計をアラームの時刻まで進める。遅れて起きたことにはしない)。 */
  async fire(): Promise<boolean> {
    if (this.alarm === null) return false;
    this.now = Math.max(this.now, this.alarm);
    this.alarm = null;
    await this.core.runNextStep();
    return true;
  }

  /** `untilMs` までのアラームを発火し続ける。 */
  async runUntil(untilMs: number, maxSteps = 5000): Promise<number> {
    let steps = 0;
    while (this.alarm !== null && this.alarm <= untilMs && steps < maxSteps) {
      await this.fire();
      steps += 1;
    }
    expect(steps, "ステップ数の暴走がない").toBeLessThan(maxSteps);
    return steps;
  }

  urls(): string[] {
    return this.fetchLog.map((f) => f.url);
  }
  get resultFetches(): string[] {
    return this.urls().filter((u) => u.includes("/race/result.html"));
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

/** 標準の筋書き: 2026-11 のカレンダーに 11/01・11/03・今日(11/05)。11/03 に 3 レース、11/01 に 1 レース。 */
function standard(w: World): { a: string[]; b: string[] } {
  const a = [rid(1, 1), rid(1, 2), rid(1, 3)];
  const b = [rid(2, 1)];
  w.site({ calendars: { "2026-11": ["20261101", "20261103", "20261105"] }, lists: { "20261103": a, "20261101": b } });
  return { a, b };
}

describe("classifyCentralDay(計画の中央の行から開催日かを決める)", () => {
  it.each([
    ["中央の一覧が 1 件以上 → 開催日", { stage: "done", venues: [{ venue: "central", state: "ok", listed: 12 }] }, "kaisai"],
    ["中央の一覧が取れて 0 件 → 開催日ではない", { stage: "done", venues: [{ venue: "central", state: "ok", listed: 0 }] }, "not-kaisai"],
    ["中央の取得が失敗 → 判定不能", { stage: "done", venues: [{ venue: "central", state: "failed", listed: null }] }, "unknown"],
    ["中央が pending → 判定不能", { stage: "pending", venues: [{ venue: "central", state: "pending", listed: null }] }, "unknown"],
    ["計画が無い(venues が空)→ 判定不能", { stage: "none", venues: [] }, "unknown"],
    ["ok だが listed が null → 判定不能", { stage: "done", venues: [{ venue: "central", state: "ok", listed: null }] }, "unknown"],
    ["地方の行だけ → 判定不能", { stage: "done", venues: [{ venue: "nar", state: "ok", listed: 8 }] }, "unknown"],
  ] as const)("%s", (_name, progress, expected) => {
    expect(classifyCentralDay(progress as PlanProgressLike)).toBe(expected);
  });
});

describe("isArchiveFetchDisabled(取得を止める var。完全一致の \"0\" だけ)", () => {
  it.each([
    ["0", true],
    [" 0 ", true],
    ["00", false],
    ["", false],
    ["1", false],
    ["off", false],
    [undefined, false],
  ] as [string | undefined, boolean][])("%j → %s", (value, expected) => {
    expect(isArchiveFetchDisabled(value)).toBe(expected);
  });
});

describe("inArchiveWindow(JST 0:00 以上 8:30 未満)", () => {
  it.each([
    ["0:00:00", jst(11, 5, 0, 0, 0), true],
    ["8:29:59", jst(11, 5, 8, 29, 59), true],
    ["8:30:00", jst(11, 5, 8, 30, 0), false],
    ["23:59:59", jst(11, 5, 23, 59, 59), false],
    ["前日 23:59:59", jst(11, 4, 23, 59, 59), false],
  ])("%s → %s", (_name, at, expected) => {
    expect(inArchiveWindow(at, 0, 8 * 60 + 30)).toBe(expected);
  });
});

describe("11/4 0:00 JST より前には取らない", () => {
  it("開始時刻は 2026-11-03T15:00:00Z(11/4 0:00 JST)", () => {
    expect(ARCHIVE_NOT_BEFORE_MS).toBe(Date.UTC(2026, 10, 3, 15, 0, 0));
    expect(ARCHIVE_NOT_BEFORE_MS).toBe(jst(11, 4, 0));
  });
  it("開始前に kick するとアラームは開始時刻。アラームが起きても gate・計画・保存に一切触れず、アラームを開始時刻に張り直す", async () => {
    const w = mk({}); // 既定の fromMonth・既定の開始時刻
    standard(w);
    w.now = jst(11, 3, 23, 59, 59);
    await w.core.kick();
    expect(w.alarm).toBe(ARCHIVE_NOT_BEFORE_MS);
    w.now = jst(11, 3, 3, 0); // アラームが早く起きた場合の想定(時間帯の中でも、開始時刻の前なら取らない)
    await w.core.runNextStep();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.gateStatusCalls).toBe(0);
    expect(w.planCalls).toBe(0);
    expect(w.alarm).toBe(ARCHIVE_NOT_BEFORE_MS);
  });
  it("開始時刻ちょうどには動き出す(カレンダーを取る)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.now = ARCHIVE_NOT_BEFORE_MS - 1;
    await w.core.kick();
    expect(w.alarm).toBe(ARCHIVE_NOT_BEFORE_MS);
    await w.fire();
    expect(w.fetchLog.length).toBeGreaterThan(0);
    expect(w.fetchLog[0]!.at).toBe(ARCHIVE_NOT_BEFORE_MS);
  });
});

describe("時間帯", () => {
  it("8:29:59 には取り、8:30:00 には取らず次の 0:00 にアラームを張る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.now = jst(11, 5, 8, 29, 59);
    w.alarm = w.now;
    await w.fire();
    expect(w.fetchLog).toHaveLength(1); // 前提: 取る対象があり、時間帯の中では取る
    const before = w.fetchLog.length;
    w.now = jst(11, 5, 8, 30, 0);
    w.alarm = w.now;
    await w.fire();
    expect(w.fetchLog).toHaveLength(before);
    expect(w.alarm).toBe(jst(11, 6, 0));
  });
  it("23:59:59 には取らず、0:00:00 のアラームを張る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.now = jst(11, 5, 23, 59, 59);
    w.alarm = w.now;
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(jst(11, 6, 0));
  });
});

describe("中央の開催日の朝は取らない", () => {
  it("計画が開催日なら、リクエストは 0 件で次の日の 0:00 に張る。状態にも理由が出る", async () => {
    const w = mk();
    standard(w);
    w.plan = KAISAI;
    await w.core.kick();
    await w.fire();
    expect(w.planCalls).toBe(1);
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(jst(11, 6, 0));
    expect((await w.core.getStatus()).waitReason).toBe("kaisai-day");
  });
  it("開催日の判定は夜ごとに 1 回だけ(同じ夜の 2 回目のステップは計画を引き直さない)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    await w.core.kick();
    await w.runUntil(T0 + 5 * MIN);
    expect(w.fetchLog.length).toBeGreaterThan(2); // 前提: 取得が複数回進んだ
    expect(w.planCalls).toBe(1);
  });
  it("計画が開催日ではないなら取る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(1);
  });
  it.each([
    ["計画の取得が失敗", new Error("rpc")],
    ["計画が無い", { stage: "none", venues: [] } as PlanProgressLike],
  ])("判定不能(%s)は休む。10 分後に引き直し、8:30 まで判定できなければその晩は取らない", async (_name, plan) => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.plan = plan;
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(T0 + 10 * MIN);
    await w.runUntil(jst(11, 5, 23, 0));
    expect(w.fetchLog).toHaveLength(0);
    expect(w.planCalls).toBeGreaterThan(40); // 10 分おきに 8:30 まで
    expect(w.alarm).toBe(jst(11, 6, 0));
  });
  it("判定不能だったが 10 分後に計画が非開催日と分かれば、そこから取る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.plan = new Error("rpc");
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    w.plan = NOT_KAISAI;
    await w.fire();
    expect(w.fetchLog).toHaveLength(1);
  });
  it.each([
    ["カレンダーに翌日(11/06)がある", ["20261101", "20261103", "20261105", "20261106"], false],
    ["カレンダーに翌日(11/06)が無い(対照)", ["20261101", "20261103", "20261105"], true],
  ])("計画が「開催日ではない」と言っても、カレンダーで集めた開催日に今日があれば休む(休む方向だけの補助): %s", async (_name, dates, fetchesYesterdayList) => {
    const w = mk({ fromMonth: "2026-11" });
    w.site({ calendars: { "2026-11": dates }, lists: { "20261103": [rid(1, 1)], "20261101": [rid(2, 1)], "20261105": [rid(3, 1)] } });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59)); // 11/05 の夜: カレンダーを取り込む(計画は非開催日)
    const before = w.fetchLog.length;
    expect(before).toBeGreaterThan(0); // 前提: 11/05 の夜に取得が進んだ
    expect(w.sql.exec("SELECT COUNT(*) AS n FROM ra_day WHERE date = '20261106'").toArray()[0].n).toBe(dates.includes("20261106") ? 1 : 0);
    await w.runUntil(jst(11, 6, 23, 59)); // 11/06 の夜: 計画は NOT_KAISAI のまま
    expect(w.planCalls).toBeGreaterThanOrEqual(2);
    if (fetchesYesterdayList) {
      expect(w.urls().slice(before)).toContain(listUrl("20261105"));
    } else {
      expect(w.fetchLog).toHaveLength(before);
      expect(w.urls()).not.toContain(listUrl("20261105"));
      expect(w.alarm).toBe(jst(11, 7, 0));
    }
  });
});

describe("取る順(新しい月 → 新しい開催日。結果を全部取ってから次の日の一覧)", () => {
  it("カレンダー(今月 → 先月)→ 新しい日の一覧 → その日の結果(一覧の順)→ 次の日の一覧 → 結果。今日の分は取らない", async () => {
    const w = mk({ fromMonth: "2026-10" });
    const { a, b } = standard(w);
    w.site({ calendars: { "2026-10": ["20261025"] }, lists: { "20261025": [rid(3, 1)] } });
    await w.core.kick();
    await w.runUntil(T0 + 8 * HOUR);
    expect(w.urls()).toEqual([
      calUrl("2026-11"),
      calUrl("2026-10"),
      listUrl("20261103"),
      ...a.map(resultUrlOf),
      listUrl("20261101"),
      ...b.map(resultUrlOf),
      listUrl("20261025"),
      resultUrlOf(rid(3, 1)),
    ]);
    expect(w.urls().some((u) => u.includes("20261105"))).toBe(false);
  });
  it("リクエストの間隔は 5 秒以上(開始から開始まで)で、早く起きたステップは出さない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    await w.core.kick();
    await w.runUntil(T0 + HOUR);
    expect(ARCHIVE_REQUEST_INTERVAL_MS).toBe(5000);
    expect(w.fetchLog.length).toBeGreaterThan(5);
    for (let i = 1; i < w.fetchLog.length; i++) {
      expect(w.fetchLog[i]!.at - w.fetchLog[i - 1]!.at).toBeGreaterThanOrEqual(5000);
    }
    // 早く起きた(2 秒後)ステップは何も出さず、残りの 3 秒後にアラームを張り直す
    const n = w.fetchLog.length;
    const last = w.fetchLog[n - 1]!.at;
    w.now = last + 2000;
    w.alarm = w.now;
    await w.fire();
    expect(w.fetchLog).toHaveLength(n);
    expect(w.alarm).toBe(last + 5000);
  });
  it("取り終えたら次の日の 0:00 に張る(追いつき済み)。翌晩はカレンダーの取り直しから", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    const total = w.fetchLog.length;
    expect(total).toBe(1 + 2 + 3 + 1); // 前提: カレンダー 1・一覧 2・結果 3+1
    expect(w.alarm).toBe(jst(11, 6, 0));
    expect((await w.core.getStatus()).waitReason).toBe("caught-up");
    w.site({ calendars: { "2026-11": ["20261101", "20261103", "20261105", "20261106"] } });
    await w.runUntil(jst(11, 6, 3));
    expect(w.urls().slice(total, total + 2)).toEqual([calUrl("2026-11"), listUrl("20261105")]);
  });
});

describe("目録にあるレースは取らない", () => {
  it("目録にあるレースは結果を取らず、間を空けずに次へ進む(同じステップで)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.catalog.add(a[0]!);
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.resultFetches).not.toContain(resultUrlOf(a[0]!));
    expect(w.resultFetches).toContain(resultUrlOf(a[1]!));
    expect(w.resultFetches).toHaveLength(3); // a の残り 2 + b の 1
    // 目録で飛ばしたレースの直後の取得は、5 秒より早く出てもよい(リクエストではない)が、リクエストどうしは 5 秒以上
    const listAt = w.fetchLog.find((f) => f.url === listUrl("20261103"))!.at;
    const firstResult = w.fetchLog.find((f) => f.url === resultUrlOf(a[1]!))!.at;
    expect(firstResult - listAt).toBe(5000);
  });
});

describe("保存", () => {
  it("取れた結果は record と html を保存に渡す。saved・unchanged のどちらも完了として数える", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.saveResults = [
      { status: "saved", key: "k", dbSizeBytes: 1 },
      { status: "unchanged", key: "k", dbSizeBytes: 2 },
    ];
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.saved).toEqual([a[0], a[1], a[2], rid(2, 1)]);
    const s = await w.core.getStatus();
    expect(s.totals.races.done).toBe(4);
    expect(s.night.saved).toBe(4);
    expect(s.dbSizeBytes).toBe(24_000_000);
  });
  it("実物の結果ページ(天皇賞・秋 202105040811)を読んで保存に渡す(buildRaceRecord は本物)", async () => {
    const w = mk({ fromMonth: "2021-11" });
    // 本物の buildRaceRecord を使う。2021-11 のカレンダーは実物。一覧は 1 件だけにして、結果は実物のページを返す
    const html = loadFixture("history_central_result_202105040811.html");
    const got: { record: { raceId: string; parserVersion: number } | null } = { record: null };
    const core = new RaceArchiveFetchCore(
      {
        sql: w.sql,
        now: () => w.now,
        setAlarm: (at) => {
          w.alarm = at;
        },
        getAlarm: async () => w.alarm,
        gate: {
          status: async () => w.gateStatus,
          fetchRaw: async (url) => {
            w.fetchLog.push({ url, at: w.now });
            if (url === calUrl("2021-11")) return ok(loadFixture("history_central_calendar_2021_11.html"));
            if (url === listUrl("20211107")) return ok(mkList(["202105040811"]));
            if (url === resultUrlOf("202105040811")) return ok(html);
            return httpStatus(404);
          },
        },
        planProgress: async () => NOT_KAISAI,
        archive: {
          saveRaceArchive: async ({ record }) => {
            got.record = { raceId: record.raceId, parserVersion: record.parserVersion };
            return { status: "saved", key: "k", dbSizeBytes: 1 };
          },
          getCatalogEntry: async () => null,
        },
        notify: async () => {},
        log: () => {},
      },
      { fromMonth: "2021-11", notBeforeMs: 0 },
    );
    w.now = Date.UTC(2021, 10, 8, 15, 0); // 2021-11-09 0:00 JST: 11/07 までが対象
    await core.kick();
    for (let i = 0; i < 40 && w.alarm !== null; i++) {
      w.now = Math.max(w.now, w.alarm);
      w.alarm = null;
      await core.runNextStep();
    }
    // 前提: 11/07 の一覧が取られ、その中の 1 件の結果まで進んだ
    expect(w.urls()).toContain(listUrl("20211107"));
    expect(w.urls()).toContain(resultUrlOf("202105040811"));
    expect(got.record).toEqual({ raceId: "202105040811", parserVersion: RACE_RECORD_PARSER_VERSION });
  });
});

describe("止められたとき(HTTP 400・403・429)", () => {
  it.each([400, 403, 429])("HTTP %i: その場で止め(リクエストは出さない)、Discord に 1 回、その晩は取らない。次の晩に 1 度だけ自動で再開する", async (status) => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: [httpStatus(status), ok(RESULT_OK)] } });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    // 前提: 結果の最初の 1 件で止められた(カレンダー・一覧・結果の 3 リクエスト)
    expect(w.urls()).toEqual([calUrl("2026-11"), listUrl("20261103"), resultUrlOf(a[0]!)]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ kind: "refused", httpStatus: status, willAutoResume: true });
    const s = await w.core.getStatus();
    expect(s.state).toBe("night-stopped");
    expect(w.alarm).toBe(jst(11, 6, 0));
    // 次の晩: 自動で再開して取り続ける
    await w.runUntil(jst(11, 6, 3));
    expect(w.resultFetches[0]).toBe(resultUrlOf(a[0]!));
    expect(w.saved).toContain(a[0]);
    expect((await w.core.getStatus()).state).toBe("running");
  });
  it("自動で再開したあとにまた止められたら、手で再開するまで動かさない(何晩たっても取らない)。resume で再開できる", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: [httpStatus(403), httpStatus(403), ok(RESULT_OK)] } });
    await w.core.kick();
    await w.runUntil(jst(11, 8, 12)); // 3 晩
    expect(w.resultFetches).toEqual([resultUrlOf(a[0]!), resultUrlOf(a[0]!)]); // 1 晩目と自動再開の 2 晩目
    expect(w.notices.map((n) => (n.kind === "refused" ? n.willAutoResume : null))).toEqual([true, false]);
    expect((await w.core.getStatus()).state).toBe("manual-stopped");
    expect(w.alarm).toBeNull();
    // 手で再開
    w.now = jst(11, 9, 1);
    const r = await w.core.resume();
    expect(r.resumed).toBe(true);
    expect(w.alarm).not.toBeNull();
    await w.runUntil(jst(11, 9, 8));
    expect(w.saved).toContain(a[0]);
    expect((await w.core.getStatus()).state).toBe("running");
  });
  it("再開した晩を拒否なしで走り切ったら、自動再開の権利が戻る(別の機会の停止でもう 1 度自動で再開する)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: [httpStatus(403), ok(RESULT_OK)], [a[1]!]: [ok(RESULT_OK), httpStatus(429), ok(RESULT_OK)] } });
    await w.core.kick();
    await w.runUntil(jst(11, 6, 8, 29)); // 11/5 に停止 → 11/6 に自動再開して走り切る
    expect((await w.core.getStatus()).autoResume.used).toBe(true);
    w.site({ calendars: { "2026-11": ["20261101", "20261103", "20261105", "20261106"] }, lists: { "20261105": [rid(4, 1), rid(4, 2)] } });
    w.site({ results: { [rid(4, 1)]: [httpStatus(429), ok(RESULT_OK)] } });
    await w.runUntil(jst(11, 7, 8, 29)); // 11/7 の夜に入った時点で権利が戻り、11/7 に別の拒否 → また自動再開の対象
    const s = await w.core.getStatus();
    expect(s.state).toBe("night-stopped");
    expect(w.notices.filter((n) => n.kind === "refused")).toHaveLength(2);
    expect(w.notices.filter((n) => n.kind === "refused").every((n) => n.kind === "refused" && n.willAutoResume)).toBe(true);
  });
  it("gate のブレーカーが開いている(誰かが止められた)ときは、自分の停止ではない: 取らず、解除の 1 分後まで待つ。通知もしない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.gateStatus = { blockedUntil: T0 + 20 * MIN, consecutiveRefusals: 2, lastStartAt: T0 - 10 * MIN, pending: 0 };
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(T0 + 21 * MIN);
    expect(w.notices).toHaveLength(0);
    expect((await w.core.getStatus()).state).toBe("running");
  });
  it("gate の応答 blocked(出す直前に開いた)も自分の停止ではない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.routes.set(calUrl("2026-11"), refusedBy("blocked", { blockedUntil: T0 + 30 * MIN }));
    await w.core.kick();
    await w.fire();
    expect(w.notices).toHaveLength(0);
    expect(w.alarm).toBe(T0 + 31 * MIN);
    expect((await w.core.getStatus()).state).toBe("running");
  });
  it("受信済みの 403 を伴う bad-response(圧縮された 403)も、止められたとして扱う", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.routes.set(calUrl("2026-11"), refusedBy("bad-response", { status: 403 }));
    await w.core.kick();
    await w.fire();
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ kind: "refused", httpStatus: 403 });
  });
});

describe("gate を巻き込まないための事前確認", () => {
  it("拒否の連続回数が 1 以上で、最後の開始が 30 分以内なら取らず、最後の開始の 30 分後に張る(自分が 2 回目になってブレーカーを開かせない)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.gateStatus = { blockedUntil: null, consecutiveRefusals: 1, lastStartAt: T0 - 10 * MIN, pending: 0 };
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(T0 - 10 * MIN + 30 * MIN);
  });
  it("拒否の連続回数が 1 でも、最後の開始が 30 分より前なら古い拒否とみなして取る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.gateStatus = { blockedUntil: null, consecutiveRefusals: 1, lastStartAt: T0 - 31 * MIN, pending: 0 };
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(1);
  });
  it.each([
    [2, 0, 30_000],
    [5, 0, 30_000],
  ])("待ち(進行中+待ち)が %i 件なら取らず 30 秒後に見直す", async (pending, _x, delay) => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.gateStatus = { blockedUntil: null, consecutiveRefusals: 0, lastStartAt: null, pending };
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.alarm).toBe(T0 + delay);
  });
  it("待ちが 1 件なら取る(1 件までは並べてよい)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.gateStatus = { blockedUntil: null, consecutiveRefusals: 0, lastStartAt: null, pending: 1 };
    await w.core.kick();
    await w.fire();
    expect(w.fetchLog).toHaveLength(1);
  });
  it("gate の応答 queue-full は 1 分後に見直す(失敗には数えない)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.routes.set(calUrl("2026-11"), refusedBy("queue-full"));
    await w.core.kick();
    await w.fire();
    expect(w.alarm).toBe(T0 + MIN);
    expect((await w.core.getStatus()).night.failed).toBe(0);
  });
});

describe("容量・柵で止まる", () => {
  it.each([
    ["db-size", { status: "skipped", reason: "db-size", dbSizeBytes: 400_000_001 } as SaveRaceArchiveResult],
    ["db-size-unknown", { status: "skipped", reason: "db-size-unknown", dbSizeBytes: null } as SaveRaceArchiveResult],
  ])("%s: 手で再開するまで止まり、Discord に 1 回。そのレースは未完のまま。resume で再開すると、まだ超えていれば再度止まる", async (reason, skipped) => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.saveResults = [skipped, skipped];
    await w.core.kick();
    await w.runUntil(jst(11, 7, 12));
    expect(w.resultFetches).toEqual([resultUrlOf(a[0]!)]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ kind: "capacity", reason });
    expect((await w.core.getStatus()).state).toBe("capacity-stopped");
    expect(w.alarm).toBeNull();
    w.now = jst(11, 8, 1);
    await w.core.resume();
    await w.runUntil(jst(11, 8, 2));
    expect(w.resultFetches).toEqual([resultUrlOf(a[0]!), resultUrlOf(a[0]!)]); // 同じレースをもう一度
    expect(w.notices.filter((n) => n.kind === "capacity")).toHaveLength(2);
    expect((await w.core.getStatus()).state).toBe("capacity-stopped");
  });
  it("容量の停止から resume したあと、保存できれば続きから進む", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.saveResults = [{ status: "skipped", reason: "db-size", dbSizeBytes: 400_000_001 }];
    await w.core.kick();
    await w.runUntil(T0 + HOUR);
    expect((await w.core.getStatus()).state).toBe("capacity-stopped");
    await w.core.resume();
    await w.runUntil(T0 + 3 * HOUR);
    expect(w.saved).toEqual([a[0], a[1], a[2], rid(2, 1)]);
  });
  it("r2-fence: 次の晩に自動で再開する。自動再開の権利は使わない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.saveResults = [{ status: "skipped", reason: "r2-fence", dbSizeBytes: 1 }];
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect((await w.core.getStatus()).state).toBe("night-stopped");
    expect(w.notices[0]).toMatchObject({ kind: "r2-fence" });
    await w.runUntil(jst(11, 6, 3));
    expect(w.saved).toContain(a[0]);
    expect((await w.core.getStatus()).autoResume.used).toBe(false);
  });
});

describe("止められたのではない失敗", () => {
  it("404 の結果は、その晩はもう取らず他のレースへ進む。3 晩試して駄目なら諦める(以後取らない)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: httpStatus(404) } });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(1);
    expect(w.saved).toEqual([a[1], a[2], rid(2, 1)]);
    expect(w.notices).toHaveLength(0);
    await w.runUntil(jst(11, 8, 23, 59)); // 2 晩目・3 晩目・それ以降
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(3);
    expect((await w.core.getStatus()).totals.races.dead).toBe(1);
  });
  it("連続失敗の上限の定数は 10(境界の値をリテラルで固定する: 9 件で止まらず、10 件で止まる)", () => {
    expect(ARCHIVE_CONSECUTIVE_FAILURE_LIMIT).toBe(10);
  });
  it(`5xx が連続 ${ARCHIVE_CONSECUTIVE_FAILURE_LIMIT} 件になったらその晩は止め、Discord に 1 回。止められたとは数えず(状態は running)、次の晩は普通に動く`, async () => {
    const w = mk({ fromMonth: "2026-11" });
    const ids = Array.from({ length: 12 }, (_, i) => rid(1, i + 1));
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": ids }, results: Object.fromEntries(ids.map((id) => [id, [httpStatus(500), ok(RESULT_OK)] as GateResult[]])) });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches).toHaveLength(10);
    expect(w.notices.map((n) => n.kind)).toEqual(["failures"]);
    expect((await w.core.getStatus()).state).toBe("running");
    expect(w.alarm).toBe(jst(11, 6, 0));
    await w.runUntil(jst(11, 6, 3));
    expect(w.saved.length).toBeGreaterThan(0); // 次の晩は普通に動く
    expect((await w.core.getStatus()).autoResume.used).toBe(false);
  });
  it("失敗が 9 件続いたあと 1 件成功すれば数え直し、止まらない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const ids = Array.from({ length: 12 }, (_, i) => rid(1, i + 1));
    const route: Record<string, GateResult> = {};
    ids.forEach((id, i) => (route[id] = i === 9 ? ok(RESULT_OK) : httpStatus(500)));
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": ids }, results: route });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.notices).toHaveLength(0);
    expect(w.resultFetches).toHaveLength(12);
  });
  it("結果が未確定などの構造の異常は、記録したうえで以後は取らない(何晩たっても 1 回)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.rejectRace.add(a[1]!);
    await w.core.kick();
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[1]!))).toHaveLength(1);
    const s = await w.core.getStatus();
    expect(s.totals.races.skipped).toBe(1);
    expect(s.skippedByClass).toEqual({ 結果未確定: 1 });
  });
  it("保存が例外のときは、そのレースの失敗として数える(止まらない。その晩はそのレースを取り直さず、他へ進む)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.saveThrows = 1;
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    const s = await w.core.getStatus();
    expect(s.state).toBe("running");
    expect(w.notices).toHaveLength(0);
    expect(s.night.failed).toBe(1);
    expect(w.saved).toEqual([a[1], a[2], rid(2, 1)]); // 最初の 1 件だけ失敗し、他は保存された
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(1);
  });
});

describe("通知の再送", () => {
  it("送信に失敗したら 10 分後に再送する。成功したあとは送らない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: [httpStatus(403), ok(RESULT_OK)] } });
    w.notifyFailures = 1;
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.notifyCalls).toBe(2);
    expect(w.notices).toHaveLength(1);
  });
  it("3 回失敗したら諦める(止まったままの状態は変わらない)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.site({ results: { [a[0]!]: httpStatus(403) } });
    w.notifyFailures = 99;
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.notifyCalls).toBe(3);
    expect(w.notices).toHaveLength(0);
    expect((await w.core.getStatus()).state).toBe("night-stopped");
  });
});

describe("上書きの設定と、状態の持ち越し", () => {
  it("無効(disabled)なら何もしない: kick もアラームを張らず、ステップも何にも触れない。状態は disabled", async () => {
    const w = mk({ fromMonth: "2026-11", disabled: true });
    standard(w);
    await w.core.kick();
    expect(w.alarm).toBeNull();
    await w.core.runNextStep();
    expect(w.fetchLog).toHaveLength(0);
    expect(w.gateStatusCalls).toBe(0);
    expect(w.planCalls).toBe(0);
    expect((await w.core.getStatus()).state).toBe("disabled");
  });
  it("1 晩の件数の上限(下げる方向の上書き)に達したら、その晩はそれ以上出さず次の 0:00 に張る", async () => {
    const w = mk({ fromMonth: "2026-11", nightlyLimit: 3 });
    standard(w);
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.fetchLog).toHaveLength(3);
    expect(w.alarm).toBe(jst(11, 6, 0));
    await w.runUntil(jst(11, 6, 1));
    expect(w.fetchLog.length).toBeGreaterThan(3); // 次の晩は続きから
  });
  it("DO が作り直されても(同じ SQLite で新しいコア)続きから進む: カレンダー・一覧を取り直さない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    await w.core.kick();
    for (let i = 0; i < 4; i++) await w.fire(); // カレンダー・一覧・結果 2 件
    expect(w.fetchLog).toHaveLength(4);
    w.core = w.makeCore();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.urls().filter((u) => u === calUrl("2026-11"))).toHaveLength(1);
    expect(w.urls().filter((u) => u === listUrl("20261103"))).toHaveLength(1);
    expect(w.saved).toEqual([a[0], a[1], a[2], rid(2, 1)]);
  });
  it("手で再開(resume)は、止まっていないときは何もしない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    const r = await w.core.resume();
    expect(r.resumed).toBe(false);
  });
  it("一覧が異常(中央の一覧に race_id が 0 件)の日は、その晩は飛ばして他へ進み、3 晩で諦める", async () => {
    const w = mk({ fromMonth: "2026-11" });
    w.site({ calendars: { "2026-11": ["20261101", "20261103"] }, lists: { "20261103": [], "20261101": [rid(2, 1)] } });
    w.routes.set(listUrl("20261103"), ok(`<div class="RaceList_Body"></div>`));
    await w.core.kick();
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.urls().filter((u) => u === listUrl("20261103"))).toHaveLength(3);
    expect(w.saved).toEqual([rid(2, 1)]);
    expect((await w.core.getStatus()).totals.days.dead).toBe(1);
  });
});

describe("読み取りが想定外の例外を投げたとき(同じページを延々と取り直さない)", () => {
  it("結果: 読み取りが投げたレースは、その晩に 1 回しか取らず、他のレースへ進む。3 晩で dead。止まらない(状態 running)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.throwOnRace.add(a[0]!);
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(1);
    expect(w.saved).toEqual([a[1], a[2], rid(2, 1)]); // 他のレースは保存された(前提: 無限に取り直していない)
    expect((await w.core.getStatus()).state).toBe("running");
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(3);
    expect((await w.core.getStatus()).totals.races.dead).toBe(1);
  });
  it("一覧: 読み取りが投げた日は、その晩に 1 回しか取らず、他の日へ進む。3 晩で dead", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    w.throwOnDay.add("20261103");
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.urls().filter((u) => u === listUrl("20261103"))).toHaveLength(1);
    expect(w.saved).toEqual([rid(2, 1)]); // 11/01 の分は進んだ
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.urls().filter((u) => u === listUrl("20261103"))).toHaveLength(3);
    // 11/03 は dead(11/05 は、後の晩に「今日より前」になって一覧の経路が無く 404 で、同じく 3 晩で dead になるので、日ごとに見る)
    expect(w.sql.exec("SELECT status FROM ra_day WHERE date = '20261103'").toArray()[0].status).toBe("dead");
    expect(w.sql.exec("SELECT status FROM ra_day WHERE date = '20261101'").toArray()[0].status).toBe("done");
  });
  it("カレンダー: 読み取りが投げた月は、その晩に 1 回しか取らず、他の月へ進む。3 晩で dead", async () => {
    const w = mk({ fromMonth: "2026-10" });
    standard(w);
    w.site({ calendars: { "2026-10": ["20261025"] }, lists: { "20261025": [rid(3, 1)] } });
    w.throwOnMonth.add("2026-11");
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.urls().filter((u) => u === calUrl("2026-11"))).toHaveLength(1);
    expect(w.saved).toEqual([rid(3, 1)]); // 先月の分は進んだ
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.urls().filter((u) => u === calUrl("2026-11"))).toHaveLength(3);
    expect((await w.core.getStatus()).totals.months.dead).toBe(1);
  });
  it("URL を組み立てられない ID(不正な race_id)は、リクエストを出さずに失敗として数え、その晩は取り直さず、他のレースへ進む。3 晩で dead", async () => {
    const w = mk({ fromMonth: "2026-11" });
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": [rid(1, 1)] } });
    w.listIdsOverride = ["999999999999", rid(1, 1)];
    await w.core.kick();
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.urls().some((u) => u.includes("999999999999"))).toBe(false); // 不正な ID のリクエストは出していない
    expect(w.saved).toEqual([rid(1, 1)]); // 後ろのレースは保存された(前提: 同じ失敗で足止めされていない)
    expect(w.sql.exec("SELECT status, nights FROM ra_race WHERE race_id = '999999999999'").toArray()[0]).toEqual({ status: "dead", nights: 3 });
    expect((await w.core.getStatus()).state).toBe("running");
  });
  it("読み取りの例外は「連続失敗」に数える: 10 件続けば、その晩は止めて通知する(状態は running のまま)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const ids = Array.from({ length: 12 }, (_, i) => rid(1, i + 1));
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": ids } });
    ids.forEach((id) => w.throwOnRace.add(id));
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches).toHaveLength(10);
    expect(w.notices.map((n) => n.kind)).toEqual(["failures"]);
    expect((await w.core.getStatus()).state).toBe("running");
  });
});

describe("「連続失敗」に数えるもの(5xx・network・timeout・保存の例外・読み取りの例外だけ)", () => {
  const ids = Array.from({ length: 15 }, (_, i) => rid(1, (i % 12) + 1)).map((id, i) => (i < 12 ? id : rid(2, i - 11)));
  it.each([
    ["404", () => httpStatus(404)],
    ["410(それ以外の 4xx)", () => httpStatus(410)],
    ["検査の不合格(結果の表が無いページ)", () => ok("<html>表なし</html>")],
  ])("%s が 15 件続いても止まらない(15 件とも取り、通知なし)", async (_name, make) => {
    const w = mk({ fromMonth: "2026-11" });
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": ids }, results: Object.fromEntries(ids.map((id) => [id, make()])) });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches).toHaveLength(15);
    expect(w.notices).toHaveLength(0);
    expect((await w.core.getStatus()).night.failed).toBe(15);
  });
  it("数えない失敗は連続回数を増やしも戻しもしない: 5xx 9 件 → 404 3 件 → 5xx 1 件 で 10 件目になり止まる", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const all = Array.from({ length: 14 }, (_, i) => rid(1, i + 1 > 12 ? 12 : i + 1)).map((_, i) => (i < 12 ? rid(1, i + 1) : rid(2, i - 11)));
    const results: Record<string, GateResult> = {};
    all.forEach((id, i) => (results[id] = i < 9 ? httpStatus(500) : i < 12 ? httpStatus(404) : httpStatus(500)));
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": all }, results });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect(w.resultFetches).toHaveLength(13); // 9 + 3 + 1 件目(5xx の 10 件目)で止まる
    expect(w.notices.map((n) => n.kind)).toEqual(["failures"]);
  });
});

describe("自動再開の権利は、再開したあとの最初のリクエストで使う", () => {
  it("11/5 に 403 → 11/6 は開催日で 1 件も取らない → 11/7 に取って走り切る → 11/8 には権利が戻っている", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    w.planByDate.set("20261106", KAISAI);
    w.site({ results: { [a[0]!]: [httpStatus(403), ok(RESULT_OK)] } });
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect((await w.core.getStatus()).state).toBe("night-stopped");
    await w.runUntil(jst(11, 6, 23, 59)); // 11/6: 自動再開はするが、開催日の朝で 1 件も取らない
    let st = await w.core.getStatus();
    expect(st.state).toBe("running");
    expect(w.fetchLog.filter((f) => f.at >= jst(11, 6, 0) && f.at < jst(11, 7, 0))).toHaveLength(0); // 前提: 11/6 は 1 件も取っていない
    expect(st.autoResume.used).toBe(false); // まだ権利を使っていない
    await w.runUntil(jst(11, 7, 23, 59)); // 11/7: 取って走り切る
    st = await w.core.getStatus();
    expect(w.fetchLog.filter((f) => f.at >= jst(11, 7, 0) && f.at < jst(11, 8, 0)).length).toBeGreaterThan(0);
    expect(st.autoResume).toEqual({ used: true, resumedNight: "20261107" });
    await w.runUntil(jst(11, 8, 1)); // 11/8 の夜が始まった時点で戻る
    expect((await w.core.getStatus()).autoResume).toEqual({ used: false, resumedNight: null });
  });
});

describe("R2 の柵で止まっている間の通知は、最初の 1 回だけ", () => {
  it("柵で 3 晩続けて止まっても通知は 1 回(毎晩 1 リクエストで確かめる)。保存に成功したあと、また柵で止まれば、もう 1 回送る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const { a } = standard(w);
    const fence: SaveRaceArchiveResult = { status: "skipped", reason: "r2-fence", dbSizeBytes: 1 };
    w.saveResults = [fence, fence, fence];
    await w.core.kick();
    await w.runUntil(jst(11, 7, 23, 59)); // 3 晩とも、a[0] の保存で柵
    expect(w.resultFetches.filter((u) => u === resultUrlOf(a[0]!))).toHaveLength(3); // 毎晩 1 リクエストで確かめている
    expect(w.notices.filter((n) => n.kind === "r2-fence")).toHaveLength(1);
    // 4 晩目は柵が解けて保存でき、5 つ目の保存でまた柵になる
    const saved: SaveRaceArchiveResult = { status: "saved", key: "k", dbSizeBytes: 1 };
    w.saveResults = [saved, fence];
    await w.runUntil(jst(11, 8, 23, 59));
    expect(w.notices.filter((n) => n.kind === "r2-fence")).toHaveLength(2);
  });
});

describe("DO の SQLite の書き込み(1 晩 6,000 件の取得でも、無料枠の書き込み行数に収める)", () => {
  const writesOf = (w: World, from: number): string[] => w.sql.statements.slice(from).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));

  it("定常の結果 1 件(取得 → 読み取り → 保存)の書き込み文は 4 文以下(最後の開始時刻・その晩の件数 2 つ・レースの完了)。変わらない値は書かない", async () => {
    const w = mk({ fromMonth: "2026-11" });
    const ids = Array.from({ length: 6 }, (_, i) => rid(1, i + 1));
    w.site({ calendars: { "2026-11": ["20261103"] }, lists: { "20261103": ids } });
    await w.core.kick();
    // カレンダー・一覧と、結果 2 件(夜の初期化・最初の保存の書き込みを済ませる)
    for (let i = 0; i < 4; i++) await w.fire();
    expect(w.saved).toHaveLength(2); // 前提: ここまでに 2 件保存した
    // 以後の結果 1 件ずつの書き込み文の数を測る
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = w.sql.statements.length;
      const saved = w.saved.length;
      await w.fire();
      expect(w.saved.length, "1 回の fire で結果が 1 件保存される").toBe(saved + 1);
      counts.push(writesOf(w, before).length);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(3); // 下限も固定する(数えそこねて 0 になっていないこと)
  });
  it("同じ値の再設定は書かない(待ちの理由・連続失敗の 0・DB の大きさが変わらないとき)", async () => {
    const w = mk({ fromMonth: "2026-11" });
    standard(w);
    await w.core.kick();
    for (let i = 0; i < 6; i++) await w.fire();
    const metaWrites = w.sql.statements.filter((q) => /^\s*INSERT INTO ra_meta/i.test(q));
    // 同じキーを同じ値で書き直していない: 6 リクエストでの ra_meta への書き込みは、キーごとの変更の回数を超えない(下限の確認つき)
    expect(metaWrites.length).toBeGreaterThan(5);
    expect(metaWrites.length).toBeLessThan(6 * 4 + 12);
  });
});

describe("起床ごとの SQL は表の全部を読まない(Issue #593。DO の rows_read の無料枠が尽きかけた)", () => {
  /** 全走査を許す文(状態の口だけ。起床の経路には出ない)。一覧に無い新しい全走査の文が増えたら落ちる。 */
  const ALLOWED_SCANS: readonly string[] = [
    // 月の表は約 60 行で、起床ごとの月の選択も状態の口の COUNT も全部読んでよい(据え置き)
    "SELECT month FROM ra_month",
    "SELECT COUNT(*) AS n FROM ra_month WHERE status = ?",
    // skipped の分類ごとの件数(状態の口だけ。skipped の行だけを読み、GROUP BY の一時表が要る)
    "SELECT last_class AS cls, COUNT(*) AS n FROM ra_race WHERE status = 'skipped' GROUP BY last_class",
  ];
  const isAllowed = (q: string): boolean => ALLOWED_SCANS.some((a) => q.replace(/\s+/g, " ").trim().startsWith(a));
  const FORBIDDEN = /SCAN ra_race|SCAN ra_day|USE TEMP B-TREE/;

  /** 重ならない妥当な race_id(年 2026・場 01〜10・回 1〜6・日 1〜12・R 1〜12。8,640 通り)。 */
  const validRaceId = (i: number): string => {
    const two = (n: number): string => String(n).padStart(2, "0");
    return `2026${two((i % 10) + 1)}${two((Math.floor(i / 10) % 6) + 1)}${two((Math.floor(i / 60) % 12) + 1)}${two((Math.floor(i / 720) % 12) + 1)}`;
  };

  /** 数千行の表を入れる(race_id は 12 桁、日付は 2026-01〜10)。 */
  function seed(w: World, input: { races: number; pendingRaces: boolean; days: number }): void {
    for (let i = 0; i < input.days; i += 1) {
      const m = String(1 + (i % 10)).padStart(2, "0");
      const d = String(1 + (Math.floor(i / 10) % 28)).padStart(2, "0");
      w.sql.exec("INSERT OR IGNORE INTO ra_day (date, status) VALUES (?, ?)", `2026-${m}-${d}x${i}`, i % 3 === 0 ? "pending" : "done");
    }
    for (let i = 0; i < input.races; i += 1) {
      const m = String(1 + (i % 10)).padStart(2, "0");
      const d = String(1 + (Math.floor(i / 10) % 28)).padStart(2, "0");
      const status = input.pendingRaces && i % 3 === 0 ? "pending" : i % 7 === 0 ? "skipped" : "done";
      w.sql.exec("INSERT INTO ra_race (race_id, date, seq, status, last_class) VALUES (?, ?, ?, ?, ?)", validRaceId(i), `2026-${m}-${d}`, i % 12, status, status === "skipped" ? "結果未確定" : null);
    }
  }

  /** 計画を引く(同じ文が別の束縛で何度も出るので、文の文字列で重複を除く)。 */
  const planOf = (w: World, queries: Iterable<string>): { query: string; plan: string[] }[] =>
    [...new Set(queries)].filter((q) => /^\s*(SELECT|UPDATE|DELETE)\b/i.test(q)).map((query) => ({ query, plan: w.sql.plan(query) }));

  it("レース・日・月を取る夜の全文に全走査と一時表(ORDER BY)が無い。状態の口も、許す一覧の外に全走査が無い", async () => {
    const wake: string[] = [];
    // (1) 取れるレースが残っている夜: 次のレース・closeDayIfDone を通る
    const w1 = mk({ fromMonth: "2026-11" });
    seed(w1, { races: 5000, pendingRaces: true, days: 2000 });
    w1.sql.exec("INSERT INTO ra_day (date, status) VALUES ('2026-01-01', 'listed')");
    w1.site({ calendars: { "2026-11": [] } });
    const from1 = w1.sql.statements.length;
    await w1.core.kick();
    for (let i = 0; i < 40; i += 1) await w1.fire();
    wake.push(...w1.sql.statements.slice(from1));
    // (2) レースが残っていない夜: 次の日(一覧)を通る
    const w2 = mk({ fromMonth: "2026-11" });
    seed(w2, { races: 5000, pendingRaces: false, days: 2000 });
    w2.site({ calendars: { "2026-11": [] } });
    const from2 = w2.sql.statements.length;
    await w2.core.kick();
    for (let i = 0; i < 6; i += 1) await w2.fire();
    wake.push(...w2.sql.statements.slice(from2));
    // 前提を固定する(通っていなければ、検査が空振りする)
    const has = (re: RegExp): boolean => wake.some((q) => re.test(q));
    expect(has(/FROM ra_race WHERE status = 'pending' AND date < \?/)).toBe(true);
    expect(has(/SELECT COUNT\(\*\) AS n FROM ra_race WHERE date = \? AND status = 'pending'/)).toBe(true);
    expect(has(/SELECT date FROM ra_day WHERE status = 'pending'/)).toBe(true);
    expect(has(/UPDATE ra_race SET status = 'done'/)).toBe(true);
    // 状態の口(進捗の読み取り)と停止時の文も集める
    const from3 = w1.sql.statements.length;
    await w1.core.getStatus();
    const statusQueries = w1.sql.statements.slice(from3);
    expect(statusQueries.length).toBeGreaterThanOrEqual(9);

    const all = planOf(w1, [...wake, ...statusQueries, "SELECT COUNT(*) AS n FROM ra_race WHERE status = 'done'"]);
    expect(all.length).toBeGreaterThanOrEqual(10);
    const bad = all.filter((p) => !isAllowed(p.query) && p.plan.some((line) => FORBIDDEN.test(line)));
    expect(bad, `全走査・一時表が残る文: ${JSON.stringify(bad)}`).toEqual([]);
    // 許す一覧の文は、実際に全走査か一時表を使っている(使っていないなら一覧から外す。一覧が不要に広がるのを防ぐ)
    const allowedUsed = all.filter((p) => isAllowed(p.query));
    expect(allowedUsed.length).toBeGreaterThanOrEqual(3);
  });
});

describe("1 晩の読み取り行数の予算(Issue #593 AC-2)", () => {
  const LIMIT = 1000;
  /** 最初の「次のレース」の選択だけが n 行読んだことにする。 */
  const firstRaceSelectReads = (w: World, n: number): void => {
    w.rowsReadOf = (query, nth) => (/FROM ra_race WHERE status = 'pending' AND date < \?/.test(query) && nth === 0 ? n : 0);
  };
  const setup = (): World => {
    const w = mk({ fromMonth: "2026-11", nightlyRowsLimit: LIMIT });
    standard(w);
    return w;
  };

  it("予算ちょうどでは止めない(次の起床でも取る)", async () => {
    const w = setup();
    firstRaceSelectReads(w, LIMIT);
    await w.core.kick();
    await w.runUntil(T0 + 30 * MIN);
    expect((await w.core.getStatus()).state).toBe("running");
    expect(w.notices.filter((n) => n.kind === "rows-budget")).toEqual([]);
    expect(w.saved.length).toBeGreaterThanOrEqual(2);
  });

  it("予算を 1 行超えたら、その晩の取得を止めて通知する(次の晩 0:00 に自動で再開)", async () => {
    const w = setup();
    firstRaceSelectReads(w, LIMIT + 1);
    await w.core.kick();
    await w.runUntil(jst(11, 5, 23, 59));
    expect((await w.core.getStatus()).state).toBe("night-stopped");
    expect(w.saved).toEqual([]); // 最初の「次のレース」の選択(一覧を取った起床。まだ空)で予算を超え、次の起床の先頭で止まった
    const notices = w.notices.filter((n) => n.kind === "rows-budget");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "rows-budget", limit: LIMIT, resumeAt: jst(11, 6, 0) });
    expect((notices[0] as { rowsRead: number }).rowsRead).toBeGreaterThan(LIMIT);
    // 次の晩は 0 から数え直して続きを取る
    w.rowsReadOf = null;
    await w.runUntil(jst(11, 6, 3));
    expect(w.saved.length).toBeGreaterThanOrEqual(3);
    expect((await w.core.getStatus()).night.date).toBe("20261106");
    expect(w.notices.filter((n) => n.kind === "rows-budget")).toHaveLength(1);
  });

  it("rowsRead を返さない SQL(テストの node:sqlite など)では数えず、止めない", async () => {
    const w = setup();
    await w.core.kick();
    await w.runUntil(T0 + 30 * MIN);
    expect((await w.core.getStatus()).night.rowsRead).toBe(0);
    expect(w.notices).toEqual([]);
  });

  it.each([
    [9_999, false],
    [10_000, true],
  ])("起床ごとには書かない: 前回の保存から %i 行増えたとき、保存される = %s", async (n, saved) => {
    const w = mk({ fromMonth: "2026-11", nightlyRowsLimit: 10_000_000 });
    standard(w);
    firstRaceSelectReads(w, n);
    await w.core.kick();
    await w.fire(); // カレンダー
    await w.fire(); // 一覧
    await w.fire(); // 次のレースの選択(n 行)
    const row = w.sql.exec("SELECT value FROM ra_meta WHERE key = 'night_rows_read'").toArray() as { value: string }[];
    expect(row.length === 1 && Number(row[0]!.value) >= n).toBe(saved);
    expect((await w.core.getStatus()).night.rowsRead).toBeGreaterThanOrEqual(n);
  });

  it("DO が作り直されても、保存した値から数え直す(コンストラクタで復元)", async () => {
    const w = mk({ fromMonth: "2026-11", nightlyRowsLimit: 10_000_000 });
    standard(w);
    firstRaceSelectReads(w, 25_000);
    await w.core.kick();
    for (let i = 0; i < 4; i += 1) await w.fire();
    const before = (await w.core.getStatus()).night.rowsRead;
    expect(before).toBeGreaterThanOrEqual(25_000);
    w.core = w.makeCore();
    expect((await w.core.getStatus()).night.rowsRead).toBeGreaterThanOrEqual(25_000);
  });
});

describe("kick: 残ったアラーム(今より 15 分以上前)は無いのと同じに張り直す(#603)", () => {
  const MIN = 60_000;
  /** 状態(mode)を DB に直接置き、キャッシュを捨てるため core を作り直す。 */
  const withMode = (w: World, mode: string, resumeAt = 0): void => {
    w.sql.exec("INSERT INTO ra_meta (key, value) VALUES ('mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mode);
    w.sql.exec("INSERT INTO ra_meta (key, value) VALUES ('resume_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(resumeAt));
    w.core = w.makeCore();
  };
  const now = jst(11, 5, 12, 0);
  const rows: { name: string; alarm: number | null; arms: boolean }[] = [
    { name: "アラームなし", alarm: null, arms: true },
    { name: "今より後", alarm: now + 5 * MIN, arms: false },
    { name: "今より 14 分前", alarm: now - 14 * MIN, arms: false },
    { name: "今より 16 分前", alarm: now - 16 * MIN, arms: true },
  ];
  for (const r of rows) {
    it(`running: ${r.name} → ${r.arms ? "張る" : "張らない"}`, async () => {
      const w = mk({ fromMonth: "2026-11" });
      standard(w);
      w.now = now;
      // アラームなしのときに張る時刻(基準)
      const base = mk({ fromMonth: "2026-11" });
      base.now = now;
      await base.core.kick();
      expect(base.alarm).toBe(jst(11, 6, 0)); // 基準は null でない(比較が自明にならない)
      w.alarm = r.alarm;
      await w.core.kick();
      if (r.arms) {
        expect(w.alarm).toBe(base.alarm);
        expect(w.logs.filter((l) => l.startsWith("race-archive: stale alarm at=")).length).toBe(r.alarm === null ? 0 : 1);
      } else {
        expect(w.alarm).toBe(r.alarm);
        expect(w.logs.some((l) => l.includes("stale alarm"))).toBe(false);
      }
    });
  }
  it("ログは 1 行で、残ったアラームの時刻(ISO)だけを出す", async () => {
    const w = mk({ fromMonth: "2026-11" });
    w.now = now;
    w.alarm = now - 16 * MIN;
    await w.core.kick();
    expect(w.logs.filter((l) => l.includes("stale alarm"))).toEqual([`race-archive: stale alarm at=${new Date(now - 16 * MIN).toISOString()} re-armed`]);
  });
  it("manual-stopped・capacity-stopped: 16 分前の残ったアラームでも張らない(通知の再送が無ければ)", async () => {
    for (const mode of ["manual-stopped", "capacity-stopped"]) {
      const w = mk({ fromMonth: "2026-11" });
      withMode(w, mode);
      w.now = now;
      w.alarm = now - 16 * MIN;
      await w.core.kick();
      expect(w.alarm, mode).toBe(now - 16 * MIN);
      // 張らないので「re-armed」とは書かず、止まっていて張らなかった旨のログにする(#604)
      expect(w.logs.filter((l) => l.includes("stale alarm")), mode).toEqual([`race-archive: stale alarm at=${new Date(now - 16 * MIN).toISOString()} (stopped, not re-armed)`]);
    }
  });
  it("manual-stopped・capacity-stopped: 通知の再送が待っていれば、残ったアラームを張り直し、ログも re-armed(#604)", async () => {
    for (const mode of ["manual-stopped", "capacity-stopped"]) {
      const w = mk({ fromMonth: "2026-11" });
      withMode(w, mode);
      w.sql.exec("INSERT INTO ra_meta (key, value) VALUES ('pending_notice', '{}'), ('notice_retry_at', ?)", String(now + 3 * MIN));
      w.core = w.makeCore();
      w.now = now;
      w.alarm = now - 16 * MIN;
      await w.core.kick();
      expect(w.alarm, mode).toBe(now + 3 * MIN);
      expect(w.logs.filter((l) => l.includes("stale alarm")), mode).toEqual([`race-archive: stale alarm at=${new Date(now - 16 * MIN).toISOString()} re-armed`]);
    }
  });
  it("night-stopped: 残ったアラームのときも max(resume_at, runAt(now)) で張る", async () => {
    const later = jst(11, 7, 0);
    for (const [resumeAt, expected] of [[later, later], [0, jst(11, 6, 0)]] as const) {
      const w = mk({ fromMonth: "2026-11" });
      withMode(w, "night-stopped", resumeAt);
      w.now = now;
      w.alarm = now - 16 * MIN;
      await w.core.kick();
      expect(w.alarm).toBe(expected);
      const none = mk({ fromMonth: "2026-11" });
      withMode(none, "night-stopped", resumeAt);
      none.now = now;
      await none.core.kick();
      expect(none.alarm).toBe(expected); // アラームなしのときと同じ
    }
  });
  it("本番の再現: 11/4 3:48:32 JST のアラームが残り、今が 11/4 21:00 JST なら、次の 0:00 に張る", async () => {
    const w = mk({ fromMonth: "2026-11" });
    w.now = jst(11, 4, 21, 0);
    w.alarm = 1793731712228;
    expect(w.alarm).toBe(jst(11, 4, 3, 48, 32) + 228); // 本番の nextRunAt
    await w.core.kick();
    expect(w.alarm).toBe(jst(11, 5, 0));
  });
});

describe("DO の SQLite: 流れた SQL の実行計画(EXPLAIN QUERY PLAN。Issue #632)", () => {
  /** 全走査・一時の並べ替えを許す文。月の表は 1 年 12 行ほど。status は管理者の status の画面だけが流す(起床の経路の外)。 */
  const EXCEPTIONS: DoPlanException[] = [
    { match: /^SELECT month FROM ra_month WHERE COALESCE\(last_night/, reason: "月の選択。ra_month は月ごとに 1 行(1 年で約 12 行)で、起床のたびに全部読んでも小さい" },
    { match: /^SELECT COUNT\(\*\) AS n FROM ra_month WHERE status = \?/, reason: "status の画面だけ。月ごとに 1 行の表" },
    { match: /^SELECT last_class AS cls, COUNT\(\*\) AS n FROM ra_race WHERE status = 'skipped' GROUP BY last_class/, reason: "status の画面だけ。status の索引で skipped の行に絞ってから一時のグループ化" },
  ];

  it("取得 → 完了・失敗・拒否を通して流れた全部の文(状態の読み取りを含む)に、例外に載せていない全走査・一時の並べ替えが無い。例外は今も該当する", async () => {
    const w = mk({ fromMonth: "2026-10" });
    const { a, b } = standard(w);
    w.site({ calendars: { "2026-10": ["20261025"] }, lists: { "20261025": [rid(3, 1)] } });
    w.rejectRace.add(a[0]!);
    await w.core.kick();
    await w.runUntil(T0 + 8 * HOUR);
    await w.core.getStatus();
    expect(w.resultFetches.length).toBeGreaterThanOrEqual(3); // 前提: 実際に取得まで走っている
    const r = checkDoStatements(w.sql.statements, (q) => w.sql.plan(q), EXCEPTIONS);
    expect(r.checked).toBeGreaterThanOrEqual(15); // 前提: 経路の SQL を集められている(空だと検査が空振りする)
    expect(r.flagged).toBeGreaterThanOrEqual(2); // 前提: 検出が空振りでない(例外の文が実際に引っかかっている)
    expect(r.unexpected).toEqual([]);
    expect(r.stale).toEqual([]);
    void b;
  });
});
