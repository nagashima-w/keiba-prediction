import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Issue #194(b2): migration 0005(`analyses.llm_note`)を、**既に分析の行がある D1**(0001〜0004 の適用済み。本番の状態)に適用しても、既存の行・子の行が壊れず、
 * 新しい列が NULL で読めることの確認(追加のみの migration の、本番への適用の想定)。本物の SQLite の意味論(`node:sqlite`)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");

describe("migration 0005: 行のある DB への適用", () => {
  it("0001〜0004 のあとに分析の行(馬の子つき)を入れ、0005 を適用すると、行は残り、llm_note は NULL。以後は理由を書ける", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const file of ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql"]) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, model, detail_key) VALUES ('202603020211', '2026-10-06T00:00:00.000Z', NULL, 'analyses/1.json.gz')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive) VALUES (1, 1, 0.3, 0.3, 0)").run();
    expect(db.prepare("SELECT count(*) AS c FROM analyses").get()).toEqual({ c: 1 });

    db.exec(read("0005_llm_note.sql"));

    expect(db.prepare("SELECT race_id, detail_key, llm_note FROM analyses WHERE id = 1").get()).toEqual({ race_id: "202603020211", detail_key: "analyses/1.json.gz", llm_note: null });
    expect(db.prepare("SELECT count(*) AS c FROM analysis_horses WHERE analysis_id = 1").get()).toEqual({ c: 1 });
    db.prepare("UPDATE analyses SET llm_note = ? WHERE id = (SELECT max(id) FROM analyses)").run("理由");
    expect(db.prepare("SELECT llm_note FROM analyses WHERE id = 1").get()).toEqual({ llm_note: "理由" });
    db.close();
  });

  it("0005 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql"]) {
      db.exec(read(file));
    }
    expect(() => db.exec(read("0005_llm_note.sql"))).toThrow(/duplicate column/i);
    db.close();
  });
});
