import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0018(Issue #317): analyses.mark_repair_json の追加。追加のみ・既存の行は NULL のまま・1回しか適用できない。
 * 旧い Worker(この列を知らない)の INSERT は、列を指定しないので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const BEFORE = ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql", "0008_migration_import.sql", "0009_start_time.sql"];

describe("migration 0018: 行のある DB への適用", () => {
  it("適用前の行は残り、mark_repair_json は NULL。以後は JSON 文字列を書ける。ほかの列は変わらない", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, model, detail_key, llm_note, llm_calls_json) VALUES ('202603020211', '2026-10-06T00:00:00.000Z', 'm', 'analyses/1.json.gz', '旧い理由', '[]')").run();
    expect((db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map((c) => c.name)).not.toContain("mark_repair_json"); // 前提: 適用前は列が無い

    db.exec(read("0018_mark_repair.sql"));

    expect(db.prepare("SELECT race_id, model, detail_key, llm_note, llm_calls_json, mark_repair_json FROM analyses WHERE id = 1").get()).toEqual({
      race_id: "202603020211",
      model: "m",
      detail_key: "analyses/1.json.gz",
      llm_note: "旧い理由",
      llm_calls_json: "[]",
      mark_repair_json: null,
    });
    db.prepare("UPDATE analyses SET mark_repair_json = ? WHERE id = 1").run('{"v":1}');
    expect(db.prepare("SELECT mark_repair_json FROM analyses WHERE id = 1").get()).toEqual({ mark_repair_json: '{"v":1}' });
    db.close();
  });

  it("共存: 旧い Worker の INSERT(この列を指さない)は、適用後の DB でも通り、列は NULL", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, "0018_mark_repair.sql"]) db.exec(read(file));
    db.prepare("INSERT INTO analyses (race_id, analyzed_at) VALUES ('202603020211', '2026-10-06T00:00:00.000Z')").run();
    expect(db.prepare("SELECT mark_repair_json FROM analyses WHERE id = 1").get()).toEqual({ mark_repair_json: null });
    db.close();
  });

  it("1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, "0018_mark_repair.sql"]) db.exec(read(file));
    expect(() => db.exec(read("0018_mark_repair.sql"))).toThrow(/duplicate column/i);
    db.close();
  });

  it("追加のみ: 破壊的な文(DROP・DELETE・UPDATE 等)を含まない", () => {
    const code = read("0018_mark_repair.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    expect(code.match(/ALTER TABLE/gi)).toHaveLength(1);
  });
});
