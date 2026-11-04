import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { raceRecordToRuns } from "../../packages/core/src/scraper/race-record-to-runs";
import { D1RaceArchiveStore, type RaceArchiveDb } from "../src/race-archive-repository";
import { convertRaceArchives } from "../src/race-archive-runs";
import { ARCHIVE_RUNS_STEP_RACES, RaceArchiveRunsCore } from "../src/race-archive-runs-core";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql } from "./node-sql";

/**
 * Issue #590: 毎晩の変換の D1 の書き込み・読み取りの行数の見積もりの根拠(ローカル D1 の `meta.rows_written`・`meta.rows_read` の実測)。
 * 本物の D1・R2・変換・目録の列挙・一括の読み出しと、コアを通して、合成した 48 レース(実フィクスチャのレースの馬 ID とレース ID を変えたもの)を最後まで変換し、D1 への全文の meta を足し上げる。
 * 見積もりの式(1 晩の上限 L 行、1 レースあたりの書き込み w 行・読み取り r 行): 変換できるレース数 ≈ L / w、読み取りの行数 ≈ (L / w) × r。下のテストが w・r を測る。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const HTML = readFileSync(path.join(FIXTURES, "history_central_result_202105040811.html"), "utf-8");
const built = buildRaceRecord(HTML, "202105040811", "central");
if (!built.ok) throw new Error("fixture が読めない");
const BASE: RaceRecord = built.record;
const RACES = 48;

/** レース i のレコード(race_id の日目とレース番号を変え、馬 ID を i ごとに変える)。 */
function recordOf(i: number): RaceRecord {
  const day = String(1 + Math.floor(i / 12)).padStart(2, "0");
  const no = String(1 + (i % 12)).padStart(2, "0");
  const raceId = `2021050408${day.slice(1)}${no}`.slice(0, 12);
  const id = `20210504${day}${no}`;
  return { ...BASE, raceId: id.length === 12 ? id : raceId, horses: BASE.horses.map((h) => ({ ...h, horseId: h.horseId === null ? null : `${String(i).padStart(2, "0")}${h.horseId.slice(2)}` })) };
}

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

describe("毎晩の変換の D1 の行数(実測)", () => {
  it(`合成した ${RACES} レースを最後まで変換した合計: 書き込みは 1 レースあたり 走数 + 1(印)+ 1 ステップあたり 1(Class B の計数)、読み取りは 1 レースあたり数十行`, async () => {
    const records = Array.from({ length: RACES }, (_, i) => recordOf(i));
    expect(new Set(records.map((r) => r.raceId)).size).toBe(RACES); // 前提: レース ID が重複していない
    const expectedRuns = records.map((r) => {
      const c = raceRecordToRuns(r);
      if (!c.ok) throw new Error("合成のレースが拒否された");
      return c.runs.length;
    });
    expect(Math.min(...expectedRuns)).toBeGreaterThan(5); // 前提: 多頭のレース
    const totalRuns = expectedRuns.reduce((a, b) => a + b, 0);

    const store = new D1RaceArchiveStore({ db: local.db, bucket: local.r2, now: () => new Date("2026-11-05T01:00:00.000Z") });
    for (const r of records) await store.saveRaceArchive({ record: r, html: "<html></html>" });

    // ここから D1 の行数を測る(保存の分は含めない)
    let written = 0;
    let read = 0;
    let statements = 0;
    /** 文の種類ごとの内訳(見積もりの式の根拠。キーは SQL の特徴)。 */
    const byKind: Record<string, { n: number; written: number; read: number }> = {};
    const kindOf = (sql: string): string =>
      sql.includes("FROM race_archive WHERE race_id >") ? "catalog-list" : sql.includes("r2_ops") ? "r2_ops" : sql.startsWith("INSERT INTO horse_runs") ? "horse_runs-insert" : sql.startsWith("UPDATE horse_runs") ? "horse_runs-rewrite" : sql.startsWith("UPDATE race_archive") ? "mark" : "other";
    const add = (meta: { rows_written?: number; rows_read?: number }, sql = ""): void => {
      written += meta.rows_written ?? 0;
      read += meta.rows_read ?? 0;
      statements += 1;
      const k = byKind[kindOf(sql)] ?? (byKind[kindOf(sql)] = { n: 0, written: 0, read: 0 });
      k.n += 1;
      k.written += meta.rows_written ?? 0;
      k.read += meta.rows_read ?? 0;
    };
    const wrapStatement = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
      ({
        bind: (...a: unknown[]) => wrapStatement(s.bind(...a), sql),
        run: async () => {
          const r = await s.run();
          add(r.meta, sql);
          return r;
        },
        all: async () => {
          const r = await s.all();
          add(r.meta, sql);
          return r;
        },
        first: async () => {
          const r = await s.all();
          add(r.meta, sql);
          return r.results[0] ?? null;
        },
        raw: (...a: unknown[]) => (s as unknown as { raw: (...x: unknown[]) => unknown }).raw(...a),
        __s: s,
        __sql: sql,
      }) as unknown as D1PreparedStatement;
    const metered = {
      prepare: (sql: string) => wrapStatement(local.db.prepare(sql), sql),
      batch: async (list: D1PreparedStatement[]) => {
        const res = await local.db.batch(list.map((s) => (s as unknown as { __s?: D1PreparedStatement }).__s ?? s));
        res.forEach((r, i) => add(r.meta, (list[i] as unknown as { __sql?: string }).__sql ?? ""));
        return res;
      },
    } as unknown as RaceArchiveDb;
    const meteredStore = new D1RaceArchiveStore({ db: metered, bucket: local.r2, now: () => new Date("2026-11-05T01:00:00.000Z") });

    const sql = openNodeSql();
    let now = Date.parse("2026-11-04T16:00:00Z"); // JST 11/5 1:00
    let alarm: number | null = now;
    let convertSteps = 0;
    const core = new RaceArchiveRunsCore(
      {
        sql,
        now: () => now,
        setAlarm: (t) => {
          alarm = t;
        },
        getAlarm: async () => alarm,
        archive: { listCatalogPage: (a, l) => meteredStore.listCatalogPage(a, l), readRaceArchives: (ids) => meteredStore.readRaceArchives(ids) },
        convert: (t, n) => {
          convertSteps += 1;
          return convertRaceArchives(metered as never, t, n);
        },
        dbSize: async () => 1,
        catalogCounts: async () => ({ total: 0, byVersion: {} }),
        notify: async () => undefined,
        log: () => undefined,
      },
      {},
    );
    let guard = 0;
    while (alarm !== null && alarm <= Date.parse("2026-11-04T16:00:00Z") + 3 * 3600_000 && guard < 500) {
      now = Math.max(now, alarm);
      alarm = null;
      await core.runNextStep();
      guard += 1;
    }
    const status = await core.getStatus();
    expect(status.totals.races).toBe(RACES);
    expect(status.totals.rows).toBe(totalRuns);
    const unconverted = (await local.db.prepare("SELECT COUNT(*) AS n FROM race_archive WHERE runs_version IS NULL").first<{ n: number }>())!.n;
    expect(unconverted).toBe(0); // 前提: 全レースに印が付いた
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM horse_runs WHERE source = 'result'").first<{ n: number }>())!.n).toBe(totalRuns);

    // 書き込み: 走数(索引なし = 1 行 1 書き込み)+ レースごとの印 1 + 1 ステップごとの Class B の計数 1。種類ごとに固定する。
    expect(written).toBe(totalRuns + RACES + convertSteps);
    expect(byKind["horse_runs-insert"]!.written).toBe(totalRuns);
    expect(byKind["horse_runs-rewrite"]!.written).toBe(0); // 版が同じなら書き直しは何も書かない
    expect(byKind["mark"]!.written).toBe(RACES);
    expect(byKind["r2_ops"]!.written).toBe(convertSteps);
    expect(byKind["catalog-list"]!.written).toBe(0);
    // 読み取り(実測: 挿入 1 走 1 行・書き直しの照合 約 2 走あたり 1.4〜2 行・印 1 レース 3 行・目録の列挙 1 ステップ最大 100 行)。1 走あたり 3.5 行 + 1 レースあたり 3 行 + 列挙 の内側
    expect(byKind["horse_runs-insert"]!.read).toBeLessThanOrEqual(totalRuns);
    expect(byKind["horse_runs-rewrite"]!.read).toBeLessThanOrEqual(2.2 * totalRuns);
    expect(byKind["mark"]!.read).toBeLessThanOrEqual(3 * RACES);
    expect(byKind["catalog-list"]!.read).toBeLessThanOrEqual(10 * 100); // 列挙の呼び出し 10 回 × 最大 100 行(この規模では周の見直しを含む)
    expect(read).toBeGreaterThan(totalRuns); // 前提: 読み取りを実際に測れている
    expect(read).toBeLessThanOrEqual(4 * totalRuns + 3 * RACES + 1000);
    expect(convertSteps).toBe(Math.ceil(RACES / ARCHIVE_RUNS_STEP_RACES));
  });
});
