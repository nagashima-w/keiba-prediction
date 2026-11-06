import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1RaceArchiveStore } from "../src/race-archive-repository";
import type { MarketHorse, MarketRow } from "../src/market-edge-calc";
import {
  D1MarketEdgeStore,
  MARKET_ROWS_DONE,
  MARKET_ROWS_SKIPPED,
  SELECT_MARKET_PENDING_PAGE_SQL,
  SELECT_MARKET_WINDOW_PAGE_SQL,
} from "../src/market-edge-repository";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #642: 市場の行(race_market_rows)・指標(market_edge)・計算の記録(market_edge_meta)・目録の取り込み印(race_archive.market_version)の D1 への読み書き。
 * ローカル(workerd)の本物の D1 で、書く行・実行計画・読み取り行数(meta.rows_read)・書き込み行数(meta.rows_written)を固定する。
 * 毎晩の段取りは market-edge-core.test.ts、集計は market-edge-aggregate.test.ts。
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

const idOf = (n: number): string => `2024010${String(10000 + n)}`;
const horse = (i: number, y: 0 | 1 = 0): MarketHorse => [`J${i}`, `騎${i}`, `T${i}`, `厩${i}`, 0.2, y];
const rowOf = (n: number, date = "2025-01-05"): MarketRow => ({ raceId: idOf(n), raceDate: date, horses: [0, 1, 2, 3, 4].map((i) => horse(i, i === 0 ? 1 : 0)) });

/** 目録の行を入れる(market_version は省略 = NULL)。 */
async function seedCatalog(n: number, opts: { kind?: "central" | "nar"; date?: string; market?: number | null } = {}): Promise<void> {
  await local.db
    .prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at, market_version) VALUES (?, ?, ?, 2, 'k', 100, '2026-11-01T00:00:00.000Z', ?)")
    .bind(idOf(n), opts.kind ?? "central", opts.date ?? "2025-01-05", opts.market ?? null)
    .run();
}
const markOf = async (n: number): Promise<number | null> => (await local.db.prepare("SELECT market_version AS v FROM race_archive WHERE race_id = ?").bind(idOf(n)).first<{ v: number | null }>())!.v;

describe("目録の取り込み印 market_version と未処理の列挙", () => {
  it("未処理(NULL)の中央のレースだけを、race_id の順に、カーソルで返す。地方・取り込み済み・読み飛ばし済みは返さない", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await seedCatalog(1);
    await seedCatalog(2, { kind: "nar" });
    await seedCatalog(3, { market: MARKET_ROWS_DONE });
    await seedCatalog(4, { market: MARKET_ROWS_SKIPPED });
    await seedCatalog(5, { date: "2022-03-01" });
    await seedCatalog(6);
    expect(await store.listPendingPage("", 100)).toEqual([
      { raceId: idOf(1), raceDate: "2025-01-05" },
      { raceId: idOf(5), raceDate: "2022-03-01" },
      { raceId: idOf(6), raceDate: "2025-01-05" },
    ]);
    expect((await store.listPendingPage(idOf(1), 1)).map((e) => e.raceId)).toEqual([idOf(5)]);
    expect(await store.listPendingPage(idOf(6), 10)).toEqual([]);
  });

  it("実行計画: 部分索引 idx_race_archive_market_pending を使い、目録の全走査にならない。読む行は未処理の行数と limit に比例し、変換済みの行数に依らない", async () => {
    for (let i = 0; i < 60; i++) await seedCatalog(i, { market: MARKET_ROWS_DONE });
    for (let i = 100; i < 105; i++) await seedCatalog(i);
    const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_MARKET_PENDING_PAGE_SQL}`).bind("", 100).all<{ detail: string }>();
    const detail = results.map((r) => r.detail).join("\n");
    expect(detail).toContain("idx_race_archive_market_pending");
    expect(detail).not.toMatch(/SCAN race_archive(?! USING)/);
    const res = await local.db.prepare(SELECT_MARKET_PENDING_PAGE_SQL).bind("", 100).all();
    expect(res.results).toHaveLength(5);
    expect(res.meta.rows_read).toBeLessThanOrEqual(5 + 5); // 未処理の 5 行(索引 + 本体)。65 行の目録を全部は読まない
  });

  it("目録の中身が変わる再保存(UPSERT の更新)は market_version を NULL に戻す。同じ中身の再保存は戻さない", async () => {
    const { bucket } = spyBucket(local.r2);
    const archive = new D1RaceArchiveStore({ db: local.db, bucket });
    const record = { raceId: idOf(7), kind: "central" as const, date: "2025-01-05", parserVersion: 2, venueCode: "01", venueName: "札幌", raceNumber: 1, missingColumns: [], horses: [], payouts: {} } as never;
    await archive.saveRaceArchive({ record, html: "<html></html>" } as never);
    expect(await markOf(7)).toBeNull();
    await local.db.prepare("UPDATE race_archive SET market_version = 1, runs_version = 1 WHERE race_id = ?").bind(idOf(7)).run();
    await archive.saveRaceArchive({ record, html: "<html></html>" } as never); // 同じ中身
    expect(await markOf(7)).toBe(1);
    await archive.saveRaceArchive({ record: { ...(record as object), parserVersion: 3 } as never, html: "<html></html>" } as never); // 中身が変わる
    expect(await markOf(7)).toBeNull();
  });
});

describe("saveRows / markSkipped(取り込みの書き込み)", () => {
  it("市場の行を 1 文で書き、同じ batch で取り込み印を付ける。行のない(使えなかった)レースにも印だけ付く。書き込み行数を固定する", async () => {
    const store = new D1MarketEdgeStore(local.db);
    for (let i = 1; i <= 4; i++) await seedCatalog(i);
    const res = await store.saveRows([rowOf(1), rowOf(2), rowOf(3)], [idOf(1), idOf(2), idOf(3), idOf(4)]);
    // 行: 本体 + 日付の索引 = 3 × 2、印: 目録の本体 1 行 = 4 × 1(部分索引から外れる分は rows_written に出ない。ローカルの workerd の実測)
    expect(res.rowsWritten).toBe(3 * 2 + 4 * 1);
    expect(res.dbSizeBytes).toBeGreaterThan(0);
    const { results } = await local.db.prepare("SELECT race_id AS raceId, race_date AS d, horses_json AS j FROM race_market_rows ORDER BY race_id").all<{ raceId: string; d: string; j: string }>();
    expect(results.map((r) => r.raceId)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(JSON.parse(results[0]!.j)).toEqual(rowOf(1).horses);
    for (let i = 1; i <= 4; i++) expect(await markOf(i)).toBe(MARKET_ROWS_DONE);
    expect(await store.listPendingPage("", 100)).toEqual([]);
  });

  it("同じレースの取り込み直しは行を置き換える(重複しない)", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await seedCatalog(1);
    await store.saveRows([rowOf(1)], [idOf(1)]);
    await store.saveRows([{ ...rowOf(1), horses: [horse(9, 1), ...rowOf(1).horses.slice(1)] }], [idOf(1)]);
    const { results } = await local.db.prepare("SELECT horses_json AS j FROM race_market_rows").all<{ j: string }>();
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!.j)[0][0]).toBe("J9");
  });

  it("20 レース分を 1 回で書ける(1 文の束縛数が上限 100 に収まる)", async () => {
    const store = new D1MarketEdgeStore(local.db);
    const ids: string[] = [];
    const rows: MarketRow[] = [];
    for (let i = 1; i <= 20; i++) {
      await seedCatalog(i);
      ids.push(idOf(i));
      rows.push(rowOf(i));
    }
    await store.saveRows(rows, ids);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_market_rows").first<{ n: number }>())!.n).toBe(20);
  });

  it("markSkipped: 窓より古いレースに、読まずに印 -1 だけ付ける(印が NULL のものだけ)。書き込みは 1 レースにつき 1 行(部分索引から外れる分は rows_written に出ない)", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await seedCatalog(1, { date: "2020-01-01" });
    await seedCatalog(2, { date: "2020-01-01" });
    await seedCatalog(3, { market: MARKET_ROWS_DONE });
    const res = await store.markSkipped([idOf(1), idOf(2), idOf(3)]);
    expect(res.rowsWritten).toBe(2 * 1); // 3 は印が NULL でないので書かない
    expect([await markOf(1), await markOf(2), await markOf(3)]).toEqual([MARKET_ROWS_SKIPPED, MARKET_ROWS_SKIPPED, MARKET_ROWS_DONE]);
    expect((await store.markSkipped([])).rowsWritten).toBe(0);
  });
});

describe("readWindowRowsPage(集計が読む市場の行)", () => {
  it("開催日 → race_id の順に、カーソルの後ろから limit 行ずつ。窓より前の日付は読まない。実行計画は日付の索引の範囲で、全走査ではない", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await store.saveRows([rowOf(1, "2023-01-01"), rowOf(2, "2024-11-07"), rowOf(3, "2024-11-07"), rowOf(4, "2025-05-05"), rowOf(5, "2026-01-01")], []);
    const p1 = await store.readWindowRowsPage({ raceDate: "2024-11-07", raceId: "" }, 2);
    expect(p1.rows.map((r) => r.raceId)).toEqual([idOf(2), idOf(3)]);
    expect(p1.broken).toBe(0);
    const p2 = await store.readWindowRowsPage(p1.next!, 2);
    expect(p2.rows.map((r) => r.raceId)).toEqual([idOf(4), idOf(5)]);
    const p3 = await store.readWindowRowsPage(p2.next!, 2);
    expect(p3.rows).toEqual([]);
    expect(p3.next).toBeNull();
    expect(p1.rows[0]).toEqual(rowOf(2, "2024-11-07"));
    const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${SELECT_MARKET_WINDOW_PAGE_SQL}`).bind("2024-11-07", "", 2).all<{ detail: string }>();
    const detail = results.map((r) => r.detail).join("\n");
    expect(detail).toContain("idx_race_market_rows_date");
    expect(detail).not.toMatch(/SCAN race_market_rows(?! USING)/);
  });

  it("壊れた horses_json の行は読み飛ばして数える(broken)", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await local.db.prepare("INSERT INTO race_market_rows (race_id, race_date, horses_json) VALUES (?, '2025-01-05', '{')").bind(idOf(1)).run();
    await store.saveRows([rowOf(2)], []);
    const p = await store.readWindowRowsPage({ raceDate: "2024-01-01", raceId: "" }, 10);
    expect(p.rows.map((r) => r.raceId)).toEqual([idOf(2)]);
    expect(p.broken).toBe(1);
  });
});

describe("replaceEdges / pruneBefore / 読み出し", () => {
  const edge = (id: string, n = 100, edgeV = 0.01) => ({ id, name: `名${id}`, n, edge: edgeV, hitRate: 0.3, predMean: 0.25 });
  const base = { computedOn: "2026-11-07", windowFrom: "2024-11-07", windowTo: "2026-11-06", coef: [2.857, 0.9216, -0.5561] as const, converged: true, iterations: 7, races: 7717, horses: 105316 };

  it("指標を騎手・調教師ごとに置き換える。窓から外れた人は消え、記録(meta)が 1 行になる。読み出しは ID の昇順", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await store.replaceEdges({ ...base, jockeys: [edge("a"), edge("b")], trainers: [edge("x")] });
    await store.replaceEdges({ ...base, computedOn: "2026-11-08", jockeys: [edge("b", 120, 0.02), edge("c")], trainers: [edge("x", 110)] });
    expect((await store.readEdges("jockey")).map((e) => [e.id, e.n, e.computedOn])).toEqual([
      ["b", 120, "2026-11-08"],
      ["c", 100, "2026-11-08"],
    ]);
    expect((await store.readEdges("trainer")).map((e) => e.id)).toEqual(["x"]);
    const one = (await store.readEdges("jockey"))[0]!;
    expect(one).toEqual({ id: "b", name: "名b", n: 120, edge: 0.02, hitRate: 0.3, predMean: 0.25, computedOn: "2026-11-08" });
    const meta = await store.readMeta();
    expect(meta).toEqual({ computedOn: "2026-11-08", windowFrom: "2024-11-07", windowTo: "2026-11-06", coef: [2.857, 0.9216, -0.5561], converged: true, iterations: 7, races: 7717, horses: 105316 });
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM market_edge_meta").first<{ n: number }>())!.n).toBe(1);
  });

  it("記録が無いとき readMeta は null。不収束の記録(converged = false)も往復する", async () => {
    const store = new D1MarketEdgeStore(local.db);
    expect(await store.readMeta()).toBeNull();
    await store.replaceEdges({ ...base, converged: false, jockeys: [], trainers: [] });
    expect((await store.readMeta())!.converged).toBe(false);
  });

  it("書き込み行数: 新規の置き換えは 人数 + 記録 1 行。同じ人の置き換えは人数 + 記録 1 行(行数が増えない)。実行計画に全走査が無い", async () => {
    const store = new D1MarketEdgeStore(local.db);
    const first = await store.replaceEdges({ ...base, jockeys: [edge("a"), edge("b"), edge("c")], trainers: [edge("x"), edge("y")] });
    expect(first.rowsWritten).toBe(5 + 1);
    const second = await store.replaceEdges({ ...base, computedOn: "2026-11-08", jockeys: [edge("a"), edge("b"), edge("c")], trainers: [edge("x"), edge("y")] });
    expect(second.rowsWritten).toBe(5 + 1);
    const third = await store.replaceEdges({ ...base, computedOn: "2026-11-09", jockeys: [edge("a")], trainers: [edge("x")] });
    expect(third.rowsWritten).toBe(2 + 1 + 3); // 置き換え 2 + 記録 1 + 消した 3 人(騎手 b,c と調教師 y)
  });

  it("pruneBefore: 窓より前の日付の市場の行を消す(日付の索引の範囲)", async () => {
    const store = new D1MarketEdgeStore(local.db);
    await store.saveRows([rowOf(1, "2023-12-31"), rowOf(2, "2024-01-01"), rowOf(3, "2025-01-01")], []);
    const res = await store.pruneBefore("2024-01-01");
    expect(res.rowsWritten).toBe(1); // 1 行(削除は索引の分が rows_written に出ない。ローカルの workerd の実測)
    expect((await local.db.prepare("SELECT race_id AS r FROM race_market_rows ORDER BY race_id").all<{ r: string }>()).results.map((x) => x.r)).toEqual([idOf(2), idOf(3)]);
  });
});
