import { afterEach, describe, expect, it } from "vitest";
import type { RaceRecord } from "../../packages/core/src/scraper/race-record";
import type { MarketAggregateResult } from "../src/market-edge-aggregate";
import type { MarketRow } from "../src/market-edge-calc";
import { MARKET_EDGE_MAX_NIGHTS, MARKET_EDGE_READ_COUNT_ROWS, RaceMarketEdgeCore, type MarketEdgeOptions } from "../src/market-edge-core";
import type { MarketPendingEntry } from "../src/market-edge-repository";
import type { PersonAggregateResult } from "../src/person-stats-aggregate";
import type { PersonRow } from "../src/person-stats-calc";
import type { ReadRaceArchivesResult } from "../src/race-archive-repository";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #729(段階 A): #642 の DO(`RaceMarketEdgeCore`)に差し込んだ「人の段」。偽の目録・偽の読み出し・偽の保存・偽の集計・偽の時計で固定する。
 *  - **PERSON_STATS_ENABLED が "1" のとき(= option personEnabled)だけ動く**。無効のとき、人の段は D1 にも R2 にも DO の SQLite にも何も触れない(市場の段は今までと同じ)。
 *  - 1 回の起床で R2 を読むのは、市場の段か人の段のどちらか一方だけ(交互)。1 ステップの件数は市場と同じ stepRaces。
 *  - 1 晩の書き込み行数の上限は、市場の段と人の段で合算する。
 *  - 人の段の失敗は市場の段を巻き込まない。失敗の記録は me_fail に `ps:` 付きで入れる。
 *  - 集計は、人の段の未処理が尽きた周の終わりに、その日まだなら 1 回。触れた年だけ。
 * D1 の上の動きは person-stats-repository.integration.test.ts、集計は person-stats-aggregate.test.ts。市場の段そのものの固定は market-edge-core.test.ts(無変更で緑)。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const JST = 9 * HOUR;
const at = (y: number, mo: number, d: number, h: number, m = 0): number => Date.UTC(y, mo - 1, d, h, m) - JST;
const NIGHT1 = at(2026, 11, 20, 3, 0);
const NIGHT2 = at(2026, 11, 21, 3, 0);
const idOf = (n: number): string => `2025010${String(10000 + n)}`;
const IN_WINDOW = "2025-06-01";

function recordOf(raceId: string, date: string): RaceRecord {
  return {
    raceId,
    date,
    kind: "central",
    parserVersion: 2,
    venueCode: "06",
    courseType: "芝",
    distance: 1600,
    horses: Array.from({ length: 6 }, (_, k) => k + 1).map((i) => ({ finish: i, finishStatus: null, winOdds: 2 + i, jockeyId: `J${i}`, jockeyName: `騎${i}`, trainerId: `T${i}`, trainerName: `厩${i}` })),
  } as unknown as RaceRecord;
}

interface Entry {
  raceId: string;
  raceDate: string;
  market: number | null;
  person: number | null;
}

class Harness {
  readonly sql: NodeSql = openNodeSql();
  now = NIGHT1;
  alarm: number | null = null;
  catalog: Entry[] = [];
  reads: string[][] = [];
  marketSaves: Array<{ rows: MarketRow[]; done: string[] }> = [];
  personSaves: Array<{ rows: PersonRow[]; done: string[] }> = [];
  personPages: Array<{ after: string; limit: number }> = [];
  personAggregates: Array<{ years: number[]; today: string }> = [];
  logs: string[] = [];
  readOutcome = new Map<string, "missing" | "error">();
  recordOverride = new Map<string, RaceRecord>();
  personSaveThrows = 0;
  personPageThrows = 0;
  personAggregateThrows = 0;
  personAggregateResult: (years: readonly number[]) => PersonAggregateResult = (years) => ({ status: "written", years: [...years], skippedYears: [], rowsWritten: 30, races: 10, broken: 0 });
  personRowsPerRace = 2;
  marketAggregateRows = 100;
  marketRowsPerRace = 2;
  /** 人の保存の大きさ。 */
  personSize: number | null = 24_000_000;
  options: MarketEdgeOptions;
  withPerson: boolean;
  core: RaceMarketEdgeCore;

  constructor(options: MarketEdgeOptions = {}, withPerson = true) {
    this.options = options;
    this.withPerson = withPerson;
    this.core = this.makeCore();
  }

  makeCore(): RaceMarketEdgeCore {
    return new RaceMarketEdgeCore(
      {
        sql: this.sql,
        now: () => this.now,
        setAlarm: (t) => {
          this.alarm = t;
        },
        getAlarm: async () => this.alarm,
        store: {
          listPendingPage: async (after, limit): Promise<MarketPendingEntry[]> =>
            this.catalog
              .filter((e) => e.market === null && e.raceId > after)
              .sort((a, b) => (a.raceId < b.raceId ? -1 : 1))
              .slice(0, limit)
              .map(({ raceId, raceDate }) => ({ raceId, raceDate })),
          markSkipped: async (ids) => {
            for (const id of ids) this.catalog.find((e) => e.raceId === id)!.market = -1;
            return { rowsWritten: ids.length };
          },
          saveRows: async (rows, done) => {
            this.marketSaves.push({ rows: [...rows], done: [...done] });
            for (const id of done) this.catalog.find((e) => e.raceId === id)!.market = 1;
            return { rowsWritten: done.length * this.marketRowsPerRace, dbSizeBytes: 24_000_000 };
          },
        },
        ...(this.withPerson
          ? {
              person: {
                store: {
                  listPendingPage: async (after: string, limit: number) => {
                    this.personPages.push({ after, limit });
                    if (this.personPageThrows > 0) {
                      this.personPageThrows -= 1;
                      throw new Error("D1 down");
                    }
                    return this.catalog
                      .filter((e) => e.person === null && e.raceId > after)
                      .sort((a, b) => (a.raceId < b.raceId ? -1 : 1))
                      .slice(0, limit)
                      .map(({ raceId, raceDate }) => ({ raceId, raceDate }));
                  },
                  saveRows: async (rows: readonly PersonRow[], done: readonly string[]) => {
                    if (this.personSaveThrows > 0) {
                      this.personSaveThrows -= 1;
                      throw new Error("D1 down");
                    }
                    this.personSaves.push({ rows: [...rows], done: [...done] });
                    for (const id of done) this.catalog.find((e) => e.raceId === id)!.person = 1;
                    return { rowsWritten: done.length * this.personRowsPerRace, dbSizeBytes: this.personSize };
                  },
                },
                aggregate: async (years: readonly number[], today: string): Promise<PersonAggregateResult> => {
                  this.personAggregates.push({ years: [...years], today });
                  if (this.personAggregateThrows > 0) {
                    this.personAggregateThrows -= 1;
                    throw new Error("D1 down");
                  }
                  return this.personAggregateResult(years);
                },
              },
            }
          : {}),
        archive: {
          readRaceArchives: async (ids): Promise<ReadRaceArchivesResult> => {
            this.reads.push([...ids]);
            return {
              status: "read",
              items: ids.map((raceId) => {
                const o = this.readOutcome.get(raceId);
                if (o === "missing") return { raceId, outcome: { status: "missing" as const } };
                if (o === "error") return { raceId, outcome: { status: "error" as const } };
                const date = this.catalog.find((e) => e.raceId === raceId)!.raceDate;
                return { raceId, outcome: { status: "found" as const, archive: { format: 1 as const, parserVersion: 2, fetchedAt: "x", html: "", record: this.recordOverride.get(raceId) ?? recordOf(raceId, date) } } };
              }),
            };
          },
        },
        aggregate: async (): Promise<MarketAggregateResult> => ({ status: "written", rowsWritten: this.marketAggregateRows, races: 1, horses: 6, jockeys: 6, trainers: 6, converged: true, usedPreviousCoef: false, broken: 0 }),
        log: (line) => this.logs.push(line),
      },
      this.options,
    );
  }

  seed(count: number, date = IN_WINDOW): void {
    this.catalog = Array.from({ length: count }, (_, i) => ({ raceId: idOf(i + 1), raceDate: date, market: null, person: null }));
  }

  async drain(max = 200): Promise<number> {
    if (this.alarm === null) await this.core.kick();
    let steps = 0;
    while (this.alarm !== null && steps < max) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    return steps;
  }

  /** 今の JST の晩(3:00 から)が終わるまで(翌日の JST 3:00 の手前まで)動かす。アラームが張られている限り、時計をその時刻に進めて 1 ステップずつ。 */
  async drainNight(max = 400): Promise<number> {
    if (this.alarm === null) await this.core.kick();
    const dayStart = Math.floor((this.now + JST) / (24 * HOUR)) * 24 * HOUR - JST;
    const end = dayStart + 24 * HOUR + 3 * HOUR;
    let steps = 0;
    while (this.alarm !== null && this.alarm < end && steps < max) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    return steps;
  }

  /** アラームを 1 回だけ進める(1 起床)。 */
  async wake(): Promise<void> {
    if (this.alarm === null) await this.core.kick();
    this.now = Math.max(this.now, this.alarm ?? this.now);
    this.alarm = null;
    await this.core.runNextStep();
  }

  metaKeys(): string[] {
    return (this.sql.exec("SELECT key FROM me_meta ORDER BY key").toArray() as { key: string }[]).map((r) => r.key);
  }
  failIds(): string[] {
    return (this.sql.exec("SELECT race_id AS id FROM me_fail ORDER BY race_id").toArray() as { id: string }[]).map((r) => r.id);
  }
}

const harnesses: Harness[] = [];
const make = (options: MarketEdgeOptions = {}, withPerson = true): Harness => {
  const h = new Harness(options, withPerson);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.sql.close();
});

describe("無効のとき(PERSON_STATS_ENABLED が \"1\" でない = personEnabled が true でない)は人の段が何もしない", () => {
  it("personEnabled が未設定・false・person の依存なしのどれでも、人の目録の列挙・人の保存・人の集計を呼ばず、DO の SQLite に ps_ のキーも作らない。R2 の読みは市場の段だけ", async () => {
    const runs: Array<{ options: MarketEdgeOptions; withPerson: boolean }> = [
      { options: {}, withPerson: true },
      { options: { personEnabled: false }, withPerson: true },
      { options: { personEnabled: true }, withPerson: false },
    ];
    const baseline = make({}, false);
    baseline.seed(45);
    await baseline.drain(60);
    expect(baseline.reads.flat()).toHaveLength(45); // 前提: 市場の段は 45 レースを読む
    for (const r of runs) {
      const h = make(r.options, r.withPerson);
      h.seed(45);
      await h.drainNight();
      expect(h.personPages, JSON.stringify(r)).toEqual([]);
      expect(h.personSaves).toEqual([]);
      expect(h.personAggregates).toEqual([]);
      expect(h.metaKeys().filter((k) => k.startsWith("ps_"))).toEqual([]);
      expect(h.reads, "R2 の読みは基準(人の依存なし)と同じ").toEqual(baseline.reads);
      expect(h.marketSaves.map((s) => s.done), "市場の段は基準と同じ").toEqual(baseline.marketSaves.map((s) => s.done));
      expect(h.catalog.every((e) => e.person === null)).toBe(true);
    }
  });
});

describe("有効のとき: 取り込み", () => {
  it("人の未処理のレースを 1 ステップ最大 20 件(市場と同じ stepRaces)、R2 から読んで人の行にして保存し、印を付ける", async () => {
    const h = make({ personEnabled: true });
    h.seed(45);
    h.catalog.forEach((e) => (e.market = 1)); // 市場の段は済んでいる(人の段だけを見る)
    await h.wake();
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toHaveLength(20);
    expect(h.personSaves[0]!.rows).toHaveLength(20);
    expect(h.personSaves[0]!.done).toEqual(h.reads[0]);
    const row = h.personSaves[0]!.rows[0]!;
    expect(row).toMatchObject({ raceId: idOf(1), raceDate: IN_WINDOW, venueCode: "06", courseType: "芝", distance: 1600 });
    expect(row.horses).toHaveLength(6);
    expect(row.horses[0]).toEqual(["J1", "T1", 1]);
    expect(h.alarm).not.toBeNull();
  });

  it("数える馬がなく行を作れないレースは、行は作らず取り込み済みの印だけ付く(毎晩やり直さない)", async () => {
    const h = make({ personEnabled: true });
    h.seed(2);
    h.catalog.forEach((e) => (e.market = 1));
    // 1 件目は全頭が取消
    h.recordOverride.set(idOf(1), { ...recordOf(idOf(1), IN_WINDOW), horses: [{ finish: null, finishStatus: "取消", winOdds: null, jockeyId: "J1", trainerId: "T1" }] } as unknown as RaceRecord);
    await h.wake();
    expect(h.personSaves[0]!.rows.map((r) => r.raceId)).toEqual([idOf(2)]); // 行を作ったのは 2 件目だけ
    expect(h.personSaves[0]!.done).toEqual([idOf(1), idOf(2)]); // 印は両方
    expect(h.catalog.map((e) => e.person)).toEqual([1, 1]);
  });

  it("1 回の起床で R2 を読むのは市場の段か人の段のどちらか一方だけで、両方に未処理がある間は厳密に交互(人 → 市場 → 人 → …)。1 回の読みは 20 件以下。合計の読みは両方の未処理の合計と同じ(二重に読まない)", async () => {
    const h = make({ personEnabled: true });
    h.seed(100); // 両方の段に 5 ステップぶん(20 件 × 5)の未処理
    const stages: string[] = [];
    for (let i = 0; i < 8; i++) {
      const beforeReads = h.reads.length;
      const beforeMarket = h.marketSaves.length;
      const beforePerson = h.personSaves.length;
      await h.wake();
      expect(h.reads.length - beforeReads, `起床 ${i} の R2 の読みの呼び出し`).toBe(1); // 1 回の起床で読むのは 1 回(両方の段が読むことはない)
      const m = h.marketSaves.length - beforeMarket;
      const p = h.personSaves.length - beforePerson;
      expect(m + p, `起床 ${i} で保存したのは一方の段だけ`).toBe(1);
      stages.push(p === 1 ? "person" : "market");
    }
    expect(stages).toEqual(["person", "market", "person", "market", "person", "market", "person", "market"]); // 厳密に交互
    expect(h.reads.every((r) => r.length <= 20)).toBe(true);
    // 最後まで流すと、どちらの段も 100 レースを 1 回ずつ読む
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done).sort()).toEqual(h.catalog.map((e) => e.raceId).sort());
    expect(h.personSaves.flatMap((s) => s.done).sort()).toEqual(h.catalog.map((e) => e.raceId).sort());
    expect(h.reads.flat()).toHaveLength(200);
  });

  it("人の段に未処理がなければ、その起床では市場の段が動く(市場の段を待たせない)。人の目録の確認は 1 時間に 1 回", async () => {
    const h = make({ personEnabled: true });
    h.seed(5);
    h.catalog.forEach((e) => (e.person = 1)); // 人の段は済んでいる
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done)).toHaveLength(5);
    expect(h.personSaves).toEqual([]);
    const pagesAtIdle = h.personPages.length;
    expect(pagesAtIdle).toBeGreaterThan(0);
    // 休み(1 時間)の間は、人の目録をもう一度確かめない
    h.now += 10 * MIN;
    h.alarm = h.now;
    await h.core.runNextStep();
    expect(h.personPages.length).toBe(pagesAtIdle);
  });
});

describe("1 晩の書き込み行数の上限は市場の段と人の段で合算する", () => {
  it("人の段の書き込みも night_rows に入り、合計が上限に達した晩はどちらの段も動かない。翌晩に再開する", async () => {
    // 1 ステップ(20 レース): 市場 20 × 2 + 1 = 41 行、人 20 × 2 + 1 = 41 行 → 上限 100 で、市場 + 人 + 市場の 3 ステップ目の前に止まる
    const h = make({ personEnabled: true, nightlyRows: 100, stepRaces: 20 });
    h.seed(100);
    await h.drainNight();
    const st = await h.core.getStatus();
    expect(st.waitReason).toBe("night-limit");
    expect(st.night.rows).toBeGreaterThanOrEqual(100);
    const marketRaces = h.marketSaves.flatMap((s) => s.done).length;
    const personRaces = h.personSaves.flatMap((s) => s.done).length;
    expect(marketRaces + personRaces).toBeGreaterThan(0);
    expect(marketRaces * 2 + h.marketSaves.length + personRaces * 2 + h.personSaves.length).toBe(st.night.rows); // 市場の分と人の分の合算
    expect(marketRaces + personRaces).toBeLessThan(200); // 前提: 1 晩では全部は終わらない(上限が効いている)
    // 人の段だけでは 100 行に届かない件数でも、市場の分を足すと届く: 人の段の分を足さない実装だと、上限に達するのが遅れて、もっと多く進む
    const doneBefore = marketRaces + personRaces;
    h.now = NIGHT2;
    await h.core.kick();
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done).length + h.personSaves.flatMap((s) => s.done).length).toBeGreaterThan(doneBefore);
    void MARKET_EDGE_READ_COUNT_ROWS;
  });
});

describe("失敗の扱い", () => {
  it("R2 の読みに失敗したレースは me_fail に `ps:` 付きで記録し、その晩はもう試さない。MAX_NIGHTS 晩で諦める。市場の段の失敗の記録(接頭辞なし)とは別", async () => {
    const h = make({ personEnabled: true });
    h.seed(3);
    h.catalog.forEach((e) => (e.market = 1));
    h.readOutcome.set(idOf(2), "missing");
    await h.drainNight();
    expect(h.failIds()).toEqual([`ps:${idOf(2)}`]);
    expect(h.personSaves.flatMap((s) => s.done)).toEqual([idOf(1), idOf(3)]);
    expect(h.catalog.find((e) => e.raceId === idOf(2))!.person).toBeNull();
    const readsOfFailing = (): number => h.reads.flat().filter((id) => id === idOf(2)).length;
    expect(readsOfFailing()).toBe(1); // 同じ晩は 1 回しか試さない
    for (let night = 1; night < MARKET_EDGE_MAX_NIGHTS + 1; night++) {
      h.now = NIGHT1 + night * 24 * HOUR;
      h.alarm = null;
      await h.drainNight();
    }
    expect(readsOfFailing()).toBe(MARKET_EDGE_MAX_NIGHTS); // 諦めたあとは読まない
  });

  it("人の保存の例外: 次は 1 レースずつに切り分け、市場の段は止まらずに進む。成功するとまとめに戻る", async () => {
    const h = make({ personEnabled: true });
    h.seed(30);
    h.personSaveThrows = 1;
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done)).toHaveLength(30); // 市場の段は全部終わっている
    expect(h.personSaves.flatMap((s) => s.done)).toHaveLength(30);
    expect(h.personSaves[0]!.done).toHaveLength(1); // 切り分け(solo)
    expect(h.personSaves.some((s) => s.done.length > 1)).toBe(true); // 成功したあとはまとめに戻る
  });

  it("人の目録の列挙が例外でも、その起床では市場の段が動く(人の段の失敗は市場の段を巻き込まない)", async () => {
    const h = make({ personEnabled: true });
    h.seed(5);
    h.personPageThrows = 3;
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done)).toHaveLength(5);
    expect(h.logs.some((l) => l.includes("person"))).toBe(true);
  });

  it("人の集計の例外も市場の段を巻き込まない。触れた年は残り、次の機会に集計し直す", async () => {
    const h = make({ personEnabled: true });
    h.seed(3);
    h.personAggregateThrows = 1;
    await h.drainNight();
    expect(h.marketSaves.flatMap((s) => s.done)).toHaveLength(3);
    expect(h.personAggregates.length).toBeGreaterThanOrEqual(1);
    expect(h.personAggregates[0]!.years).toEqual([2025]);
  });
});

describe("人の集計", () => {
  it("人の段の未処理が尽きた周の終わりに、触れた年だけを、その日(JST)1 回だけ集計する", async () => {
    const h = make({ personEnabled: true });
    h.catalog = [
      { raceId: idOf(1), raceDate: "2024-12-30", market: 1, person: null },
      { raceId: idOf(2), raceDate: "2025-01-05", market: 1, person: null },
      { raceId: idOf(3), raceDate: "2025-06-01", market: 1, person: null },
    ];
    await h.drainNight();
    expect(h.personAggregates).toEqual([{ years: [2024, 2025], today: "2026-11-20" }]);
    // 同じ晩にレースが増えても、集計は翌晩まで待つ(取り込みは進む)。人の目録の休み(1 時間)は、DO の再起動(新しいコア)で解いて、同じ晩の早い時刻から動かす
    h.catalog.push({ raceId: idOf(4), raceDate: "2026-11-19", market: 1, person: null });
    h.sql.exec("DELETE FROM me_meta WHERE key = 'ps_next_check'");
    h.core = h.makeCore();
    h.now = at(2026, 11, 20, 5, 0);
    h.alarm = h.now;
    await h.drainNight();
    expect(h.personAggregates).toHaveLength(1);
    expect(h.personSaves.flatMap((s) => s.done)).toContain(idOf(4)); // 取り込みは進む
    // 翌晩: 触れた年(2026)だけを集計する
    h.now = NIGHT2;
    h.alarm = null;
    await h.drainNight();
    expect(h.personAggregates).toEqual([
      { years: [2024, 2025], today: "2026-11-20" },
      { years: [2026], today: "2026-11-21" },
    ]);
  });

  it("触れた年がなければ集計しない。取り込みが途中の間は集計しない。壊れた行で書かなかった年は触れた年として残り、次の晩に試す", async () => {
    const h = make({ personEnabled: true });
    h.seed(1);
    h.catalog[0]!.market = 1;
    h.personAggregateResult = (years) => ({ status: "written", years: [], skippedYears: [...years], rowsWritten: 0, races: 0, broken: 1 });
    await h.drainNight();
    expect(h.personAggregates).toHaveLength(1);
    h.now = NIGHT2;
    h.alarm = null;
    await h.drainNight();
    expect(h.personAggregates).toHaveLength(2); // 残っていた年を次の晩に試す
    expect(h.personAggregates[1]!.years).toEqual([2025]);
    h.personAggregateResult = (years) => ({ status: "written", years: [...years], skippedYears: [], rowsWritten: 3, races: 1, broken: 0 });
    h.now = at(2026, 11, 22, 3, 0);
    h.alarm = null;
    await h.drainNight();
    expect(h.personAggregates).toHaveLength(3);
    h.now = at(2026, 11, 23, 3, 0);
    h.alarm = null;
    await h.drainNight();
    expect(h.personAggregates).toHaveLength(3); // 触れた年が尽きたので、もう集計しない
  });

  it("集計の書き込み行数も、その晩の書き込み行数に足される", async () => {
    const h = make({ personEnabled: true });
    h.marketAggregateRows = 0; // 市場の集計の行は数えない(人の分だけを見る)
    h.seed(1);
    h.catalog[0]!.market = 1;
    await h.drainNight();
    const st = await h.core.getStatus();
    // 取り込み: 1 レース × 2 行 + 1(読みの計数)= 3、集計: 30 行
    expect(st.night.rows).toBe(1 * 2 + MARKET_EDGE_READ_COUNT_ROWS + 30);
  });
});
