import { afterEach, describe, expect, it } from "vitest";

import {
  BACKFILL_CHUNK_SIZE,
  BACKFILL_ERROR_RETRY_MS,
  BACKFILL_GATE_BUSY_DELAY_MS,
  BACKFILL_GATE_BUSY_PENDING,
  BACKFILL_INFLIGHT_MAX_MS,
  BACKFILL_MAX_DEFER_NIGHTS,
  BACKFILL_MAX_NIGHTS,
  BACKFILL_MIGRATION_POLL_MS,
  BACKFILL_NIGHTLY_LIMIT,
  BACKFILL_POLL_MS,
  BACKFILL_WINDOW_END_HOUR_JST,
  BACKFILL_WINDOW_START_HOUR_JST,
  inBackfillWindow,
  nextBackfillWindowStart,
  ResultBackfillCore,
  type BackfillDayStub,
  type BackfillOptions,
  type BackfillStore,
} from "../src/result-backfill-core";
import type { MigrationState } from "../src/migration-core";
import type { ResultClass } from "../src/race-day-result";
import type { ResultImportProgress } from "../src/race-day-core";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #217(#167-C): 結果の補完の状態機械(`ResultBackfillCore`)。移行が `completed` のときだけ、JST 01:00〜06:00 の間、1 晩 150 レース・1 回 30 レースまで、
 * 既存の `dispatchResultImports` で日単位の DO に結果の取り込みを依頼し、進行を見て、取得できなかったレースを記録して諦める。
 * 時計・アラーム・移行の状態・gate の状態・D1 の列挙・日単位の DO は偽物。状態(DO の SQLite)は本物の SQLite(`node:sqlite`)。
 */

const JST = 9 * 3600_000;
/** JST の時刻 → epoch ミリ秒。 */
const jst = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute) - JST;
const MIN = 60_000;
const NIGHT = "20261010";
const YESTERDAY = "20261009";
/** 既定の「今」: 2026-10-10 JST 02:00(窓の中)。 */
const T0 = jst(10, 10, 2);

// ---- 偽の世界 ----

interface DayRow {
  state: "queued" | "imported" | "gave_up";
  lastClass: ResultClass | null;
}

class World {
  now = T0;
  alarm: number | null = null;
  migration: MigrationState = "completed";
  migrationError = false;
  gate: { blockedUntil: number | null; pending: number } = { blockedUntil: null, pending: 0 };
  gateError = false;
  /** 未取込のレース(取り込み済みになると消える)。 */
  unimported: Array<{ raceId: string; kaisaiDate: string }> = [];
  undated = 0;
  listCalls: Array<{ to: string; exclude: string[]; limit: number }> = [];
  listError = false;
  /** 日ごとの DO。 */
  days = new Map<string, { requests: string[][]; rows: Map<string, DayRow>; failRequest: boolean; failProgress: boolean }>();
  setAlarmCalls: number[] = [];
  warns: string[] = [];

  day(date: string) {
    let d = this.days.get(date);
    if (d === undefined) {
      d = { requests: [], rows: new Map(), failRequest: false, failProgress: false };
      this.days.set(date, d);
    }
    return d;
  }

  /** 日の DO の、積まれた行を全部「取り込み済み」にする(D1 にも結果が入ったことにする)。 */
  settleImported(date: string): void {
    for (const [id, row] of this.day(date).rows) {
      if (row.state === "queued") {
        row.state = "imported";
        row.lastClass = "imported";
        this.unimported = this.unimported.filter((r) => r.raceId !== id);
      }
    }
  }

  /** 日の DO の、積まれた行を全部「諦めた」にする。 */
  settleGaveUp(date: string, lastClass: ResultClass): void {
    for (const row of this.day(date).rows.values()) {
      if (row.state === "queued") {
        row.state = "gave_up";
        row.lastClass = lastClass;
      }
    }
  }

  store: BackfillStore = {
    listBackfillRaces: async ({ to, exclude, limit }) => {
      this.listCalls.push({ to, exclude: [...exclude], limit });
      if (this.listError) throw new Error("D1 SECRET-LIST");
      const candidates = this.unimported.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId));
      if (candidates.length === 0) return [];
      const newest = candidates.map((r) => r.kaisaiDate).sort().at(-1)!;
      return candidates
        .filter((r) => r.kaisaiDate === newest)
        .sort((a, b) => a.raceId.localeCompare(b.raceId))
        .slice(0, limit);
    },
    countBackfill: async ({ to, exclude }) => ({
      dated: this.unimported.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId)).length,
      undated: this.undated,
    }),
  };

  stubFor = (date: string): BackfillDayStub => {
    const d = this.day(date);
    return {
      requestResultImport: async ({ raceIds }) => {
        if (d.failRequest) throw new Error("RPC SECRET-REQ");
        d.requests.push([...raceIds]);
        let accepted = 0;
        for (const id of raceIds) {
          if (!d.rows.has(id) || d.rows.get(id)!.state !== "queued") {
            d.rows.set(id, { state: "queued", lastClass: null });
            accepted += 1;
          }
        }
        return { accepted, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
      },
      getResultImportProgress: async (): Promise<ResultImportProgress> => {
        if (d.failProgress) throw new Error("RPC SECRET-PROGRESS");
        const races = [...d.rows].map(([raceId, r]) => ({
          raceId,
          state: r.state,
          attempts: 0,
          deferrals: 0,
          requestedOn: NIGHT,
          nextTryAt: null,
          lastClass: r.lastClass,
          updatedAt: 0,
        }));
        return { total: races.length, queued: races.filter((r) => r.state === "queued").length, imported: 0, gaveUp: 0, races };
      },
    };
  };
}

let opened: NodeSql[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  opened = [];
});

function make(world: World, options: BackfillOptions = {}, sql: NodeSql = openNodeSql()): { core: ResultBackfillCore; sql: NodeSql } {
  if (!opened.includes(sql)) opened.push(sql);
  const core = new ResultBackfillCore(
    {
      sql,
      now: () => world.now,
      setAlarm: (at) => {
        world.alarm = at;
        world.setAlarmCalls.push(at);
      },
      getAlarm: async () => world.alarm,
      migrationState: async () => {
        if (world.migrationError) throw new Error("RPC SECRET-MIGRATION");
        return world.migration;
      },
      gateStatus: async () => {
        if (world.gateError) throw new Error("RPC SECRET-GATE");
        return world.gate;
      },
      store: world.store,
      stubFor: world.stubFor,
      log: () => undefined,
      onWarn: (m) => world.warns.push(m),
    },
    options,
  );
  return { core, sql };
}

/**
 * 検証を通る 12 桁の中央のレースID(`parseRaceId`・`checkRaceDate` を通る。中央は年だけが開催日と一致すればよく、レース番号は 01〜12 に限られる)。日付(日)ごと・番号ごとに一意(200 レースまで)。
 * 形: 年(4)+ 場コード 05 + 日(2)+ ブロック(2。12 レースごと)+ レース番号(2。01〜12)。テストの開催日は 2026 年 10 月だけなので、月は入れない。
 */
const idOf = (date: string, n: number): string => `${date.slice(0, 4)}05${date.slice(6, 8)}${String(Math.floor((n - 1) / 12)).padStart(2, "0")}${String(((n - 1) % 12) + 1).padStart(2, "0")}`;
const races = (date: string, n: number): Array<{ raceId: string; kaisaiDate: string }> => Array.from({ length: n }, (_, i) => ({ raceId: idOf(date, i + 1), kaisaiDate: date }));

// ---- 定数・窓 ----

describe("定数", () => {
  it("1 晩 150 レース・1 回 30 レース・JST 01:00〜06:00・30 秒おきに進行を見る・40 分で待ちを打ち切る・gate は待ち 4 以上で引く", () => {
    expect(BACKFILL_NIGHTLY_LIMIT).toBe(150);
    expect(BACKFILL_CHUNK_SIZE).toBe(30);
    expect(BACKFILL_WINDOW_START_HOUR_JST).toBe(1);
    expect(BACKFILL_WINDOW_END_HOUR_JST).toBe(6);
    expect(BACKFILL_POLL_MS).toBe(30_000);
    expect(BACKFILL_INFLIGHT_MAX_MS).toBe(40 * MIN);
    expect(BACKFILL_GATE_BUSY_PENDING).toBe(4);
    expect(BACKFILL_GATE_BUSY_DELAY_MS).toBe(5 * MIN);
    expect(BACKFILL_ERROR_RETRY_MS).toBe(10 * MIN);
    expect(BACKFILL_MIGRATION_POLL_MS).toBe(30 * MIN);
    expect(BACKFILL_MAX_NIGHTS).toBe(3);
    expect(BACKFILL_MAX_DEFER_NIGHTS).toBe(5);
  });
});

describe("窓(JST 01:00〜06:00。開始を含み、終了を含まない)", () => {
  const cases: Array<[string, number, boolean]> = [
    ["00:59", jst(10, 10, 0, 59), false],
    ["01:00", jst(10, 10, 1, 0), true],
    ["03:30", jst(10, 10, 3, 30), true],
    ["05:59", jst(10, 10, 5, 59), true],
    ["06:00", jst(10, 10, 6, 0), false],
    ["09:00(cron の時刻)", jst(10, 10, 9, 0), false],
    ["23:59", jst(10, 10, 23, 59), false],
  ];
  it.each(cases)("%s → %s", (_label, at, expected) => {
    expect(inBackfillWindow(at)).toBe(expected);
  });

  const next: Array<[string, number, boolean, number]> = [
    ["窓の前(00:30)は当日の 01:00", jst(10, 10, 0, 30), false, jst(10, 10, 1)],
    ["窓の中(03:00)で currentOk なら今", jst(10, 10, 3), false, jst(10, 10, 3)],
    ["窓の中(03:00)で skipCurrent なら翌日の 01:00", jst(10, 10, 3), true, jst(10, 11, 1)],
    ["窓の後(07:00)は翌日の 01:00", jst(10, 10, 7), false, jst(10, 11, 1)],
    ["月末(10/31 07:00)は 11/01 の 01:00", jst(10, 31, 7), false, jst(11, 1, 1)],
    ["06:00 ちょうど(窓の外)は翌日の 01:00", jst(10, 10, 6), false, jst(10, 11, 1)],
  ];
  it.each(next)("次の窓の開始: %s", (_label, at, skipCurrent, expected) => {
    expect(nextBackfillWindowStart(at, skipCurrent)).toBe(expected);
  });
});

// ---- 起動の条件(移行の状態) ----

describe("移行の状態: completed のときだけ補完を動かす", () => {
  const cases: Array<[MigrationState, boolean, boolean]> = [
    // [移行の状態, 依頼するか, アラームを張るか]
    ["idle", false, false],
    ["failed", false, false],
    ["verifying", false, true],
    ["importing", false, true],
    ["waiting-budget", false, true],
    ["waiting-r2", false, true],
    ["completed", true, true],
  ];
  it.each(cases)("%s → 依頼=%s・アラーム=%s", async (state, dispatches, alarms) => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.migration = state;
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(dispatches ? 1 : 0);
    expect(w.alarm !== null).toBe(alarms);
    if (alarms && !dispatches) {
      expect(w.alarm).toBe(T0 + BACKFILL_MIGRATION_POLL_MS); // 移行が進行中なら 30 分後にもう一度見る
    }
  });

  it("移行の状態を読めないときは、依頼せず、30 分後に見直す(例外にしない)", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.migrationError = true;
    const { core } = make(w);
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.day(YESTERDAY).requests).toEqual([]);
    expect(w.alarm).toBe(T0 + BACKFILL_MIGRATION_POLL_MS);
  });
});

// ---- 時間帯・gate ----

describe("時間帯と gate: 自動実行の邪魔をしない", () => {
  const outside: Array<[string, number, number]> = [
    ["窓の前(00:30)", jst(10, 10, 0, 30), jst(10, 10, 1)],
    ["窓の後(06:00)", jst(10, 10, 6), jst(10, 11, 1)],
    ["朝の cron の時刻(09:00)", jst(10, 10, 9), jst(10, 11, 1)],
    ["夜(21:00)", jst(10, 10, 21), jst(10, 11, 1)],
  ];
  it.each(outside)("%s: 依頼せず、次の窓の開始にアラームを張る", async (_label, at, expectedAlarm) => {
    const w = new World();
    w.now = at;
    w.unimported = races("20261009", 3);
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day("20261009").requests).toEqual([]);
    expect(w.listCalls).toEqual([]); // D1 の列挙も発行しない
    expect(w.alarm).toBe(expectedAlarm);
  });

  it("gate のブレーカーが開いている: 依頼せず、解除の 1 分後にアラームを張る", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.gate = { blockedUntil: T0 + 20 * MIN, pending: 0 };
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([]);
    expect(w.alarm).toBe(T0 + 21 * MIN);
  });

  it(`gate の待ちが ${BACKFILL_GATE_BUSY_PENDING} 以上: 依頼せず 5 分後。${BACKFILL_GATE_BUSY_PENDING - 1} なら依頼する(境界)`, async () => {
    const busy = new World();
    busy.unimported = races(YESTERDAY, 3);
    busy.gate = { blockedUntil: null, pending: BACKFILL_GATE_BUSY_PENDING };
    await make(busy).core.runNextStep();
    expect(busy.day(YESTERDAY).requests).toEqual([]);
    expect(busy.alarm).toBe(T0 + BACKFILL_GATE_BUSY_DELAY_MS);

    const ok = new World();
    ok.unimported = races(YESTERDAY, 3);
    ok.gate = { blockedUntil: null, pending: BACKFILL_GATE_BUSY_PENDING - 1 };
    await make(ok).core.runNextStep();
    expect(ok.day(YESTERDAY).requests.length).toBe(1);
  });

  it("gate の状態を読めないときは、依頼せず 10 分後に見直す", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.gateError = true;
    await make(w).core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([]);
    expect(w.alarm).toBe(T0 + BACKFILL_ERROR_RETRY_MS);
  });
});

// ---- 依頼 ----

describe("依頼: 未取込のある最も新しい日を、1 回 30 レースまで。1 度に飛行中は 1 チャンクだけ", () => {
  it("最初の tick: 昨日(JST)以前で最も新しい日の 30 レースを、その日の DO に依頼し、30 秒後に進行を見る。列挙の to は昨日", async () => {
    const w = new World();
    w.unimported = [...races("20261009", 45), ...races("20261001", 5)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.listCalls).toEqual([{ to: YESTERDAY, exclude: [], limit: 30 }]);
    expect(w.day("20261009").requests).toEqual([races("20261009", 30).map((r) => r.raceId)]);
    expect([...w.days.keys()]).toEqual(["20261009"]); // 古い日の DO は開かない
    expect(w.alarm).toBe(T0 + BACKFILL_POLL_MS);
    const status = await core.getStatus();
    expect(status.state).toBe("running");
    expect(status.inflight).toMatchObject({ day: "20261009", races: 30 });
    expect(status.tonight).toMatchObject({ night: NIGHT, dispatched: 30, limit: 150 });
  });

  it("今日(JST)以降の開催日は依頼しない(to は昨日)", async () => {
    const w = new World();
    w.unimported = [...races("20261010", 3), ...races("20261011", 3)];
    await make(w).core.runNextStep();
    expect([...w.days.keys()]).toEqual([]);
  });

  it("進行中(queued が残る)の間は、次のチャンクを依頼しない。30 秒後にまた見る", async () => {
    const w = new World();
    w.unimported = races("20261009", 45);
    const { core } = make(w);
    await core.runNextStep();
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.day("20261009").requests.length).toBe(1); // 追加の依頼なし
    expect(w.alarm).toBe(w.now + BACKFILL_POLL_MS);
  });

  it("全部が取り込み済みになったら、同じ tick で結果を数え、次のチャンク(残り 15 レース)を依頼する", async () => {
    const w = new World();
    w.unimported = races("20261009", 45);
    const { core } = make(w);
    await core.runNextStep();
    w.settleImported("20261009");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.day("20261009").requests.length).toBe(2);
    expect(w.day("20261009").requests[1]).toEqual(races("20261009", 45).slice(30).map((r) => r.raceId));
    const status = await core.getStatus();
    expect(status.imported).toBe(30);
    expect(status.remaining).toBe(15);
    expect(status.tonight.dispatched).toBe(45);
  });

  it("未取込が尽きたら、依頼せず、次の晩にアラームを張る(状態 done)", async () => {
    const w = new World();
    w.unimported = races("20261009", 2);
    const { core } = make(w);
    await core.runNextStep();
    w.settleImported("20261009");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.day("20261009").requests.length).toBe(1);
    expect(w.alarm).toBe(jst(10, 11, 1));
    const status = await core.getStatus();
    expect(status.state).toBe("done");
    expect(status.imported).toBe(2);
    expect(status.remaining).toBe(0);
  });
});

describe("1 晩の上限", () => {
  async function runNight(w: World, core: ResultBackfillCore): Promise<number> {
    let ticks = 0;
    // アラームが翌晩以降(= 窓の外か次の日)に飛ぶまで、完了させながら進める。
    for (; ticks < 40; ticks += 1) {
      await core.runNextStep();
      for (const date of w.days.keys()) w.settleImported(date);
      if (w.alarm === null || w.alarm >= jst(10, 11, 1)) break;
      w.now = w.alarm;
    }
    return ticks;
  }

  it("既定: 1 晩 150 レースでちょうど止まり(30 × 5)、アラームは翌晩の 01:00。翌晩はまた 150 レース依頼する", async () => {
    const w = new World();
    w.unimported = [...races("20261009", 100), ...races("20261008", 100), ...races("20261007", 100)];
    const { core } = make(w);
    await runNight(w, core);
    const sizes = [...w.days.values()].flatMap((d) => d.requests.map((r) => r.length));
    expect(sizes).toEqual([30, 30, 30, 10, 30, 20]); // 20261009 の 100 → 30 30 30 10(1 チャンクは 1 つの日だけ)、20261008 は 30 と 20(= 150 - 130)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(BACKFILL_NIGHTLY_LIMIT);
    expect(w.listCalls.length).toBe(6); // 上限に達した後は列挙しない(本物の D1 は limit 0 を RangeError にする)
    expect(w.listCalls.every((c) => c.limit >= 1)).toBe(true);
    expect(w.alarm).toBe(jst(10, 11, 1));
    expect((await core.getStatus()).state).toBe("waiting-window");

    // 翌晩
    w.now = jst(10, 11, 1, 5);
    await core.runNextStep();
    expect((await core.getStatus()).tonight).toMatchObject({ night: "20261011", dispatched: 30 });
  });

  it("上限を下げる指定(70)と 1 回の数(30): 30・30・10", async () => {
    const w = new World();
    w.unimported = races("20261009", 200);
    const { core } = make(w, { nightlyLimit: 70, chunkSize: 30 });
    await runNight(w, core);
    expect(w.day("20261009").requests.map((r) => r.length)).toEqual([30, 30, 10]);
  });
});

// ---- 取得できないレース ----

describe("取得できなかったレースの記録(無限に再試行しない)", () => {
  /** 1 レースだけを、指定の分類で諦めさせる 1 晩。 */
  async function failOnce(w: World, core: ResultBackfillCore, cls: ResultClass): Promise<void> {
    await core.runNextStep(); // 依頼
    w.settleGaveUp(YESTERDAY, cls);
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収
  }

  const permanent: ResultClass[] = ["not-confirmed", "no-payout", "parse-error", "incomplete"];
  it.each(permanent)("%s: 1 サイクルで永久に除外する(翌晩以降も依頼しない)", async (cls) => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    const { core } = make(w);
    await failOnce(w, core, cls);
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect((await core.getStatus()).abandoned).toEqual({ total: 1, byClass: { [cls]: 1 } });
    for (const day of [11, 12, 13]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day(YESTERDAY).requests.length).toBe(1); // 追加の依頼なし
    expect(w.listCalls.at(-1)!.exclude).toEqual([idOf(YESTERDAY, 1)]);
  });

  const transient: ResultClass[] = ["fetch-failed", "save-failed"];
  it.each(transient)(`%s: 1 晩に 1 回、翌晩に再試行し、${BACKFILL_MAX_NIGHTS} 晩目で永久に除外する`, async (cls) => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    const { core } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2); // 10/10, 10/11, 10/12 の 02:00
      await failOnce(w, core, cls);
      expect(w.day(YESTERDAY).requests.length).toBe(night);
      const abandoned = (await core.getStatus()).abandoned.total;
      expect(abandoned).toBe(night === BACKFILL_MAX_NIGHTS ? 1 : 0);
    }
    w.now = jst(10, 13, 2);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(BACKFILL_MAX_NIGHTS); // それ以上は依頼しない
  });

  it("同じ晩のうちは、諦めたレースを再び依頼しない(その晩に試したものを除外する)。次の依頼は翌晩", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    const { core } = make(w);
    await failOnce(w, core, "fetch-failed");
    // 回収した tick の中で再び列挙しているが、そのレースは除外されて空 → 翌晩にアラーム。
    expect(w.listCalls.at(-1)!.exclude).toEqual([idOf(YESTERDAY, 1)]);
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect(w.alarm).toBe(jst(10, 11, 1));
  });

  it("blocked・busy(gate の都合): 晩数に数えず、その晩は止める(翌晩にアラーム)。5 晩続いたら永久に除外する", async () => {
    const w = new World();
    w.unimported = [...races(YESTERDAY, 1), ...races("20261001", 1)];
    const { core } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_DEFER_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await failOnce(w, core, night % 2 === 0 ? "busy" : "blocked");
      // その晩は止める: 古い日(20261001)のレースを続けて依頼しない
      expect(w.day("20261001").requests.length).toBe(0);
      expect(w.alarm).toBe(jst(10, 10 + night, 1));
      expect((await core.getStatus()).state).toBe("paused");
      expect((await core.getStatus()).abandoned.total).toBe(night === BACKFILL_MAX_DEFER_NIGHTS ? 1 : 0);
    }
    expect(w.day(YESTERDAY).requests.length).toBe(BACKFILL_MAX_DEFER_NIGHTS);
  });

  it("40 分たっても queued のまま(止まっている)なら、stalled として 1 晩に数え、待ちを打ち切る", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 2);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.now += BACKFILL_INFLIGHT_MAX_MS - 1;
    await core.runNextStep();
    expect((await core.getStatus()).inflight).not.toBeNull(); // まだ待つ
    w.now += 1;
    await core.runNextStep();
    const status = await core.getStatus();
    expect(status.inflight).toBeNull();
    expect(w.day(YESTERDAY).requests.length).toBe(1); // その晩は再依頼しない
    const rows = sql.exec("SELECT race_id, nights, last_class, state FROM backfill_race ORDER BY race_id").toArray() as Array<{ race_id: string; nights: number; last_class: string; state: string }>;
    expect(rows.map((r) => [r.race_id, r.nights, r.last_class, r.state])).toEqual([
      [idOf(YESTERDAY, 1), 1, "stalled", "tried"],
      [idOf(YESTERDAY, 2), 1, "stalled", "tried"],
    ]);
  });

  it("進行の読み取りが失敗: 待ちの途中は inflight を残して 10 分後に再試行、40 分を過ぎたら stalled として回収する", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    const { core } = make(w);
    await core.runNextStep();
    w.day(YESTERDAY).failProgress = true;
    w.now += BACKFILL_POLL_MS;
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.alarm).toBe(w.now + BACKFILL_ERROR_RETRY_MS);
    expect((await core.getStatus()).inflight).not.toBeNull();
    w.now = T0 + BACKFILL_INFLIGHT_MAX_MS;
    await core.runNextStep();
    expect((await core.getStatus()).inflight).toBeNull();
  });

  it("日の DO への依頼が失敗(RPC): 例外にせず、その晩は止め、記録する(晩数ではなく gate 側の都合と同じ数え方)", async () => {
    const w = new World();
    w.unimported = [...races(YESTERDAY, 1), ...races("20261001", 1)];
    w.day(YESTERDAY).failRequest = true;
    const { core } = make(w);
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.day("20261001").requests.length).toBe(0);
    expect(w.alarm).toBe(jst(10, 11, 1));
    const status = await core.getStatus();
    expect(status.inflight).toBeNull();
    expect(status.state).toBe("paused");
    expect(w.warns.join("\n")).not.toContain("SECRET");
  });

  it("D1 の列挙が失敗: 例外にせず、依頼せず、10 分後に再試行する", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    w.listError = true;
    const { core } = make(w);
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.days.size).toBe(0);
    expect(w.alarm).toBe(T0 + BACKFILL_ERROR_RETRY_MS);
    expect(w.warns.join("\n")).not.toContain("SECRET");
  });
});

describe("日単位の DO が受け付けないレース(不正なレースID・開催日との不整合)は、チャンクの他のレースを巻き込まないよう、依頼の前に除外する", () => {
  // 開催日と食い違うレースID: 年が違う中央のID、月日が違う地方のID(地方は 7〜10 桁目が開催日の月日)、12 桁でないID。
  const bad = [
    { raceId: "202505009002", kaisaiDate: YESTERDAY, label: "年が違う中央" },
    { raceId: "202646071203", kaisaiDate: YESTERDAY, label: "月日が違う地方(0712 ≠ 1009)" },
    { raceId: "12345", kaisaiDate: YESTERDAY, label: "12 桁でない" },
  ];

  it.each(bad)("$label: 依頼せず、永久に除外する(invalid-race)。同じチャンクの有効なレースは同じ tick で依頼する", async ({ raceId, kaisaiDate }) => {
    const w = new World();
    w.unimported = [{ raceId, kaisaiDate }, ...races(YESTERDAY, 2)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([races(YESTERDAY, 2).map((r) => r.raceId)]); // 不正なレースは含まない
    const status = await core.getStatus();
    expect(status.abandoned).toEqual({ total: 1, byClass: { "invalid-race": 1 } });
    expect(status.tonight.dispatched).toBe(2); // 不正なレースは 1 晩の上限に数えない
    expect(status.inflight).toMatchObject({ races: 2 });
  });

  it("チャンクが全部不正なら、同じ tick で次を列挙し直す(次の晩まで待たない)。永久に除外したレースは次の列挙から外れる", async () => {
    const w = new World();
    w.unimported = [...bad.map((b) => ({ raceId: b.raceId, kaisaiDate: b.kaisaiDate })), ...races("20261001", 2)];
    const { core } = make(w, { chunkSize: 3 });
    await core.runNextStep();
    expect(w.listCalls.length).toBe(2); // 1 回目は全部不正 → 2 回目で古い日の有効なレース
    expect(w.listCalls[1]!.exclude.sort()).toEqual(bad.map((b) => b.raceId).sort());
    expect(w.day("20261001").requests).toEqual([races("20261001", 2).map((r) => r.raceId)]);
    expect((await core.getStatus()).abandoned.total).toBe(3);
  });

  it("不正なレースだけが残っているなら、依頼せず(DO を開かず)、次の晩にアラームを張る。再列挙は有限回(無限ループしない)", async () => {
    const w = new World();
    w.unimported = bad.map((b) => ({ raceId: b.raceId, kaisaiDate: b.kaisaiDate }));
    const { core } = make(w, { chunkSize: 1 });
    await core.runNextStep();
    expect(w.days.size).toBe(0);
    expect(w.alarm).toBe(jst(10, 11, 1));
    expect(w.listCalls.length).toBeLessThanOrEqual(4); // 3 件を 1 件ずつ除外して、最後に空
    expect((await core.getStatus()).abandoned.total).toBe(3);
  });
});

// ---- 状態・永続 ----

describe("状態は DO の SQLite に残る(再起動しても続きから)", () => {
  it("新しいインスタンス(同じ SQLite)が、飛行中のチャンクと除外を引き継ぐ", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 40);
    const first = make(w);
    await first.core.runNextStep();
    const { core: second } = make(w, {}, first.sql);
    // 進行中なので、新しいインスタンスも依頼しない
    w.now += BACKFILL_POLL_MS;
    await second.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect((await second.getStatus()).inflight).toMatchObject({ day: YESTERDAY, races: 30 });
  });
});

describe("getStatus: 残り・取得済み・取得できなかった・開催日不明", () => {
  it("残り(dated)・開催日不明(undated)・取得済み・取得できなかった(クラス別)・次の実行・移行の状態を返す", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 5);
    w.undated = 7;
    const { core } = make(w, { chunkSize: 5 });
    await core.runNextStep();
    const row = w.day(YESTERDAY).rows;
    const ids = [...row.keys()];
    row.get(ids[0]!)!.state = "imported";
    w.unimported = w.unimported.filter((r) => r.raceId !== ids[0]);
    row.get(ids[1]!)!.state = "gave_up";
    row.get(ids[1]!)!.lastClass = "no-payout";
    row.get(ids[2]!)!.state = "gave_up";
    row.get(ids[2]!)!.lastClass = "parse-error";
    row.get(ids[3]!)!.state = "gave_up";
    row.get(ids[3]!)!.lastClass = "no-payout";
    row.get(ids[4]!)!.state = "gave_up";
    row.get(ids[4]!)!.lastClass = "fetch-failed";
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    const status = await core.getStatus();
    expect(status.imported).toBe(1);
    expect(status.abandoned).toEqual({ total: 3, byClass: { "no-payout": 2, "parse-error": 1 } });
    expect(status.remaining).toBe(1); // 一時的な失敗の 1 件だけが残る(除外は数えない)
    expect(status.undated).toBe(7);
    expect(status.migrationState).toBe("completed");
    expect(status.window).toEqual({ startHour: 1, endHour: 6 });
    expect(status.nextRunAt).toBe(new Date(w.alarm!).toISOString());
  });

  it("移行が完了していないときは waiting-migration(移行の状態も返す)。移行の状態を読めないときは migrationState が null", async () => {
    const w = new World();
    w.migration = "importing";
    const { core } = make(w);
    expect(await core.getStatus()).toMatchObject({ state: "waiting-migration", migrationState: "importing" });
    w.migrationError = true;
    expect(await core.getStatus()).toMatchObject({ state: "waiting-migration", migrationState: null });
  });

  it("窓の外では waiting-window、窓の中で未取込があれば ready", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 1);
    const { core } = make(w);
    expect((await core.getStatus()).state).toBe("ready");
    w.now = jst(10, 10, 12);
    expect((await core.getStatus()).state).toBe("waiting-window");
  });
});

describe("kick(cron から毎日 1 回。アラームが無いときだけ張る)", () => {
  it("アラームが無ければ、次の窓の開始に張る(窓の中なら今)。あれば触らない", async () => {
    const w = new World();
    const { core } = make(w);
    w.now = jst(10, 10, 9);
    await core.kick();
    expect(w.alarm).toBe(jst(10, 11, 1));
    const calls = w.setAlarmCalls.length;
    await core.kick();
    expect(w.setAlarmCalls.length).toBe(calls); // 既にあるので張り直さない

    w.alarm = null;
    w.now = jst(10, 10, 3);
    await core.kick();
    expect(w.alarm).toBe(jst(10, 10, 3));
  });

  it("飛行中のチャンクがあるときにアラームが無ければ、すぐ(進行を見る)に張る", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    const { core } = make(w);
    await core.runNextStep();
    w.alarm = null;
    w.now = jst(10, 10, 9);
    await core.kick();
    expect(w.alarm).toBe(w.now);
  });
});

describe("例外を投げない", () => {
  it("setAlarm・getAlarm 以外の依存がどう失敗しても runNextStep は reject しない", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.listError = true;
    w.gateError = true;
    w.migrationError = true;
    const { core } = make(w);
    await expect(core.runNextStep()).resolves.toBeUndefined();
    w.migrationError = false;
    await expect(core.runNextStep()).resolves.toBeUndefined();
    w.gateError = false;
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.setAlarmCalls.length).toBe(3);
  });
});
