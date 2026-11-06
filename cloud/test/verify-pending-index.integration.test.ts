import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1VerifyStore, PENDING_PREDICATE, PENDING_SQL } from "../src/verify-store";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #600(#594-3): 検証の画面の未確定の一覧(`PENDING_SQL`)が、部分索引 `idx_analyses_pending`(migration 0034)で未確定の行だけを読むこと。
 * ★限界(本番との差): ローカルの D1 は workerd 内蔵の SQLite で、本番の D1 と同じビルドとは限らない。実行計画と rows_read は、本番のデプロイ後に D1 の分析(読み取り行数)で確かめる。
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
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
  // 索引の状態をテスト間に持ち越さない: 0034 のファイルの SQL そのものから作り直す(ファイルを壊す変異がここで効く)。
  await local.db.prepare("DROP INDEX IF EXISTS idx_analyses_pending").run();
  if (MIGRATION_CODE !== "") await local.db.prepare(MIGRATION_CODE.replace(/;$/, "")).run();
});

const MIGRATION = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0034_analyses_pending_index.sql"), "utf8");
const MIGRATION_CODE = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
const INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_analyses_pending ON analyses (id) WHERE start_time IS NULL OR cond_read IS NULL";

/** 確定済み(start_time・cond_read が入っている)の行を n 行、未確定の行を m 行入れる。未確定は id が最後になるよう、確定済みの後ろに入れる。 */
async function seed(settled: number, pending: number): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const ins = "INSERT INTO analyses (race_id, analyzed_at, kaisai_date, prompt_version, start_time, cond_read) VALUES (?, ?, '20261001', 'v', ?, ?)";
  for (let i = 0; i < settled; i += 1) stmts.push(local.db.prepare(ins).bind(`S${i}`, "2026-10-01T00:00:00.000Z", "10:00", 1));
  for (let i = 0; i < pending; i += 1) stmts.push(local.db.prepare(ins).bind(`P${i}`, "2026-10-01T00:00:00.000Z", i % 2 === 0 ? null : "10:00", i % 2 === 0 ? 1 : null));
  for (let i = 0; i < stmts.length; i += 500) await local.db.batch(stmts.slice(i, i + 500));
}

let planCounter = 0;
async function plan(sql: string, binds: unknown[]): Promise<string[]> {
  planCounter += 1;
  return (await local.db.prepare(`EXPLAIN QUERY PLAN ${sql} /* pending-plan-${planCounter} */`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail);
}

async function pendingMeta(): Promise<{ rows_read: number; returned: number; total: number }> {
  const r = await local.db.prepare(PENDING_SQL).bind(0, 50).all<{ total: number }>();
  return { rows_read: r.meta.rows_read, returned: r.results.length, total: r.results[0]?.total ?? 0 };
}

describe("索引の条件と SQL の条件が同じ形(Issue #600)", () => {
  it("migration の索引の WHERE は PENDING_PREDICATE と文字列として一致し、PENDING_SQL もそれを含む", () => {
    expect(PENDING_PREDICATE).toBe("start_time IS NULL OR cond_read IS NULL");
    expect(MIGRATION).toContain(`ON analyses (id) WHERE ${PENDING_PREDICATE};`);
    expect(PENDING_SQL).toContain(`(${PENDING_PREDICATE})`);
    expect(MIGRATION_CODE).toBe(`${INDEX_SQL};`);
  });
});

describe("実行計画(EXPLAIN QUERY PLAN)", () => {
  it("PENDING_SQL は idx_analyses_pending を使う", async () => {
    await seed(20, 4);
    const details = await plan(PENDING_SQL, [0, 50]);
    expect(details.some((d) => /USING INDEX idx_analyses_pending/.test(d)), details.join(" / ")).toBe(true);
  });

  it("対照: 索引の条件を SQL とずらす(cond_read だけ)と、PENDING_SQL は部分索引を使わない", async () => {
    await seed(20, 4);
    try {
      await local.db.prepare("DROP INDEX idx_analyses_pending").run();
      await local.db.prepare("CREATE INDEX idx_analyses_pending ON analyses (id) WHERE cond_read IS NULL").run();
      const details = await plan(PENDING_SQL, [0, 50]);
      expect(details.some((d) => /USING INDEX idx_analyses_pending/.test(d)), details.join(" / ")).toBe(false);
    } finally {
      await local.db.prepare("DROP INDEX IF EXISTS idx_analyses_pending").run();
    }
  });
});

describe("読み取り行数(meta.rows_read)", () => {
  it("未確定を一定(12 行)にして確定済みを 100 → 1,000 に増やしても、rows_read は増えない。前提: 未確定の行は実際に返る", async () => {
    await seed(100, 12);
    const small = await pendingMeta();
    expect(small.returned).toBe(12);
    expect(small.total).toBe(12);
    await seed(900, 0); // 確定済みを 1,000 にする(未確定の id は途中に挟まる。並びは id 順のまま)
    const large = await pendingMeta();
    expect(large.returned).toBe(12);
    expect(large.total).toBe(12);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(1012);
    expect(small.rows_read).toBeGreaterThanOrEqual(12);
    expect(large.rows_read).toBe(small.rows_read);
    expect(large.rows_read).toBeLessThan(100);
  });

  it("対照(検出が空振りでない): 索引を消すと、確定済みの行も読む(rows_read が確定済みの行数以上になる)", async () => {
    await seed(1000, 12);
    try {
      await local.db.prepare("DROP INDEX idx_analyses_pending").run();
      const m = await pendingMeta();
      expect(m.returned).toBe(12);
      expect(m.rows_read).toBeGreaterThanOrEqual(1000);
    } finally {
      await local.db.prepare(INDEX_SQL).run(); // 次のテストは beforeEach が作り直す
    }
  });

  it("検証の画面の数字は変わらない: listPending の total は未確定の件数、並びは id 順、cursor より後ろだけ返る", async () => {
    await seed(30, 6);
    const store = new D1VerifyStore({ db: local.db, bucket: local.r2 });
    const all = await store.listPending(0, 50);
    expect(all.total).toBe(6);
    const ids = all.rows.map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const page = await store.listPending(ids[1]!, 2);
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(2, 4));
  });
});
