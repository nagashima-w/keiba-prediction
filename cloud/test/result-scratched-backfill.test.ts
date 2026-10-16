import { readFileSync } from "node:fs";
import { pathFromMeta } from "./meta-path.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildScratchedStatement, D1ResultStore, type ResultDb } from "../src/result-repository";
import type { RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #270: 取消・除外の区別を記録する前の結果の行(`race_results.scratched` が NULL)を、再取込で補完する。
 * ここは保存の層(`saveScratched`): 結果ページを取り直した入力から、**着順が NULL かつ scratched が NULL の行にだけ** scratched を書く。
 * 他の列・着順のある馬・既に 0/1 の行・組合せ払戻・面には触れない。冪等(2 回目は何も書かない)。
 */

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const store = (db: ResultDb = local.db): D1ResultStore => new D1ResultStore({ db });
const loadFixture = (name: string): string => readFileSync(pathFromMeta(`../../fixtures/${name}`, import.meta.url), "utf-8");

async function scratchedColumn(raceId: string): Promise<Array<[number, number | null]>> {
  const r = await local.db.prepare("SELECT umaban, scratched FROM race_results WHERE race_id = ? ORDER BY umaban").bind(raceId).all<{ umaban: number; scratched: number | null }>();
  return r.results.map((x) => [x.umaban, x.scratched]);
}

/** scratched 以外の全表・全列のダンプ(補完が触らないことの比較用)。 */
async function dumpExceptScratched(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  out["race_results"] = (
    await local.db.prepare("SELECT race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f, win_odds, ninki FROM race_results ORDER BY race_id, umaban").all()
  ).results;
  for (const t of ["race_result_meta", "race_combo_payouts", "race_combo_payout_imports"]) {
    out[t] = (await local.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

const RACE = "202603020211";

/**
 * 補完の対象 = 列を足す前に取り込んだ結果。馬 1・2 は着順あり、馬 3 は着順なし(取消か中止か判別できない)、馬 4 も着順なし。
 * `saveResult` は scratched に 0/1 を書いてしまうので、書いた後に NULL に戻して「旧い行」にする。
 */
async function seedOldResult(raceId = RACE): Promise<void> {
  await store().saveResult(
    raceId,
    [
      { umaban: 1, finishPosition: 2, placePayout: 150, winPayout: null, passing: [2, 2], last3f: 34.1, winOdds: 4.5, ninki: 2 },
      { umaban: 2, finishPosition: 1, placePayout: 120, winPayout: 340, passing: [1, 1], last3f: 33.8, winOdds: 3.4, ninki: 1 },
      { umaban: 3, finishPosition: null, placePayout: null, winPayout: null, passing: [], last3f: null },
      { umaban: 4, finishPosition: null, placePayout: null, winPayout: null, passing: [], last3f: null },
    ],
    "芝",
    { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] }, quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 560 }] } },
  );
  await local.db.prepare("UPDATE race_results SET scratched = NULL WHERE race_id = ?").bind(raceId).run();
}

/** 取り直したページの入力: 馬 3 が取消、馬 4 は中止(取消ではない)。 */
const PAGE: RaceResultEntry[] = [
  { umaban: 1, finishPosition: 2 },
  { umaban: 2, finishPosition: 1 },
  { umaban: 3, finishPosition: null, scratched: true },
  { umaban: 4, finishPosition: null },
];

describe("saveScratched: 旧い行(scratched が NULL)の、着順が NULL の行にだけ書く", () => {
  it("前提(空振り防止): 補完前は 4 頭とも scratched が NULL で、ダンプは空でなく組合せ払戻・取込印・面を含む", async () => {
    await seedOldResult();
    expect(await scratchedColumn(RACE)).toEqual([[1, null], [2, null], [3, null], [4, null]]);
    const before = (await dumpExceptScratched()) as Record<string, unknown[]>;
    expect(before["race_results"]).toHaveLength(4);
    expect(before["race_combo_payouts"]).toHaveLength(2);
    expect(before["race_combo_payout_imports"]).toHaveLength(2);
    expect(before["race_result_meta"]).toHaveLength(1);
  });

  it("取消の馬は 1、中止の馬(着順が NULL で取消でない)は 0。着順のある馬は NULL のまま(検証は NULL を従来どおり不的中として数える=結果は変わらない)", async () => {
    await seedOldResult();
    const outcome = await store().saveScratched(RACE, PAGE);
    expect(await scratchedColumn(RACE)).toEqual([[1, null], [2, null], [3, 1], [4, 0]]);
    expect(outcome.rowsWritten).toBeGreaterThan(0);
  });

  it("scratched 以外は 1 バイトも変わらない: 入力の着順・払戻・通過順・オッズが保存済みと違っていても上書きしない(着順・払戻・オッズ・組合せ払戻・面・取込印)", async () => {
    await seedOldResult();
    const before = await dumpExceptScratched();
    const hostile = PAGE.map((e) => ({ ...e, finishPosition: 99, placePayout: 9999, winPayout: 8888, passing: [9, 9, 9], last3f: 11.1, winOdds: 77.7, ninki: 9 }));
    await store().saveScratched(RACE, hostile);
    expect(await dumpExceptScratched()).toStrictEqual(before);
    expect(await scratchedColumn(RACE)).toEqual([[1, null], [2, null], [3, 1], [4, 0]]); // 前提: 書くべきものは書かれた
  });

  it("2 回目は何も書かない: 行は変わらず rows_written は 0。別の値(取消でなくなった入力)を渡しても、記録済みの 0/1 を上書きしない", async () => {
    await seedOldResult();
    await store().saveScratched(RACE, PAGE);
    const afterFirst = await scratchedColumn(RACE);
    expect(afterFirst).toEqual([[1, null], [2, null], [3, 1], [4, 0]]); // 前提
    expect((await store().saveScratched(RACE, PAGE)).rowsWritten).toBe(0);
    const flipped = PAGE.map((e) => (e.umaban === 3 ? { umaban: 3, finishPosition: null } : e.umaban === 4 ? { umaban: 4, finishPosition: null, scratched: true } : e));
    expect((await store().saveScratched(RACE, flipped)).rowsWritten).toBe(0);
    expect(await scratchedColumn(RACE)).toEqual(afterFirst);
  });

  it("既に記録済みの行(1 も 0 も)には、入力が違っても触れない。NULL の行だけが埋まる", async () => {
    await seedOldResult();
    await local.db.prepare("UPDATE race_results SET scratched = 1 WHERE race_id = ? AND umaban = 4").bind(RACE).run(); // 記録済みの取消
    await store().saveScratched(RACE, PAGE); // 入力は 4 を取消でないと言う
    expect(await scratchedColumn(RACE)).toEqual([[1, null], [2, null], [3, 1], [4, 1]]);
    await local.db.prepare("UPDATE race_results SET scratched = NULL WHERE race_id = ? AND umaban = 3").bind(RACE).run();
    await local.db.prepare("UPDATE race_results SET scratched = 0 WHERE race_id = ? AND umaban = 4").bind(RACE).run();
    await store().saveScratched(RACE, PAGE.map((e) => (e.umaban === 4 ? { ...e, scratched: true } : e)));
    expect(await scratchedColumn(RACE)).toEqual([[1, null], [2, null], [3, 1], [4, 0]]); // 4 は 0 のまま(上書きしない)・3 は埋まる
  });

  it("別のレースの行には触れない(race_id で絞る)。結果の行が無いレースを渡しても何も作らない。ページに無い馬番の入力は行を作らず、入力に無い馬は NULL のまま", async () => {
    await seedOldResult();
    await seedOldResult("202603020212");
    await store().saveScratched(RACE, PAGE);
    expect(await scratchedColumn("202603020212")).toEqual([[1, null], [2, null], [3, null], [4, null]]);
    const before = await local.db.prepare("SELECT COUNT(*) AS n FROM race_results").first<{ n: number }>();
    await store().saveScratched("202699999999", PAGE);
    await store().saveScratched("202603020212", [{ umaban: 18, finishPosition: null, scratched: true }]);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_results").first<{ n: number }>())!.n).toBe(before!.n);
    expect(await scratchedColumn("202603020212")).toEqual([[1, null], [2, null], [3, null], [4, null]]); // 入力に無い馬は NULL のまま
  });

  it("書くものが無い入力(空配列)は D1 に何も発行しない。文は 1 つで、バインドは 2 個(JSON 1 つと race_id)", async () => {
    const calls: Array<{ sql: string; binds: number }> = [];
    const batches: number[] = [];
    const spy: ResultDb = {
      prepare: (sql: string) => {
        const real = local.db.prepare(sql);
        return {
          bind: (...args: unknown[]) => {
            calls.push({ sql, binds: args.length });
            return real.bind(...args);
          },
        } as unknown as D1PreparedStatement;
      },
      batch: (async (stmts: D1PreparedStatement[]) => {
        batches.push(stmts.length);
        return local.db.batch(stmts);
      }) as ResultDb["batch"],
    };
    expect(await store(spy).saveScratched(RACE, [])).toEqual({ rowsWritten: 0 });
    expect(calls).toEqual([]);
    expect(batches).toEqual([]);
    expect(buildScratchedStatement(local.db, RACE, [])).toBeNull();
    await seedOldResult();
    await store(spy).saveScratched(RACE, PAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binds).toBe(2);
    expect(batches).toEqual([1]);
  });

  it("実フィクスチャ(取消あり result_202606040901): パース → 変換 → 補完で、取消の 1 頭だけが 1 になり、他の着順なしの行があれば 0", async () => {
    const parsed = parseRaceResult(loadFixture("result_202606040901.html"));
    const entries = toResultEntries(parsed);
    const scratchedUmabans = entries.filter((e) => e.scratched === true).map((e) => e.umaban);
    expect(scratchedUmabans).toHaveLength(1); // 前提: フィクスチャに取消が 1 頭
    await store().saveResult("202606040901", entries, parsed.courseType ?? null);
    await local.db.prepare("UPDATE race_results SET scratched = NULL").run(); // 旧い行にする
    await store().saveScratched("202606040901", entries);
    const saved = await local.db.prepare("SELECT umaban, finish_position, scratched FROM race_results ORDER BY umaban").all<{ umaban: number; finish_position: number | null; scratched: number | null }>();
    expect(saved.results).toHaveLength(entries.length);
    expect(saved.results.filter((r) => r.scratched === 1).map((r) => r.umaban)).toEqual(scratchedUmabans);
    // 着順のある馬は NULL のまま、着順の無い馬は(取消でなければ)0。
    expect(saved.results.filter((r) => r.finish_position !== null).every((r) => r.scratched === null)).toBe(true);
    expect(saved.results.filter((r) => r.finish_position === null).every((r) => r.scratched === 0 || r.scratched === 1)).toBe(true);
  });

  it("実フィクスチャ(除外あり result_202605040205): 除外の馬が 1 になる", async () => {
    const parsed = parseRaceResult(loadFixture("result_202605040205.html"));
    const entries = toResultEntries(parsed);
    const scratchedUmabans = entries.filter((e) => e.scratched === true).map((e) => e.umaban);
    expect(scratchedUmabans).toHaveLength(1); // 前提
    await store().saveResult("202605040205", entries, parsed.courseType ?? null);
    await local.db.prepare("UPDATE race_results SET scratched = NULL").run();
    await store().saveScratched("202605040205", entries);
    const ones = await local.db.prepare("SELECT umaban FROM race_results WHERE scratched = 1").all<{ umaban: number }>();
    expect(ones.results.map((r) => r.umaban)).toEqual(scratchedUmabans);
  });
});
