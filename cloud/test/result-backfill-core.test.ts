import { afterEach, describe, expect, it } from "vitest";

import {
  BACKFILL_CHUNK_SIZE,
  BACKFILL_ERROR_RETRY_MS,
  BACKFILL_GATE_BUSY_DELAY_MS,
  BACKFILL_GATE_BUSY_PENDING,
  BACKFILL_INFLIGHT_MAX_MS,
  BACKFILL_MAX_DEFER_NIGHTS,
  BACKFILL_MAX_RELIST,
  BACKFILL_MAX_NIGHTS,
  BACKFILL_NIGHTLY_LIMIT,
  BACKFILL_POLL_MS,
  BACKFILL_WINDOW_END_HOUR_JST,
  BACKFILL_WINDOW_START_HOUR_JST,
  inBackfillWindow,
  isBackfillDisabled,
  nextBackfillWindowStart,
  ResultBackfillCore,
  type BackfillDayStub,
  type BackfillOptions,
  type BackfillStore,
} from "../src/result-backfill-core";
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
  gate: { blockedUntil: number | null; pending: number } = { blockedUntil: null, pending: 0 };
  gateError = false;
  /** 未取込のレース(取り込み済みになると消える)。 */
  unimported: Array<{ raceId: string; kaisaiDate: string }> = [];
  undated = 0;
  /** 段階 2(Issue #259): 結果はあるがオッズが 1 頭も無いレース(オッズが入ると消える)。 */
  needOdds: Array<{ raceId: string; kaisaiDate: string }> = [];
  undatedOdds = 0;
  /** 段階 2 の観測(Issue #270): scratched が欠けて対象になるレースの数。偽の列挙には関与せず、`countWinOddsBackfill` がそのまま返す。 */
  scratchedMissing = 0;
  oddsListCalls: Array<{ to: string; exclude: string[]; limit: number }> = [];
  listCalls: Array<{ to: string; exclude: string[]; limit: number }> = [];
  listError = false;
  /** 日ごとの DO。 */
  days = new Map<string, { requests: string[][]; flags: Array<boolean | undefined>; rows: Map<string, DayRow>; failRequest: boolean; failProgress: boolean }>();
  setAlarmCalls: number[] = [];
  warns: string[] = [];

  day(date: string) {
    let d = this.days.get(date);
    if (d === undefined) {
      d = { requests: [], flags: [], rows: new Map(), failRequest: false, failProgress: false };
      this.days.set(date, d);
    }
    return d;
  }

  /**
   * 日の DO の、積まれた行を全部「取り込み済み」にする(D1 にも結果が入ったことにする)。
   * `oddsStay: true` は、段階 2 の依頼が成功したのに D1 のオッズが入らなかった(結果ページにオッズが無かった)ことにする(列挙の対象に残る)。
   */
  settleImported(date: string, oddsStay = false): void {
    for (const [id, row] of this.day(date).rows) {
      if (row.state === "queued") {
        row.state = "imported";
        row.lastClass = "imported";
        this.unimported = this.unimported.filter((r) => r.raceId !== id);
        if (!oddsStay) {
          this.needOdds = this.needOdds.filter((r) => r.raceId !== id);
        }
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
    listWinOddsBackfillRaces: async ({ to, exclude, limit }) => {
      this.oddsListCalls.push({ to, exclude: [...exclude], limit });
      const candidates = this.needOdds.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId));
      if (candidates.length === 0) return [];
      const newest = candidates.map((r) => r.kaisaiDate).sort().at(-1)!;
      return candidates
        .filter((r) => r.kaisaiDate === newest)
        .sort((a, b) => a.raceId.localeCompare(b.raceId))
        .slice(0, limit);
    },
    countWinOddsBackfill: async ({ to, exclude }) => ({
      dated: this.needOdds.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId)).length,
      undated: this.undatedOdds,
      scratchedMissing: this.scratchedMissing,
    }),
  };

  stubFor = (date: string): BackfillDayStub => {
    const d = this.day(date);
    return {
      requestResultImport: async ({ raceIds, winOddsOnly }) => {
        if (d.failRequest) throw new Error("RPC SECRET-REQ");
        d.requests.push([...raceIds]);
        d.flags.push(winOddsOnly);
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

// ---- 起動の条件(Issue #394: 移行の状態には依存しない) ----

describe("移行の状態には依存しない(Issue #394。以前は移行の DO が completed のときだけ動かしていた)", () => {
  it("窓の中で未取込があれば、移行の状態を読まずに最初の runNextStep で依頼する(依存に migrationState が無い)", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect(w.alarm).not.toBeNull();
  });

  it("getStatus は移行の状態を持たず、窓の中で未取込があれば ready(waiting-migration の状態は無い)", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    const status = await make(w).core.getStatus();
    expect(status.state).toBe("ready");
    expect("migrationState" in status).toBe(false);
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
  it.each(permanent)("%s: 同じチャンクに取り込めたレースがあれば、1 サイクルで永久に除外する(翌晩以降も依頼しない)", async (cls) => {
    const w = new World();
    w.unimported = races(YESTERDAY, 2);
    const { core } = make(w);
    await core.runNextStep(); // 依頼(2 レース)
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 1))!.state = "imported"; // 1 つは取り込めた(系統的な障害ではない)
    w.unimported = w.unimported.filter((r) => r.raceId !== idOf(YESTERDAY, 1));
    w.settleGaveUp(YESTERDAY, cls);
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect((await core.getStatus()).abandoned).toEqual({ total: 1, byClass: { [cls]: 1 } });
    for (const day of [11, 12, 13]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day(YESTERDAY).requests.length).toBe(1); // 追加の依頼なし
    expect(w.listCalls.at(-1)!.exclude).toEqual([idOf(YESTERDAY, 2)]);
  });

  // 系統的な障害(netkeiba が 200 のメンテナンス画面を返す等)で、その晩のレースが一括で永久に除外されない。
  it.each(permanent)(`%s: チャンクで取り込みが 0 件かつ全件が同じ分類なら、系統的な障害とみなして一時的な扱い(晩数に数える)。${BACKFILL_MAX_NIGHTS} 晩目で除外する`, async (cls) => {
    const w = new World();
    w.unimported = races(YESTERDAY, 30);
    const { core } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await failOnce(w, core, cls);
      const status = await core.getStatus();
      expect(w.day(YESTERDAY).requests.length, `${night} 晩目の依頼`).toBe(night);
      expect(w.day(YESTERDAY).requests[night - 1]!.length).toBe(30);
      expect(status.abandoned.total, `${night} 晩目の除外`).toBe(night === BACKFILL_MAX_NIGHTS ? 30 : 0);
      expect(status.remaining).toBe(night === BACKFILL_MAX_NIGHTS ? 0 : 30);
    }
    w.now = jst(10, 13, 2);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(BACKFILL_MAX_NIGHTS); // 無限には再試行しない
  });

  it("系統的な障害の判定は『取り込み 0 件かつ全件が同じ分類』だけ: 分類が混ざる(no-payout と parse-error)チャンクは従来どおり永久に除外する", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 2);
    const { core } = make(w);
    await core.runNextStep();
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 1))!.state = "gave_up";
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 1))!.lastClass = "no-payout";
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 2))!.state = "gave_up";
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 2))!.lastClass = "parse-error";
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect((await core.getStatus()).abandoned).toEqual({ total: 2, byClass: { "no-payout": 1, "parse-error": 1 } });
  });

  it("系統的な障害のとき、その晩のほかのチャンクも(その晩に試したレースは除外されるので)同じレースを再び取得しない。1 晩 1 回だけ", async () => {
    const w = new World();
    w.unimported = [...races(YESTERDAY, 30), ...races("20261001", 5)];
    const { core } = make(w);
    await failOnce(w, core, "not-confirmed"); // 新しい日の 30 レースが全滅 → 一時的な扱い
    // 同じ tick で次のチャンク(古い日の 5 レース)が依頼されている。新しい日のレースは再び依頼されない。
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect(w.day("20261001").requests.length).toBe(1);
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

describe("補完を止める設定(disabled): 何もせず、アラームも張らない", () => {
  it("kick はアラームを張らず、runNextStep は列挙も依頼もせず、アラームも張らない。残りがあって窓の中でも同じ", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    const { core } = make(w, { disabled: true });
    await core.kick();
    await core.runNextStep();
    expect(w.alarm).toBeNull();
    expect(w.setAlarmCalls).toEqual([]);
    expect(w.listCalls).toEqual([]);
    expect(w.days.size).toBe(0);
  });

  it("既にアラームがあっても(止める前に張られたもの)、起きたときは何もせず張り直さない", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.alarm = T0;
    const { core } = make(w, { disabled: true });
    w.alarm = null; // 起きた(アラームは消費された)
    await core.runNextStep();
    expect(w.alarm).toBeNull();
    expect(w.days.size).toBe(0);
  });

  it("getStatus は state が disabled(残りは読める)。止めていなければ disabled にならない", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 3);
    w.undated = 2;
    const status = await make(w, { disabled: true }).core.getStatus();
    expect(status).toMatchObject({ state: "disabled", remaining: 3, undated: 2 });
    expect((await make(new World()).core.getStatus()).state).not.toBe("disabled");
  });

  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ["", false],
    ["150", false],
    ["1", false],
    ["abc", false],
    ["-1", false],
    ["0", true],
    [" 0 ", true],
    ["00", false],
  ];
  it.each(cases)("isBackfillDisabled(%j) → %s(\"0\" だけが無効。前後の空白は無視)", (value, expected) => {
    expect(isBackfillDisabled(value)).toBe(expected);
  });
});

describe("dispatch-failed は gate の都合と同じ defer(晩数に数えない): 1 回の失敗で 30 レースを永久に除外しない", () => {
  it(`依頼の失敗が ${BACKFILL_MAX_DEFER_NIGHTS - 1} 晩続いても除外せず、${BACKFILL_MAX_DEFER_NIGHTS} 晩目で除外する。晩数(nights)は増えない`, async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 30);
    w.day(YESTERDAY).failRequest = true;
    const { core, sql } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_DEFER_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await core.runNextStep();
      const rows = sql.exec("SELECT nights, defers, last_class, state FROM backfill_race").toArray() as Array<{ nights: number; defers: number; last_class: string; state: string }>;
      expect(rows).toHaveLength(30);
      expect(rows.every((r) => r.nights === 0 && r.defers === night && r.last_class === "dispatch-failed"), `${night} 晩目の記録`).toBe(true);
      expect(rows.every((r) => r.state === (night === BACKFILL_MAX_DEFER_NIGHTS ? "abandoned" : "tried"))).toBe(true);
      expect((await core.getStatus()).abandoned.total).toBe(night === BACKFILL_MAX_DEFER_NIGHTS ? 30 : 0);
    }
  });

  it("1 回の失敗のあと、翌晩は同じレースを再び依頼する(永久に除外されていない)", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 30);
    w.day(YESTERDAY).failRequest = true;
    const { core } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([]);
    w.day(YESTERDAY).failRequest = false;
    w.now = jst(10, 11, 2);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(1);
    expect(w.day(YESTERDAY).requests[0]!.length).toBe(30);
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
    expect(status.window).toEqual({ startHour: 1, endHour: 6 });
    expect(status.nextRunAt).toBe(new Date(w.alarm!).toISOString());
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
    const { core } = make(w);
    await expect(core.runNextStep()).resolves.toBeUndefined();
    await expect(core.runNextStep()).resolves.toBeUndefined();
    w.gateError = false;
    await expect(core.runNextStep()).resolves.toBeUndefined();
    expect(w.setAlarmCalls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Issue #259: 段階 2(確定の単勝オッズ・人気の補完)
// ---------------------------------------------------------------------------

describe("段階 2: 段階 1 が尽きたら、結果はあるがオッズが無いレースを winOddsOnly で依頼する", () => {
  it("段階 1 が空なら、同じ tick で段階 2 を列挙して依頼する(最も新しい日の 30 レース・winOddsOnly: true)。段階 1 の依頼には winOddsOnly を付けない", async () => {
    const w = new World();
    w.needOdds = [...races("20261009", 45), ...races("20261001", 5)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.listCalls).toHaveLength(1); // 段階 1 を先に引く(空)
    expect(w.oddsListCalls).toEqual([{ to: YESTERDAY, exclude: [], limit: 30 }]);
    expect(w.day("20261009").requests).toEqual([races("20261009", 30).map((r) => r.raceId)]);
    expect(w.day("20261009").flags).toEqual([true]);
    expect(w.alarm).toBe(T0 + BACKFILL_POLL_MS);
    const status = await core.getStatus();
    expect(status.state).toBe("running");
    expect(status.inflight).toMatchObject({ day: "20261009", races: 30 });
    expect(status.tonight).toMatchObject({ dispatched: 30 });
  });

  it("段階 1 に未取込が残る間は、段階 2 を列挙しない(段階 1 が先)。段階 1 の依頼は winOddsOnly を付けない(undefined)", async () => {
    const w = new World();
    w.unimported = races("20261009", 3);
    w.needOdds = races("20261008", 3);
    const { core } = make(w);
    await core.runNextStep();
    expect(w.oddsListCalls).toEqual([]);
    expect(w.day("20261009").flags).toEqual([undefined]);
    expect([...w.days.keys()]).toEqual(["20261009"]);
  });

  it("段階 1 が尽きた次の tick で段階 2 に進む: 1 チャンク目を取り込み、次の tick で段階 2 のチャンクを依頼する", async () => {
    const w = new World();
    w.unimported = races("20261009", 2);
    w.needOdds = races("20261008", 2);
    const { core } = make(w);
    await core.runNextStep(); // 段階 1 の依頼
    w.settleImported("20261009");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収 → 段階 1 は空 → 段階 2 を依頼
    expect(w.day("20261009").flags).toEqual([undefined]);
    expect(w.day("20261008").flags).toEqual([true]);
    expect(w.day("20261008").requests).toEqual([races("20261008", 2).map((r) => r.raceId)]);
    expect((await core.getStatus()).imported).toBe(2); // 取り込みの累計は段階 1 だけが数える
  });

  it("段階 2 の取り込みが成功したレースは fill_done になり、ページにオッズが無くて D1 の列挙に残っても、二度と依頼しない(毎晩の再列挙を防ぐ)", async () => {
    const w = new World();
    w.needOdds = races("20261009", 3);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.settleImported("20261009", true); // 成功したが D1 にはオッズが入らず、列挙の対象に残る
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収。続けて列挙するが、全部 fill_done で除外されて空
    expect(w.needOdds).toHaveLength(3); // 前提: D1 の列挙の対象には残っている
    expect(w.day("20261009").requests).toHaveLength(1);
    expect(w.oddsListCalls.at(-1)!.exclude).toEqual(races("20261009", 3).map((r) => r.raceId).sort());
    expect((sql.exec("SELECT state, COUNT(*) AS n FROM backfill_race GROUP BY state").toArray() as Array<{ state: string; n: number }>)).toEqual([{ state: "fill_done", n: 3 }]);
    for (const day of [11, 12, 13]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day("20261009").requests).toHaveLength(1); // 追加の依頼なし
    const status = await core.getStatus();
    expect(status.winOdds).toEqual({ remaining: 0, undated: 0, filled: 3, scratchedMissing: 0, abandoned: { total: 0, byClass: {} } });
    expect(status.state).toBe("done");
  });

  it("1 晩の上限は段階 1・2 で共有する: 段階 1 の 100 レースのあと、段階 2 は残り 50 レースだけ(30・20)", async () => {
    const w = new World();
    w.unimported = races("20261009", 100);
    w.needOdds = races("20261008", 80);
    const { core } = make(w);
    for (let i = 0; i < 12; i += 1) {
      await core.runNextStep();
      w.settleImported("20261009");
      w.settleImported("20261008");
      w.now += BACKFILL_POLL_MS;
    }
    const sizes = (date: string) => w.day(date).requests.map((r) => r.length);
    expect(sizes("20261009")).toEqual([30, 30, 30, 10]); // 段階 1: 100
    expect(sizes("20261008")).toEqual([30, 20]); // 段階 2: 150 - 100 = 50
    expect((await core.getStatus()).tonight.dispatched).toBe(150);
  });

  it("段階 2 の失敗は段階 2 の状態(odds_tried / odds_abandoned)に記録し、段階 1 の abandoned には混ざらない。永久な分類は 1 サイクルで除外(取り込めたレースがあるとき)", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 2);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 1))!.state = "imported";
    w.needOdds = w.needOdds.filter((r) => r.raceId !== idOf(YESTERDAY, 1));
    w.settleGaveUp(YESTERDAY, "no-payout");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    const status = await core.getStatus();
    expect(status.abandoned).toEqual({ total: 0, byClass: {} }); // 段階 1 の除外には数えない
    expect(status.winOdds).toEqual({ remaining: 0, undated: 0, filled: 1, scratchedMissing: 0, abandoned: { total: 1, byClass: { "no-payout": 1 } } });
    expect((sql.exec("SELECT race_id, state FROM backfill_race ORDER BY race_id").toArray() as Array<{ race_id: string; state: string }>)).toEqual([
      { race_id: idOf(YESTERDAY, 1), state: "fill_done" },
      { race_id: idOf(YESTERDAY, 2), state: "odds_abandoned" },
    ]);
  });

  it("段階 2 の一時的な失敗は晩数に数え、BACKFILL_MAX_NIGHTS 晩目で除外する(段階 1 と同じ規則)", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 1);
    const { core, sql } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await core.runNextStep();
      w.settleGaveUp(YESTERDAY, "fetch-failed");
      w.now += BACKFILL_POLL_MS;
      await core.runNextStep();
      expect(w.day(YESTERDAY).requests.length, `${night} 晩目`).toBe(night);
    }
    expect((sql.exec("SELECT state FROM backfill_race").toArray() as Array<{ state: string }>)).toEqual([{ state: "odds_abandoned" }]);
    w.now = jst(10, 13, 2);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(BACKFILL_MAX_NIGHTS);
  });

  it("再起動しても続きから: 段階 2 の飛行中の記録(kind)を新しいインスタンスが引き継ぎ、回収したレースを fill_done にする", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 2);
    const first = make(w);
    await first.core.runNextStep();
    w.settleImported(YESTERDAY, true);
    w.now += BACKFILL_POLL_MS;
    const second = make(w, {}, first.sql);
    await second.core.runNextStep();
    expect((await second.core.getStatus()).winOdds.filled).toBe(2);
  });

  it("この変更より前に保存された飛行中の記録(kind なし)は段階 1 として回収する(取り込めたレースの記録を消す=従来どおり)", async () => {
    const w = new World();
    w.unimported = races(YESTERDAY, 2);
    const first = make(w);
    await first.core.runNextStep();
    const meta = first.sql.exec("SELECT value FROM backfill_meta WHERE key = 'inflight'").toArray() as Array<{ value: string }>;
    const legacy = JSON.parse(meta[0]!.value) as Record<string, unknown>;
    expect(legacy["kind"]).toBe("results"); // 前提: 新しい記録は kind を持つ
    delete legacy["kind"];
    first.sql.exec("UPDATE backfill_meta SET value = ? WHERE key = 'inflight'", JSON.stringify(legacy));
    w.settleImported(YESTERDAY);
    w.now += BACKFILL_POLL_MS;
    await make(w, {}, first.sql).core.runNextStep();
    expect((first.sql.exec("SELECT COUNT(*) AS n FROM backfill_race").toArray() as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  it("getStatus: 段階 2 の残りがあれば、段階 1 が空でも done にならない(ready)。残り・開催日不明の数を返す", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 4);
    w.undatedOdds = 9;
    const { core } = make(w);
    const status = await core.getStatus();
    expect(status.remaining).toBe(0);
    expect(status.state).toBe("ready");
    expect(status.winOdds).toEqual({ remaining: 4, undated: 9, filled: 0, scratchedMissing: 0, abandoned: { total: 0, byClass: {} } });
  });

  it("段階 2 の日単位の DO への依頼が失敗: 段階 1 と同じく、その晩は止める(dispatch-failed を記録)", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 3);
    w.day(YESTERDAY).failRequest = true;
    const { core, sql } = make(w);
    await core.runNextStep();
    expect(w.alarm).toBe(jst(10, 11, 1));
    expect((sql.exec("SELECT state, last_class FROM backfill_race ORDER BY race_id").toArray() as Array<{ state: string; last_class: string }>)).toEqual(
      Array.from({ length: 3 }, () => ({ state: "odds_tried", last_class: "dispatch-failed" })),
    );
  });
});

describe("段階 2 と不正なレース(Issue #259)", () => {
  it("段階 1 の再列挙の上限(BACKFILL_MAX_RELIST 回)を不正なレースだけで使い切った tick は、まだ段階 1 が尽きたと言えないので、段階 2 に進まない。次の tick で空になって初めて進む", async () => {
    const w = new World();
    // 12 桁でないレースID(checkRaceDate が弾く)を上限+1 件。chunkSize 1 なので、1 回の列挙で 1 件ずつ除外され、再列挙の上限を使い切っても 1 件が残る。
    w.unimported = Array.from({ length: BACKFILL_MAX_RELIST + 1 }, (_, i) => ({ raceId: `9${i}`, kaisaiDate: YESTERDAY }));
    w.needOdds = races("20261008", 2);
    const { core } = make(w, { chunkSize: 1 });
    await core.runNextStep();
    expect(w.listCalls).toHaveLength(BACKFILL_MAX_RELIST);
    expect(w.oddsListCalls).toEqual([]); // 段階 2 は列挙しない
    expect(w.days.size).toBe(0);
    expect(w.alarm).toBe(T0 + BACKFILL_POLL_MS); // 続きは次のステップ
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 残りの 1 件を除外して空 → 段階 2 を依頼
    expect(w.oddsListCalls).toHaveLength(1);
    expect(w.day("20261008").flags).toEqual([true]);
  });

  it("段階 2 でも、開催日と食い違う不正なレースID は依頼の前に除外する(odds_abandoned・invalid-race)。同じ列挙の有効なレースは依頼する", async () => {
    const w = new World();
    w.needOdds = [{ raceId: "12345", kaisaiDate: YESTERDAY }, ...races(YESTERDAY, 2)];
    const { core, sql } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([races(YESTERDAY, 2).map((r) => r.raceId)]);
    expect(sql.exec("SELECT race_id, state, last_class FROM backfill_race").toArray()).toEqual([{ race_id: "12345", state: "odds_abandoned", last_class: "invalid-race" }]);
    const status = await core.getStatus();
    expect(status.abandoned.total).toBe(0);
    expect(status.winOdds.abandoned).toEqual({ total: 1, byClass: { "invalid-race": 1 } });
  });
});

// ---------------------------------------------------------------------------
// Issue #270: 段階 2 の対象に scratched の補完を畳み込む(完了の印は fill_done。旧い odds_done は除外しない)
// ---------------------------------------------------------------------------

describe("Issue #270: 完了の印 fill_done と、旧い odds_done の扱い", () => {
  const stateRows = (sql: NodeSql) => sql.exec("SELECT race_id, state, last_class FROM backfill_race ORDER BY race_id").toArray() as Array<{ race_id: string; state: string; last_class: string }>;

  it("#72 の公開より前に odds_done になったレースは、列挙の除外に含めず、D1 の条件(scratched の欠け)が選ぶ限り依頼する。取り込めたら fill_done に変わる", async () => {
    const w = new World();
    const legacy = races(YESTERDAY, 2);
    w.needOdds = legacy; // D1 の列挙は、オッズ済みでも scratched が欠けるレースを返す(偽)
    const { core, sql } = make(w);
    for (const r of legacy) {
      sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES (?, 0, 0, '20261001', 'imported', 'odds_done')", r.raceId);
    }
    await core.runNextStep();
    expect(w.oddsListCalls[0]!.exclude).toEqual([]); // 旧い odds_done は除外しない
    expect(w.day(YESTERDAY).requests).toEqual([legacy.map((r) => r.raceId)]);
    expect(w.day(YESTERDAY).flags).toEqual([true]);
    w.settleImported(YESTERDAY, true); // 取り込めたが、ページに何も無く D1 の列挙の対象に残る
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(stateRows(sql).map((r) => r.state)).toEqual(["fill_done", "fill_done"]); // 上書きされ、件数は増えない
    expect(w.oddsListCalls.at(-1)!.exclude).toEqual(legacy.map((r) => r.raceId).sort()); // 以後は除外される
    for (const day of [11, 12]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day(YESTERDAY).requests).toHaveLength(1); // 二度と依頼しない(ping-pong しない)
  });

  it("odds_abandoned は従来どおり除外する(取得の失敗が永続した分は、scratched のためにも救済しない)", async () => {
    const w = new World();
    w.needOdds = races(YESTERDAY, 2);
    const { core, sql } = make(w);
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES (?, 3, 0, '20261001', 'fetch-failed', 'odds_abandoned')", idOf(YESTERDAY, 1));
    await core.runNextStep();
    expect(w.oddsListCalls[0]!.exclude).toEqual([idOf(YESTERDAY, 1)]);
    expect(w.day(YESTERDAY).requests).toEqual([[idOf(YESTERDAY, 2)]]);
  });

  it("getStatus: filled は旧い odds_done と fill_done の両方を数える(1 レースは 1 回)。scratchedMissing は D1 の観測値をそのまま出す", async () => {
    const w = new World();
    w.scratchedMissing = 7;
    const { core, sql } = make(w);
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('A', 0, 0, '20261001', 'imported', 'odds_done')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('B', 0, 0, '20261001', 'imported', 'fill_done')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('C', 3, 0, '20261001', 'no-payout', 'odds_abandoned')");
    const status = await core.getStatus();
    expect(status.winOdds).toEqual({ remaining: 0, undated: 0, filled: 2, scratchedMissing: 7, abandoned: { total: 1, byClass: { "no-payout": 1 } } });
  });

  it("getStatus の段階 2 の残りの数えは、旧い odds_done を除外に含めない(含めると scratched が欠けたまま残りに数えられない)", async () => {
    const w = new World();
    const seen: string[][] = [];
    const original = w.store.countWinOddsBackfill;
    w.store.countWinOddsBackfill = async (opts) => {
      seen.push([...opts.exclude]);
      return original(opts);
    };
    const { core, sql } = make(w);
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('A', 0, 0, '20261001', 'imported', 'odds_done')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('B', 0, 0, '20261001', 'imported', 'fill_done')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('C', 3, 0, '20261001', 'no-payout', 'odds_abandoned')");
    await core.getStatus();
    expect(seen).toEqual([["B", "C"]]);
  });
});

describe("Issue #270: 1 晩の取得の本数は、scratched の補完を足しても上限(150)の内側に収まる", () => {
  it("対象が 200 レースあっても、1 晩の依頼は 150 レースまで(30 × 5 チャンク)。翌晩に続きを依頼する。同じレースを 2 回依頼しない(1 レースにつき取得 1 本)", async () => {
    const w = new World();
    w.needOdds = races("20261009", 200);
    const { core } = make(w);
    for (let i = 0; i < 12; i += 1) {
      await core.runNextStep();
      w.settleImported("20261009"); // D1 の列挙から外れる(scratched・オッズが埋まった)
      w.now += BACKFILL_POLL_MS;
    }
    const sizes = w.day("20261009").requests.map((r) => r.length);
    expect(sizes).toEqual([30, 30, 30, 30, 30]); // 1 晩目: 150
    expect((await core.getStatus()).tonight.dispatched).toBe(150);
    expect(new Set(w.day("20261009").requests.flat()).size).toBe(150);
    w.now = jst(10, 11, 2);
    await core.runNextStep();
    w.settleImported("20261009");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.day("20261009").requests.slice(5).map((r) => r.length)).toEqual([30, 20]); // 翌晩: 残りの 50
    expect(new Set(w.day("20261009").requests.flat()).size).toBe(200);
  });
});
