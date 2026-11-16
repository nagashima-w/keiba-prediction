import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PersonHorse, PersonRow, PersonYearRow } from "../src/person-stats-calc";
import { D1PersonStatsStore, PERSON_ROWS_DONE, SELECT_PERSON_PENDING_PAGE_SQL, SELECT_PERSON_ROWS_PAGE_SQL } from "../src/person-stats-repository";
import { D1RaceArchiveStore } from "../src/race-archive-repository";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #729(段階 A): 人の行(race_person_rows)・年ごとの集計(person_year)・目録の取り込み印(race_archive.person_version)の D1 への読み書き。
 * ローカル(workerd)の本物の D1 で、書く行・実行計画・読み取り行数(meta.rows_read)・書き込み行数(meta.rows_written)を固定する。
 * 毎晩の段取りは market-edge-core.test.ts(人の段)、集計は person-stats-aggregate.test.ts、定義は person-stats-calc.test.ts。
 */

const MIGRATION = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0048_person_stats.sql"), "utf-8");

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

const idOf = (n: number): string => `2024010${String(10000 + n)}`;
const horse = (i: number, placed: 0 | 1 = 0): PersonHorse => [`J${i}`, `T${i}`, placed];
const rowOf = (n: number, date = "2025-01-05"): PersonRow => ({ raceId: idOf(n), raceDate: date, venueCode: "06", courseType: "芝", distance: 1600, horses: [0, 1, 2].map((i) => horse(i, i === 0 ? 1 : 0)) });

async function seedCatalog(n: number, opts: { kind?: "central" | "nar"; date?: string; person?: number | null } = {}): Promise<void> {
  await local.db
    .prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at, person_version) VALUES (?, ?, ?, 2, 'k', 100, '2026-11-01T00:00:00.000Z', ?)")
    .bind(idOf(n), opts.kind ?? "central", opts.date ?? "2025-01-05", opts.person ?? null)
    .run();
}
const markOf = async (n: number): Promise<number | null> => (await local.db.prepare("SELECT person_version AS v FROM race_archive WHERE race_id = ?").bind(idOf(n)).first<{ v: number | null }>())!.v;

describe("目録の取り込み印 person_version と未処理の列挙", () => {
  it("未処理(NULL)の中央・2021-01-01 以降のレースだけを、race_id の順に、カーソルで返す。地方・取り込み済み・2020 年以前は返さない", async () => {
    const store = new D1PersonStatsStore(local.db);
    await seedCatalog(1);
    await seedCatalog(2, { kind: "nar" });
    await seedCatalog(3, { person: PERSON_ROWS_DONE });
    await seedCatalog(4, { date: "2020-12-31" });
    await seedCatalog(5, { date: "2021-01-01" });
    await seedCatalog(6);
    expect(await store.listPendingPage("", 100)).toEqual([
      { raceId: idOf(1), raceDate: "2025-01-05" },
      { raceId: idOf(5), raceDate: "2021-01-01" },
      { raceId: idOf(6), raceDate: "2025-01-05" },
    ]);
    expect((await store.listPendingPage(idOf(1), 1)).map((e) => e.raceId)).toEqual([idOf(5)]);
    expect(await store.listPendingPage(idOf(6), 10)).toEqual([]);
  });

  it("実行計画: 部分索引 idx_race_archive_person_pending を使い、目録の全走査にならない。読む行は未処理の行数に比例し、取り込み済み・対象外の行数に依らない", async () => {
    for (let i = 0; i < 60; i++) await seedCatalog(i, { person: PERSON_ROWS_DONE });
    for (let i = 60; i < 80; i++) await seedCatalog(i, { date: "2019-01-01" });
    for (let i = 100; i < 105; i++) await seedCatalog(i);
    const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_PERSON_PENDING_PAGE_SQL}`).bind("", 100).all<{ detail: string }>();
    const detail = results.map((r) => r.detail).join("\n");
    expect(detail).toContain("idx_race_archive_person_pending");
    expect(detail).not.toMatch(/SCAN race_archive(?! USING)/);
    const res = await local.db.prepare(SELECT_PERSON_PENDING_PAGE_SQL).bind("", 100).all();
    expect(res.results).toHaveLength(5);
    expect(res.meta.rows_read).toBeLessThanOrEqual(5 + 5); // 未処理の 5 行(索引 + 本体)。85 行の目録を全部は読まない
  });

  it("migration の部分索引の WHERE と、SQL の WHERE が同じ形(日付のリテラルを含む): 索引の定義を読み、WHERE の文字列が SQL に現れる", () => {
    const indexWhere = /CREATE INDEX IF NOT EXISTS idx_race_archive_person_pending ON race_archive \(race_id\) WHERE (.+);/.exec(MIGRATION)?.[1];
    expect(indexWhere).toBe("person_version IS NULL AND kind = 'central' AND race_date >= '2021-01-01'");
    expect(SELECT_PERSON_PENDING_PAGE_SQL).toContain(indexWhere!);
  });

  it("目録の中身が変わる再保存(UPSERT の更新)は person_version を NULL に戻す。同じ中身の再保存は戻さない", async () => {
    const { bucket } = spyBucket(local.r2);
    const archive = new D1RaceArchiveStore({ db: local.db, bucket });
    const record = { raceId: idOf(7), kind: "central" as const, date: "2025-01-05", parserVersion: 2, venueCode: "01", venueName: "札幌", raceNumber: 1, missingColumns: [], horses: [], payouts: {} } as never;
    await archive.saveRaceArchive({ record, html: "<html></html>" } as never);
    expect(await markOf(7)).toBeNull();
    await local.db.prepare("UPDATE race_archive SET person_version = 1, market_version = 1 WHERE race_id = ?").bind(idOf(7)).run();
    await archive.saveRaceArchive({ record, html: "<html></html>" } as never); // 同じ中身
    expect(await markOf(7)).toBe(1);
    await archive.saveRaceArchive({ record: { ...(record as object), parserVersion: 3 } as never, html: "<html></html>" } as never); // 中身が変わる
    expect(await markOf(7)).toBeNull();
  });
});

describe("saveRows(取り込みの書き込み)", () => {
  it("人の行を 1 文で書き、同じ batch で取り込み印を付ける。行のない(数える馬がなかった)レースにも印だけ付く。書き込み行数を固定する", async () => {
    const store = new D1PersonStatsStore(local.db);
    for (let i = 1; i <= 4; i++) await seedCatalog(i);
    const res = await store.saveRows([rowOf(1), rowOf(2), rowOf(3)], [idOf(1), idOf(2), idOf(3), idOf(4)]);
    // 行: 本体 + 日付の索引 = 3 × 2、印: 目録の本体 1 行 = 4 × 1(部分索引から外れる分は rows_written に出ない。ローカルの workerd の実測で合計 10)
    expect(res.rowsWritten).toBe(3 * 2 + 4 * 1);
    expect(res.dbSizeBytes).toBeGreaterThan(0);
    const { results } = await local.db.prepare("SELECT race_id AS raceId, race_date AS d, venue_code AS v, course_type AS c, distance AS dist, horses_json AS j FROM race_person_rows ORDER BY race_id").all<{
      raceId: string;
      d: string;
      v: string;
      c: string;
      dist: number;
      j: string;
    }>();
    expect(results.map((r) => r.raceId)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(results[0]).toMatchObject({ d: "2025-01-05", v: "06", c: "芝", dist: 1600 });
    expect(JSON.parse(results[0]!.j)).toEqual(rowOf(1).horses);
    for (let i = 1; i <= 4; i++) expect(await markOf(i)).toBe(PERSON_ROWS_DONE);
    expect(await store.listPendingPage("", 100)).toEqual([]);
  });

  it("印を付けるのは未処理(NULL)のレースだけ: 取り込み済みの印のレースには書き込まない。中身が変わる再保存で NULL に戻ったレースだけが、もう一度印を受ける", async () => {
    const store = new D1PersonStatsStore(local.db);
    await seedCatalog(1, { person: PERSON_ROWS_DONE }); // 取り込み済み
    await seedCatalog(2, { person: PERSON_ROWS_DONE });
    await local.db.prepare("UPDATE race_archive SET person_version = NULL WHERE race_id = ?").bind(idOf(2)).run(); // 中身が変わる再保存(UPSERT)で NULL に戻った
    expect(await markOf(1)).toBe(PERSON_ROWS_DONE); // 前提
    expect(await markOf(2)).toBeNull(); // 前提
    const res = await store.saveRows([], [idOf(1), idOf(2)]);
    expect(res.rowsWritten).toBe(1); // 書くのは NULL だった 2 だけ(1 は WHERE の `person_version IS NULL` で書かない)
    expect(await markOf(1)).toBe(PERSON_ROWS_DONE);
    expect(await markOf(2)).toBe(PERSON_ROWS_DONE);
    expect((await store.saveRows([], [idOf(1), idOf(2)])).rowsWritten).toBe(0); // もう NULL はない
  });

  it("同じレースの取り込み直しは行を置き換える(重複しない)。コース情報が null の行も書ける", async () => {
    const store = new D1PersonStatsStore(local.db);
    await seedCatalog(1);
    await store.saveRows([rowOf(1)], [idOf(1)]);
    await store.saveRows([{ ...rowOf(1), courseType: null, distance: null, horses: [horse(9, 1)] }], [idOf(1)]);
    const { results } = await local.db.prepare("SELECT course_type AS c, distance AS d, horses_json AS j FROM race_person_rows").all<{ c: string | null; d: number | null; j: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ c: null, d: null });
    expect(JSON.parse(results[0]!.j)[0][0]).toBe("J9");
  });

  it("20 レース分を 1 回で書ける(1 文の束縛数が上限 100 に収まる。16 行ずつ 2 文)", async () => {
    const store = new D1PersonStatsStore(local.db);
    const ids: string[] = [];
    const rows: PersonRow[] = [];
    for (let i = 1; i <= 20; i++) {
      await seedCatalog(i);
      ids.push(idOf(i));
      rows.push(rowOf(i));
    }
    await store.saveRows(rows, ids);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_person_rows").first<{ n: number }>())!.n).toBe(20);
    expect((await store.saveRows([], [])).rowsWritten).toBe(0);
  });
});

describe("readRowsPage(集計が読む人の行)", () => {
  it("開催日 → race_id の順に、カーソルの後ろから limit 行ずつ。範囲の終わり(含まない)より後は読まない。実行計画は日付の索引の範囲で、全走査ではない", async () => {
    const store = new D1PersonStatsStore(local.db);
    await store.saveRows([rowOf(1, "2024-12-28"), rowOf(2, "2025-01-05"), rowOf(3, "2025-01-05"), rowOf(4, "2025-05-05"), rowOf(5, "2026-01-01")], []);
    const from = { raceDate: "2025-01-01", raceId: "" };
    const p1 = await store.readRowsPage(from, "2026-01-01", 2);
    expect(p1.rows.map((r) => r.raceId)).toEqual([idOf(2), idOf(3)]);
    expect(p1.broken).toBe(0);
    const p2 = await store.readRowsPage(p1.next!, "2026-01-01", 2);
    expect(p2.rows.map((r) => r.raceId)).toEqual([idOf(4)]); // 2026-01-01 は範囲の外
    expect(p2.next).toBeNull();
    expect(p1.rows[0]).toEqual(rowOf(2, "2025-01-05"));
    const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_PERSON_ROWS_PAGE_SQL}`).bind("2025-01-01", "", "2026-01-01", 2).all<{ detail: string }>();
    const detail = results.map((r) => r.detail).join("\n");
    expect(detail).toContain("idx_race_person_rows_date");
    expect(detail).not.toMatch(/SCAN race_person_rows(?! USING)/);
  });

  it("壊れた horses_json の行は読み飛ばして数える(broken)", async () => {
    const store = new D1PersonStatsStore(local.db);
    await local.db.prepare("INSERT INTO race_person_rows (race_id, race_date, venue_code, course_type, distance, horses_json) VALUES (?, '2025-01-05', '06', NULL, NULL, '{')").bind(idOf(1)).run();
    await store.saveRows([rowOf(2)], []);
    const p = await store.readRowsPage({ raceDate: "2025-01-01", raceId: "" }, "2026-01-01", 10);
    expect(p.rows.map((r) => r.raceId)).toEqual([idOf(2)]);
    expect(p.broken).toBe(1);
  });
});

describe("replaceYears(人 × 年の集計の置き換え)", () => {
  const y = (kind: "jockey" | "trainer", id: string, year: number, starts: number, placed: number): PersonYearRow => ({ personKind: kind, personId: id, year, starts, placed });
  const all = async () =>
    (await local.db.prepare("SELECT person_kind AS k, person_id AS id, year, starts, placed, computed_on AS c FROM person_year ORDER BY person_kind, person_id, year").all<{ k: string; id: string; year: number; starts: number; placed: number; c: string }>()).results;

  it("新規は 1 人 × 年につき 1 行書く。値が同じ再計算は 0 行(computed_on も据え置き)。値が変わった行だけ 1 行書き、computed_on が新しくなる", async () => {
    const store = new D1PersonStatsStore(local.db);
    const rows = [y("jockey", "A", 2025, 10, 3), y("jockey", "B", 2025, 5, 1), y("trainer", "X", 2025, 8, 2)];
    expect((await store.replaceYears(rows, "2026-11-20")).rowsWritten).toBe(3);
    expect((await store.replaceYears(rows, "2026-11-21")).rowsWritten).toBe(0);
    expect((await all()).map((r) => r.c)).toEqual(["2026-11-20", "2026-11-20", "2026-11-20"]);
    const changed = [y("jockey", "A", 2025, 11, 3), y("jockey", "B", 2025, 5, 1), y("trainer", "X", 2025, 8, 2)];
    expect((await store.replaceYears(changed, "2026-11-22")).rowsWritten).toBe(1);
    expect(await all()).toEqual([
      { k: "jockey", id: "A", year: 2025, starts: 11, placed: 3, c: "2026-11-22" },
      { k: "jockey", id: "B", year: 2025, starts: 5, placed: 1, c: "2026-11-20" },
      { k: "trainer", id: "X", year: 2025, starts: 8, placed: 2, c: "2026-11-20" },
    ]);
  });

  it("人 × 年は別の行(年が違えば別。騎手と調教師で同じ ID でも別)。先頭の 0 を含む ID を文字列のまま保つ。700 人を複数の文に分けて書ける", async () => {
    const store = new D1PersonStatsStore(local.db);
    await store.replaceYears([y("jockey", "05386", 2024, 1, 0), y("jockey", "05386", 2025, 2, 1), y("trainer", "05386", 2025, 3, 2)], "2026-11-20");
    expect((await all()).map((r) => [r.k, r.id, r.year, r.starts])).toEqual([
      ["jockey", "05386", 2024, 1],
      ["jockey", "05386", 2025, 2],
      ["trainer", "05386", 2025, 3],
    ]);
    const many = Array.from({ length: 700 }, (_, i) => y("trainer", `T${String(1000 + i)}`, 2025, 1, 0));
    expect((await store.replaceYears(many, "2026-11-20")).rowsWritten).toBe(700);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM person_year").first<{ n: number }>())!.n).toBe(3 + 700);
  });
});
