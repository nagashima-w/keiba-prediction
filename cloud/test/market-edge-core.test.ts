import { afterEach, describe, expect, it } from "vitest";
import type { RaceRecord } from "../../packages/core/src/scraper/race-record";
import type { MarketAggregateResult } from "../src/market-edge-aggregate";
import type { MarketRow } from "../src/market-edge-calc";
import {
  MARKET_EDGE_MAX_NIGHTS,
  MARKET_EDGE_NIGHTLY_ROWS_DEFAULT,
  MARKET_EDGE_READ_COUNT_ROWS,
  RaceMarketEdgeCore,
  isMarketEdgeDisabled,
  type MarketEdgeOptions,
} from "../src/market-edge-core";
import type { MarketPendingEntry } from "../src/market-edge-repository";
import type { ReadRaceArchivesResult } from "../src/race-archive-repository";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #642: 騎手・調教師の指標の毎晩の段取り `RaceMarketEdgeCore`。偽の目録・偽の読み出し・偽の保存・偽の集計・偽の時計で、
 * 時間帯(JST 3:00〜8:30)・1 晩の書き込み行数の上限・窓より古いレースの読み飛ばし・取り込み・失敗の扱い・停止と翌晩の再開・
 * 「取り込みが終わるまで集計しない」「集計は 1 日 1 回」・状態を固定する。D1 の上の動きは market-edge-repository.integration.test.ts。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const JST = 9 * HOUR;
const at = (y: number, mo: number, d: number, h: number, m = 0): number => Date.UTC(y, mo - 1, d, h, m) - JST;
const NIGHT1 = at(2026, 11, 7, 3, 0); // 11/7 3:00 JST(時間帯の開始)。窓の開始日は 2024-11-07
const NIGHT2 = at(2026, 11, 8, 3, 0);

const idOf = (n: number): string => `2025010${String(10000 + n)}`;
const IN_WINDOW = "2025-06-01";
const OLD = "2022-06-01";

function recordOf(raceId: string, date: string, field = 6): RaceRecord {
  return {
    raceId,
    date,
    kind: "central",
    parserVersion: 2,
    horses: Array.from({ length: field }, (_, k) => k + 1).map((i) => ({ finish: i, winOdds: 2 + i, jockeyId: `J${i}`, jockeyName: `騎${i}`, trainerId: `T${i}`, trainerName: `厩${i}` })),
  } as unknown as RaceRecord;
}

class Harness {
  readonly sql: NodeSql = openNodeSql();
  now = NIGHT1;
  alarm: number | null = null;
  /** 目録(未処理かどうかは done で持つ)。 */
  catalog: Array<MarketPendingEntry & { mark: number | null }> = [];
  pages: Array<{ after: string; limit: number }> = [];
  reads: string[][] = [];
  saves: Array<{ rows: MarketRow[]; done: string[] }> = [];
  skipped: string[][] = [];
  aggregates: string[] = [];
  logs: string[] = [];
  readOutcome = new Map<string, "missing" | "error">();
  /** 計算に入る馬が少ないレース(race_id → 頭数)。 */
  field = new Map<string, number>();
  readFenced = false;
  saveThrows = 0;
  saveSize: number | null = 24_000_000;
  aggregateResult: MarketAggregateResult = { status: "written", rowsWritten: 500, races: 1, horses: 6, jockeys: 6, trainers: 6, converged: true, usedPreviousCoef: false, broken: 0 };
  aggregateThrows = 0;
  options: MarketEdgeOptions = {};
  core: RaceMarketEdgeCore;

  constructor(options: MarketEdgeOptions = {}) {
    this.options = options;
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
          listPendingPage: async (after, limit) => {
            this.pages.push({ after, limit });
            return this.catalog
              .filter((e) => e.mark === null && e.raceId > after)
              .sort((a, b) => (a.raceId < b.raceId ? -1 : 1))
              .slice(0, limit)
              .map(({ raceId, raceDate }) => ({ raceId, raceDate }));
          },
          markSkipped: async (ids) => {
            this.skipped.push([...ids]);
            for (const id of ids) this.catalog.find((e) => e.raceId === id)!.mark = -1;
            return { rowsWritten: ids.length };
          },
          saveRows: async (rows, done) => {
            if (this.saveThrows > 0) {
              this.saveThrows -= 1;
              throw new Error("D1 down");
            }
            this.saves.push({ rows: [...rows], done: [...done] });
            for (const id of done) this.catalog.find((e) => e.raceId === id)!.mark = 1;
            return { rowsWritten: rows.length * 2 + done.length, dbSizeBytes: this.saveSize };
          },
        },
        archive: {
          readRaceArchives: async (ids): Promise<ReadRaceArchivesResult> => {
            this.reads.push([...ids]);
            if (this.readFenced) return { status: "skipped", reason: "r2-fence" };
            return {
              status: "read",
              items: ids.map((raceId) => {
                const o = this.readOutcome.get(raceId);
                if (o === "missing") return { raceId, outcome: { status: "missing" as const } };
                if (o === "error") return { raceId, outcome: { status: "error" as const } };
                const date = this.catalog.find((e) => e.raceId === raceId)!.raceDate;
                return { raceId, outcome: { status: "found" as const, archive: { format: 1 as const, parserVersion: 2, fetchedAt: "x", html: "", record: recordOf(raceId, date, this.field.get(raceId) ?? 6) } } };
              }),
            };
          },
        },
        aggregate: async (today) => {
          this.aggregates.push(today);
          if (this.aggregateThrows > 0) {
            this.aggregateThrows -= 1;
            throw new Error("D1 down");
          }
          return this.aggregateResult;
        },
        log: (line) => this.logs.push(line),
      },
      this.options,
    );
  }

  seed(count: number, date = IN_WINDOW): void {
    this.catalog = Array.from({ length: count }, (_, i) => ({ raceId: idOf(i + 1), raceDate: date, mark: null }));
  }

  /** アラームが張られている限り、時計をその時刻に進めて 1 ステップずつ動かす(最大 max 回)。 */
  async drain(max = 200): Promise<number> {
    let steps = 0;
    while (this.alarm !== null && steps < max) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    return steps;
  }
  /** 一晩だけ動かす(翌晩の開始より前まで)。 */
  async drainNight(nightEnd: number, max = 400): Promise<number> {
    if (this.alarm === null) await this.core.kick(); // cron の kick と同じ
    let steps = 0;
    while (this.alarm !== null && this.alarm < nightEnd && steps < max) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    return steps;
  }
}

const harnesses: Harness[] = [];
const make = (options: MarketEdgeOptions = {}): Harness => {
  const h = new Harness(options);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.sql.close();
});

describe("設定と時間帯", () => {
  it("var が文字列 0(前後の空白は無視)のときだけ無効", () => {
    expect(isMarketEdgeDisabled("0")).toBe(true);
    expect(isMarketEdgeDisabled(" 0 ")).toBe(true);
    for (const v of [undefined, "", "00", "1", "false", "0.0"]) expect(isMarketEdgeDisabled(v)).toBe(false);
  });

  it("kick: アラームが無ければ次の時間帯の開始(JST 3:00)に張る。時間帯の中なら今すぐ。既にあれば張り直さない", async () => {
    const h = make();
    h.now = at(2026, 11, 7, 21, 0);
    await h.core.kick();
    expect(h.alarm).toBe(at(2026, 11, 8, 3, 0));
    h.alarm = null;
    h.now = at(2026, 11, 8, 4, 0);
    await h.core.kick();
    expect(h.alarm).toBe(h.now);
    const before = h.alarm;
    h.now += MIN;
    await h.core.kick();
    expect(h.alarm).toBe(before);
  });

  it("無効のときは kick もステップも何もしない", async () => {
    const h = make({ disabled: true });
    h.seed(3);
    await h.core.kick();
    expect(h.alarm).toBeNull();
    await h.core.runNextStep();
    expect(h.pages).toEqual([]);
    expect((await h.core.getStatus()).state).toBe("disabled");
  });

  it("時間帯の外(JST 2:59・8:30)では動かず、次の開始に張る。3:00 と 8:29 は動く", async () => {
    const h = make();
    h.seed(1);
    h.now = at(2026, 11, 7, 2, 59);
    await h.core.runNextStep();
    expect(h.pages).toEqual([]);
    expect(h.alarm).toBe(at(2026, 11, 7, 3, 0));
    h.now = at(2026, 11, 7, 8, 30);
    await h.core.runNextStep();
    expect(h.pages).toEqual([]);
    expect(h.alarm).toBe(at(2026, 11, 8, 3, 0));
    h.now = at(2026, 11, 7, 8, 29);
    await h.core.runNextStep();
    expect(h.pages).toHaveLength(1);
  });
});

describe("取り込み", () => {
  it("窓の中の未処理のレースを 1 ステップ最大 20 件、R2 から読んで市場の行にして保存し、印を付ける", async () => {
    const h = make();
    h.seed(45);
    h.now = NIGHT1;
    await h.core.runNextStep();
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toHaveLength(20);
    expect(h.saves[0]!.rows).toHaveLength(20);
    expect(h.saves[0]!.done).toEqual(h.reads[0]);
    const row = h.saves[0]!.rows[0]!;
    expect(row.raceId).toBe(idOf(1));
    expect(row.raceDate).toBe(IN_WINDOW);
    expect(row.horses).toHaveLength(6);
    expect(h.alarm).not.toBeNull();
  });

  it("窓より古い(開催日が窓の開始日より前の)レースは R2 を読まず、印だけ付ける。窓の開始日ちょうどは取り込む", async () => {
    const h = make();
    h.catalog = [
      { raceId: idOf(1), raceDate: OLD, mark: null },
      { raceId: idOf(2), raceDate: "2024-11-06", mark: null }, // 窓の開始日(2024-11-07)の前日
      { raceId: idOf(3), raceDate: "2024-11-07", mark: null }, // 開始日ちょうど
      { raceId: idOf(4), raceDate: IN_WINDOW, mark: null },
    ];
    await h.core.runNextStep();
    expect(h.skipped).toEqual([[idOf(1), idOf(2)]]);
    // 取り込みは次のステップ(同じ呼び出しで古い分の印と取り込みの両方をしてもよいが、読まれるのは窓の中だけ)
    await h.drain(5);
    expect(h.reads.flat()).toEqual([idOf(3), idOf(4)]);
    expect(h.catalog.map((e) => e.mark)).toEqual([-1, -1, 1, 1]);
  });

  it("使えないレース(計算に入る馬が 4 頭以下)は行を作らないが、取り込み済みの印は付く(毎晩やり直さない)", async () => {
    const h = make();
    h.seed(2);
    h.field.set(idOf(1), 4);
    await h.core.runNextStep();
    expect(h.saves[0]!.rows.map((r) => r.raceId)).toEqual([idOf(2)]);
    expect(h.saves[0]!.done).toEqual([idOf(1), idOf(2)]);
    expect(h.catalog.map((e) => e.mark)).toEqual([1, 1]);
  });

  it("R2 に無い・読み出しの例外は、そのレースの失敗に数え、その晩はもう試さない。ほかのレースは進む", async () => {
    const h = make();
    h.seed(3);
    h.readOutcome.set(idOf(2), "missing");
    await h.drainNight(NIGHT2);
    expect(h.catalog.map((e) => e.mark)).toEqual([1, null, 1]);
    expect(h.reads.flat().filter((id) => id === idOf(2))).toHaveLength(1);
    const status = await h.core.getStatus();
    expect(status.failing).toBe(1);
    expect(status.gaveUp).toBe(0);
  });

  it(`同じレースが ${MARKET_EDGE_MAX_NIGHTS} 晩続けて失敗したら諦める(以後は試さない)`, async () => {
    const h = make();
    h.seed(2);
    h.readOutcome.set(idOf(1), "error");
    let night = NIGHT1;
    for (let i = 0; i < MARKET_EDGE_MAX_NIGHTS + 1; i++) {
      h.now = night;
      h.alarm = night;
      await h.drainNight(night + 24 * HOUR);
      night += 24 * HOUR;
    }
    expect(h.reads.flat().filter((id) => id === idOf(1))).toHaveLength(MARKET_EDGE_MAX_NIGHTS);
    expect((await h.core.getStatus()).gaveUp).toBe(1);
  });

  it("保存の batch が例外のときは、次のステップから 1 レースずつに切り分け、成功すればまとめに戻る", async () => {
    const h = make();
    h.seed(3);
    h.saveThrows = 1;
    await h.core.runNextStep(); // まとめて失敗
    expect(h.saves).toEqual([]);
    await h.drain(10);
    expect(h.saves.map((s) => s.done.length)).toEqual([1, 2]); // 1 件が通ったらまとめに戻る
    expect(h.catalog.every((e) => e.mark === 1)).toBe(true);
  });

  it("R2 の柵(Class B)に達していたら、その晩は止めて翌晩に再開する", async () => {
    const h = make();
    h.seed(3);
    h.readFenced = true;
    await h.core.runNextStep();
    expect((await h.core.getStatus()).stopReason).toBe("r2-fence");
    expect(h.alarm).toBe(NIGHT2);
    h.readFenced = false;
    h.now = NIGHT2;
    await h.drain(10);
    expect(h.catalog.every((e) => e.mark === 1)).toBe(true);
  });

  it("D1 の大きさが上限を超えたら、その晩は止めて翌晩に再開する", async () => {
    const h = make({ maxDbBytes: 100 });
    h.seed(3);
    await h.core.runNextStep();
    expect((await h.core.getStatus()).stopReason).toBe("capacity");
    expect(h.alarm).toBe(NIGHT2);
  });

  it("失敗(読み出しか保存)が連続 10 ステップになったら、その晩は止める", async () => {
    const h = make({ stepRaces: 1 });
    h.seed(30);
    for (const e of h.catalog) h.readOutcome.set(e.raceId, "error");
    await h.drainNight(NIGHT2);
    expect((await h.core.getStatus()).stopReason).toBe("failures");
    expect(h.alarm).toBe(NIGHT2);
  });
});

describe("1 晩の書き込み行数の上限", () => {
  it("上限に達した晩は取り込みを止め、翌晩に続きをする。上限は var で下げられるが、上限(10 万)を超えない", async () => {
    const h = make({ nightlyRows: 100, stepRaces: 5 });
    h.seed(60);
    await h.drainNight(NIGHT2);
    const processed = h.catalog.filter((e) => e.mark === 1).length;
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(60);
    const status = await h.core.getStatus();
    expect(status.waitReason).toBe("night-limit");
    expect(status.night.rows).toBeGreaterThanOrEqual(100);
    // 超えるのは最後の 1 ステップぶんだけ(1 ステップ 5 レース = 行 10 + 印 5 + 計数 1 = 16 行)
    expect(status.night.rows).toBeLessThan(100 + 16);
    expect(h.aggregates).toEqual([]); // 取り込みが終わっていないので集計しない
    h.now = NIGHT2;
    await h.drain(200);
    expect(h.catalog.every((e) => e.mark === 1)).toBe(true);
  });

  it("既定は 20,000 行。1 ステップの Class B の計数 1 行を足して数える", async () => {
    expect(MARKET_EDGE_NIGHTLY_ROWS_DEFAULT).toBe(20_000);
    expect(MARKET_EDGE_READ_COUNT_ROWS).toBe(1);
    const h = make();
    h.seed(4);
    await h.core.runNextStep();
    // 行 4 × 2 + 印 4 + 計数 1
    expect((await h.core.getStatus()).night.rows).toBe(4 * 2 + 4 + MARKET_EDGE_READ_COUNT_ROWS);
  });
});

describe("集計(取り込みが終わるまでしない。1 日 1 回)", () => {
  it("未処理が尽きた周の終わりで、その日 1 回だけ集計する。取り込みが途中の晩は集計しない", async () => {
    const h = make();
    h.seed(25);
    await h.drainNight(NIGHT2);
    expect(h.aggregates).toEqual(["2026-11-07"]);
    // 同じ晩に新しいレースが来ても、集計は翌晩
    h.catalog.push({ raceId: idOf(99), raceDate: IN_WINDOW, mark: null });
    h.now = at(2026, 11, 7, 5, 0);
    h.alarm = h.now;
    await h.drainNight(NIGHT2);
    expect(h.aggregates).toEqual(["2026-11-07"]);
    h.now = NIGHT2;
    h.alarm = h.now;
    await h.drainNight(at(2026, 11, 9, 3, 0));
    expect(h.aggregates).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("未処理が 0 件でも、その日まだ集計していなければ集計する(窓が進むだけの晩)", async () => {
    const h = make();
    h.seed(0);
    await h.drainNight(NIGHT2);
    expect(h.aggregates).toEqual(["2026-11-07"]);
  });

  it("集計の書き込み行数は、その晩の行数に足す", async () => {
    const h = make();
    h.seed(0);
    await h.drainNight(NIGHT2);
    expect((await h.core.getStatus()).night.rows).toBe(500);
  });

  it("集計が失敗(例外)したら 10 分後に再試行する。成功したら記録する", async () => {
    const h = make();
    h.seed(0);
    h.aggregateThrows = 1;
    await h.core.runNextStep();
    expect(h.aggregates).toHaveLength(1);
    expect(h.alarm).toBe(NIGHT1 + 10 * MIN);
    await h.drain(5);
    expect(h.aggregates).toEqual(["2026-11-07", "2026-11-07"]);
    expect((await h.core.getStatus()).lastCalc).toMatchObject({ date: "2026-11-07", status: "written" });
  });

  it("窓に市場の行が無い(no-rows)ときは記録せず、1 時間後に見直す。前日の係数も無い不収束(fit-failed)は、その日は再試行しない", async () => {
    const h = make();
    h.seed(0);
    h.aggregateResult = { status: "no-rows" };
    await h.core.runNextStep();
    expect(h.alarm).toBe(NIGHT1 + HOUR);
    const h2 = make();
    h2.seed(0);
    h2.aggregateResult = { status: "fit-failed" };
    await h2.drainNight(NIGHT2);
    expect(h2.aggregates).toEqual(["2026-11-07"]);
    expect((await h2.core.getStatus()).lastCalc).toMatchObject({ date: "2026-11-07", status: "fit-failed" });
  });
});

describe("状態", () => {
  it("getStatus: 進行・待ちの理由・夜の集計・累計・最後の集計を返す", async () => {
    const h = make();
    h.seed(3);
    await h.drainNight(NIGHT2);
    const s = await h.core.getStatus();
    expect(s.state).toBe("running");
    expect(s.nightlyRowLimit).toBe(MARKET_EDGE_NIGHTLY_ROWS_DEFAULT);
    expect(s.night.date).toBe("2026-11-07");
    expect(s.totals.races).toBe(3);
    expect(s.lastCalc).toMatchObject({ date: "2026-11-07", status: "written" });
    expect(s.cursor).toBe("");
  });

  it("DO の SQLite の文は、起床のたびに表の全部を読まない(実行計画に全走査が無い)", async () => {
    const h = make();
    h.seed(25);
    await h.drainNight(NIGHT2);
    for (const q of new Set(h.sql.statements.filter((s) => /^\s*(SELECT|DELETE|UPDATE)/i.test(s)))) {
      // 状態の読み取り(getStatus)の集計を除き、SCAN が出る文は無い
      const detail = h.sql.plan(q).join(" | ");
      expect(detail, q).not.toMatch(/\bSCAN\b(?! .*USING)/);
    }
  });
});
