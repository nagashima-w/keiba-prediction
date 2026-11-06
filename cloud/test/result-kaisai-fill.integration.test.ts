import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1ResultStore } from "../src/result-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #630: 開催日(`analyses.kaisai_date`)が NULL の分析に、開催日を入れる(`D1ResultStore.fillNullKaisaiDates`)。
 * 地方はレース ID の日付、中央は過去の結果の目録 `race_archive.race_date`。決められないものは NULL のまま。
 * 入れたレースは、補完の状態(race_backfill)と検証の変更の印(verify_race_mark)を同じ batch で作り直す。本物のローカル D1(workerd)で確かめる。
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

const NAR_A = "202630071511"; // 地方: 2026-07-15
const NAR_B = "202642071511";
const CEN_A = "202605020411"; // 中央: 目録あり(2026-05-03)
const CEN_NO_ARCHIVE = "202604010211"; // 中央: 目録なし

async function addAnalysis(raceId: string, kaisaiDate: string | null): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, '2026-07-14T00:00:00.000Z', 0, ?)")
    .bind(raceId, kaisaiDate)
    .run();
}
async function addArchive(raceId: string, raceDate: string): Promise<void> {
  await local.db
    .prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at) VALUES (?, 'central', ?, 1, 'k', 1, '2026-07-14T00:00:00.000Z')")
    .bind(raceId, raceDate)
    .run();
}
const dateOf = async (raceId: string): Promise<(string | null)[]> =>
  (await local.db.prepare("SELECT kaisai_date FROM analyses WHERE race_id = ? ORDER BY id").bind(raceId).all<{ kaisai_date: string | null }>()).results.map((r) => r.kaisai_date);
const store = (): D1ResultStore => new D1ResultStore({ db: local.db });

describe("fillNullKaisaiDates", () => {
  it("地方はレース ID の日付、中央は目録の race_date で埋める。目録に無い中央は NULL のまま(undecided に数える)。同じレースの複数の分析は全部埋める", async () => {
    await addAnalysis(NAR_A, null);
    await addAnalysis(NAR_A, null);
    await addAnalysis(NAR_B, null);
    await addAnalysis(CEN_A, null);
    await addAnalysis(CEN_NO_ARCHIVE, null);
    await addArchive(CEN_A, "2026-05-03");
    const r = await store().fillNullKaisaiDates();
    expect(await dateOf(NAR_A)).toEqual(["20260715", "20260715"]);
    expect(await dateOf(NAR_B)).toEqual(["20260715"]);
    expect(await dateOf(CEN_A)).toEqual(["20260503"]);
    expect(await dateOf(CEN_NO_ARCHIVE)).toEqual([null]);
    expect(r).toEqual({ races: 3, analyses: 4, undecided: 1 });
  });

  it("開催日が既にある行は書き換えない(NULL の行だけ)。別の日付が入っている行は、レース ID や目録と食い違っていても残る", async () => {
    await addAnalysis(NAR_A, "20260101");
    await addAnalysis(CEN_A, "20260102");
    await addArchive(CEN_A, "2026-05-03");
    await addAnalysis(NAR_B, null); // 前提(空振り防止): NULL の行が 1 つはあり、処理は走る
    const r = await store().fillNullKaisaiDates();
    expect(r.analyses).toBe(1);
    expect(await dateOf(NAR_A)).toEqual(["20260101"]);
    expect(await dateOf(CEN_A)).toEqual(["20260102"]);
  });

  it("目録の race_date が YYYY-MM-DD でなければ書かない(NULL のまま、undecided)", async () => {
    await addAnalysis(CEN_A, null);
    await addArchive(CEN_A, "2026/05/03");
    const r = await store().fillNullKaisaiDates();
    expect(await dateOf(CEN_A)).toEqual([null]);
    expect(r).toEqual({ races: 0, analyses: 0, undecided: 1 });
  });

  it("入れたレースの補完の状態(race_backfill の kaisai_date と st1)と検証の印(verify_race_mark)が同じ batch で作られる。入れなかったレースには作らない", async () => {
    await addAnalysis(NAR_A, null);
    await addAnalysis(CEN_NO_ARCHIVE, null);
    const spy = spyDb(local.db);
    await new D1ResultStore({ db: spy.db }).fillNullKaisaiDates();
    const state = await local.db.prepare("SELECT race_id, kaisai_date, st1 FROM race_backfill ORDER BY race_id").all();
    expect(state.results).toEqual([{ race_id: NAR_A, kaisai_date: "20260715", st1: 1 }]);
    const mark = await local.db.prepare("SELECT race_id, kaisai_date FROM verify_race_mark ORDER BY race_id").all();
    expect(mark.results).toEqual([{ race_id: NAR_A, kaisai_date: "20260715" }]);
    expect(spy.batches).toEqual([3]); // 1 レース = UPDATE・状態の作り直し・印 の 3 文を 1 batch で
  });

  it("整合検査が直す行が 0(状態の作り直しが正しい)", async () => {
    await addAnalysis(NAR_A, null);
    await addAnalysis(CEN_A, null);
    await addArchive(CEN_A, "2026-05-03");
    await store().fillNullKaisaiDates();
    expect(await store().reconcileBackfillState()).toBe(0);
  });

  it("多数のレースは 50 レースずつの batch に分ける(1 つ目の batch は 150 文)。冪等(2 回目は何も書かない)", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `2026${30 + (i % 35)}0715${String((i % 12) + 1).padStart(2, "0")}`);
    const unique = [...new Set(ids)];
    expect(unique.length).toBe(51); // 前提(空振り防止): 51 個の別のレース
    for (const id of unique) await addAnalysis(id, null);
    const spy = spyDb(local.db);
    const first = await new D1ResultStore({ db: spy.db }).fillNullKaisaiDates();
    expect(first.races).toBe(51);
    expect(spy.batches).toEqual([150, 3]);
    const second = await new D1ResultStore({ db: spy.db }).fillNullKaisaiDates();
    expect(second).toEqual({ races: 0, analyses: 0, undecided: 0 });
    expect(spy.batches).toEqual([150, 3]);
  });

  it("読み取り: NULL を引く読みは kaisai_date の索引(idx_analyses_kaisai_date か kaisai_analyzed)の SEARCH(全表の SCAN でない)。NULL が 0 件の晩は analyses の行をほとんど読まず、書き込みの batch も流さない", async () => {
    const plan = (await local.db.prepare("EXPLAIN QUERY PLAN SELECT id, race_id FROM analyses WHERE kaisai_date IS NULL").all<{ detail: string }>()).results.map((r) => r.detail);
    expect(plan.some((d) => /SEARCH analyses USING (?:COVERING )?INDEX idx_analyses_kaisai_(?:date|analyzed) \(kaisai_date=\?\)/.test(d))).toBe(true);
    for (let i = 0; i < 40; i += 1) await addAnalysis(`2026${30 + (i % 35)}0715${String((i % 12) + 1).padStart(2, "0")}`, "20260715");
    const spy = spyDb(local.db);
    const r = await new D1ResultStore({ db: spy.db }).fillNullKaisaiDates();
    expect(r).toEqual({ races: 0, analyses: 0, undecided: 0 });
    expect(spy.batches).toEqual([]);
    const meta = (await local.db.prepare("SELECT id, race_id FROM analyses WHERE kaisai_date IS NULL").all()).meta;
    expect(meta.rows_read).toBeLessThanOrEqual(2); // 40 行あっても読まない
  });
});
