import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0031(Issue #551〈#549-A2〉): race_archive(過去の結果ページの目録)の追加。追加のみ・既存の行は変わらない・1回しか適用できない。
 * 主キー race_id が「同じレースは 1 行」の保証の実体。旧い Worker(この表を知らない)は何も読み書きしないので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0031_race_archive.sql";
/** 0031 より前の migration(番号順)。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0031")
  .sort();

const INSERT = "INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

describe("migration 0031: 行のある DB への適用", () => {
  it("前提: 0031 より前は 0001〜0030 の30本", () => {
    expect(BEFORE).toHaveLength(30);
    expect(BEFORE[29]).toBe("0030_trainer_names.sql");
  });

  it("適用前の trainer_names の行は変わらない。表は空で作られ、列は期待どおり", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO trainer_names (trainer_name, trainer_id, first_seen) VALUES ('藤野', '01200', '20261031')").run();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE name = 'race_archive'").all() as unknown[]).length).toBe(0); // 前提: 適用前は表が無い

    db.exec(read(FILE));

    expect(db.prepare("SELECT trainer_name, trainer_id, first_seen FROM trainer_names").all()).toEqual([{ trainer_name: "藤野", trainer_id: "01200", first_seen: "20261031" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM race_archive").get()).toEqual({ n: 0 });
    expect((db.prepare("PRAGMA table_info(race_archive)").all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["race_id", "TEXT", 1, 1],
      ["kind", "TEXT", 1, 0],
      ["race_date", "TEXT", 1, 0],
      ["parser_version", "INTEGER", 1, 0],
      ["r2_key", "TEXT", 1, 0],
      ["raw_bytes", "INTEGER", 1, 0],
      ["fetched_at", "TEXT", 1, 0],
    ]);
    db.close();
  });

  it("主キー race_id: 同じレースは 2 行目が入らない。kind は central か nar だけ。どの列も NULL は入らない", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    const put = db.prepare(INSERT);
    const row = ["202105040811", "central", "2021-10-31", 2, "race-results/202105040811.json.gz", 140_000, "2026-11-01T01:02:03.456Z"] as const;
    expect(put.run(...row).changes).toBe(1);
    expect(() => put.run(...row)).toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(() => put.run("202146110310", "other", "2021-11-03", 2, "k", 1, "2026-11-01T01:02:03.456Z")).toThrow(/CHECK/i);
    expect(put.run("202146110310", "nar", "2021-11-03", 2, "k", 1, "2026-11-01T01:02:03.456Z").changes).toBe(1);
    for (let i = 0; i < row.length; i += 1) {
      const withNull = row.map((v, j) => (j === i ? null : v)) as unknown as [string, string, string, number, string, number, string];
      withNull[0] = i === 0 ? (null as unknown as string) : `20210504081${i}`;
      expect(() => put.run(...withNull), `列 ${i}`).toThrow(/NOT NULL|CHECK/i);
    }
    db.close();
  });

  it("1回しか適用できない(同じ CREATE を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    expect(() => db.exec(read(FILE))).toThrow(/already exists/i);
    db.close();
  });

  it("追加のみ: CREATE TABLE が 1 文だけで、破壊的な文(DROP・DELETE・UPDATE・ALTER・INSERT)を含まない。副索引(CREATE INDEX)も無い。WITHOUT ROWID", () => {
    const code = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER|INSERT|CREATE INDEX)\b/i);
    expect(code).toMatch(/WITHOUT ROWID/);
  });
});
