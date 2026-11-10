import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OIKIRI_PARSER_VERSION, parseOikiri } from "../../packages/core/src/scraper/parse-oikiri.js";
import { D1RaceOikiriStore, type RaceOikiriDb } from "../src/race-oikiri-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #731: 過去の追い切りの評価の保存(D1 の race_oikiri。レースで 1 行)。ローカル(workerd)の本物の D1 で確かめる。
 * 固定するもの: 行の中身([馬番, 馬 ID, ランク, 評語] の並び)・冪等(同じ中身の再保存は D1 の書き込みが 0 行)・中身が変わったときの更新・
 * D1 の大きさの守り・不正な入力は D1 に触れる前に例外。
 * ★限界: ローカルの D1 の `size_after` は小さい値。上限の前後は `size_after` を差し替える窓口で固定する。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const ENTRIES = parseOikiri(readFileSync(path.join(FIXTURES, "oikiri_202105010101.html"), "utf-8")).entries;
const T1 = "2026-11-10T01:02:03.456Z";
const T2 = "2026-11-11T04:05:06.789Z";

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

interface Meter {
  readonly db: RaceOikiriDb;
  /** 各文の実行結果(changes・rows_written)。 */
  readonly runs: { sql: string; changes: number; rowsWritten: number }[];
}
function meterDb(real: D1Database, options: { sizeAfter?: unknown } = {}): Meter {
  const runs: Meter["runs"] = [];
  const wrap = (sql: string, statement: D1PreparedStatement) => ({
    bind: (...args: unknown[]) => wrap(sql, statement.bind(...args)),
    run: async () => {
      const r = await statement.run();
      runs.push({ sql, changes: r.meta.changes, rowsWritten: r.meta.rows_written });
      return "sizeAfter" in options ? { ...r, meta: { ...r.meta, size_after: options.sizeAfter } } : r;
    },
    first: () => statement.first(),
    all: () => statement.all(),
  });
  const db = { prepare: (sql: string) => wrap(sql, real.prepare(sql)) } as unknown as RaceOikiriDb;
  return { db, runs };
}

let clock = new Date(T1);
beforeEach(() => {
  clock = new Date(T1);
});
const makeStore = (options: { sizeAfter?: unknown; maxDbBytes?: number } = {}) => {
  const meter = meterDb(local.db, "sizeAfter" in options ? { sizeAfter: options.sizeAfter } : {});
  return { store: new D1RaceOikiriStore({ db: meter.db, now: () => clock, ...(options.maxDbBytes === undefined ? {} : { maxDbBytes: options.maxDbBytes }) }), ...meter };
};
const rows = async (): Promise<Array<Record<string, unknown>>> => (await local.db.prepare("SELECT * FROM race_oikiri ORDER BY race_id").all()).results as Array<Record<string, unknown>>;
const INPUT = { raceId: "202105010101", raceDate: "2021-01-30", entries: ENTRIES, skippedRows: 0 };

describe("保存: 行の中身", () => {
  it("レースで 1 行。horses_json は [馬番, 馬 ID, ランク, 評語] の配列(HTML の並び)で、版・取得時刻・読めなかった行数が付く", async () => {
    const { store } = makeStore();
    expect(ENTRIES).toHaveLength(16);
    const result = await store.saveRaceOikiri(INPUT);
    expect(result.status).toBe("saved");
    const all = await rows();
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row["race_id"]).toBe("202105010101");
    expect(row["race_date"]).toBe("2021-01-30");
    expect(row["parser_version"]).toBe(OIKIRI_PARSER_VERSION);
    expect(row["fetched_at"]).toBe(T1);
    expect(row["skipped_rows"]).toBe(0);
    const horses = JSON.parse(row["horses_json"] as string) as unknown[][];
    expect(horses).toHaveLength(16);
    // 馬 ID とランクの取り違えを検出する: 馬番 1 と 2 の全 4 項目を固定する
    expect(horses[0]).toEqual([1, "2018101424", "C", "目立たず"]);
    expect(horses[1]).toEqual([2, "2018105460", "B", "追毎良化"]);
    expect(horses.map((h) => h[0])).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("評語・ランクが空(null)の馬も、null のまま行に残す(取消馬などで空になる場合)", async () => {
    const { store } = makeStore();
    const withNull = [{ ...ENTRIES[0]!, critic: null, rank: null }, ENTRIES[1]!];
    await store.saveRaceOikiri({ ...INPUT, entries: withNull, skippedRows: 1 });
    const row = (await rows())[0]!;
    expect(JSON.parse(row["horses_json"] as string)).toEqual([[1, "2018101424", null, null], [2, "2018105460", "B", "追毎良化"]]);
    expect(row["skipped_rows"]).toBe(1);
  });

  it("読み出し(getRaceOikiri)は保存した馬ごとの値を返す。無いレースは null", async () => {
    const { store } = makeStore();
    expect(await store.getRaceOikiri("202105010101")).toBeNull();
    await store.saveRaceOikiri(INPUT);
    const got = await store.getRaceOikiri("202105010101");
    expect(got?.raceDate).toBe("2021-01-30");
    expect(got?.horses[7]).toEqual({ umaban: 8, horseId: "2018100299", rank: "B", critic: "好気配" });
  });
});

describe("保存: 冪等と更新", () => {
  it("同じ中身の再保存は unchanged で、D1 の書き込みは 0 行・fetched_at も据え置く。初回は 1 行の書き込み", async () => {
    const { store, runs } = makeStore();
    await store.saveRaceOikiri(INPUT);
    const first = runs.filter((r) => r.sql.includes("INSERT INTO race_oikiri"));
    expect(first).toHaveLength(1);
    expect(first[0]!.rowsWritten).toBe(1);
    clock = new Date(T2);
    const again = await store.saveRaceOikiri(INPUT);
    expect(again.status).toBe("unchanged");
    const second = runs.filter((r) => r.sql.includes("INSERT INTO race_oikiri"));
    expect(second).toHaveLength(2);
    expect(second[1]!.changes).toBe(0);
    expect(second[1]!.rowsWritten).toBe(0);
    expect((await rows()).map((r) => r["fetched_at"])).toEqual([T1]);
  });

  it("中身(ランク 1 つ)が変わった再保存は saved で、行は 1 つのまま中身と fetched_at が新しくなる", async () => {
    const { store } = makeStore();
    await store.saveRaceOikiri(INPUT);
    clock = new Date(T2);
    const changed = ENTRIES.map((e, i) => (i === 0 ? { ...e, rank: "A" } : e));
    const result = await store.saveRaceOikiri({ ...INPUT, entries: changed });
    expect(result.status).toBe("saved");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!["fetched_at"]).toBe(T2);
    expect((JSON.parse(all[0]!["horses_json"] as string) as unknown[][])[0]![2]).toBe("A");
  });
});

describe("保存: D1 の大きさの守り", () => {
  it("上限を超えていれば skipped(db-size)で、何も書かない。ちょうど上限なら保存する", async () => {
    const over = makeStore({ sizeAfter: 1001, maxDbBytes: 1000 });
    expect(await over.store.saveRaceOikiri(INPUT)).toEqual({ status: "skipped", reason: "db-size", dbSizeBytes: 1001 });
    expect(await rows()).toHaveLength(0);
    const edge = makeStore({ sizeAfter: 1000, maxDbBytes: 1000 });
    expect((await edge.store.saveRaceOikiri(INPUT)).status).toBe("saved");
    expect(await rows()).toHaveLength(1);
  });

  it("大きさが数で取れなければ skipped(db-size-unknown)で、何も書かない", async () => {
    const { store } = makeStore({ sizeAfter: undefined });
    expect(await store.saveRaceOikiri(INPUT)).toEqual({ status: "skipped", reason: "db-size-unknown", dbSizeBytes: null });
    expect(await rows()).toHaveLength(0);
  });
});

describe("保存: 不正な入力は D1 に触れる前に例外", () => {
  it.each([
    ["race_id が 12 桁でない", { ...INPUT, raceId: "2021050101" }],
    ["日付が YYYY-MM-DD でない", { ...INPUT, raceDate: "20210130" }],
    ["頭数が 0", { ...INPUT, entries: [] }],
    ["読めなかった行数が負", { ...INPUT, skippedRows: -1 }],
  ])("%s", async (_name, input) => {
    const { store, runs } = makeStore();
    await expect(store.saveRaceOikiri(input)).rejects.toThrow();
    expect(runs).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});
