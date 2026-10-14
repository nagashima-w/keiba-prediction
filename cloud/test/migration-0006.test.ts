import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Issue #197(#196-a): migration 0006(`analysis_horses.highlights_json`・`concerns_json`)を、**既に分析の行がある D1**(0001〜0005 の適用済み。本番の状態)に適用しても、
 * 既存の行・子の行が壊れず、新しい列が NULL で読めることの確認(追加のみの migration の、本番への適用の想定)。本物の SQLite の意味論(`node:sqlite`)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const BEFORE = ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql"];

describe("migration 0006: 行のある DB への適用", () => {
  it("0001〜0005 のあとに分析の行(馬の子つき)を入れ、0006 を適用すると、行は残り、2列は NULL。以後は JSON 配列の文字列を書ける", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const file of BEFORE) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, model, detail_key) VALUES ('202603020211', '2026-10-06T00:00:00.000Z', NULL, 'analyses/1.json.gz')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, reason) VALUES (1, 1, 0.3, 0.3, 0, '旧い根拠')").run();
    // 前提: 適用前は2列が無い(適用後の NULL が「列が元からあった」ことの偽の証拠にならない)。
    expect((db.prepare("PRAGMA table_info(analysis_horses)").all() as { name: string }[]).map((c) => c.name)).not.toContain("highlights_json");

    db.exec(read("0006_horse_items.sql"));

    expect(db.prepare("SELECT umaban, reason, highlights_json, concerns_json FROM analysis_horses WHERE analysis_id = 1").get()).toEqual({ umaban: 1, reason: "旧い根拠", highlights_json: null, concerns_json: null });
    expect(db.prepare("SELECT count(*) AS c FROM analyses").get()).toEqual({ c: 1 });
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, highlights_json, concerns_json) VALUES (1, 2, 0.3, 0.3, 0, ?, ?)").run('["強み"]', '["弱み1","弱み2"]');
    expect(db.prepare("SELECT highlights_json, concerns_json FROM analysis_horses WHERE umaban = 2").get()).toEqual({ highlights_json: '["強み"]', concerns_json: '["弱み1","弱み2"]' });
    db.close();
  });

  it("0006 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, "0006_horse_items.sql"]) {
      db.exec(read(file));
    }
    expect(() => db.exec(read("0006_horse_items.sql"))).toThrow(/duplicate column/i);
    db.close();
  });

  it("【凍結の理由】0001 を今の exe のスキーマで作り直した版(新しい列入り)に 0006 を流すと、重複して失敗する。0001 を書き換えてはならない", () => {
    // 凍結していない場合に起きること(0001 が exe の最終スキーマの生成物のままだった場合)の再現: 0001 の analysis_horses に列を足した版。
    const db = new DatabaseSync(":memory:");
    const regenerated = read("0001_init.sql").replace("reason TEXT,\n        PRIMARY KEY (analysis_id, umaban)", "reason TEXT,\n        highlights_json TEXT,\n        concerns_json TEXT,\n        PRIMARY KEY (analysis_id, umaban)");
    expect(regenerated).not.toBe(read("0001_init.sql")); // 置換が実際に効いている
    db.exec(regenerated);
    expect(() => db.exec(read("0006_horse_items.sql"))).toThrow(/duplicate column/i);
    db.close();
  });
});
