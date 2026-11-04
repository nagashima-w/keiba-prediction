import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { encodeRaceArchive, raceArchiveKeyOf } from "../src/race-archive-format";
import { D1RaceArchiveStore, READ_BATCH_MAX, type RaceArchiveBucket, type RaceArchiveDb } from "../src/race-archive-repository";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #588(#549-B3-1): 目録の印 runs_version(migration 0033)・目録の主キー順の列挙・複数レースの一括の読み出し。
 * ローカル(workerd)の本物の D1・R2 で確かめる。変換そのものは race-archive-runs.test.ts。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const load = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");
function mustRecord(html: string, raceId: string, kind: "central" | "nar"): RaceRecord {
  const r = buildRaceRecord(html, raceId, kind);
  if (!r.ok) throw new Error(`読めるはずのレースが読めなかった: ${r.category} ${r.detail}`);
  return r.record;
}
const CENTRAL_HTML = load("history_central_result_202105040811.html");
const NAR_HTML = load("history_nar_result_202146110310.html");
const CENTRAL = mustRecord(CENTRAL_HTML, "202105040811", "central");
const NAR = mustRecord(NAR_HTML, "202146110310", "nar");

const T1 = "2026-11-01T01:02:03.456Z";
const YM = 202611;

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  const keys = (await local.r2.list()).objects.map((o) => o.key);
  if (keys.length > 0) await local.r2.delete(keys);
});

function makeStore(bucket?: RaceArchiveBucket): { store: D1RaceArchiveStore; prepared: string[]; batches: number[]; calls: Array<{ op: string; key: string }> } {
  const prepared: string[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return local.db.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      batches.push(statements.length);
      return local.db.batch(statements);
    },
  } as unknown as RaceArchiveDb;
  const spy = spyBucket(local.r2);
  const calls: Array<{ op: string; key: string }> = [];
  const wrapped: RaceArchiveBucket = {
    put: (key, value, options) => spy.bucket.put(key, value, options),
    get: (key) => {
      calls.push({ op: "get", key });
      return (bucket ?? spy.bucket).get(key);
    },
  };
  return { store: new D1RaceArchiveStore({ db, bucket: wrapped, now: () => new Date(T1) }), prepared, batches, calls };
}
async function ops(): Promise<{ classA: number; classB: number } | null> {
  return local.db.prepare("SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?").bind(YM).first();
}
async function runsVersionOf(raceId: string): Promise<number | null> {
  return (await local.db.prepare("SELECT runs_version AS v FROM race_archive WHERE race_id = ?").bind(raceId).first<{ v: number | null }>())!.v;
}
async function seedCatalog(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await local.db.prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at) VALUES (?, 'central', '2021-11-01', 2, ?, 100, ?)").bind(id, raceArchiveKeyOf(id), T1).run();
  }
}

describe("目録の印 runs_version と保存", () => {
  it("新規の保存では runs_version は NULL。中身が変わる保存(saved)は印を NULL に戻し、変わらない保存(unchanged)は印を据え置く", async () => {
    const { store } = makeStore();
    expect((await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
    expect(await runsVersionOf("202105040811")).toBeNull();
    await local.db.prepare("UPDATE race_archive SET runs_version = 1 WHERE race_id = '202105040811'").run();
    expect(await runsVersionOf("202105040811")).toBe(1); // 前提: 印が付いている

    // 同じ中身の再保存(取得時刻だけが違う): unchanged。印は据え置き
    const later = new D1RaceArchiveStore({ db: local.db, bucket: local.r2, now: () => new Date("2026-11-02T04:05:06.789Z") });
    expect((await later.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("unchanged");
    expect(await runsVersionOf("202105040811")).toBe(1);

    // HTML が変わった再保存: saved。印は NULL に戻る
    expect((await later.saveRaceArchive({ record: CENTRAL, html: `${CENTRAL_HTML}<!-- 追記 -->` })).status).toBe("saved");
    expect(await runsVersionOf("202105040811")).toBeNull();
  });

  it("getCatalogEntry は印を返す(付けた値・未変換の null)", async () => {
    const { store } = makeStore();
    await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect((await store.getCatalogEntry("202105040811"))!.runsVersion).toBeNull();
    await local.db.prepare("UPDATE race_archive SET runs_version = 7 WHERE race_id = '202105040811'").run();
    expect((await store.getCatalogEntry("202105040811"))!.runsVersion).toBe(7);
  });
});

describe("目録の主キー順の列挙(listCatalogPage)", () => {
  const IDS = ["202101010101", "202101010102", "202101010103", "202101010104", "202101010105"];

  it("カーソル(race_id)より後ろを、主キー順に limit 件。続きは最後の race_id を渡す。末尾を過ぎたら空", async () => {
    await seedCatalog([IDS[3]!, IDS[0]!, IDS[4]!, IDS[1]!, IDS[2]!]); // 挿入順は主キー順でない
    const { store } = makeStore();
    const p1 = await store.listCatalogPage("", 2);
    expect(p1.map((e) => e.raceId)).toEqual([IDS[0], IDS[1]]);
    const p2 = await store.listCatalogPage(p1[1]!.raceId, 2);
    expect(p2.map((e) => e.raceId)).toEqual([IDS[2], IDS[3]]);
    const p3 = await store.listCatalogPage(p2[1]!.raceId, 2);
    expect(p3.map((e) => e.raceId)).toEqual([IDS[4]]);
    expect(await store.listCatalogPage(IDS[4]!, 2)).toEqual([]);
    expect(p1[0]).toEqual({ raceId: IDS[0], kind: "central", raceDate: "2021-11-01", parserVersion: 2, r2Key: raceArchiveKeyOf(IDS[0]!), rawBytes: 100, fetchedAt: T1, runsVersion: null });
  });

  it("読む行は limit 件ぶんだけ(全件走査にならない): 300 件の目録で limit 20 の rows_read は 20 前後", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `2021010${String(10000 + i)}`);
    expect(ids.every((id) => /^\d{12}$/.test(id))).toBe(true); // 前提
    await seedCatalog(ids);
    const res = await local.db.prepare("SELECT race_id AS raceId, kind, race_date AS raceDate, parser_version AS parserVersion, r2_key AS r2Key, raw_bytes AS rawBytes, fetched_at AS fetchedAt, runs_version AS runsVersion FROM race_archive WHERE race_id > ? ORDER BY race_id LIMIT ?").bind(ids[100]!, 20).all();
    expect(res.results).toHaveLength(20);
    expect(res.meta.rows_read).toBeLessThanOrEqual(25);
    const { store, prepared } = makeStore();
    const page = await store.listCatalogPage(ids[100]!, 20);
    expect(page).toHaveLength(20);
    expect(page[0]!.raceId).toBe(ids[101]);
    expect(prepared).toHaveLength(1); // 1 文
  });

  it("limit は 1〜200 の整数、カーソルは空文字か 12 桁の数字。違えば RangeError(D1 に触れない)", async () => {
    const { store, prepared } = makeStore();
    for (const limit of [0, 201, 1.5, -1, Number.NaN]) await expect(store.listCatalogPage("", limit)).rejects.toThrow(RangeError);
    await expect(store.listCatalogPage("abc", 10)).rejects.toThrow(RangeError);
    expect(prepared).toEqual([]);
    await expect(store.listCatalogPage("", 200)).resolves.toEqual([]); // 境界の内側は通る
  });
});

describe("複数レースの一括の読み出し(readRaceArchives)", () => {
  async function saveBoth(): Promise<void> {
    const { store } = makeStore();
    await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    await store.saveRaceArchive({ record: NAR, html: NAR_HTML });
  }

  it("柵の確認は 1 回・Class B の計数は 1 回(まとめて +N)。get は N 回。found と missing が混ざっても全部返る", async () => {
    await saveBoth();
    const { store, prepared, calls } = makeStore();
    const result = await store.readRaceArchives(["202105040811", "202146110310", "202199999999"]);
    expect(result.status).toBe("read");
    if (result.status !== "read") throw new Error("unreachable");
    expect(result.items.map((i) => [i.raceId, i.outcome.status])).toEqual([["202105040811", "found"], ["202146110310", "found"], ["202199999999", "missing"]]);
    const found = result.items[0]!.outcome;
    if (found.status !== "found") throw new Error("unreachable");
    expect(found.archive.record).toStrictEqual(CENTRAL);
    expect(calls.map((c) => c.op)).toEqual(["get", "get", "get"]);
    expect(prepared.filter((s) => s.includes("class_b"))).toHaveLength(2); // 柵の読み取り 1 + 計数 1
    expect(await ops()).toEqual({ classA: 2, classB: 3 });
  });

  it("1 件の get が失敗しても、ほかは読める。失敗した件は error(「無い」と区別する)で、要求は出たので Class B は数える", async () => {
    await saveBoth();
    const failing: RaceArchiveBucket = {
      put: async () => { throw new Error("使わない"); },
      get: (key: string) => (key === raceArchiveKeyOf("202146110310") ? Promise.reject(new Error("R2_ERROR: injected")) : local.r2.get(key)),
    } as unknown as RaceArchiveBucket;
    const { store } = makeStore(failing);
    const result = await store.readRaceArchives(["202105040811", "202146110310"]);
    if (result.status !== "read") throw new Error("unreachable");
    expect(result.items.map((i) => i.outcome.status)).toEqual(["found", "error"]);
    expect(await ops()).toEqual({ classA: 2, classB: 2 });
  });

  it("Class B が柵に達していれば、R2 を引かず skipped(r2-fence)。計数もしない。1 つ手前なら読める", async () => {
    await saveBoth();
    await local.db.prepare("UPDATE r2_ops SET class_b = ? WHERE ym = ?").bind(R2_FENCE_LIMITS.classB, YM).run();
    const { store, calls } = makeStore();
    expect(await store.readRaceArchives(["202105040811"])).toEqual({ status: "skipped", reason: "r2-fence" });
    expect(calls).toEqual([]);
    expect((await ops())!.classB).toBe(R2_FENCE_LIMITS.classB);
    await local.db.prepare("UPDATE r2_ops SET class_b = ? WHERE ym = ?").bind(R2_FENCE_LIMITS.classB - 1, YM).run();
    expect((await makeStore().store.readRaceArchives(["202105040811"])).status).toBe("read");
  });

  it(`1 回に読めるのは ${READ_BATCH_MAX} 件まで(サブリクエストの上限の内側)。超える・12 桁でない・重複は RangeError で、R2 にも D1 にも触れない。空配列は何も呼ばず空を返す`, async () => {
    const { store, prepared, calls } = makeStore();
    const ids = Array.from({ length: READ_BATCH_MAX + 1 }, (_, i) => `2021010${String(10000 + i)}`);
    await expect(store.readRaceArchives(ids)).rejects.toThrow(RangeError);
    await expect(store.readRaceArchives(["abc"])).rejects.toThrow(RangeError);
    await expect(store.readRaceArchives(["202105040811", "202105040811"])).rejects.toThrow(RangeError);
    expect(prepared).toEqual([]);
    expect(calls).toEqual([]);
    expect(await store.readRaceArchives([])).toEqual({ status: "read", items: [] });
    expect(prepared).toEqual([]);
    // 境界: ちょうど上限の件数は通る
    expect((await store.readRaceArchives(ids.slice(0, READ_BATCH_MAX))).status).toBe("read");
  });

  it("計数の失敗は読み出しを妨げない(best-effort)", async () => {
    await saveBoth();
    const db = { prepare: (sql: string) => (sql.includes("class_b = class_b +") ? { bind: () => ({ run: () => Promise.reject(new Error("D1 失敗")) }) } : local.db.prepare(sql)), batch: (s: D1PreparedStatement[]) => local.db.batch(s) } as unknown as RaceArchiveDb;
    const store = new D1RaceArchiveStore({ db, bucket: local.r2, now: () => new Date(T1) });
    const result = await store.readRaceArchives(["202105040811"]);
    expect(result.status).toBe("read");
    expect(await ops()).toEqual({ classA: 2, classB: 0 }); // 前提: 計数は実際に失敗している
  });

  it("壊れたオブジェクト・別のレースの保存物は missing(クラッシュしない)", async () => {
    await local.r2.put(raceArchiveKeyOf("202105040811"), new Uint8Array([1, 2, 3]));
    await local.r2.put(raceArchiveKeyOf("202146110310"), encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: T1 }).body);
    const result = await makeStore().store.readRaceArchives(["202105040811", "202146110310"]);
    if (result.status !== "read") throw new Error("unreachable");
    expect(result.items.map((i) => i.outcome.status)).toEqual(["missing", "missing"]);
  });
});
