import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0027(Issue #519): kaisai_days(開催日ごとの記録)の追加。追加のみ・既存の行は変わらない・1回しか適用できない。
 * 主キー (track_code, year, kai, nichi) が「1 日 1 行」の保証の実体。旧い Worker(この表を知らない)は何も読み書きしないので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0027_kaisai_days.sql";
/** 0027 より前の migration(番号順)。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0027")
  .sort();

describe("migration 0027: 行のある DB への適用", () => {
  it("前提: 0027 より前は 0001〜0026 の26本", () => {
    expect(BEFORE).toHaveLength(26);
    expect(BEFORE[25]).toBe("0026_baba_attempts.sql");
  });

  it("適用前の baba_fetch_attempts の行は変わらない。表は空で作られ、列は期待どおり", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO baba_fetch_attempts (kaisai_date, slot, attempted_at) VALUES ('20261017', 0, 1)").run();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE name = 'kaisai_days'").all() as unknown[]).length).toBe(0); // 前提: 適用前は表が無い

    db.exec(read(FILE));

    expect(db.prepare("SELECT kaisai_date, slot, attempted_at FROM baba_fetch_attempts").all()).toEqual([{ kaisai_date: "20261017", slot: 0, attempted_at: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM kaisai_days").get()).toEqual({ n: 0 });
    expect((db.prepare("PRAGMA table_info(kaisai_days)").all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["track_code", "TEXT", 1, 1],
      ["year", "INTEGER", 1, 2],
      ["kai", "INTEGER", 1, 3],
      ["nichi", "INTEGER", 1, 4],
      ["kaisai_date", "TEXT", 1, 0],
      ["fence", "TEXT", 0, 0],
    ]);
    db.close();
  });

  it("主キー (track_code, year, kai, nichi): 同じ日は ON CONFLICT DO NOTHING で changes = 0。場・年・回・日次のどれかが違えば入る", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    const put = db.prepare("INSERT INTO kaisai_days (track_code, year, kai, nichi, kaisai_date, fence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (track_code, year, kai, nichi) DO NOTHING");
    expect(put.run("06", 2026, 3, 2, "20260329", "C").changes).toBe(1);
    expect(put.run("06", 2026, 3, 2, "20260330", "D").changes).toBe(0); // 同じ日は通らない
    expect(put.run("05", 2026, 3, 2, "20260329", null).changes).toBe(1); // 別の場
    expect(put.run("06", 2025, 3, 2, "20250329", null).changes).toBe(1); // 別の年
    expect(put.run("06", 2026, 4, 2, "20260329", null).changes).toBe(1); // 別の回
    expect(put.run("06", 2026, 3, 3, "20260404", null).changes).toBe(1); // 別の日次
    expect(db.prepare("SELECT kaisai_date, fence FROM kaisai_days WHERE track_code = '06' AND year = 2026 AND kai = 3 AND nichi = 2").all()).toEqual([{ kaisai_date: "20260329", fence: "C" }]);
    expect(() => put.run(null as unknown as string, 2026, 3, 2, "20260329", null)).toThrow(/NOT NULL/i);
    db.close();
  });

  it("1回しか適用できない(同じ CREATE を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    expect(() => db.exec(read(FILE))).toThrow(/already exists/i);
    db.close();
  });

  it("追加のみ: CREATE TABLE が 1 文だけで、破壊的な文(DROP・DELETE・UPDATE・ALTER・INSERT)を含まない。副索引(CREATE INDEX)も無い", () => {
    const code = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER|INSERT|CREATE INDEX)\b/i);
    expect(code).toMatch(/WITHOUT ROWID/);
  });
});
