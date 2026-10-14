import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Issue #219: migration 0009(`analyses.start_time`)を、**既に分析の行がある D1**(0001〜0008 の適用済み。本番の状態)に適用しても、
 * 既存の行・子の行が壊れず、新しい列が NULL(=発走時刻は未確認)で読めることの確認(追加のみの migration の、本番への適用の想定)。
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const BEFORE = ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql", "0008_migration_import.sql"];

describe("migration 0009: 行のある DB への適用", () => {
  it("適用前は列が無く、適用後は既存の行が残り start_time は NULL(未確認)。以後は '' と 'HH:MM' を書ける", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const file of BEFORE) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, detail_key) VALUES ('202603020211', '2026-10-06T00:00:00.000Z', 'analyses/1.json.gz')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive) VALUES (1, 1, 0.3, 0.3, 0)").run();
    // 前提: 適用前は列が無い(適用後の NULL が「列が元からあった」ことの偽の証拠にならない)。
    expect((db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map((c) => c.name)).not.toContain("start_time");

    db.exec(read("0009_start_time.sql"));

    expect(db.prepare("SELECT race_id, detail_key, start_time FROM analyses WHERE id = 1").get()).toEqual({ race_id: "202603020211", detail_key: "analyses/1.json.gz", start_time: null });
    expect(db.prepare("SELECT count(*) AS n FROM analysis_horses WHERE analysis_id = 1").get()).toEqual({ n: 1 });
    db.prepare("UPDATE analyses SET start_time = ? WHERE id = 1").run("15:45");
    expect(db.prepare("SELECT start_time FROM analyses WHERE id = 1").get()).toEqual({ start_time: "15:45" });
    db.prepare("UPDATE analyses SET start_time = '' WHERE id = 1").run();
    expect(db.prepare("SELECT start_time FROM analyses WHERE id = 1").get()).toEqual({ start_time: "" });
    db.close();
  });

  it("0009 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, "0009_start_time.sql"]) {
      db.exec(read(file));
    }
    expect(() => db.exec(read("0009_start_time.sql"))).toThrow(/duplicate column/i);
    db.close();
  });

  it("migration は追加の1文だけで、新しい索引は足さない(書き込み行を増やさない・UPDATE を含まない)", () => {
    const sql = read("0009_start_time.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql.trim()).toBe("ALTER TABLE analyses ADD COLUMN start_time TEXT;");
  });
});
