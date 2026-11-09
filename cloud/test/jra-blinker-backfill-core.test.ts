import { afterEach, describe, expect, it } from "vitest";

import {
  BLINKER_BACKFILL_DAILY_ROWS_MAX,
  BLINKER_BACKFILL_GAP_MS,
  BLINKER_BACKFILL_PER_WAKE,
  BLINKER_BACKFILL_ROWS_PER_RACE_MAX,
  BLINKER_BACKFILL_SUBREQUEST_MAX,
  isJraBlinkerBackfillDisabled,
  JraBlinkerBackfillCore,
  type JraBlinkerBackfillOptions,
  type ResultFetchOutcome,
} from "../src/jra-blinker-backfill-core";
import { monthCname, PAST_SEARCH_CNAME } from "../src/jra-result-links";
import type { PastBlinkerStoreLike, SavedPastRace } from "../src/past-blinker-repository";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #698: 過去の結果のブリンカー着用を取る段取り(`JraBlinkerBackfillCore`)。時計・アラーム・JRA への取得・D1 は偽物。DO の SQLite は本物の SQLite(node:sqlite)。
 * JRA の頁は、本物の頁の形(タイトル・リンク・`td.place`・`div.icon.blinker`)に合わせた最小の合成。時刻は JST で書く。
 */

/** 2026-11-<日> <時>:<分>:<秒> JST のエポックミリ秒。 */
const jst = (day: number, h: number, mi = 0, s = 0): number => Date.UTC(2026, 10, day, h - 9, mi, s);

const hid = (n: number): string => `20180${String(n).padStart(5, "0")}`;

// ---- 合成の頁 ----

const pastSearchHtml = (months: string[]): string =>
  `<html><head><title>過去レース結果検索　JRA</title><script>` + months.map((m) => `objParam["${m.slice(2)}"]="${(Number(m.slice(2)) % 256).toString(16).toUpperCase().padStart(2, "0")}";`).join("") + `</script></head><body></body></html>`;
const codeOf = (yyyymm: string): string => (Number(yyyymm.slice(2)) % 256).toString(16).toUpperCase().padStart(2, "0");

interface RaceDef {
  /** 着順の欄の文字(省略は数字)。 */
  readonly head: number;
  readonly blinkers: readonly string[];
  /** 頁を壊す: "param-error" | "no-id" | "too-large"(取得の失敗)。 */
  readonly broken?: "param-error" | "no-id";
}
interface DayDef {
  readonly date: string;
  readonly venue: string;
  readonly kai: string;
  readonly day: string;
  readonly races: readonly RaceDef[];
}

const srlOf = (d: DayDef): string => `pw01srl10${d.venue}${d.date.slice(0, 4)}${d.kai}${d.day}${d.date}/C6`;
const sdeOf = (d: DayDef, r: number): string => `pw01sde10${d.venue}${d.date.slice(0, 4)}${d.kai}${d.day}${String(r + 1).padStart(2, "0")}${d.date}/4F`;
const raceIdOf = (d: DayDef, r: number): string => `${d.date.slice(0, 4)}${d.venue}${d.kai}${d.day}${String(r + 1).padStart(2, "0")}`;

const monthHtml = (days: readonly DayDef[], extra = ""): string =>
  `<html><head><title>過去レース結果検索　JRA</title></head><body>` + days.map((d) => `<a onclick="return doAction('/JRADB/accessS.html', '${srlOf(d)}');">x</a>`).join("") + extra + `</body></html>`;
const dayHtml = (d: DayDef): string =>
  `<html><head><title>レース結果 レース選択　JRA</title></head><body>` + d.races.map((_, i) => `<a href="/JRADB/accessS.html?CNAME=${sdeOf(d, i)}">${i + 1}R</a>`).join("") + `</body></html>`;
const resultHtml = (r: RaceDef): string => {
  if (r.broken === "param-error") return "<html><head><title>パラメータエラー　JRA</title></head></html>";
  const rows = Array.from({ length: r.head }, (_, i) => {
    const id = i < r.blinkers.length ? r.blinkers[i]! : hid(900 + i);
    const link = `<a href="/JRADB/accessU.html?CNAME=pw01dud10${id}/AC">馬</a>`;
    const cell = r.broken === "no-id" && i === 0 ? "馬名" : i < r.blinkers.length ? `<div class="horse">${link}<div class="icon blinker"></div></div>` : link;
    return `<tr><td class="place">${i + 1}</td><td class="horse">${cell}</td></tr>`;
  });
  return `<html><head><title>レース結果　JRA</title></head><body><table><tbody>${rows.join("")}</tbody></table></body></html>`;
};

/** 開催日の世界(月 → 場日)。cname → 頁 の表を作る。 */
class World {
  readonly pages = new Map<string, ResultFetchOutcome>();
  readonly days: DayDef[] = [];
  private nextDay = 1;
  constructor(private readonly months: string[]) {}

  /** 月に 1 場日を足す(開催日の日付は 1 日から順に)。 */
  addDay(yyyymm: string, races: readonly RaceDef[], date?: string): DayDef {
    const d: DayDef = { date: date ?? `${yyyymm}${String(this.nextDay++).padStart(2, "0")}`, venue: "06", kai: "01", day: String(this.days.length + 1).padStart(2, "0"), races };
    this.days.push(d);
    return d;
  }
  build(): void {
    this.pages.set(PAST_SEARCH_CNAME, { kind: "page", html: pastSearchHtml(this.months) });
    for (const m of this.months) {
      const days = this.days.filter((d) => d.date.startsWith(m));
      this.pages.set(monthCname(m, codeOf(m)), { kind: "page", html: monthHtml(days) });
    }
    for (const d of this.days) {
      this.pages.set(srlOf(d), { kind: "page", html: dayHtml(d) });
      d.races.forEach((r, i) => this.pages.set(sdeOf(d, i), { kind: "page", html: resultHtml(r) }));
    }
  }
}

// コアの範囲(202101〜202611)の全部の月に表を持たせる
const ALL_MONTHS: string[] = [];
for (let y = 2021; y <= 2026; y++) for (let m = 1; m <= 12; m++) if (y * 100 + m <= 202611) ALL_MONTHS.push(`${y}${String(m).padStart(2, "0")}`);

class FakeStore implements PastBlinkerStoreLike {
  done = new Set<string>();
  filterCalls: string[][] = [];
  saveCalls: { races: SavedPastRace[]; today: string }[] = [];
  failSave = false;
  async filterDone(ids: readonly string[]): Promise<string[]> {
    this.filterCalls.push([...ids]);
    return ids.filter((id) => this.done.has(id));
  }
  async saveRaces(races: readonly SavedPastRace[], today: string): Promise<number> {
    if (this.failSave) throw new Error("D1 down");
    this.saveCalls.push({ races: [...races], today });
    let changes = 0;
    for (const r of races) {
      if (this.done.has(r.raceId)) continue;
      this.done.add(r.raceId);
      changes += 1 + r.blinkerHorseIds.length;
    }
    return changes;
  }
  savedRows(): number {
    return this.saveCalls.reduce((s, c) => s + c.races.reduce((t, r) => t + 1 + r.blinkerHorseIds.length, 0), 0);
  }
}

class Harness {
  sql: NodeSql = openNodeSql();
  now = jst(10, 20);
  alarm: number | null = null;
  store = new FakeStore();
  world = new World(ALL_MONTHS);
  /** cname → 上書きの結果(失敗など)。 */
  overrides = new Map<string, ResultFetchOutcome>();
  /** cname → 残りの失敗の回数(0 になったら本物の頁を返す)。 */
  flaky = new Map<string, number>();
  fetched: { cname: string; at: number }[] = [];
  logs: string[] = [];
  sleeps: number[] = [];
  fetchMs = 0;
  core!: JraBlinkerBackfillCore;
  options: JraBlinkerBackfillOptions;

  constructor(options: JraBlinkerBackfillOptions = {}) {
    this.options = options;
  }

  /** 世界を作り終えてから呼ぶ。 */
  start(): void {
    this.world.build();
    this.core = this.makeCore();
  }
  makeCore(): JraBlinkerBackfillCore {
    return new JraBlinkerBackfillCore(
      {
        sql: this.sql,
        now: () => this.now,
        sleep: async (ms) => {
          this.sleeps.push(ms);
          this.now += ms;
        },
        setAlarm: (at) => {
          this.alarm = at;
        },
        getAlarm: async () => this.alarm,
        store: this.store,
        fetchPage: async (cname) => {
          this.fetched.push({ cname, at: this.now });
          this.now += this.fetchMs;
          const left = this.flaky.get(cname) ?? 0;
          if (left > 0) {
            this.flaky.set(cname, left - 1);
            return { kind: "failed", reason: "timeout" };
          }
          return this.overrides.get(cname) ?? this.world.pages.get(cname) ?? { kind: "failed", reason: "http" };
        },
        log: (line) => this.logs.push(line),
      },
      this.options,
    );
  }
  meta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM bb_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }
  skips(): { cname: string; reason: string }[] {
    // 結果の頁・場日の頁の記録だけ(月の記録は cname が `month:` で始まるので除く)
    return this.sql.exec("SELECT cname, reason FROM bb_skip WHERE cname NOT LIKE 'month:%' ORDER BY cname").toArray() as { cname: string; reason: string }[];
  }
  count(table: string): number {
    return (this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as { n: number }[])[0]!.n;
  }
  /** 取得した cname の種類ごとの並び。 */
  kinds(): string[] {
    return this.fetched.map((f) => f.cname.slice(0, 9));
  }
  /** 終わるまで起床を繰り返す(最大 n 回)。 */
  async runUntilQuiet(n = 200): Promise<number> {
    for (let wakes = 1; wakes <= n; wakes++) {
      this.alarm = null;
      await this.core.runNextStep();
      if (this.alarm === null) return wakes;
      this.now = Math.max(this.now, this.alarm);
    }
    return n;
  }
}

let h: Harness;
afterEach(() => h?.sql.close());

const R = (head: number, blinkers: string[] = [], broken?: RaceDef["broken"]): RaceDef => ({ head, blinkers, ...(broken ? { broken } : {}) });
const races = (n: number, blinkersPer = 1): RaceDef[] => Array.from({ length: n }, (_, i) => R(10, Array.from({ length: blinkersPer }, (_, k) => hid(i * 10 + k + 1))));

describe("isJraBlinkerBackfillDisabled", () => {
  it("文字列 \"0\"(前後の空白は無視)だけが無効。未設定・\"1\"・空・その他は有効", () => {
    expect(isJraBlinkerBackfillDisabled("0")).toBe(true);
    expect(isJraBlinkerBackfillDisabled(" 0 ")).toBe(true);
    for (const v of [undefined, "1", "", "00", "false", "off"]) expect(isJraBlinkerBackfillDisabled(v), String(v)).toBe(false);
  });
});

describe("定数", () => {
  it("間隔 3 秒以上・1 起床 40 本以下・サブリクエスト 48 以下・1 日の上限 14,000 行・1 レースの行は 1 + 18 = 19", () => {
    expect(BLINKER_BACKFILL_GAP_MS).toBeGreaterThanOrEqual(3000);
    expect(BLINKER_BACKFILL_PER_WAKE).toBe(40);
    expect(BLINKER_BACKFILL_SUBREQUEST_MAX).toBe(48);
    expect(BLINKER_BACKFILL_DAILY_ROWS_MAX).toBe(14_000);
    expect(BLINKER_BACKFILL_ROWS_PER_RACE_MAX).toBe(19);
  });
});

describe("道筋: 過去検索 → 月 → 場日 → 結果", () => {
  it("取る順は 過去検索 1 本、2021-01 の月、その月の場日、場日の 12 レース。月の cname は表の 2 桁から組む。保存は race_id・頭数・印の馬", async () => {
    h = new Harness();
    h.world.addDay("202101", races(3, 1));
    h.start();
    await h.core.runNextStep();
    const d = h.world.days[0]!;
    expect(h.fetched.slice(0, 4).map((f) => f.cname)).toEqual([PAST_SEARCH_CNAME, monthCname("202101", codeOf("202101")), srlOf(d), sdeOf(d, 0)]);
    expect(h.kinds().slice(0, 4)).toEqual(["pw01skl00", "pw01skl10", "pw01srl10", "pw01sde10"]);
    expect(h.store.saveCalls).toHaveLength(1);
    expect(h.store.saveCalls[0]!.races.map((r) => r.raceId)).toEqual([0, 1, 2].map((i) => raceIdOf(d, i)));
    expect(h.store.saveCalls[0]!.races[0]).toEqual({ raceId: raceIdOf(d, 0), headCount: 10, blinkerHorseIds: [hid(1)] });
    expect(h.store.saveCalls[0]!.today).toBe("20261110"); // 取得日は JST の YYYYMMDD
  });

  it("月は 2021-01 から 1 か月ずつ進み、2026-11 の月の cname だけ pw01skl00(それまでは pw01skl10)。範囲は 202611 まで", async () => {
    h = new Harness();
    h.world.addDay("202101", races(1));
    h.world.addDay("202611", races(1), "20261101");
    h.start();
    await h.runUntilQuiet();
    const months = h.fetched.map((f) => f.cname).filter((c) => c.startsWith("pw01skl") && c !== PAST_SEARCH_CNAME);
    expect(months).toHaveLength(71); // 2021-01〜2026-11 = 6 年 × 12 − 1
    expect(months[0]).toBe("pw01skl10202101/" + codeOf("202101"));
    expect(months[69]).toBe("pw01skl10202610/" + codeOf("202610"));
    expect(months[70]).toBe("pw01skl00202611/" + codeOf("202611"));
    expect(h.store.done.has(raceIdOf(h.world.days[1]!, 0))).toBe(true);
  });

  it("2026-11-07 以降の場日は取らない(出馬表の取得〈#639〉が持つ)。11-06 までは取る", async () => {
    h = new Harness();
    const d06 = h.world.addDay("202611", races(1), "20261106");
    const d07 = h.world.addDay("202611", races(1), "20261107");
    const d08 = h.world.addDay("202611", races(1), "20261108");
    h.start();
    await h.runUntilQuiet();
    expect(h.fetched.map((f) => f.cname)).toContain(srlOf(d06));
    expect(h.fetched.map((f) => f.cname)).not.toContain(srlOf(d07));
    expect(h.fetched.map((f) => f.cname)).not.toContain(srlOf(d08));
    expect([...h.store.done]).toEqual([raceIdOf(d06, 0)]);
  });

  it("過去検索の頁は 1 周で 1 回だけ(次の起床や再起動でも取り直さない。表は DO の SQLite に持つ)", async () => {
    h = new Harness();
    h.world.addDay("202101", races(40));
    h.start();
    await h.core.runNextStep();
    h.now = h.alarm!;
    h.core = h.makeCore(); // DO の再起動(同じ SQLite)
    await h.core.runNextStep();
    await h.runUntilQuiet();
    expect(h.fetched.filter((f) => f.cname === PAST_SEARCH_CNAME)).toHaveLength(1);
  });
});

describe("取り終えたレースは取らない", () => {
  it("場日の頁を取ったあと、そのレースの ID の配列を 1 回だけ束縛して D1 に尋ね、取り終えたレースの結果は取らない。他は取る", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", races(12));
    h.start();
    for (const i of [0, 1, 5]) h.store.done.add(raceIdOf(d, i));
    await h.core.runNextStep();
    expect(h.store.filterCalls).toHaveLength(1);
    expect(h.store.filterCalls[0]).toEqual(Array.from({ length: 12 }, (_, i) => raceIdOf(d, i)));
    const sde = h.fetched.map((f) => f.cname).filter((c) => c.startsWith("pw01sde"));
    expect(sde).toEqual([2, 3, 4, 6, 7, 8, 9, 10, 11].map((i) => sdeOf(d, i)));
    expect(h.store.saveCalls[0]!.races.map((r) => r.raceId)).toEqual([2, 3, 4, 6, 7, 8, 9, 10, 11].map((i) => raceIdOf(d, i)));
  });

  it("全部取り終えている場日は、場日の頁の取得と D1 の確認だけで終わり、結果の頁は 1 本も取らず、何も書かない", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", races(12));
    h.start();
    for (let i = 0; i < 12; i++) h.store.done.add(raceIdOf(d, i));
    await h.core.runNextStep();
    expect(h.fetched.map((f) => f.cname).filter((c) => c.startsWith("pw01sde"))).toEqual([]);
    expect(h.store.saveCalls).toEqual([]);
  });
});

describe("起床 1 回の上限: 40 本・サブリクエスト 48", () => {
  it("頁の種類を問わず最大 40 本。残りは次の起床(カーソルから続ける)で、同じ頁を取り直さない", async () => {
    h = new Harness();
    h.world.addDay("202101", races(12));
    h.world.addDay("202101", races(12));
    h.world.addDay("202101", races(12));
    h.world.addDay("202101", races(12));
    h.start();
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(40);
    expect(h.alarm).toBe(h.now + 30_000); // 起床の終わりから 30 秒後
    h.now = h.alarm!;
    await h.core.runNextStep();
    const all = h.fetched.map((f) => f.cname);
    expect(new Set(all).size, "同じ頁を 2 回取っていない").toBe(all.length);
    expect(all.length).toBeGreaterThan(40);
    expect(h.store.done.size).toBeGreaterThan(30);
  });

  it("取り終えた場日ばかり(1 場日 = 取得 1 + D1 の確認 1)が続いても、取得と D1 の呼び出しの合計は 48 以下で、その起床を打ち切る(40 本には届かない)", async () => {
    h = new Harness();
    for (let i = 0; i < 40; i++) {
      const d = h.world.addDay("202101", races(2), `202101${String((i % 28) + 1).padStart(2, "0")}`);
      void d;
    }
    h.start();
    for (const d of h.world.days) for (let i = 0; i < d.races.length; i++) h.store.done.add(raceIdOf(d, i));
    await h.core.runNextStep();
    const subrequests = h.fetched.length + h.store.filterCalls.length + h.store.saveCalls.length;
    expect(h.store.filterCalls.length, "D1 の確認が付いている(前提)").toBeGreaterThan(10);
    expect(h.fetched.length).toBeLessThan(40);
    expect(subrequests).toBeLessThanOrEqual(BLINKER_BACKFILL_SUBREQUEST_MAX);
    expect(subrequests, "打ち切りが早すぎない").toBeGreaterThanOrEqual(BLINKER_BACKFILL_SUBREQUEST_MAX - 3);
  });

  it("書き込みは起床につき 1 回(レースごとに書かない)", async () => {
    h = new Harness();
    h.world.addDay("202101", races(12));
    h.start();
    await h.core.runNextStep();
    expect(h.store.saveCalls).toHaveLength(1);
    expect(h.store.saveCalls[0]!.races).toHaveLength(12);
  });
});

describe("間隔と時間帯", () => {
  it("取得の開始から開始まで 3 秒以上あける(取得に 1 秒かかれば残りの 2 秒だけ待つ)。起床の最初の取得の前には待たない", async () => {
    h = new Harness();
    h.world.addDay("202101", races(3));
    h.start();
    h.fetchMs = 1000;
    await h.core.runNextStep();
    expect(h.sleeps.length).toBeGreaterThan(3);
    expect(h.sleeps.every((ms) => ms === 2000)).toBe(true);
    const gaps = h.fetched.slice(1).map((f, i) => f.at - h.fetched[i]!.at);
    expect(gaps.every((g) => g >= BLINKER_BACKFILL_GAP_MS)).toBe(true);
    expect(h.fetched[0]!.at).toBe(jst(10, 20)); // 最初は待たない
  });

  it("時間帯の外(JST 8:00〜18:00)では取らず、その日の 18:00 にアラームを張る。18:00 ちょうどは中、8:00 ちょうどは外", async () => {
    h = new Harness();
    h.world.addDay("202101", races(1));
    h.start();
    h.now = jst(10, 12);
    await h.core.runNextStep();
    expect(h.fetched).toEqual([]);
    expect(h.alarm).toBe(jst(10, 18));
    expect(h.meta("wait_reason")).toBe("outside-window");
    h.now = jst(10, 8);
    await h.core.runNextStep();
    expect(h.fetched).toEqual([]);
    h.now = jst(10, 18);
    await h.core.runNextStep();
    expect(h.fetched.length).toBeGreaterThan(0);
  });

  it("起床の途中で 8:00 を過ぎたら、その先は取らない(日をまたぐ時間帯 23:59:50 → 翌 0:00 → 8:00)", async () => {
    h = new Harness();
    h.world.addDay("202101", races(12));
    h.start();
    h.now = jst(11, 7, 59, 50);
    h.fetchMs = 4000;
    await h.core.runNextStep();
    expect(h.fetched.length).toBeLessThan(5);
    expect(h.fetched.length).toBeGreaterThan(0);
    expect(h.fetched.every((f) => f.at < jst(11, 8))).toBe(true);
  });

  it("kick: アラームが無ければ時間帯の初めに張る。あれば張り直さない。無効なら張らない", async () => {
    h = new Harness();
    h.start();
    h.now = jst(10, 12);
    await h.core.kick();
    expect(h.alarm).toBe(jst(10, 18));
    h.alarm = jst(10, 19);
    await h.core.kick();
    expect(h.alarm).toBe(jst(10, 19));
    h.sql.close();
    h = new Harness({ disabled: true });
    h.start();
    await h.core.kick();
    await h.core.runNextStep();
    expect(h.alarm).toBeNull();
    expect(h.fetched).toEqual([]);
  });
});

describe("1 日の書き込みの上限(2 つの表の meta.changes の合計)", () => {
  it("取り込んだ行数(レース 1 + 印の馬)を数え、残りが 1 レースの最大(19)未満になったら取らずに翌日 18:00 まで休む。上限を超えて書かない", async () => {
    h = new Harness({ dailyRows: 60 });
    for (let i = 0; i < 3; i++) h.world.addDay("202101", races(12, 3)); // 1 レース = 1 + 3 = 4 行
    h.start();
    await h.core.runNextStep();
    // 残り 60 のうち、書いた行 + 19 ≤ 60 の間だけ取る: 行を 41 まで → 4 行ずつなので 11 レース(44 行)の手前で止まる
    expect(h.store.savedRows()).toBeLessThanOrEqual(60);
    expect(h.store.savedRows()).toBeGreaterThan(30);
    expect(Number(h.meta("day_rows"))).toBe(h.store.savedRows());
    h.now = h.alarm!;
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.store.savedRows()).toBeLessThanOrEqual(60);
    expect(h.meta("wait_reason")).toBe("daily-limit");
    expect(h.alarm).toBe(jst(11, 18)); // 翌日 18:00
  });

  it("日が変われば(JST 0:00 を過ぎれば)数え直す。翌日は続きから書く", async () => {
    h = new Harness({ dailyRows: 60 });
    for (let i = 0; i < 3; i++) h.world.addDay("202101", races(12, 3));
    h.start();
    h.now = jst(10, 22);
    await h.core.runNextStep();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("daily-limit");
    const first = h.store.savedRows();
    expect(first).toBeLessThanOrEqual(60);
    h.now = jst(11, 18);
    await h.core.runNextStep();
    expect(h.store.savedRows()).toBeGreaterThan(first);
    expect(h.store.savedRows() - first).toBeLessThanOrEqual(60);
  });

  it("オプションの上限は下げる方向だけ: 14,000 を超える値・不正な値は 14,000", () => {
    for (const [v, expected] of [[14_001, 14_000], [1_000_000, 14_000], [0, 14_000], [-5, 14_000], [2.5, 14_000], [100, 100], [14_000, 14_000]] as const) {
      const hh = new Harness({ dailyRows: v });
      hh.start();
      const limit = (hh.core as unknown as { dailyRows: number }).dailyRows;
      expect(limit, String(v)).toBe(expected);
      hh.sql.close();
    }
    h = new Harness();
  });
});

describe("飛ばす頁・再試行", () => {
  it("誤りの結果の頁(パラメータエラー)と、馬の ID が取れない頁は、D1 に何も書かず DO に記録して飛ばす。他のレースは書く。飛ばした件数はログの skipped= に出る", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", [R(10, [hid(1)]), R(10, [hid(2)], "param-error"), R(10, [hid(3)], "no-id"), R(10, [hid(4)])]);
    h.start();
    await h.core.runNextStep();
    expect(h.store.saveCalls[0]!.races.map((r) => r.raceId)).toEqual([raceIdOf(d, 0), raceIdOf(d, 3)]);
    expect(h.store.done.has(raceIdOf(d, 1)) || h.store.done.has(raceIdOf(d, 2))).toBe(false);
    expect(h.skips()).toEqual([
      { cname: sdeOf(d, 1), reason: "param-error" },
      { cname: sdeOf(d, 2), reason: "unparsable" },
    ].sort((a, b) => (a.cname < b.cname ? -1 : 1)));
    // ログの skipped= は、その起床で飛ばした頁の数(結果の頁 2 + 場日のない月の頁)。記録(bb_skip)の行数と一致する
    const logged = Number(/skipped=(\d+)/.exec(h.logs.find((l) => l.includes("wake fetched"))!)?.[1]);
    expect(logged).toBe(h.count("bb_skip"));
    expect(logged).toBeGreaterThanOrEqual(2);
    // 次の起床で取り直さない
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.fetched.filter((f) => f.cname === sdeOf(d, 1) || f.cname === sdeOf(d, 2))).toHaveLength(2);
    expect(h.fetched.length).toBeGreaterThan(40); // 2 回目の起床は先(月)へ進んでいる(前提)
  });

  it("月の頁に場日が無い(今月が過去検索の頁のまま返る形)・場日の頁にレースが無い・過去検索の表に無い月は、記録して飛ばし、次へ進む", async () => {
    h = new Harness();
    const d = h.world.addDay("202102", races(2));
    h.start();
    // 202101 は場日が 0 件の月の頁(world に日が無い)。202102 の場日の頁は、中身を空にする
    h.overrides.set(srlOf(d), { kind: "page", html: "<html><head><title>レース結果 レース選択　JRA</title></head></html>" });
    await h.runUntilQuiet();
    const reasons = (h.sql.exec("SELECT reason FROM bb_skip").toArray() as { reason: string }[]).map((r) => r.reason);
    expect(reasons.filter((r) => r === "no-days").length).toBe(70); // 71 か月のうち、日のある 202102 以外
    expect(reasons).toContain("no-races");
    expect(h.meta("finished")).toBe("1");
  });

  it("過去検索の表に無い月は、月の頁を取らずに no-param で記録して飛ばし、次の月へ進む(他の月は取る)", async () => {
    h = new Harness();
    h.world.addDay("202102", races(1));
    h.world.addDay("202104", races(1));
    h.start();
    h.overrides.set(PAST_SEARCH_CNAME, { kind: "page", html: pastSearchHtml(ALL_MONTHS.filter((m) => m !== "202103")) });
    await h.runUntilQuiet();
    expect(h.sql.exec("SELECT cname, reason FROM bb_skip WHERE reason = 'no-param'").toArray()).toEqual([{ cname: "month:202103", reason: "no-param" }]);
    expect(h.fetched.some((f) => f.cname.startsWith("pw01skl10202103/"))).toBe(false);
    expect(h.store.done.size).toBe(2);
  });

  it("timeout・network は記録せず、次の起床で同じ頁をもう一度取る。成功すれば書く", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", races(2));
    h.start();
    h.overrides.set(sdeOf(d, 0), { kind: "failed", reason: "timeout" });
    h.overrides.set(sdeOf(d, 1), { kind: "failed", reason: "network" });
    await h.core.runNextStep();
    expect(h.skips()).toEqual([]);
    expect(h.store.saveCalls).toEqual([]);
    h.overrides.clear();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.store.saveCalls[0]!.races.map((r) => r.raceId)).toEqual([raceIdOf(d, 0), raceIdOf(d, 1)]);
    expect(h.fetched.filter((f) => f.cname === sdeOf(d, 0))).toHaveLength(2);
  });

  it("月の頁の失敗の回数は、月が進むたびに 0 に戻る(前の月の失敗が次の月の「諦め」を早めない)。どちらの月も 6 回失敗してから成功しても、諦めずに取り終える", async () => {
    h = new Harness();
    const d1 = h.world.addDay("202101", races(1));
    const d2 = h.world.addDay("202102", races(1));
    h.start();
    h.flaky.set(monthCname("202101", codeOf("202101")), 6);
    h.flaky.set(monthCname("202102", codeOf("202102")), 6);
    await h.runUntilQuiet(80);
    expect(h.sql.exec("SELECT reason FROM bb_skip WHERE reason = 'gave-up'").toArray()).toEqual([]);
    expect(h.store.done.has(raceIdOf(d1, 0)) && h.store.done.has(raceIdOf(d2, 0))).toBe(true);
    expect(h.fetched.filter((f) => f.cname === monthCname("202102", codeOf("202102")))).toHaveLength(7);
  });

  it("大きすぎる頁(too-large)は取り直さず記録して飛ばす。同じ頁の失敗が 10 回続いたら、諦めて記録して飛ばす(終わらなくなるのを防ぐ)", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", races(3));
    h.start();
    h.overrides.set(sdeOf(d, 0), { kind: "failed", reason: "too-large" });
    h.overrides.set(sdeOf(d, 1), { kind: "failed", reason: "http" });
    await h.runUntilQuiet(40);
    expect(h.skips().find((s) => s.cname === sdeOf(d, 0))?.reason).toBe("too-large");
    expect(h.fetched.filter((f) => f.cname === sdeOf(d, 0))).toHaveLength(1);
    expect(h.fetched.filter((f) => f.cname === sdeOf(d, 1))).toHaveLength(10);
    expect(h.skips().find((s) => s.cname === sdeOf(d, 1))?.reason).toBe("gave-up");
    expect(h.store.done.has(raceIdOf(d, 2))).toBe(true);
  });

  it("連続 3 回の起床で 1 本も読めなければ止まり、翌日 18:00 に再開する。読めた起床で数えは 0 に戻る", async () => {
    h = new Harness();
    h.world.addDay("202101", races(2));
    h.start();
    h.overrides.set(PAST_SEARCH_CNAME, { kind: "failed", reason: "timeout" });
    await h.core.runNextStep();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.alarm).toBe(h.now + 30_000);
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
    expect(h.alarm).toBe(jst(11, 18));
    expect(h.meta("streak")).toBe("0");
    // 再開後、読めれば進む
    h.overrides.clear();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.store.saveCalls.length).toBe(1);
    expect(h.meta("streak")).toBe("0");
  });

  it("2 回失敗して 3 回目に読めたら止まらない(連続でない)", async () => {
    h = new Harness();
    h.world.addDay("202101", races(2));
    h.start();
    h.overrides.set(PAST_SEARCH_CNAME, { kind: "failed", reason: "network" });
    await h.core.runNextStep();
    h.now = h.alarm!;
    await h.core.runNextStep();
    h.overrides.clear();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("active");
    expect(h.meta("streak")).toBe("0");
  });
});

describe("D1 の失敗", () => {
  it("書き込みが失敗した起床は、飛ばす記録も取り終えの印も進めず、10 分後に再試行する。次の起床で同じレースをもう一度取って書く", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", [R(10, [hid(1)]), R(10, [hid(2)], "param-error")]);
    h.start();
    h.store.failSave = true;
    await h.core.runNextStep();
    expect(h.logs.some((l) => l.includes("step failed"))).toBe(true);
    expect(h.alarm).toBe(h.now + 10 * 60_000);
    expect(h.skips()).toEqual([]);
    h.store.failSave = false;
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.store.saveCalls[0]!.races.map((r) => r.raceId)).toEqual([raceIdOf(d, 0)]);
    expect(h.skips().map((s) => s.cname)).toEqual([sdeOf(d, 1)]);
  });

  it("書き込みの失敗が連続 3 回の起床なら止まり、翌日 18:00 に再開する", async () => {
    h = new Harness();
    h.world.addDay("202101", races(2));
    h.start();
    h.store.failSave = true;
    await h.core.runNextStep();
    h.now = h.alarm!;
    await h.core.runNextStep();
    h.now = h.alarm!;
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
    expect(h.alarm).toBe(jst(11, 18));
  });
});

describe("最後まで進んだら止まる", () => {
  it("最後の月(2026-11)まで終えると finished=1。アラームを張らず、次の kick でも何もしない(取得も書き込みも無い)", async () => {
    h = new Harness();
    h.world.addDay("202101", races(2));
    h.start();
    await h.runUntilQuiet();
    expect(h.meta("finished")).toBe("1");
    expect(h.meta("wait_reason")).toBe("finished");
    const fetched = h.fetched.length;
    const saves = h.store.saveCalls.length;
    h.alarm = null;
    await h.core.kick();
    expect(h.alarm).toBeNull();
    await h.core.runNextStep();
    expect(h.alarm).toBeNull();
    expect(h.fetched.length).toBe(fetched);
    expect(h.store.saveCalls.length).toBe(saves);
    // 再起動しても同じ
    h.core = h.makeCore();
    await h.core.kick();
    expect(h.alarm).toBeNull();
  });
});

describe("DO の再起動(同じ SQLite)でも続きから進む", () => {
  it("場日の途中で切れても、再起動後に残りのレースだけを取る(場日の頁・取得済みの頁を取り直さない)", async () => {
    h = new Harness();
    const d = h.world.addDay("202101", races(12));
    h.start();
    h.now = jst(10, 20);
    // 1 起床の取得を 6 本に制限する代わりに、途中で時間帯を外す: 取得に 400 秒かかるとして 2 本目で 8:00 を過ぎる
    h.now = jst(11, 7, 59, 40);
    h.fetchMs = 5000;
    await h.core.runNextStep();
    const first = h.fetched.map((f) => f.cname);
    h.core = h.makeCore();
    h.fetchMs = 0;
    h.now = jst(11, 18);
    await h.runUntilQuiet();
    const all = h.fetched.map((f) => f.cname);
    expect(new Set(all).size, "取り直しが無い").toBe(all.length);
    expect(first.length).toBeLessThan(all.length);
    expect(h.store.done.size).toBe(12);
    expect([...h.store.done].sort()).toEqual(Array.from({ length: 12 }, (_, i) => raceIdOf(d, i)).sort());
  });
});

describe("ログ", () => {
  it("固定の文と数だけ。cname・URL・応答の本文・例外のメッセージを含まない", async () => {
    h = new Harness();
    h.world.addDay("202101", [R(10, [hid(1)]), R(10, [], "param-error")]);
    h.start();
    h.store.failSave = true;
    await h.core.runNextStep();
    h.store.failSave = false;
    h.now = h.alarm!;
    await h.core.runNextStep();
    const text = h.logs.join("\n");
    expect(h.logs.length).toBeGreaterThanOrEqual(2);
    expect(text).not.toMatch(/pw01|https?:|<html|D1 down/);
    expect(text).toMatch(/fetched=\d+ saved=\d+ skipped=\d+ failed=\d+/);
  });
});
