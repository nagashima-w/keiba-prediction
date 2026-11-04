import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ResultBackfillCore, type BackfillDayStub, type BackfillOptions } from "../src/result-backfill-core";
import type { ResultImportProgress } from "../src/race-day-core";
import { D1ResultStore } from "../src/result-repository";
import { countingDb, isBackfillListSql } from "./counting-db";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #598: 結果の補完の「1 晩ぶんの待ち行列」。本物の `ResultBackfillCore`・本物の D1(ローカルの workerd。`D1ResultStore`)を繋ぎ、日単位の DO・gate・時計だけを偽物にする。
 * 固定すること(いずれも**待ち行列を入れる前の版でも通る**ように、観測は「依頼の並び」と「列挙の回数・rows_read」だけにする):
 *  - 依頼されたレースの並びとチャンクの割り方(日の新しい順・同じ日は race_id 昇順・30 件刻み・1 チャンクに 2 日を混ぜない・1 晩 150 件)
 *  - 1 晩ぶんの列挙の SQL の回数と rows_read の合計の上界
 *  - 段階 1 で結果が入った直後に増える段階 2 の対象を、同じ晩に拾う
 *  - 件数の SQL は夜のステップでは流れない
 */

const JST = 9 * 3600_000;
const jst = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute) - JST;
/** 既定の「今」: 2026-10-10 JST 02:00(窓の中)。補完の `to` は昨日(20261009)。 */
const T0 = jst(10, 10, 2);
const WINDOW_END = jst(10, 10, 6);

/** 検証を通る 12 桁の中央のレースID(年 + 場コード 05 + 日 + ブロック + レース番号)。 */
const idOf = (date: string, n: number): string => `2026${"05"}${date.slice(6, 8)}${String(Math.floor((n - 1) / 12)).padStart(2, "0")}${String(((n - 1) % 12) + 1).padStart(2, "0")}`;

let local: LocalBindings;
const opened: NodeSql[] = [];
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

/** 分析の行(クラス入り)。`stage1` は結果なし。`stage4` は結果があり単勝の払戻だけが全馬 NULL(オッズ・着順あり)。 */
async function seed(date: string, n: number, kind: "stage1" | "stage2" | "stage4"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = idOf(date, i);
    ids.push(id);
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES (?, ?, 0, ?, 'オープン')")
      .bind(id, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, date)
      .run();
    if (kind !== "stage1") {
      for (const umaban of [1, 2]) {
        await local.db
          .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES (?, ?, ?, ?)")
          .bind(id, umaban, umaban, kind === "stage4" ? 3.5 : null)
          .run();
      }
    }
  }
  return ids;
}

interface Request {
  readonly date: string;
  readonly raceIds: string[];
  readonly winOddsOnly: boolean;
}

/**
 * 1 晩ぶんを、アラームを時刻順に動かして回す。日単位の DO の偽物は、依頼を受けたら**その場で D1 を「取り込み済み」の状態にする**:
 * 通常の依頼(段階 1)は結果の行を足す(`stage1Result` が `"noOdds"` ならオッズ無し=段階 2 の対象になる)。補完モードの依頼(段階 2〜4)は、オッズ・単勝の払戻・クラスを埋める。
 */
async function runNight(options: { backfill?: BackfillOptions; stage1Result?: "full" | "noOdds"; failDispatchOn?: (n: number) => boolean } = {}) {
  const { db, calls } = countingDb(local.db);
  const clock = { now: T0 };
  const alarm: { at: number | null } = { at: null };
  const requests: Request[] = [];
  const sql = openNodeSql();
  opened.push(sql);
  const stubFor = (date: string): BackfillDayStub =>
    ({
      requestResultImport: async ({ raceIds, winOddsOnly }: { raceIds: readonly string[]; winOddsOnly?: boolean }) => {
        requests.push({ date, raceIds: [...raceIds], winOddsOnly: winOddsOnly === true });
        if (options.failDispatchOn?.(requests.length) === true) throw new Error("RPC SECRET");
        for (const id of raceIds) {
          if (winOddsOnly === true) {
            await local.db.prepare("UPDATE race_results SET win_odds = COALESCE(win_odds, 2.0), win_payout = COALESCE(win_payout, 200) WHERE race_id = ?").bind(id).run();
            await local.db.prepare("UPDATE analyses SET race_class = COALESCE(race_class, 'オープン') WHERE race_id = ?").bind(id).run();
          } else {
            for (const umaban of [1, 2]) {
              await local.db
                .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, win_payout) VALUES (?, ?, ?, ?, ?)")
                .bind(id, umaban, umaban, options.stage1Result === "noOdds" ? null : 2.0, 200)
                .run();
            }
          }
        }
        return { accepted: raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
      },
      getResultImportProgress: async (): Promise<ResultImportProgress> => {
        const races = requests.flatMap((r) => r.raceIds).map((raceId) => ({ raceId, state: "imported" as const, attempts: 0, deferrals: 0, requestedOn: "20261010", nextTryAt: null, lastClass: "imported" as const, updatedAt: 0 }));
        return { total: races.length, queued: 0, imported: races.length, gaveUp: 0, races };
      },
    }) as unknown as BackfillDayStub;
  const makeCore = (): ResultBackfillCore =>
    new ResultBackfillCore(
      {
        sql,
        now: () => clock.now,
        setAlarm: (at) => void (alarm.at = at),
        getAlarm: async () => alarm.at,
        gateStatus: async () => ({ blockedUntil: null, pending: 0 }),
        store: new D1ResultStore({ db }),
        stubFor,
        log: () => undefined,
        onWarn: () => undefined,
      },
      options.backfill ?? {},
    );
  let core = makeCore();
  await core.kick();
  let steps = 0;
  /** アラームを窓の終わりまで動かす。`recreateEvery` ステップごとに core を作り直す(DO の追い出しの再現。状態は同じ SQLite)。 */
  async function run(recreateEvery = 0, until = WINDOW_END): Promise<void> {
    for (; steps < 4000; steps += 1) {
      if (alarm.at === null || alarm.at >= until) break;
      clock.now = Math.max(clock.now, alarm.at);
      alarm.at = null;
      if (recreateEvery > 0 && steps > 0 && steps % recreateEvery === 0) core = makeCore();
      await core.runNextStep();
    }
  }
  return { run, requests, calls, clock, alarm, sql, core: () => core, steps: () => steps };
}

const listCalls = (calls: ReturnType<typeof countingDb>["calls"]) => calls.filter((c) => isBackfillListSql(c.sql));

/** 期待する依頼の並び(オラクル): 日の新しい順・同じ日は race_id 昇順で `limit` 件に切り、同じ日を `chunk` 件刻みに割る。 */
function oracle(days: ReadonlyArray<{ date: string; ids: string[] }>, limit: number, chunk: number): Array<{ date: string; raceIds: string[] }> {
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  const out: Array<{ date: string; raceIds: string[] }> = [];
  let left = limit;
  for (const d of sorted) {
    const ids = [...d.ids].sort();
    for (let i = 0; i < ids.length && left > 0; ) {
      const take = Math.min(chunk, left, ids.length - i);
      out.push({ date: d.date, raceIds: ids.slice(i, i + take) });
      i += take;
      left -= take;
    }
  }
  return out;
}

describe("1 晩ぶんの依頼の並びとチャンクの割り方(段階 4 だけの晩。上限 150 が効く)", () => {
  it("日の新しい順・同じ日は race_id 昇順・30 件刻み・1 チャンクに 2 日を混ぜない・合計 150 件(155 件の対象のうち)", async () => {
    const days = [
      { date: "20261009", ids: await seed("20261009", 40, "stage4") },
      { date: "20261008", ids: await seed("20261008", 10, "stage4") },
      { date: "20261007", ids: await seed("20261007", 35, "stage4") },
      { date: "20261006", ids: await seed("20261006", 70, "stage4") },
    ];
    const night = await runNight();
    await night.run();
    const expected = oracle(days, 150, 30);
    // 前提(空振り防止): 対象は上限より多く、チャンクは複数日・同日の複数回にまたがる。
    expect(days.reduce((s, d) => s + d.ids.length, 0)).toBe(155);
    expect(expected.map((e) => e.raceIds.length)).toEqual([30, 10, 10, 30, 5, 30, 30, 5]);
    expect(night.requests.map((r) => ({ date: r.date, raceIds: r.raceIds }))).toEqual(expected);
    expect(night.requests.every((r) => r.winOddsOnly)).toBe(true);
    // 1 晩ぶんの列挙: 待ち行列の前の版は 32 回・rows_read 合計 21,093(8 チャンク × 段階 1〜4 の 4 本。N = 155 件・155 レース。この版で測った値)。
    // 待ち行列では、段階ごとに 1 回(段階 4 は上限の 150 件を一度に取る)の計 4 回。rows_read は 1 回あたり分析の全部を読む(今回は #597 の前なので N 比例)ので、4 回ぶんになる。
    const lists = listCalls(night.calls);
    expect(lists.length).toBe(4);
    expect(lists.reduce((s, c) => s + c.rowsRead, 0)).toBeLessThanOrEqual(4 * 5 * 155);
    expect(lists.reduce((s, c) => s + c.rowsRead, 0)).toBeGreaterThan(0);
    // 件数の SQL は夜のステップでは流れない(状態の取得だけ)。
    expect(night.calls.filter((c) => c.sql.includes("SUM(CASE"))).toEqual([]);
  });
});

describe("待ち行列は DO の追い出しをまたぐ・晩をまたがない", () => {
  it("ステップごとに core を作り直しても(状態は同じ SQLite)、同じ並びで依頼し、同じレースを 2 回依頼せず、列挙は段階ごとに 1 回", async () => {
    const days = [
      { date: "20261009", ids: await seed("20261009", 40, "stage4") },
      { date: "20261008", ids: await seed("20261008", 10, "stage4") },
      { date: "20261007", ids: await seed("20261007", 35, "stage4") },
      { date: "20261006", ids: await seed("20261006", 70, "stage4") },
    ];
    const night = await runNight();
    await night.run(1);
    expect(night.steps()).toBeGreaterThan(8); // 前提: 作り直しが何度も起きた
    expect(night.requests.map((r) => ({ date: r.date, raceIds: r.raceIds }))).toEqual(oracle(days, 150, 30));
    expect(listCalls(night.calls).length).toBe(4);
  });

  it("2 晩目は新しい列挙から始める: 1 晩目に尽きた段階の印・待ち行列を持ち越さない(1 晩目の後に増えた段階 1 の対象を、2 晩目に依頼する)", async () => {
    const day9 = await seed("20261009", 6, "stage4");
    const night = await runNight();
    await night.run();
    expect(night.requests.map((r) => r.raceIds)).toEqual([day9]); // 1 晩目: 段階 4 の 6 件だけ
    const late = await seed("20261008", 4, "stage1"); // 1 晩目の後に分析が増えた(結果なし = 段階 1)
    await night.run(0, jst(10, 11, 6));
    const second = night.requests.slice(1);
    expect(second.map((r) => ({ date: r.date, raceIds: r.raceIds, winOddsOnly: r.winOddsOnly }))).toEqual([{ date: "20261008", raceIds: late, winOddsOnly: false }]);
  });

  it("依頼が失敗した晩(その晩は止める)の待ち行列の残りは、2 晩目に持ち越さない: 2 晩目は試した分も含めて列挙し直す", async () => {
    const ids = await seed("20261009", 40, "stage4");
    // 上限 40 → 1 晩目の待ち行列は 40 件。最初の依頼(30 件)が失敗して、その晩は止まる(残り 10 件は待ち行列に残る)。
    const night = await runNight({ backfill: { nightlyLimit: 40 }, failDispatchOn: (n) => n === 1 });
    await night.run(0, jst(10, 11, 6));
    expect(night.requests.map((r) => r.raceIds)).toEqual([ids.slice(0, 30), ids.slice(0, 30), ids.slice(30)]);
  });
});

describe("段階をまたぐ: 段階 1 で結果が入った直後に増える段階 2 の対象を、同じ晩に拾う", () => {
  it("段階 1 の依頼(オッズ無しで取り込まれる)の後、同じ晩に同じレースを補完モードで依頼する。新しい日の順に、段階 2 の既存の対象も続く", async () => {
    const fresh = await seed("20261009", 3, "stage1");
    const old = await seed("20261008", 2, "stage2");
    const night = await runNight({ stage1Result: "noOdds" });
    await night.run();
    expect(night.requests.map((r) => ({ date: r.date, raceIds: r.raceIds, winOddsOnly: r.winOddsOnly }))).toEqual([
      { date: "20261009", raceIds: fresh, winOddsOnly: false },
      { date: "20261009", raceIds: fresh, winOddsOnly: true },
      { date: "20261008", raceIds: old, winOddsOnly: true },
    ]);
  });
});

describe("不正なレース: 依頼の前に記録して除外し、残りは依頼する", () => {
  it("年が開催日と合わないレース ID は依頼せず(abandoned として記録)、他のレースは並びどおり依頼する。同じレースを 2 回依頼しない", async () => {
    const good = await seed("20261009", 5, "stage4");
    // 開催日 20261009 なのに年が 2025 のレース ID(checkRaceDate で落ちる)。race_id 昇順では先頭ではない。
    const bad = "202505090099";
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES (?, '2026-10-06T00:00:00.000Z', 0, '20261009', 'オープン')").bind(bad).run();
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES (?, 1, 1, 3.5)").bind(bad).run();
    const night = await runNight();
    await night.run();
    expect(night.requests.map((r) => r.raceIds)).toEqual([good]);
    const rows = night.sql.exec("SELECT state FROM backfill_payout WHERE race_id = ?", bad).toArray() as Array<{ state: string }>;
    expect(rows).toEqual([{ state: "payout_abandoned" }]);
  });
});
