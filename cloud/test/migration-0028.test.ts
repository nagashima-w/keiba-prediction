import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0028(Issue #526 段階 1b): jockey_names(出馬表の騎手名と騎手 ID の組)の追加。追加のみ・既存の行は変わらない・1回しか適用できない。
 * 主キー (jockey_name, jockey_id) が「同じ組は 1 行」の保証の実体。旧い Worker(この表を知らない)は何も読み書きしないので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0028_jockey_names.sql";
/** 0028 より前の migration(番号順)。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0028")
  .sort();

describe("migration 0028: 行のある DB への適用", () => {
  it("前提: 0028 より前は 0001〜0027 の27本", () => {
    expect(BEFORE).toHaveLength(27);
    expect(BEFORE[26]).toBe("0027_kaisai_days.sql");
  });

  it("適用前の kaisai_days の行は変わらない。表は空で作られ、列は期待どおり", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO kaisai_days (track_code, year, kai, nichi, kaisai_date, fence) VALUES ('06', 2026, 3, 2, '20260329', 'C')").run();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE name = 'jockey_names'").all() as unknown[]).length).toBe(0); // 前提: 適用前は表が無い

    db.exec(read(FILE));

    expect(db.prepare("SELECT track_code, year, kai, nichi, kaisai_date, fence FROM kaisai_days").all()).toEqual([{ track_code: "06", year: 2026, kai: 3, nichi: 2, kaisai_date: "20260329", fence: "C" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jockey_names").get()).toEqual({ n: 0 });
    expect((db.prepare("PRAGMA table_info(jockey_names)").all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["jockey_name", "TEXT", 1, 1],
      ["jockey_id", "TEXT", 1, 2],
      ["first_seen", "TEXT", 1, 0],
    ]);
    db.close();
  });

  it("主キー (jockey_name, jockey_id): 同じ組は ON CONFLICT DO NOTHING で changes = 0。名前だけ・ID だけが違えば入る", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    const put = db.prepare("INSERT INTO jockey_names (jockey_name, jockey_id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    expect(put.run("戸崎圭", "05386", "20261031").changes).toBe(1);
    expect(put.run("戸崎圭", "05386", "20261101").changes).toBe(0); // 同じ組は通らない
    expect(put.run("戸崎圭太", "05386", "20261031").changes).toBe(1); // 同じ ID の別の名前(地方のフルネーム)
    expect(put.run("戸崎圭", "99999", "20261031").changes).toBe(1); // 同じ名前の別の ID(曖昧になる)
    expect(db.prepare("SELECT first_seen FROM jockey_names WHERE jockey_name = '戸崎圭' AND jockey_id = '05386'").all()).toEqual([{ first_seen: "20261031" }]); // 最初に見た日を保つ
    expect(() => put.run(null as unknown as string, "05386", "20261031")).toThrow(/NOT NULL/i);
    expect(() => put.run("戸崎圭", null as unknown as string, "20261031")).toThrow(/NOT NULL/i);
    expect(() => put.run("戸崎圭", "05386", null as unknown as string)).toThrow(/NOT NULL/i);
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
