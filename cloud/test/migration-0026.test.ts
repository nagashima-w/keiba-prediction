import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0026(Issue #480): baba_fetch_attempts(馬場の取得の枠ごとの試み)の追加。追加のみ・既存の行(baba_fetches)は変わらない・1回しか適用できない。
 * 主キー (kaisai_date, slot) が「1 枠 1 回」の保証の実体。旧い Worker(この表を知らない)は baba_fetches だけを読み書きするので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0026_baba_attempts.sql";
/** 0026 より前の migration(番号順)。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0026")
  .sort();

describe("migration 0026: 行のある DB への適用", () => {
  it("前提: 0026 より前は 0001〜0025 の25本", () => {
    expect(BEFORE).toHaveLength(25);
    expect(BEFORE[24]).toBe("0025_min_hit_prob.sql");
  });

  it("適用前の baba_fetches の行は変わらない。表は空で作られ、列は期待どおり", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped) VALUES ('20261017', 1, 2, 'ok', '2026-10-16T23:00:00.000Z', 3, 0)").run();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE name = 'baba_fetch_attempts'").all() as unknown[]).length).toBe(0); // 前提: 適用前は表が無い

    db.exec(read(FILE));

    expect(db.prepare("SELECT * FROM baba_fetches").all()).toEqual([
      { kaisai_date: "20261017", attempted_at: 1, finished_at: 2, result: "ok", api_fetched_at: "2026-10-16T23:00:00.000Z", venues_saved: 3, venues_dropped: 0, dropped_json: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM baba_fetch_attempts").get()).toEqual({ n: 0 });
    expect((db.prepare("PRAGMA table_info(baba_fetch_attempts)").all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["kaisai_date", "TEXT", 1, 1],
      ["slot", "INTEGER", 1, 2],
      ["attempted_at", "INTEGER", 1, 0],
      ["finished_at", "INTEGER", 0, 0],
      ["result", "TEXT", 0, 0],
      ["api_fetched_at", "TEXT", 0, 0],
      ["venues_saved", "INTEGER", 0, 0],
      ["venues_dropped", "INTEGER", 0, 0],
      ["dropped_json", "TEXT", 0, 0],
      ["complete", "INTEGER", 0, 0],
    ]);
    db.close();
  });

  it("主キー (kaisai_date, slot): 同じ日の別の枠は入り、同じ枠は ON CONFLICT DO NOTHING で changes = 0(1 枠 1 回の保証)。別の日の同じ枠は入る", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    const claim = db.prepare("INSERT INTO baba_fetch_attempts (kaisai_date, slot, attempted_at) VALUES (?, ?, ?) ON CONFLICT (kaisai_date, slot) DO NOTHING");
    expect(claim.run("20261025", 0, 100).changes).toBe(1);
    expect(claim.run("20261025", 0, 200).changes).toBe(0); // 同じ枠は通らない
    expect(claim.run("20261025", 1, 300).changes).toBe(1); // 次の枠は通る
    expect(claim.run("20261026", 0, 400).changes).toBe(1); // 別の日の同じ枠は通る
    expect(db.prepare("SELECT kaisai_date, slot, attempted_at, complete FROM baba_fetch_attempts ORDER BY kaisai_date, slot").all()).toEqual([
      { kaisai_date: "20261025", slot: 0, attempted_at: 100, complete: null },
      { kaisai_date: "20261025", slot: 1, attempted_at: 300, complete: null },
      { kaisai_date: "20261026", slot: 0, attempted_at: 400, complete: null },
    ]);
    db.close();
  });

  it("1回しか適用できない(同じ CREATE を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    expect(() => db.exec(read(FILE))).toThrow(/already exists/i);
    db.close();
  });

  it("追加のみ: CREATE TABLE が 1 文だけで、破壊的な文(DROP・DELETE・UPDATE・ALTER・INSERT)を含まない", () => {
    const code = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i);
  });
});
