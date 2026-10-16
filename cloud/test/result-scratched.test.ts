import { readFileSync } from "node:fs";
import { pathFromMeta } from "./meta-path.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1ResultStore, MIGRATED_RESULTS_SQL, withScratchedColumn } from "../src/result-repository";
import { UPSERT_RACE_RESULT_SQL } from "../../packages/core/src/ev/analysis-store-codec.js";
import { buildVerifySource, VERIFY_READ_SQL, type VerifyReadRows } from "../src/verify-read";
import type { RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { computeVerifyReport } from "../../packages/core/src/ev/verify";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #72: 取消・除外の記録(`race_results.scratched`。migration 0013)。D1 への書き込み → 読み出し → 検証の集計まで、
 * ローカル(workerd)の D1 で通す。
 *
 * 書き込み: 取消・除外の馬は 1、印のない馬(`toResultEntries` が `scratched` のキーを付けない馬)は 0(記録済み・取消でない)。
 * 移行で入れた行(exe 由来)は列に触れない = NULL(記録なし)。読み出し: 1 は `true`、0 は `false`、NULL はキー自体を付けない。
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

const store = (): D1ResultStore => new D1ResultStore({ db: local.db });

async function scratchedColumn(raceId: string): Promise<Array<[number, number | null]>> {
  const r = await local.db.prepare("SELECT umaban, scratched FROM race_results WHERE race_id = ? ORDER BY umaban").bind(raceId).all<{ umaban: number; scratched: number | null }>();
  return r.results.map((x) => [x.umaban, x.scratched]);
}

describe("withScratchedColumn(codec の UPSERT に D1 専用の列を足す)", () => {
  it("列・? ・DO UPDATE SET に scratched が1つずつ足され、元の7列はそのまま残る", () => {
    const sql = withScratchedColumn(UPSERT_RACE_RESULT_SQL);
    expect(sql).toContain("(race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f, scratched)");
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    expect(sql).toContain("last3f = excluded.last3f,");
    expect(sql).toContain("scratched = excluded.scratched");
    expect(sql.match(/scratched/g)).toHaveLength(3);
    // codec の文は変えていない(exe の AnalysisStore と共有。列が足されていない)
    expect(UPSERT_RACE_RESULT_SQL).not.toContain("scratched");
  });

  it("codec の文の形が想定と違えば(列・VALUES・SET のどれかが見つからなければ)落ちる(黙って scratched を書かない文にならない)", () => {
    expect(() => withScratchedColumn("INSERT INTO race_results (a) VALUES (?)")).toThrow(/想定と違い/);
    expect(() => withScratchedColumn(UPSERT_RACE_RESULT_SQL.replace("last3f = excluded.last3f", "last3f = 1"))).toThrow(/想定と違い/);
    expect(() => withScratchedColumn(UPSERT_RACE_RESULT_SQL.replace("VALUES (?, ?, ?, ?, ?, ?, ?)", "VALUES (1, 2, 3, 4, 5, 6, 7)"))).toThrow(/想定と違い/);
  });
});

describe("保存: scratched の書き込み", () => {
  it("scratched=true の馬は 1、印のない馬は 0 で保存される(NULL にしない)", async () => {
    const entries: RaceResultEntry[] = [
      { umaban: 1, finishPosition: 1 },
      { umaban: 2, finishPosition: null, scratched: true },
      { umaban: 3, finishPosition: null }, // 中止など(印なし)
    ];
    await store().saveResult("R72A", entries, null);
    expect(await scratchedColumn("R72A")).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
  });

  it("再保存(UPSERT)で上書きされる: NULL(旧い行)の馬も、取り込み直しで 0 / 1 になる", async () => {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES ('R72B', 1, 1), ('R72B', 2, NULL)").run();
    expect(await scratchedColumn("R72B")).toEqual([
      [1, null],
      [2, null],
    ]);
    await store().saveResult("R72B", [{ umaban: 1, finishPosition: 1 }, { umaban: 2, finishPosition: null, scratched: true }], null);
    expect(await scratchedColumn("R72B")).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("実フィクスチャ(中山1R。6番が取消): パース → toResultEntries → 保存で、6番だけが 1、他の15頭は 0", async () => {
    const html = readFileSync(pathFromMeta("../../fixtures/result_202606040901.html", import.meta.url), "utf-8");
    const parsed = parseRaceResult(html);
    await store().saveResult("202606040901", toResultEntries(parsed), parsed.courseType ?? null);
    const col = await scratchedColumn("202606040901");
    expect(col).toHaveLength(16);
    expect(col.filter(([, s]) => s === 1)).toEqual([[6, 1]]);
    expect(col.filter(([, s]) => s === 0)).toHaveLength(15);
  });

  it("移行で入れた行(MIGRATED_RESULTS_SQL。exe の列だけ)は scratched に触れない = NULL のまま", async () => {
    await local.db.prepare(MIGRATED_RESULTS_SQL).bind("R72C", JSON.stringify([[1, 1, 150, 300, "[]", null], [2, null, null, null, "[]", null]]), "R72C").run();
    expect(await scratchedColumn("R72C")).toEqual([
      [1, null],
      [2, null],
    ]);
  });
});

describe("読み出し → 検証の集計", () => {
  async function readRows(): Promise<VerifyReadRows> {
    const all = async <T>(sql: string): Promise<T[]> => (await local.db.prepare(sql).all()).results as T[];
    return {
      analyses: await all(VERIFY_READ_SQL.analyses),
      horses: await all(VERIFY_READ_SQL.horses),
      allocationMeta: await all(VERIFY_READ_SQL.allocationMeta),
      bets: await all(VERIFY_READ_SQL.bets),
      results: await all(VERIFY_READ_SQL.results),
      comboPayouts: await all(VERIFY_READ_SQL.comboPayouts),
      comboImports: await all(VERIFY_READ_SQL.comboImports),
    };
  }

  it("D1 の 1 / 0 / NULL が、getResult の scratched の true / false / キーなしになる", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at) VALUES ('R72D', '2026-10-12T00:00:00.000Z')").run();
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, scratched) VALUES ('R72D', 1, 1, 0), ('R72D', 2, NULL, 1), ('R72D', 3, NULL, NULL)")
      .run();
    const results = buildVerifySource(await readRows()).getResult("R72D")!;
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.scratched)).toEqual([false, true, undefined]);
    expect("scratched" in results[2]!).toBe(false);
  });

  it("エンドツーエンド: 取消の馬への複勝・ワイドの買い目が返還になり、同じレースの取消でない買い目は払戻のまま。取消が未記録(NULL)の同じ構成は不的中", async () => {
    // 分析2件(別レース)。R72E は取消を記録済み、R72F は同じ構成だが取消が未記録(NULL)の旧い行。
    for (const raceId of ["R72E", "R72F"]) {
      await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, kaisai_date, history_cutoff_date, prompt_lookahead_guarded) VALUES (?, '2026-10-12T00:00:00.000Z', '20261012', '20261012', 1)").bind(raceId).run();
    }
    const ids = (await local.db.prepare("SELECT id FROM analyses ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      await local.db
        .prepare("INSERT INTO analysis_allocation_meta (analysis_id, route, bankroll, per_race_cap, kelly_fraction, ev_threshold, include_combo_odds, include_wide, include_trio, odds_status) VALUES (?, 'mixed', 100000, 10000, 0.5, 1, 1, 1, 1, 'result')")
        .bind(id)
        .run();
      await local.db
        .prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake) VALUES (?, 'place', '05', 500), (?, 'wide', '0105', 300), (?, 'place', '01', 200)")
        .bind(id, id, id)
        .run();
    }
    for (const raceId of ["R72E", "R72F"]) {
      // R72E は取消を記録済み(5番=1、他=0)。R72F は旧い行(全部 NULL)。
      const mark = (recorded: number): number | null => (raceId === "R72E" ? recorded : null);
      await local.db
        .prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, scratched) VALUES (?, 1, 1, 150, ?), (?, 2, 2, 120, ?), (?, 3, 3, 130, ?), (?, 5, NULL, NULL, ?)")
        .bind(raceId, mark(0), raceId, mark(0), raceId, mark(0), raceId, mark(1))
        .run();
      await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'wide')").bind(raceId).run();
      await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'wide', '0102', 400)").bind(raceId).run();
    }
    const report = computeVerifyReport(buildVerifySource(await readRows()));
    expect(report.proposedBet.population.allocated).toBe(2);
    // R72E: 複勝5番(500円)・ワイド1-5(300円)は返還。複勝1番(200円×150/100=300円)は的中。 R72F: 返還なし(5番絡みは不的中)、複勝1番は的中。
    expect(report.proposedBet.place).toMatchObject({ betCount: 4, totalStake: 1400, totalReturn: 500 + 300 + 300, refundedCount: 1, refundedStake: 500 });
    expect(report.proposedBet.wide).toMatchObject({ betCount: 2, totalStake: 600, totalReturn: 300, refundedCount: 1, refundedStake: 300 });
    expect(report.proposedBet.overall).toMatchObject({ refundedCount: 2, refundedStake: 800 });
  });
});
