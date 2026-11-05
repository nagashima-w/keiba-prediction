import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1RaceArchiveStore, SELECT_CATALOG_PAGE_SQL, SELECT_CATALOG_PENDING_PAGE_SQL, type RaceArchiveBucket, type RaceArchiveDb } from "../src/race-archive-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #613(#594 の候補 2): 変換の DO の目録の走査が、未変換(runs_version IS NULL)の行だけを部分索引 idx_race_archive_runs_pending から読む。
 * ローカル(workerd)の本物の D1 で、実行計画・読み取り行数(meta.rows_read)・書き込み行数(meta.rows_written)を確かめる。
 * 走査の範囲を切り替えるロジック(いつ pending を使うか)は race-archive-runs-core.test.ts。
 */

const MIGRATION = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0036_race_archive_runs_pending_index.sql"), "utf-8");
const INDEX_NAME = "idx_race_archive_runs_pending";
const PAGE = 100; // 変換の DO の 1 回の読み(ARCHIVE_RUNS_PAGE_SIZE)

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

const idOf = (n: number): string => `2021010${String(10000 + n)}`;

/** 目録に `converted` 件の変換済み(印 1)と、`pending` 件の未変換(印 NULL)を入れる。race_id は交互に並べる(変換済みが未変換の間に挟まる)。 */
async function seed(converted: number, pending: number): Promise<void> {
  const total = converted + pending;
  // 1 文で入れる(再帰 CTE。i 番目が未変換になるのは、ちょうど pending 件、等間隔)
  await local.db
    .prepare(
      `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?1)
       INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at, runs_version)
       SELECT '2021010' || (10000 + i), 'central', '2021-11-01', 2, 'k', 100, '2026-11-01T00:00:00.000Z',
              CASE WHEN CAST(((i + 1) * ?2) / ?1 AS INTEGER) > CAST((i * ?2) / ?1 AS INTEGER) THEN NULL ELSE 1 END FROM s`,
    )
    .bind(total, pending)
    .run();
}

interface PassResult {
  readonly rows: string[];
  readonly rowsRead: number;
  readonly calls: number;
}
/** 走査 1 周分(先頭から末尾まで。カーソルで進む)。返った行の race_id と、meta.rows_read の合計。 */
async function onePass(sql: string): Promise<PassResult> {
  const rows: string[] = [];
  let rowsRead = 0;
  let calls = 0;
  let cursor = "";
  for (;;) {
    const res = await local.db.prepare(sql).bind(cursor, PAGE).all<{ raceId: string }>();
    calls += 1;
    rowsRead += res.meta.rows_read;
    if (res.results.length === 0) break;
    rows.push(...res.results.map((r) => r.raceId));
    cursor = res.results[res.results.length - 1]!.raceId;
  }
  return { rows, rowsRead, calls };
}
async function plan(sql: string): Promise<string> {
  const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("", PAGE).all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}
async function exec(sql: string): Promise<void> {
  await local.db.prepare(sql).run();
}
/** migration の CREATE INDEX の 1 文(コメント以外)。 */
const MIGRATION_CODE = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();

describe("実行計画: 部分索引が使われる", () => {
  it("未変換だけを引く SQL は idx_race_archive_runs_pending を使う。全行を引く SQL は使わない(主キーを読む)", async () => {
    await seed(100, 10);
    const pending = await plan(SELECT_CATALOG_PENDING_PAGE_SQL);
    expect(pending).toContain(INDEX_NAME);
    expect(pending).not.toMatch(/SCAN race_archive(?! USING)/);
    const all = await plan(SELECT_CATALOG_PAGE_SQL);
    expect(all).not.toContain(INDEX_NAME);
  });

  it("migration の索引の WHERE と、走査の SQL の WHERE は同じ形(runs_version IS NULL)", () => {
    expect(MIGRATION_CODE).toBe(`CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON race_archive (race_id) WHERE runs_version IS NULL;`);
    expect(SELECT_CATALOG_PENDING_PAGE_SQL).toContain("WHERE runs_version IS NULL AND race_id > ?");
  });

  it("変異: 索引を消す・索引の WHERE をずらすと、走査の SQL は部分索引を使えなくなり、全行を読む(上のテストがそれを検出する)", async () => {
    await seed(300, 10);
    const healthy = await onePass(SELECT_CATALOG_PENDING_PAGE_SQL);
    try {
      await exec(`DROP INDEX ${INDEX_NAME}`);
      expect(await plan(SELECT_CATALOG_PENDING_PAGE_SQL)).not.toContain(INDEX_NAME);
      const dropped = await onePass(SELECT_CATALOG_PENDING_PAGE_SQL);
      expect(dropped.rows).toEqual(healthy.rows); // 返る行は同じ(読む行だけが違う)
      expect(dropped.rowsRead).toBeGreaterThan(healthy.rowsRead + 250); // 変換済みの 300 行を読むようになる
      await exec(`CREATE INDEX ${INDEX_NAME} ON race_archive (race_id) WHERE runs_version IS NOT NULL`); // WHERE をずらす
      expect(await plan(SELECT_CATALOG_PENDING_PAGE_SQL)).not.toContain(INDEX_NAME);
      const shifted = await onePass(SELECT_CATALOG_PENDING_PAGE_SQL);
      expect(shifted.rows).toEqual(healthy.rows);
      expect(shifted.rowsRead).toBeGreaterThan(healthy.rowsRead + 250);
    } finally {
      await exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
      await exec(MIGRATION_CODE);
    }
    expect(await plan(SELECT_CATALOG_PENDING_PAGE_SQL)).toContain(INDEX_NAME); // 元に戻した
  });
});

describe("読み取り行数: 変換済みの行が増えても、走査 1 周の rows_read は増えない", () => {
  it("未変換 20 件のまま、変換済みを 100 → 1,000 に増やしても pending の 1 周の rows_read は同じ。全行を読む走査は増える", async () => {
    await seed(100, 20);
    const small = await onePass(SELECT_CATALOG_PENDING_PAGE_SQL);
    const smallAll = await onePass(SELECT_CATALOG_PAGE_SQL);
    expect(small.rows).toHaveLength(20); // 前提: 未変換の行が実際に返る
    await local.reset();
    await seed(1000, 20);
    const large = await onePass(SELECT_CATALOG_PENDING_PAGE_SQL);
    const largeAll = await onePass(SELECT_CATALOG_PAGE_SQL);
    expect(large.rows).toHaveLength(20); // 前提
    expect(smallAll.rowsRead).toBeGreaterThanOrEqual(120); // 前提: 全行の走査は行数に比例して読む
    expect(largeAll.rowsRead - smallAll.rowsRead).toBeGreaterThanOrEqual(900);
    expect(large.rowsRead).toBe(small.rowsRead); // pending は増えない
    expect(large.rowsRead).toBeLessThan(120); // 変換済みの 100 行ぶんすら読んでいない
  });
});

describe("store.listCatalogPage の scope", () => {
  const bucket = { put: async () => undefined, get: async () => null } as unknown as RaceArchiveBucket;
  const store = (): D1RaceArchiveStore => new D1RaceArchiveStore({ db: local.db as unknown as RaceArchiveDb, bucket, now: () => new Date("2026-11-01T00:00:00Z") });

  it("pending は未変換の行だけを主キー順に返し、all は全部返す。カーソルで続き、失敗中の行も 1 周に 1 回だけ読む", async () => {
    await seed(30, 12);
    const s = store();
    const readAll = async (scope: "pending" | "all", limit: number): Promise<string[]> => {
      const out: string[] = [];
      let cursor = "";
      for (;;) {
        const page = await s.listCatalogPage(cursor, limit, scope);
        if (page.length === 0) return out;
        out.push(...page.map((e) => e.raceId));
        cursor = page[page.length - 1]!.raceId;
      }
    };
    const all = await readAll("all", 7);
    const pending = await readAll("pending", 5);
    expect(all).toHaveLength(42);
    expect(pending).toHaveLength(12); // 前提
    const nullRows = (await local.db.prepare("SELECT race_id AS id FROM race_archive WHERE runs_version IS NULL ORDER BY race_id").all<{ id: string }>()).results.map((r) => r.id);
    expect(pending).toEqual(nullRows);
    expect(new Set(pending).size).toBe(pending.length); // 同じ行を 2 回読んでいない
    expect(pending).toEqual([...pending].sort());
    // 既定は all(従来どおり)
    expect((await s.listCatalogPage("", 200)).map((e) => e.raceId)).toEqual(all);
  });

  it("変換して印が付いた行は、次の読みから pending に出てこない", async () => {
    await seed(2, 3);
    const s = store();
    const before = await s.listCatalogPage("", 10, "pending");
    expect(before).toHaveLength(3);
    await exec(`UPDATE race_archive SET runs_version = 1 WHERE race_id = '${before[0]!.raceId}'`);
    expect((await s.listCatalogPage("", 10, "pending")).map((e) => e.raceId)).toEqual(before.slice(1).map((e) => e.raceId));
  });
});

describe("書き込み行数: 索引ぶんの増え方(meta.rows_written。ローカルの D1)", () => {
  it("レース 1 件を目録に入れるときの rows_written は索引ぶん +1。変換して印を付けるとき(索引から外れる)は、ローカルでは増えない", async () => {
    const insert = (id: string): Promise<D1Result> =>
      local.db
        .prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at, runs_version) VALUES (?, 'central', '2021-11-01', 2, 'k', 100, 'x', NULL)")
        .bind(id)
        .run();
    const mark = (id: string): Promise<D1Result> => local.db.prepare("UPDATE race_archive SET runs_version = 1 WHERE race_id = ?").bind(id).run();
    // 索引あり
    const withIndex = { insert: (await insert(idOf(1))).meta.rows_written, mark: (await mark(idOf(1))).meta.rows_written };
    // 索引なし
    try {
      await exec(`DROP INDEX ${INDEX_NAME}`);
      const without = { insert: (await insert(idOf(2))).meta.rows_written, mark: (await mark(idOf(2))).meta.rows_written };
      expect(without.insert).toBeGreaterThan(0); // 前提: 書き込みが数えられている
      expect(withIndex.insert - without.insert).toBe(1);
      // 変換で印を付ける UPDATE(索引から外れる)は、ローカルの D1 では索引ありでも rows_written が増えない(外れる 1 行は数えられない)。
      // 本番の課金上の数え方は未確認で、調査(#612)の見込みは「索引の入る +1・外れる +1」。ここは測った値を固定する
      expect(withIndex.mark).toBe(1);
      expect(withIndex.mark - without.mark).toBe(0);
    } finally {
      await exec(MIGRATION_CODE);
    }
  });
});
