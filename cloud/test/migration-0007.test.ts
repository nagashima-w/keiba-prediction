import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { D1_HEALTH_SQL } from "../src/d1-health";

/**
 * Issue #197(段2): migration 0007(`analyses.llm_calls_json`)を、**既に分析の行がある D1**(0001〜0006 の適用済み。本番の状態)に適用しても、既存の行・子の行が壊れず、
 * 新しい列が NULL で読めることの確認(追加のみの migration の、本番への適用の想定)。あわせて、`/api/health` の D1 の検査の文(`D1_HEALTH_SQL`)が、
 * **0006・0007 を含む必要な migration がひとつでも欠けた D1 では失敗し、すべてあれば成功する**ことを、本物の SQLite の意味論(`node:sqlite`)で確かめる。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const ALL = ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql"];

describe("migration 0007: 行のある DB への適用", () => {
  it("0001〜0006 のあとに分析の行(馬の子つき・理由つき)を入れ、0007 を適用すると、行は残り、llm_calls_json は NULL。以後は JSON 文字列を書ける", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const file of ALL.slice(0, 6)) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, model, detail_key, llm_note) VALUES ('202603020211', '2026-10-06T00:00:00.000Z', NULL, 'analyses/1.json.gz', '旧い理由')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, highlights_json) VALUES (1, 1, 0.3, 0.3, 0, '[\"強み\"]')").run();
    // 前提: 適用前は列が無い(適用後の NULL が「列が元からあった」ことの偽の証拠にならない)。
    expect((db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map((c) => c.name)).not.toContain("llm_calls_json");

    db.exec(read("0007_llm_calls.sql"));

    expect(db.prepare("SELECT race_id, detail_key, llm_note, llm_calls_json FROM analyses WHERE id = 1").get()).toEqual({ race_id: "202603020211", detail_key: "analyses/1.json.gz", llm_note: "旧い理由", llm_calls_json: null });
    expect(db.prepare("SELECT highlights_json FROM analysis_horses WHERE analysis_id = 1").get()).toEqual({ highlights_json: '["強み"]' });
    db.prepare("UPDATE analyses SET llm_calls_json = ? WHERE id = (SELECT max(id) FROM analyses)").run('[{"ok":true}]');
    expect(db.prepare("SELECT llm_calls_json FROM analyses WHERE id = 1").get()).toEqual({ llm_calls_json: '[{"ok":true}]' });
    db.close();
  });

  it("0007 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of ALL) {
      db.exec(read(file));
    }
    expect(() => db.exec(read("0007_llm_calls.sql"))).toThrow(/duplicate column/i);
    db.close();
  });
});

describe("D1_HEALTH_SQL(/api/health の D1 の検査): 必要な列が1つでも欠ければ失敗し、すべてあれば成功する", () => {
  function dbWith(files: readonly string[]): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    for (const file of files) {
      db.exec(read(file));
    }
    return db;
  }

  it("全 migration(0001〜0007)を適用した空の D1(行が1つも無い)で成功する(行が無くても、列の有無は文の準備で検査される)", () => {
    const db = dbWith(ALL);
    expect(() => db.prepare(D1_HEALTH_SQL).get()).not.toThrow();
    db.close();
  });

  it("行があっても成功する(NULL を返すだけ。読み取り専用)", () => {
    const db = dbWith(ALL);
    db.prepare("INSERT INTO analyses (race_id, analyzed_at) VALUES ('202603020211', '2026-10-06T00:00:00.000Z')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive) VALUES (1, 1, 0.3, 0.3, 0)").run();
    expect(() => db.prepare(D1_HEALTH_SQL).get()).not.toThrow();
    db.close();
  });

  // 欠けた migration ごとに、どの列が見つからないかまで確かめる(別の理由で落ちていないことの確認)。
  const missing: ReadonlyArray<readonly [string, readonly string[], RegExp]> = [
    ["0002(detail_key)", ALL.filter((f) => !f.startsWith("0002")), /detail_key/],
    ["0005(llm_note)", ALL.filter((f) => !f.startsWith("0005")), /llm_note/],
    ["0006(highlights_json・concerns_json)", ALL.filter((f) => !f.startsWith("0006")), /highlights_json|concerns_json/],
    ["0007(llm_calls_json)", ALL.filter((f) => !f.startsWith("0007")), /llm_calls_json/],
  ];
  it.each(missing)("%s が未適用の D1 では失敗する(migration の反映漏れを、/api/health が d1.ok=false にできる)", (_name, files, column) => {
    const db = dbWith(files);
    expect(() => db.prepare(D1_HEALTH_SQL).get()).toThrow(column);
    db.close();
  });

  it("検査の文は読み取りだけ(SELECT)で、書き込みの語を含まない", () => {
    expect(D1_HEALTH_SQL).toMatch(/^SELECT /);
    expect(D1_HEALTH_SQL).not.toMatch(/INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER/i);
  });
});
