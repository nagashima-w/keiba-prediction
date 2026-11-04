import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1AnalysisStore } from "../src/analysis-repository";
import { RECOMPUTE_RACES_SQL, RECONCILE_RACE_BACKFILL_SQL, raceBackfillStateSelect } from "../src/race-backfill-state";
import {
  COUNT_BACKFILL_SQL,
  COUNT_CLASS_BACKFILL_SQL,
  COUNT_PAYOUT_BACKFILL_SQL,
  COUNT_WIN_ODDS_BACKFILL_SQL,
  D1ResultStore,
  LIST_BACKFILL_SQL,
  LIST_CLASS_BACKFILL_SQL,
  LIST_PAYOUT_BACKFILL_SQL,
  LIST_WIN_ODDS_BACKFILL_SQL,
} from "../src/result-repository";
import { D1VerifyStore } from "../src/verify-store";
import {
  OLD_COUNT_BACKFILL_SQL,
  OLD_COUNT_CLASS_BACKFILL_SQL,
  OLD_COUNT_PAYOUT_BACKFILL_SQL,
  OLD_COUNT_WIN_ODDS_BACKFILL_SQL,
  OLD_LIST_BACKFILL_QUEUE_SQL,
  OLD_LIST_CLASS_BACKFILL_QUEUE_SQL,
  OLD_LIST_PAYOUT_BACKFILL_QUEUE_SQL,
  OLD_LIST_WIN_ODDS_BACKFILL_QUEUE_SQL,
} from "./old-backfill-sql";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";
import { withState } from "./race-backfill-test-helpers";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #597(#594-1): 結果の補完のレース単位の状態の表 `race_backfill`。ローカル(workerd)の本物の D1 で、次を固定する:
 *  1. 列挙・件数の SQL が `analyses` の全走査をしない(`EXPLAIN QUERY PLAN`)。読み取り行数(`meta.rows_read`)が、済みのレースを増やしても増えず、未完了を増やすと増える
 *  2. 新しい列挙・件数が、旧い SQL(`old-backfill-sql.ts`。除外の JSON で済み・諦めを外していた)と同じ fixture で一致する(順序・件数・undated・stillNull)
 *  3. 状態の遷移(書き込みの経路ごとの再計算)と、書き込みの全経路の足し忘れの検出(整合検査が直す行が 0)
 *  4. 整合検査(食い違いを直し、件数を返す)・済み・諦めの写し・migration の初期投入と再計算の式が同じ
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run(); // 分析の id を 1 から振り直す(検証の補完のテストが id で指す)
});

const resultStore = () => new D1ResultStore({ db: local.db });
const store = () => withState(resultStore());

interface State {
  readonly kaisai_date: string | null;
  readonly sm: number;
  readonly st1: number;
  readonly st2: number;
  readonly st3: number;
  readonly st4: number;
}
const stateOf = async (raceId: string): Promise<State | null> =>
  local.db.prepare("SELECT kaisai_date, sm, st1, st2, st3, st4 FROM race_backfill WHERE race_id = ?").bind(raceId).first<State>();
const sts = (s: State | null): number[] | null => (s === null ? null : [s.st1, s.st2, s.st3, s.st4]);

/** 整合検査が直した行数(0 なら、直前までの書き込みの経路が状態を正しく作り直していた)。 */
const drift = async (): Promise<number> => resultStore().reconcileBackfillState();

// ---------------------------------------------------------------------------
// 1. EXPLAIN QUERY PLAN と rows_read
// ---------------------------------------------------------------------------

const LISTS: ReadonlyArray<readonly [string, string, number]> = [
  ["LIST_BACKFILL_SQL", LIST_BACKFILL_SQL, 1],
  ["LIST_WIN_ODDS_BACKFILL_SQL", LIST_WIN_ODDS_BACKFILL_SQL, 2],
  ["LIST_CLASS_BACKFILL_SQL", LIST_CLASS_BACKFILL_SQL, 3],
  ["LIST_PAYOUT_BACKFILL_SQL", LIST_PAYOUT_BACKFILL_SQL, 4],
];
const COUNTS: ReadonlyArray<readonly [string, string, number, unknown[]]> = [
  ["COUNT_BACKFILL_SQL", COUNT_BACKFILL_SQL, 1, ["20261004"]],
  ["COUNT_WIN_ODDS_BACKFILL_SQL", COUNT_WIN_ODDS_BACKFILL_SQL, 2, ["20261004", "20261004"]],
  ["COUNT_CLASS_BACKFILL_SQL", COUNT_CLASS_BACKFILL_SQL, 3, ["20261004"]],
  ["COUNT_PAYOUT_BACKFILL_SQL", COUNT_PAYOUT_BACKFILL_SQL, 4, ["20261004"]],
];

async function planOf(sql: string, binds: unknown[]): Promise<string[]> {
  const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
  return results.map((r) => r.detail);
}

describe("EXPLAIN QUERY PLAN: 列挙・件数の SQL は analyses を読まず、race_backfill の部分索引だけを使う", () => {
  it.each(LISTS)("%s: 部分索引の SEARCH(race_backfill)。analyses・race_results の走査も、全表の SCAN も、ORDER BY の一時 B 木も出ない", async (_name, sql, stage) => {
    const plan = await planOf(sql, ["20261004", "[]", 150]);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some((d) => d.includes(`SEARCH race_backfill USING COVERING INDEX idx_race_backfill_st${stage}`))).toBe(true);
    expect(plan.some((d) => /analyses|race_results/.test(d))).toBe(false);
    expect(plan.some((d) => /^SCAN race_backfill/.test(d))).toBe(false);
    expect(plan.some((d) => d.includes("TEMP B-TREE"))).toBe(false);
  });

  it.each(COUNTS)("%s: 部分索引の SEARCH(race_backfill)。analyses・race_results の走査も、race_backfill の全表の SCAN も出ない", async (_name, sql, stage, binds) => {
    const plan = await planOf(sql, binds);
    expect(plan.some((d) => d.includes(`idx_race_backfill_st${stage}`))).toBe(true);
    expect(plan.some((d) => /analyses|race_results/.test(d))).toBe(false);
    expect(plan.some((d) => /^SCAN race_backfill(?! USING)/.test(d))).toBe(false);
  });

  it("対照(空振り防止): 旧い SQL は analyses の全走査を出す(この確認方法が全走査を検出できる)", async () => {
    const plan = await planOf(OLD_LIST_CLASS_BACKFILL_QUEUE_SQL, ["20261004", "[]", 150]);
    expect(plan.some((d) => /SCAN a/.test(d))).toBe(true);
  });
});

/** 分析と結果を JSON 配列の 1 文ずつで大量に入れる(`prefix` + 連番のレース ID)。`payout` が null なら単勝の払戻は全馬 NULL(段階 4 の対象)。クラス・オッズは入れる。 */
async function seedBulk(prefix: string, n: number, payout: number | null): Promise<void> {
  const nums = JSON.stringify(Array.from({ length: n }, (_, i) => i));
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) SELECT ? || printf('%05d', value), '2026-10-06T00:00:00.000Z', 0, '20261003', 'オープン' FROM json_each(?)")
    .bind(prefix, nums)
    .run();
  await local.db
    .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, win_payout) SELECT ? || printf('%05d', value), 1, 1, 2.0, ? FROM json_each(?)")
    .bind(prefix, payout, nums)
    .run();
}

async function reads(sql: string, binds: unknown[]): Promise<number> {
  const r = await local.db.prepare(sql).bind(...binds).all();
  return r.meta.rows_read ?? 0;
}

describe("rows_read: 済みのレースを増やしても増えず、未完了を増やすと増える(段階 4 で測る。列挙は 30 件・除外 JSON は空)", () => {
  const LIST4 = (): Promise<number> => reads(LIST_PAYOUT_BACKFILL_SQL, ["20261004", "[]", 30]);
  const COUNT4 = (): Promise<number> => reads(COUNT_PAYOUT_BACKFILL_SQL, ["20261004"]);

  it("条件が偽のレース(状態 0 = 払戻が入った済みのレース)を 50 → 600 に増やしても、列挙も件数も rows_read は同じ", async () => {
    await seedBulk("P", 40, null); // 未完了 40(段階 4 の対象)
    await seedBulk("D", 50, 100);
    await resultStore().reconcileBackfillState();
    const listSmall = await LIST4();
    const countSmall = await COUNT4();
    await seedBulk("E", 550, 100);
    await resultStore().reconcileBackfillState();
    // 前提(空振り防止): 済みのレースが増えている・対象は 40 のまま・列挙が実際に 30 件返る・読み取りが 0 でない
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill").first<{ n: number }>())!.n).toBe(640);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill WHERE st4 = 1").first<{ n: number }>())!.n).toBe(40);
    expect((await local.db.prepare(LIST_PAYOUT_BACKFILL_SQL).bind("20261004", "[]", 30).all()).results).toHaveLength(30);
    expect(listSmall).toBeGreaterThan(0);
    expect(countSmall).toBeGreaterThan(0);
    expect(await LIST4()).toBe(listSmall);
    expect(await COUNT4()).toBe(countSmall);
  });

  it("済み・諦めの状態(2)のレースを 0 → 300 に増やしても、列挙の rows_read は同じ(件数は stillNull の数え分だけ増える)", async () => {
    await seedBulk("P", 40, null);
    await resultStore().reconcileBackfillState();
    const listBefore = await LIST4();
    const countBefore = await COUNT4();
    await seedBulk("S", 300, null);
    await resultStore().reconcileBackfillState();
    await local.db.prepare("UPDATE race_backfill SET st4 = 2 WHERE race_id LIKE 'S%'").run();
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill WHERE st4 = 2").first<{ n: number }>())!.n).toBe(300); // 前提
    expect(await LIST4()).toBe(listBefore);
    expect(await COUNT4()).toBeGreaterThan(countBefore); // 件数の stillNull は状態 2 の数を数える(部分索引の範囲。分析の全走査ではない)
  });

  it("未完了を 40 → 120 に増やすと、列挙(上限 150 の内側)も件数も rows_read が増える(両向きの確認。常に同じ値で自明に通らない)", async () => {
    await seedBulk("P", 40, null);
    await resultStore().reconcileBackfillState();
    const list40 = await reads(LIST_PAYOUT_BACKFILL_SQL, ["20261004", "[]", 150]);
    const count40 = await COUNT4();
    await seedBulk("Q", 80, null);
    await resultStore().reconcileBackfillState();
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill WHERE st4 = 1").first<{ n: number }>())!.n).toBe(120); // 前提
    expect(await reads(LIST_PAYOUT_BACKFILL_SQL, ["20261004", "[]", 150])).toBeGreaterThan(list40);
    expect(await COUNT4()).toBeGreaterThan(count40);
  });
});

// ---------------------------------------------------------------------------
// 2. 旧い SQL との同値
// ---------------------------------------------------------------------------

/** 決定的な乱数(mulberry32)。 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATES: ReadonlyArray<string | null> = ["20261001", "20261002", "20261003", "20261003", "20261009", "20261012", null];

describe("旧い SQL(除外の JSON)との同値: 同じ fixture で、列挙の順序・件数と、件数の dated・undated・scratchedMissing・stillNull が一致する", () => {
  it("ランダムな 160 レース(開催日・分析の行数・クラス・結果の有無・オッズ・scratched・払戻)× 段階ごとに済み・諦めを 15% 選ぶ", async () => {
    const rand = rng(597);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const raceIds: string[] = [];
    const settleable: string[] = []; // 済み・諦めにしうるレース = 開催日のあるレース(開催日 NULL は日単位の DO の宛先が決まらず、依頼されないので、済み・諦めにならない)
    for (let i = 0; i < 160; i += 1) {
      const id = `Z${String(i).padStart(4, "0")}`;
      raceIds.push(id);
      const date = pick(DATES);
      if (date !== null) settleable.push(id);
      const rows = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < rows; k += 1) {
        // 同じレースの分析の行は同じ開催日にする(旧い SQL の最小の開催日は条件に当たる行だけの最小で、全行の最小とは別。race-backfill-state.ts の「旧い SQL との差」)。
        await local.db
          .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES (?, ?, 0, ?, ?)")
          .bind(id, `2026-10-06T00:00:${String(k).padStart(2, "0")}.000Z`, date, rand() < 0.45 ? null : "オープン")
          .run();
      }
      if (rand() < 0.75) {
        const horses = 1 + Math.floor(rand() * 3);
        for (let u = 1; u <= horses; u += 1) {
          const finish = rand() < 0.2 ? null : u;
          const scratched = rand() < 0.5 ? null : rand() < 0.5 ? 0 : 1;
          await local.db
            .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, scratched, win_payout) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(id, u, finish, rand() < 0.4 ? null : 2.5, scratched, rand() < 0.4 ? null : 300)
            .run();
        }
      }
    }
    const s = resultStore();
    await s.reconcileBackfillState();
    const settled: Record<1 | 2 | 3 | 4, string[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const stage of [1, 2, 3, 4] as const) settled[stage] = settleable.filter(() => rand() < 0.15);
    await s.settleBackfill([1, 2, 3, 4].map((stage) => ({ stage: stage as 1 | 2 | 3 | 4, raceIds: settled[stage as 1 | 2 | 3 | 4] })));

    const to = "20261004";
    const oldList = async (sql: string, excl: string[]) =>
      (await local.db.prepare(sql).bind(to, JSON.stringify(excl), 200).all<{ raceId: string; firstDate: string }>()).results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
    const pairs: Array<[string, 1 | 2 | 3 | 4, string, Promise<unknown[]>]> = [
      ["段階 1", 1, OLD_LIST_BACKFILL_QUEUE_SQL, s.listBackfillRaces({ to, exclude: [], limit: 200 })],
      ["段階 2", 2, OLD_LIST_WIN_ODDS_BACKFILL_QUEUE_SQL, s.listWinOddsBackfillRaces({ to, exclude: [], limit: 200 })],
      ["段階 3", 3, OLD_LIST_CLASS_BACKFILL_QUEUE_SQL, s.listClassBackfillRaces({ to, exclude: [], limit: 200 })],
      ["段階 4", 4, OLD_LIST_PAYOUT_BACKFILL_QUEUE_SQL, s.listPayoutBackfillRaces({ to, exclude: [], limit: 200 })],
    ];
    for (const [label, stage, oldSql, fresh] of pairs) {
      const expected = await oldList(oldSql, settled[stage]);
      const actual = await fresh;
      expect(actual.length, `${label}: 前提(空振り防止): 列挙が空でない`).toBeGreaterThan(5);
      expect(actual, `${label}の列挙`).toEqual(expected);
    }

    // 件数。旧い SQL の束縛値の並びは各定数の JSDoc のとおり。
    const one = async (sql: string, binds: unknown[]) => (await local.db.prepare(sql).bind(...binds).first<Record<string, number>>())!;
    const e = (stage: 1 | 2 | 3 | 4): string => JSON.stringify(settled[stage]);
    const o1 = await one(OLD_COUNT_BACKFILL_SQL, [to, e(1)]);
    const o2 = await one(OLD_COUNT_WIN_ODDS_BACKFILL_SQL, [to, e(2), to, e(2)]);
    const o3 = await one(OLD_COUNT_CLASS_BACKFILL_SQL, [to, e(3), e(3)]);
    const o4 = await one(OLD_COUNT_PAYOUT_BACKFILL_SQL, [to, e(4), e(4)]);
    const n1 = await s.countBackfill({ to });
    const n2 = await s.countWinOddsBackfill({ to });
    const n3 = await s.countClassBackfill({ to });
    const n4 = await s.countPayoutBackfill({ to });
    expect(n1).toEqual({ dated: o1.dated, undated: o1.undated });
    expect(n2).toEqual({ dated: o2.dated, undated: o2.undated, scratchedMissing: o2.scratchedMissing });
    expect(n3).toEqual({ dated: o3.dated, undated: o3.undated, stillNull: o3.stillNull });
    expect(n4).toEqual({ dated: o4.dated, undated: o4.undated, stillNull: o4.stillNull });
    // 前提(空振り防止): 各件数の項目が 0 でない値を含む(undated・stillNull・scratchedMissing も)
    expect(n1.dated).toBeGreaterThan(0);
    expect(n1.undated).toBeGreaterThan(0);
    expect(n2.scratchedMissing).toBeGreaterThan(0);
    expect(n3.stillNull).toBeGreaterThan(0);
    expect(n4.stillNull).toBeGreaterThan(0);
    expect(n4.dated).toBeGreaterThan(0);
    expect(n2.dated).toBeGreaterThan(0);
    expect(n3.dated).toBeGreaterThan(0);
  });

  it("旧い SQL との既知の差: 段階 3 の開催日は、クラスが NULL の行だけの最小でなく、そのレースの分析の全部の最小(クラス NULL の行が NULL の開催日のとき)", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES ('DIFF', '2026-10-06T00:00:00.000Z', 0, '20261003', 'オープン')").run();
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES ('DIFF', '2026-10-06T00:00:01.000Z', 0, NULL, NULL)").run();
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES ('DIFF', 1, 1)").run();
    await resultStore().reconcileBackfillState();
    const old = (await local.db.prepare(OLD_LIST_CLASS_BACKFILL_QUEUE_SQL).bind("20261004", "[]", 10).all()).results;
    expect(old).toEqual([]); // 旧: クラス NULL の行の開催日が NULL → `kaisai_date <= ?` に入らず列挙されない(undated 扱い)
    expect(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 10 })).toEqual([{ raceId: "DIFF", kaisaiDate: "20261003" }]); // 新: 全部の最小
  });
});

// ---------------------------------------------------------------------------
// 3. 状態の遷移と、書き込みの全経路の足し忘れの検出
// ---------------------------------------------------------------------------

const RACE = "202603020211";

function record(raceId: string, kaisaiDate = "20261003"): AnalysisRecord {
  return {
    raceId,
    analyzedAt: "2026-10-06T00:00:00.000Z",
    kaisaiDate,
    promptVersion: "v-test",
    raceSnapshot: { race: { raceName: "x" } },
    horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null }],
  };
}
const NOW = new Date("2026-10-10T12:00:00.000Z");
const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const verifyStore = () => new D1VerifyStore({ db: local.db, bucket: local.r2, now: () => NOW });
const FACTS = { courseType: "芝", distance: 1800, trackCondition: "良", grade: null, raceName: "x" };
const horse = (umaban: number, over: Record<string, unknown> = {}) => ({ umaban, finishPosition: umaban, placePayout: 120, winPayout: null, winOdds: null, ninki: null, scratched: false, ...over });

describe("状態の遷移(書き込みの経路ごと。表駆動): 各経路の直後に整合検査が直す行が 0", () => {
  it("分析の保存 → 結果の保存 → オッズ・scratched → 払戻 → クラス(結果側)の順に、状態が期待どおりに変わり、各段階で整合検査の直し 0", async () => {
    // [操作の名前, 操作, 期待する [st1, st2, st3, st4], 期待する sm]
    const steps: Array<[string, () => Promise<unknown>, number[], number]> = [
      ["分析を保存(クラスなし・結果なし)", () => analyses().saveAnalysis(record(RACE)), [1, 0, 0, 0], 0],
      ["結果を保存(オッズ・払戻なし。着順あり。scratched は記録済み)", () => resultStore().saveResult(RACE, [horse(1, { scratched: false }), horse(2, { scratched: false })] as never), [0, 1, 1, 1], 0],
      ["オッズを補完", () => resultStore().saveWinOdds(RACE, [horse(1, { winOdds: 3.4, ninki: 1 }), horse(2, { winOdds: 5.6, ninki: 2 })] as never), [0, 0, 1, 1], 0],
      ["単勝の払戻を補完", () => resultStore().saveWinPayout(RACE, [horse(1, { winPayout: 340 })] as never), [0, 0, 1, 0], 0],
      ["クラスを補完(結果側 saveRaceClass)", () => resultStore().saveRaceClass(RACE, "オープン"), [0, 0, 0, 0], 0],
    ];
    for (const [name, op, expected, sm] of steps) {
      await op();
      const s = await stateOf(RACE);
      expect(sts(s), `${name}: 状態`).toEqual(expected);
      expect(s?.sm, `${name}: sm`).toBe(sm);
      expect(await drift(), `${name}: 整合検査の直し`).toBe(0);
    }
    expect((await stateOf(RACE))!.kaisai_date).toBe("20261003");
  });

  it("scratched の補完(着順 NULL・scratched NULL の行がある結果): sm が立ち、補完で下りる", async () => {
    await analyses().saveAnalysis(record(RACE));
    // 着順 NULL・scratched NULL の行を生で入れる(旧い取り込み。saveResult は scratched を必ず書くため)
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES (?, 1, 1, 3.4)").bind(RACE).run();
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES (?, 2, NULL, 5.6)").bind(RACE).run();
    await drift(); // 生の INSERT は状態を作り直さないので、直しが入る(件数は検査しない)
    expect((await stateOf(RACE))!.sm).toBe(1);
    expect((await stateOf(RACE))!.st2).toBe(1); // オッズが入っていても scratched が欠ける(B)
    await resultStore().saveScratched(RACE, [horse(1), horse(2, { finishPosition: null, scratched: true })] as never);
    expect(sts(await stateOf(RACE))![1]).toBe(0);
    expect((await stateOf(RACE))!.sm).toBe(0);
    expect(await drift()).toBe(0);
  });

  it("2 件目の分析の保存(開催日が違う・クラスなし)は、最小の開催日と段階 3 の状態を作り直す(クラスが入ったあとに分析し直して NULL の行が増えたら、段階 3 の対象に戻る)", async () => {
    await analyses().saveAnalysis(record(RACE, "20261003"));
    await resultStore().saveResult(RACE, [horse(1, { winOdds: 3.4, winPayout: 340 })] as never);
    await resultStore().saveRaceClass(RACE, "オープン");
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 0, 0]);
    await analyses().saveAnalysis(record(RACE, "20261001")); // クラス NULL の行が増え、開催日が前の日
    const s = await stateOf(RACE);
    expect(s!.kaisai_date).toBe("20261001"); // 最小の開催日
    expect(s!.st3).toBe(1); // 挙動が変わる点(Q4): 旧い版は DO の class_done の除外で補完しなかった
    expect(await drift()).toBe(0);
  });

  it("済み・諦めの状態(2)は、条件が真の間は保たれ(再計算で 1 に戻らない)、条件が偽になれば 0 に戻る", async () => {
    await analyses().saveAnalysis(record(RACE));
    await resultStore().saveResult(RACE, [horse(1, { winOdds: 3.4 })] as never); // st3=1, st4=1
    await resultStore().settleBackfill([{ stage: 4, raceIds: [RACE] }, { stage: 3, raceIds: [RACE] }]);
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 2, 2]);
    await resultStore().saveWinOdds(RACE, [horse(1, { winOdds: 9.9 })] as never); // 無関係な再計算
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 2, 2]); // 2 のまま
    expect(await drift()).toBe(0);
    await resultStore().saveWinPayout(RACE, [horse(1, { winPayout: 340 })] as never);
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 2, 0]); // 段階 4 は条件が偽 → 0
    await resultStore().saveRaceClass(RACE, "オープン");
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 0, 0]);
    // 条件が偽のレースを settle しても 0 のまま(対象 = 状態 1 だけを 2 にする)
    await resultStore().settleBackfill([{ stage: 3, raceIds: [RACE] }]);
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 0, 0]);
  });

  it("検証の DO の補完(commitStartTimes)が race_class を埋める経路: 状態が作り直される(足し忘れなし)", async () => {
    await analyses().saveAnalysis(record(RACE));
    await resultStore().saveResult(RACE, [horse(1, { winOdds: 3.4, winPayout: 340 })] as never);
    expect(sts(await stateOf(RACE))![2]).toBe(1);
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 0, [{ id: 1, facts: { ...FACTS, raceClass: "オープン" } }]);
    expect(sts(await stateOf(RACE))![2]).toBe(0);
    expect(await drift()).toBe(0);
  });

  it("結果だけがあって分析の無いレースには、状態の行を作らない(列挙は分析済みのレースだけ)", async () => {
    await resultStore().saveResult("202603020299", [horse(1)] as never);
    expect(await stateOf("202603020299")).toBeNull();
    expect(await drift()).toBe(0);
  });
});

describe("書き込みの全経路の足し忘れの検出(ソースの走査)", () => {
  it("analyses・race_results に INSERT / UPDATE / DELETE する SQL を持つ src のファイルは、状態の作り直しを呼ぶ経路として確認済みのものだけ", () => {
    const dir = path.join(ROOT, "src");
    const files = ["analysis-repository.ts", "result-repository.ts", "verify-store.ts"];
    const writers = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts").filter((f) => {
      const text = readFileSync(path.join(dir, f), "utf-8");
      return /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(analyses|race_results)\b/.test(text) || /\bINSERT_ANALYSIS_SQL\b|\bUPSERT_RESULTS_JSON_SQL\b/.test(text.replace(/^\s*\*.*$/gm, ""));
    });
    // 新しい書き込みの経路が増えたら、ここに足す前に、その経路が RECOMPUTE_*(race-backfill-state.ts)を batch の最後に流すことを確かめる。
    expect(writers.sort()).toEqual(files.sort());
    for (const f of files) {
      expect(readFileSync(path.join(dir, f), "utf-8"), `${f} は状態の作り直しを呼ぶ`).toMatch(/RECOMPUTE_(RACES|BY_ANALYSIS_IDS)_SQL|recomputeRaceBackfillStatement/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 整合検査・済み・諦めの写し・migration
// ---------------------------------------------------------------------------

describe("整合検査 reconcileBackfillState", () => {
  it("食い違い(状態の書き換え・行の欠け)の行数を返して直す。直ったあとは 0", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES ('X1', '2026-10-06T00:00:00.000Z', 0, '20261003')").run();
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES ('X2', '2026-10-06T00:00:00.000Z', 0, '20261003')").run();
    expect(await drift()).toBe(2); // 行が無い(生の INSERT は状態を作らない)→ 2 行を作る
    expect(await drift()).toBe(0);
    await local.db.prepare("UPDATE race_backfill SET st1 = 0 WHERE race_id = 'X1'").run(); // 状態が食い違う
    await local.db.prepare("DELETE FROM race_backfill WHERE race_id = 'X2'").run(); // 行が無い
    expect(await drift()).toBe(2);
    expect(sts(await stateOf("X1"))).toEqual([1, 0, 0, 0]);
    expect(sts(await stateOf("X2"))).toEqual([1, 0, 0, 0]);
    expect(await drift()).toBe(0);
  });

  it("済み・諦め(2)は直さない(条件が真なら保つ)。条件が偽なのに 1 や 2 の状態は 0 に直す", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES ('Y1', '2026-10-06T00:00:00.000Z', 0, '20261003')").run();
    await drift();
    await resultStore().settleBackfill([{ stage: 1, raceIds: ["Y1"] }]);
    expect(await drift()).toBe(0);
    expect(sts(await stateOf("Y1"))).toEqual([2, 0, 0, 0]);
    await local.db.prepare("UPDATE race_backfill SET st4 = 2 WHERE race_id = 'Y1'").run(); // 結果が無いのに段階 4 が 2(条件が偽)
    expect(await drift()).toBe(1);
    expect(sts(await stateOf("Y1"))).toEqual([2, 0, 0, 0]);
  });
});

describe("settleBackfill: 済み・諦めの写し", () => {
  it("段階ごとに、状態 1 のレースだけを 2 にする。実際に 2 にした行数を返す(冪等)。500 件を超える大きさでも通る(1 文 500 件ずつに分かれる)", async () => {
    const nums = JSON.stringify(Array.from({ length: 1300 }, (_, i) => i));
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) SELECT 'W' || printf('%05d', value), '2026-10-06T00:00:00.000Z', 0, '20261003' FROM json_each(?)")
      .bind(nums)
      .run();
    await resultStore().reconcileBackfillState();
    const ids = Array.from({ length: 1300 }, (_, i) => `W${String(i).padStart(5, "0")}`);
    const first = await resultStore().settleBackfill([{ stage: 1, raceIds: ids }, { stage: 3, raceIds: ids.slice(0, 10) }]);
    expect(first).toEqual({ 1: 1300, 2: 0, 3: 0, 4: 0 }); // 段階 3 は条件が偽(結果が無い)ので 0
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill WHERE st1 = 2").first<{ n: number }>())!.n).toBe(1300);
    expect(await resultStore().settleBackfill([{ stage: 1, raceIds: ids }])).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 }); // 冪等
  });
});

describe("settleBackfill の分割: 1 回の batch は 20 文以内、1 文のレース ID は 500 件以内", () => {
  it("10,100 件(= 21 文)は 2 回の batch(20 文 + 1 文)に分かれる。1 文の束縛は 500 件以内の JSON", async () => {
    const spy = spyDb(local.db);
    const ids = Array.from({ length: 10_100 }, (_, i) => `NOPE${i}`);
    const changed = await new D1ResultStore({ db: spy.db }).settleBackfill([{ stage: 2, raceIds: ids }]);
    expect(changed).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 }); // 存在しないレースは 2 にならない
    expect(spy.batches).toEqual([20, 1]);
    expect(spy.prepared).toHaveLength(21);
  });
});

describe("D1 の書き込み行数(meta.rows_written。見積りの再現): 状態の作り直しの 1 文", () => {
  /** 生の書き込みのあとに、状態の作り直しの 1 文だけを流して、その rows_written を返す。 */
  async function recomputeWrites(raceId: string): Promise<number> {
    const r = await local.db.prepare(RECOMPUTE_RACES_SQL).bind(JSON.stringify([raceId])).run();
    return r.meta.rows_written ?? 0;
  }

  it("新しい分析 → 2 行(状態の行〈WITHOUT ROWID なので主キーの索引は別に持たない〉+ 段階 1 の部分索引)。結果の保存で段階 1 が外れ、段階 3・4 が付く → 3 行。変化なしの再計算 → 0 行", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES ('WR1', '2026-10-06T00:00:00.000Z', 0, '20261003')").run();
    expect(await recomputeWrites("WR1")).toBe(2);
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES ('WR1', 1, 1, 3.4)").run();
    const afterResult = await recomputeWrites("WR1"); // st1: 1→0(索引から外れる)・st3: 0→1・st4: 0→1(索引に入る)
    expect(afterResult).toBeGreaterThan(0);
    expect(afterResult).toBeLessThanOrEqual(8);
    expect(await recomputeWrites("WR1")).toBe(0); // 変化なし → 書かない
    process.stderr.write(`REPORT rows_written: 新しい分析 2 / 結果の保存 ${afterResult}\n`);
  });
});

describe("整合検査の読み取り行数(meta.rows_read。1 晩 1 回の全走査の見積りの再現)", () => {
  it("N レース(各 13 頭・分析 1 行)の整合検査は、読み取りがレース数に比例する(1 レースあたり 20 行以下に固定)。状態が変わらなければ書き込みは 0", async () => {
    const races = 300;
    const nums = JSON.stringify(Array.from({ length: races }, (_, i) => i));
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) SELECT 'V' || printf('%05d', value), '2026-10-06T00:00:00.000Z', 0, '20261003', 'オープン' FROM json_each(?)")
      .bind(nums)
      .run();
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, scratched, win_payout) SELECT 'V' || printf('%05d', r.value), h.value + 1, h.value + 1, 2.0, 0, CASE WHEN h.value = 0 THEN 300 ELSE NULL END FROM json_each(?) r, json_each(?) h")
      .bind(nums, JSON.stringify(Array.from({ length: 13 }, (_, i) => i)))
      .run();
    await drift(); // 初回(状態の行を作る)
    const again = await local.db.prepare(RECONCILE_RACE_BACKFILL_SQL).run();
    expect(again.meta.changes).toBe(0);
    expect(again.meta.rows_written).toBe(0);
    process.stderr.write(`REPORT reconcile rows_read=${again.meta.rows_read} races=${races}\n`);
    expect(again.meta.rows_read!).toBeGreaterThan(races); // 前提(空振り防止): 全レースを読んでいる
    expect(again.meta.rows_read!).toBeLessThanOrEqual(races * 20); // 結果の表を 1 回走査(13 頭)+ 分析 1 行 + 結合。レースごとの相関副問い合わせ版は約 35 行/レースだった
  });
});

describe("migration 0035 の初期投入は、再計算の式と同じ文字列", () => {
  const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

  it("migration の SELECT は raceBackfillStateSelect('') と(空白を除いて)同じ", () => {
    const migration = readFileSync(path.join(ROOT, "migrations", "0035_race_backfill.sql"), "utf-8");
    expect(normalize(migration)).toContain(normalize(raceBackfillStateSelect("")));
  });

  it("migration は追加だけ(既存の表・列を変えない)", () => {
    const migration = readFileSync(path.join(ROOT, "migrations", "0035_race_backfill.sql"), "utf-8");
    const statements = migration.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter((s) => s !== "");
    for (const st of statements) {
      expect(st, st.slice(0, 60)).toMatch(/^(CREATE TABLE race_backfill|CREATE INDEX idx_race_backfill_st\d|INSERT INTO race_backfill)/);
    }
  });

  it("既存データへの初期投入(migration の INSERT … SELECT)が、整合検査の作る状態と一致する: 既存の分析・結果がある D1 に migration の投入文を流して比べる", async () => {
    await analyses().saveAnalysis(record(RACE));
    await resultStore().saveResult(RACE, [horse(1, { winOdds: 3.4 })] as never);
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES ('NOROW', '2026-10-06T00:00:00.000Z', 0, NULL)").run();
    await local.db.prepare("DELETE FROM race_backfill").run(); // 投入前の状態(migration の時点では表は空)
    const migration = readFileSync(path.join(ROOT, "migrations", "0035_race_backfill.sql"), "utf-8");
    const insert = migration.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).find((s) => s.startsWith("INSERT INTO race_backfill"))!;
    await local.db.prepare(insert).run();
    expect(await stateOf("NOROW")).toEqual({ kaisai_date: null, sm: 0, st1: 1, st2: 0, st3: 0, st4: 0 }); // 開催日 NULL の分析のレースも行を作る(undated として数える)
    expect(sts(await stateOf(RACE))).toEqual([0, 0, 1, 1]);
    expect(await drift()).toBe(0); // 初期投入の結果は、整合検査(同じ式)と食い違わない
  });
});
