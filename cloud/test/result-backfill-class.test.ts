import { afterEach, describe, expect, it } from "vitest";

import {
  BACKFILL_CHUNK_SIZE,
  BACKFILL_MAX_DEFER_NIGHTS,
  BACKFILL_MAX_NIGHTS,
  BACKFILL_POLL_MS,
  ResultBackfillCore,
  type BackfillDayStub,
  type BackfillOptions,
  type BackfillStore,
} from "../src/result-backfill-core";
import type { ResultClass } from "../src/race-day-result";
import type { ResultImportProgress } from "../src/race-day-core";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #426-b: 結果の補完の段階 3(`race-class` kind。既存の分析のレースのクラスを、結果ページを取り直して埋める)。
 * 段階 1・2 が尽きたあとに、結果はあるがクラスが NULL のレースを、同じ仕組み(窓・1 晩 150・1 回 30・gate の混雑で引く)で列挙して `winOddsOnly: true` で依頼する。
 * 状態は DO の SQLite の別の表 `backfill_class`(段階 1・2 の `backfill_race` は触らない)。時計・アラーム・gate・D1 の列挙・日単位の DO は偽物、状態は本物の SQLite(`node:sqlite`)。
 */

const JST = 9 * 3600_000;
/** JST の時刻 → epoch ミリ秒。 */
const jst = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute) - JST;
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
  /** 段階 3(Issue #426-b): 結果はあるがクラスが NULL のレース(取り込み済みでクラスが入ると消える)。 */
  needClass: Array<{ raceId: string; kaisaiDate: string }> = [];
  undatedClass = 0;
  classStillNull = 0;
  classDistribution: Array<{ value: string; races: number }> = [];
  classListCalls: Array<{ to: string; exclude: string[]; limit: number }> = [];
  classCountCalls: Array<{ to: string; exclude: string[] }> = [];
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
  settleImported(date: string, oddsStay = false, classStay = false): void {
    for (const [id, row] of this.day(date).rows) {
      if (row.state === "queued") {
        row.state = "imported";
        row.lastClass = "imported";
        this.unimported = this.unimported.filter((r) => r.raceId !== id);
        if (!oddsStay) {
          this.needOdds = this.needOdds.filter((r) => r.raceId !== id);
        }
        if (!classStay) {
          this.needClass = this.needClass.filter((r) => r.raceId !== id);
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
    listClassBackfillRaces: async ({ to, exclude, limit }) => {
      this.classListCalls.push({ to, exclude: [...exclude], limit });
      const candidates = this.needClass.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId));
      if (candidates.length === 0) return [];
      const newest = candidates.map((r) => r.kaisaiDate).sort().at(-1)!;
      return candidates
        .filter((r) => r.kaisaiDate === newest)
        .sort((a, b) => a.raceId.localeCompare(b.raceId))
        .slice(0, limit);
    },
    countClassBackfill: async ({ to, exclude }) => {
      this.classCountCalls.push({ to, exclude: [...exclude] });
      return {
        dated: this.needClass.filter((r) => r.kaisaiDate <= to && !exclude.includes(r.raceId)).length,
        undated: this.undatedClass,
        stillNull: this.classStillNull,
      };
    },
    classDistribution: async () => this.classDistribution,
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

// ---- 段階 3 の順序・依頼 ----

describe("段階 3: 段階 1・2 が尽きたら、結果はあるがクラスが NULL のレースを winOddsOnly で依頼する", () => {
  it("段階 1・2 が空なら、同じ tick で段階 3 を列挙して依頼する(最も新しい日の 30 レース・winOddsOnly: true・除外は空)", async () => {
    const w = new World();
    w.needClass = [...races("20261009", 45), ...races("20261001", 5)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.listCalls).toHaveLength(1); // 段階 1 を先に引く(空)
    expect(w.oddsListCalls).toHaveLength(1); // 段階 2 を次に引く(空)
    expect(w.classListCalls).toEqual([{ to: YESTERDAY, exclude: [], limit: 30 }]);
    expect(w.day("20261009").requests).toEqual([races("20261009", 30).map((r) => r.raceId)]);
    expect(w.day("20261009").flags).toEqual([true]);
    expect(w.alarm).toBe(T0 + BACKFILL_POLL_MS);
    const status = await core.getStatus();
    expect(status.state).toBe("running");
    expect(status.inflight).toMatchObject({ day: "20261009", races: 30 });
    expect(status.tonight).toMatchObject({ dispatched: 30 });
  });

  it("段階 1 に未取込が残る間、段階 2 に対象が残る間は、段階 3 を列挙しない(段階 1・2 が先。枠を食わない)", async () => {
    const w = new World();
    w.unimported = races("20261009", 3);
    w.needClass = races("20261008", 3);
    const first = make(w);
    await first.core.runNextStep();
    expect(w.classListCalls).toEqual([]);
    expect([...w.days.keys()]).toEqual(["20261009"]);

    const w2 = new World();
    w2.needOdds = races("20261009", 3);
    w2.needClass = races("20261008", 3);
    const second = make(w2);
    await second.core.runNextStep();
    expect(w2.classListCalls).toEqual([]);
    expect(w2.day("20261009").flags).toEqual([true]); // 段階 2 の依頼
    expect([...w2.days.keys()]).toEqual(["20261009"]);
  });

  it("段階 2 が尽きた次の tick で段階 3 に進む: 段階 2 のチャンクを回収し、次に段階 3 のチャンクを依頼する", async () => {
    const w = new World();
    w.needOdds = races("20261009", 2);
    w.needClass = races("20261008", 2);
    const { core } = make(w);
    await core.runNextStep();
    w.settleImported("20261009");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.day("20261009").requests).toHaveLength(1);
    expect(w.day("20261008").requests).toEqual([races("20261008", 2).map((r) => r.raceId)]);
    expect(w.day("20261008").flags).toEqual([true]);
    expect((await core.getStatus()).imported).toBe(0); // 取り込みの累計は段階 1 だけが数える
  });

  it("1 晩の上限は段階 1〜3 で共有する: 段階 1 の 100 レースのあと、段階 3 は残り 50 レースだけ(30・20)", async () => {
    const w = new World();
    w.unimported = races("20261009", 100);
    w.needClass = races("20261008", 80);
    const { core } = make(w);
    for (let i = 0; i < 12; i += 1) {
      await core.runNextStep();
      w.settleImported("20261009");
      w.settleImported("20261008");
      w.now += BACKFILL_POLL_MS;
    }
    const sizes = (date: string) => w.day(date).requests.map((r) => r.length);
    expect(sizes("20261009")).toEqual([30, 30, 30, 10]);
    expect(sizes("20261008")).toEqual([30, 20]);
    expect((await core.getStatus()).tonight.dispatched).toBe(BACKFILL_CHUNK_SIZE * 5);
  });
});

// ---- 状態 ----

describe("段階 3 の状態(DO の SQLite の別の表 backfill_class)", () => {
  const rowsOf = (sql: NodeSql): Array<{ race_id: string; state: string }> => sql.exec("SELECT race_id, state FROM backfill_class ORDER BY race_id").toArray() as Array<{ race_id: string; state: string }>;

  it("取り込めたレースは class_done: ページにクラスが無くて D1 の列挙に残っても、二度と依頼しない(毎晩の再列挙を防ぐ)", async () => {
    const w = new World();
    w.needClass = races("20261009", 3);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.settleImported("20261009", false, true); // 成功したが D1 にはクラスが入らず、列挙の対象に残る
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.needClass).toHaveLength(3); // 前提: D1 の列挙の対象には残っている
    expect(w.day("20261009").requests).toHaveLength(1);
    expect(w.classListCalls.at(-1)!.exclude).toEqual(races("20261009", 3).map((r) => r.raceId).sort());
    expect(rowsOf(sql)).toEqual(races("20261009", 3).map((r) => ({ race_id: r.raceId, state: "class_done" })).sort((a, b) => a.race_id.localeCompare(b.race_id)));
    for (const day of [11, 12, 13]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day("20261009").requests).toHaveLength(1);
    const status = await core.getStatus();
    expect(status.raceClass).toMatchObject({ remaining: 0, filled: 3, abandoned: { total: 0, byClass: {} } });
    expect(status.state).toBe("done");
  });

  it("★class_done と fill_done は互いを上書きしない: 段階 2 が fill_done にしたレースを段階 3 が class_done にしても、backfill_race の fill_done は残り、段階 2 の除外が保たれる(オッズが NULL のまま D1 に残るレースを、段階 2 が再列挙しない)", async () => {
    const w = new World();
    const ids = races("20261009", 2);
    w.needOdds = [...ids];
    w.needClass = [...ids];
    const { core, sql } = make(w);
    await core.runNextStep(); // 段階 2 の依頼
    w.settleImported("20261009", true, true); // オッズもクラスも D1 に入らなかった
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 段階 2 を回収(fill_done)。今夜試したレースは段階 3 の列挙から除かれる(同じ晩に重ねて取らない)
    expect(w.day("20261009").requests).toHaveLength(1);
    w.now = jst(10, 11, 2); // 翌晩
    await core.runNextStep(); // 段階 2 は fill_done で除外されて空 → 段階 3 を依頼
    expect(w.day("20261009").requests).toHaveLength(2);
    w.settleImported("20261009", true, true);
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 段階 3 を回収(class_done)
    expect((sql.exec("SELECT state, COUNT(*) AS n FROM backfill_race GROUP BY state").toArray() as Array<{ state: string; n: number }>)).toEqual([{ state: "fill_done", n: 2 }]);
    expect(rowsOf(sql).map((r) => r.state)).toEqual(["class_done", "class_done"]);
    // 以後の晩も、段階 2・3 とも再依頼しない
    for (const day of [12, 13, 14]) {
      w.now = jst(10, day, 2);
      await core.runNextStep();
    }
    expect(w.day("20261009").requests).toHaveLength(2);
    expect(w.oddsListCalls.at(-1)!.exclude).toEqual(ids.map((r) => r.raceId).sort()); // 段階 2 の除外が保たれている
    const status = await core.getStatus();
    expect(status.winOdds.filled).toBe(2);
    expect(status.raceClass.filled).toBe(2);
  });

  it("段階 3 の失敗は class_tried / class_abandoned に記録し、段階 1・2 の abandoned には混ざらない。永久な分類は取り込めたレースがあれば 1 サイクルで除外", async () => {
    const w = new World();
    w.needClass = races(YESTERDAY, 2);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.day(YESTERDAY).rows.get(idOf(YESTERDAY, 1))!.state = "imported";
    w.needClass = w.needClass.filter((r) => r.raceId !== idOf(YESTERDAY, 1));
    w.settleGaveUp(YESTERDAY, "no-payout");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    const status = await core.getStatus();
    expect(status.abandoned).toEqual({ total: 0, byClass: {} });
    expect(status.winOdds.abandoned).toEqual({ total: 0, byClass: {} });
    expect(status.raceClass.abandoned).toEqual({ total: 1, byClass: { "no-payout": 1 } });
    expect(status.raceClass.filled).toBe(1);
    expect(rowsOf(sql)).toEqual([
      { race_id: idOf(YESTERDAY, 1), state: "class_done" },
      { race_id: idOf(YESTERDAY, 2), state: "class_abandoned" },
    ]);
    expect(sql.exec("SELECT COUNT(*) AS n FROM backfill_race").toArray()).toEqual([{ n: 0 }]); // 段階 1・2 の表には何も書かない
  });

  it("一時的な失敗は晩数に数え、BACKFILL_MAX_NIGHTS 晩目で class_abandoned にして以後依頼しない", async () => {
    const w = new World();
    w.needClass = races(YESTERDAY, 1);
    const { core, sql } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await core.runNextStep();
      w.settleGaveUp(YESTERDAY, "fetch-failed");
      w.now += BACKFILL_POLL_MS;
      await core.runNextStep();
      expect(w.day(YESTERDAY).requests.length, `${night} 晩目`).toBe(night);
    }
    expect(rowsOf(sql).map((r) => r.state)).toEqual(["class_abandoned"]);
    w.now = jst(10, 13, 2);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests.length).toBe(BACKFILL_MAX_NIGHTS);
  });

  it("系統的な障害(取り込み 0 件で失敗が全件・同じ永続的な分類)は一時的な扱い: すぐには除外しない", async () => {
    const w = new World();
    w.needClass = races(YESTERDAY, 3);
    const { core, sql } = make(w);
    await core.runNextStep();
    w.settleGaveUp(YESTERDAY, "parse-error");
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(rowsOf(sql).map((r) => r.state)).toEqual(["class_tried", "class_tried", "class_tried"]);
  });

  it("gate の都合の失敗は晩数に数えずその晩は止める。BACKFILL_MAX_DEFER_NIGHTS 晩続いたら class_abandoned", async () => {
    const w = new World();
    w.needClass = races(YESTERDAY, 1);
    const { core, sql } = make(w);
    for (let night = 1; night <= BACKFILL_MAX_DEFER_NIGHTS; night += 1) {
      w.now = jst(10, 9 + night, 2);
      await core.runNextStep();
      w.settleGaveUp(YESTERDAY, "blocked");
      w.now += BACKFILL_POLL_MS;
      await core.runNextStep();
      expect((await core.getStatus()).state, `${night} 晩目`).toBe(night === BACKFILL_MAX_DEFER_NIGHTS ? "done" : "paused");
    }
    expect(rowsOf(sql).map((r) => r.state)).toEqual(["class_abandoned"]);
  });

  it("不正なレース(年が違う中央のID)は依頼の前に class_abandoned にして除外し、有効なレースだけを依頼する(不正なレースは 1 晩の上限に数えない)", async () => {
    const w = new World();
    w.needClass = [{ raceId: "202505009002", kaisaiDate: YESTERDAY }, ...races(YESTERDAY, 2)];
    const { core, sql } = make(w);
    await core.runNextStep();
    expect(w.day(YESTERDAY).requests).toEqual([races(YESTERDAY, 2).map((r) => r.raceId)]);
    expect(rowsOf(sql)).toEqual([{ race_id: "202505009002", state: "class_abandoned" }]);
    const status = await core.getStatus();
    expect(status.raceClass.abandoned).toEqual({ total: 1, byClass: { "invalid-race": 1 } });
    expect(status.tonight.dispatched).toBe(2);
  });

  it("その晩に試したレースは、段階 1・2 が試したものも段階 3 が試したものも、段階 3 の列挙から除く(同じ晩に重ねて取らない)", async () => {
    const w = new World();
    const ids = races("20261009", 2);
    w.needOdds = [ids[0]!];
    w.needClass = [...ids];
    const { core } = make(w);
    await core.runNextStep(); // 段階 2 が ids[0] を依頼(last_night = 今夜)
    w.settleImported("20261009", false, true); // オッズは入るがクラスは D1 に入らない(列挙に残る)
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収 → 段階 3 の列挙
    expect(w.classListCalls.at(-1)!.exclude).toEqual([ids[0]!.raceId]); // 段階 2 が今夜試したレースは除外
    expect(w.day("20261009").requests.at(-1)).toEqual([ids[1]!.raceId]);
    w.settleImported("20261009", false, true);
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.classListCalls.at(-1)!.exclude).toEqual([ids[0]!.raceId, ids[1]!.raceId]); // 今夜は全部試した
  });

  it("再起動しても続きから: 段階 3 の飛行中の記録(kind)を新しいインスタンスが引き継ぎ、回収したレースを class_done にする", async () => {
    const w = new World();
    w.needClass = races(YESTERDAY, 2);
    const first = make(w);
    await first.core.runNextStep();
    w.settleImported(YESTERDAY, false, true);
    w.now += BACKFILL_POLL_MS;
    const second = make(w, {}, first.sql);
    await second.core.runNextStep();
    expect((await second.core.getStatus()).raceClass.filled).toBe(2);
  });
});

// ---- 観測 ----

describe("getStatus.raceClass(管理者が GET /api/results/backfill で残りを観測する)", () => {
  it("remaining・undated・stillNull・distribution は Store の値、filled・abandoned は backfill_class から。count には class_done・class_abandoned と段階 2 の odds_abandoned を除外として渡す(今夜の試行は含めない)", async () => {
    const w = new World();
    w.needClass = races("20261001", 7);
    w.undatedClass = 4;
    w.classStillNull = 9;
    w.classDistribution = [{ value: "未勝利", races: 5 }, { value: "C1", races: 2 }];
    const { core, sql } = make(w);
    sql.exec("INSERT INTO backfill_class (race_id, nights, defers, last_night, last_class, state) VALUES ('D1', 0, 0, '20261001', 'imported', 'class_done')");
    sql.exec("INSERT INTO backfill_class (race_id, nights, defers, last_night, last_class, state) VALUES ('A1', 1, 0, '20261001', 'no-payout', 'class_abandoned')");
    sql.exec("INSERT INTO backfill_class (race_id, nights, defers, last_night, last_class, state) VALUES ('T1', 1, 0, '20261010', 'fetch-failed', 'class_tried')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('O1', 1, 0, '20261001', 'no-payout', 'odds_abandoned')");
    sql.exec("INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES ('F1', 0, 0, '20261010', 'imported', 'fill_done')");
    const status = await core.getStatus();
    expect(status.raceClass).toEqual({
      remaining: 7,
      undated: 4,
      filled: 1,
      stillNull: 9,
      abandoned: { total: 1, byClass: { "no-payout": 1 } },
      distribution: [{ value: "未勝利", races: 5 }, { value: "C1", races: 2 }],
    });
    expect(w.classCountCalls).toEqual([{ to: YESTERDAY, exclude: ["A1", "D1", "O1"] }]);
  });

  it("残りが段階 3 だけにあるとき state は done でない(ready)。0 になれば done", async () => {
    const w = new World();
    w.needClass = races("20261009", 1);
    const { core } = make(w);
    expect((await core.getStatus()).state).toBe("ready");
    w.needClass = [];
    expect((await core.getStatus()).state).toBe("done");
  });

  it("Store が段階 3 のメソッドを持たない構成(従来)では、raceClass はすべて 0・空で、段階 3 は動かない。state は段階 1・2 だけで決まる", async () => {
    const w = new World();
    w.needClass = races("20261009", 3);
    const { listClassBackfillRaces: _l, countClassBackfill: _c, classDistribution: _d, ...legacy } = w.store;
    w.store = legacy;
    const { core } = make(w);
    await core.runNextStep();
    expect(w.classListCalls).toEqual([]);
    expect([...w.days.keys()]).toEqual([]);
    const status = await core.getStatus();
    expect(status.raceClass).toEqual({ remaining: 0, undated: 0, filled: 0, stillNull: 0, abandoned: { total: 0, byClass: {} }, distribution: [] });
    expect(status.state).toBe("done");
  });

  it("止める設定(disabled)では段階 3 も動かない", async () => {
    const w = new World();
    w.needClass = races("20261009", 3);
    const { core } = make(w, { disabled: true });
    await core.runNextStep();
    expect(w.classListCalls).toEqual([]);
    expect((await core.getStatus()).state).toBe("disabled");
  });
});
