import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findWalLeftovers } from "./d1-template-core";
import { getMigratedTemplate, openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #621: ひな形(migration 済みの D1 の状態)から写しを開く方式の確認。
 * (1) ひな形は閉じた状態(-wal・-shm なし)で、その写しから開いた D1 に、migration を順に当てた結果と同じ表・索引と、
 *     migration の記録(d1_migrations)が全部そろう。(2) 写しはほかと共有しない: 片方の書き込みは他方に見えず、ひな形も変わらない。
 * migration を当てること自体の確認は d1-schema.integration.test.ts が今の形で行う。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(CLOUD, "migrations");

let a: LocalBindings;
let b: LocalBindings;

beforeAll(async () => {
  a = await openLocalBindings();
  b = await openLocalBindings();
});
afterAll(async () => {
  await a?.dispose();
  await b?.dispose();
});

async function names(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT type || ':' || name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY 1").all<{ n: string }>();
  return results.map((r) => r.n);
}

describe("ひな形は閉じた状態で、写しから開いた D1 に migration の結果が全部そろう", () => {
  it("ひな形に -wal・-shm が残っていない", async () => {
    const template = await getMigratedTemplate();
    expect(findWalLeftovers(template)).toEqual([]);
  });

  it("表・索引の一覧が、migration を順に当てた結果(別の SQLite に直接当てたもの)と一致する", async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(30);
    const reference = new DatabaseSync(":memory:");
    for (const f of files) reference.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
    const expected = (reference.prepare("SELECT type || ':' || name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1").all() as Array<{ n: string }>)
      .map((r) => r.n)
      .filter((n) => !n.startsWith("table:d1_migrations"));
    const actual = (await names(a.db)).filter((n) => !n.startsWith("table:d1_migrations"));
    expect(expected.length).toBeGreaterThan(30);
    expect(actual).toEqual(expected);
  });

  it("d1_migrations に、全 migration が名前の順にそろう", async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const { results } = await a.db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(files);
  });
});

describe("写しはほかと共有しない", () => {
  const insert = "INSERT INTO cloud_settings (id, settings_json, updated_at) VALUES (1, ?, 't')";
  it("片方の書き込みは他方に見えない。他方の reset も書き込みを消さない", async () => {
    await a.db.prepare(insert).bind("{\"from\":\"a\"}").run();
    const inA = await a.db.prepare("SELECT COUNT(*) AS c FROM cloud_settings").first<{ c: number }>();
    const inB = await b.db.prepare("SELECT COUNT(*) AS c FROM cloud_settings").first<{ c: number }>();
    expect(inA?.c).toBe(1);
    expect(inB?.c).toBe(0);
    await b.reset();
    const stillA = await a.db.prepare("SELECT COUNT(*) AS c FROM cloud_settings").first<{ c: number }>();
    expect(stillA?.c).toBe(1);
  });

  it("あとから開いた写しにも、書き込み済みの写しの内容は入らず、ひな形(の主ファイル)も変わらない", async () => {
    const template = await getMigratedTemplate();
    const snapshot = (): Record<string, number> => {
      const out: Record<string, number> = {};
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else out[path.relative(template, full)] = readFileSync(full).length;
        }
      };
      walk(template);
      return out;
    };
    const before = snapshot();
    const c = await openLocalBindings();
    try {
      const inC = await c.db.prepare("SELECT COUNT(*) AS n FROM cloud_settings").first<{ n: number }>();
      expect(inC?.n).toBe(0);
      await c.db.prepare(insert).bind("{}").run();
    } finally {
      await c.dispose();
    }
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
  });
});
