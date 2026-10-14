import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Issue #72: migration 0013(`race_results.scratched`)を、**既に結果の行がある D1**(0001〜0010 の適用済み。本番の状態)に適用しても、
 * 既存の行が壊れず、新しい列が NULL(=取消・除外の記録なし〈旧い行〉)で読めることの確認(追加のみの migration の、本番への適用の想定)。
 *
 * 番号が 0013 なのは、0011(#259)・0012(#226)がこのブランチより先に main に入る予定のため(この枝には無い)。
 * 適用の順序が違っても(0011・0012 が間に入っても)、この ALTER は他の migration の表に触れないので影響しない。
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const BEFORE = [
  "0001_init.sql",
  "0002_d1.sql",
  "0003_r2_ops.sql",
  "0004_settings.sql",
  "0005_llm_note.sql",
  "0006_horse_items.sql",
  "0007_llm_calls.sql",
  "0008_migration_import.sql",
  "0009_start_time.sql",
  "0010_daily_reports.sql",
];
const FILE = "0013_result_scratched.sql";

describe("migration 0013: 行のある DB への適用", () => {
  it("適用前は列が無く、適用後は既存の行が残り scratched は NULL(記録なし)。以後は 0 と 1 を書ける", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout) VALUES ('202603020211', 1, 1, 150), ('202603020211', 2, NULL, NULL)").run();
    // 前提: 適用前は列が無い(適用後の NULL が「列が元からあった」ことの偽の証拠にならない)。
    expect((db.prepare("PRAGMA table_info(race_results)").all() as { name: string }[]).map((c) => c.name)).not.toContain("scratched");

    db.exec(read(FILE));

    expect(db.prepare("SELECT umaban, finish_position, place_payout, scratched FROM race_results ORDER BY umaban").all()).toEqual([
      { umaban: 1, finish_position: 1, place_payout: 150, scratched: null },
      { umaban: 2, finish_position: null, place_payout: null, scratched: null },
    ]);
    db.prepare("UPDATE race_results SET scratched = 1 WHERE umaban = 2").run();
    db.prepare("UPDATE race_results SET scratched = 0 WHERE umaban = 1").run();
    expect(db.prepare("SELECT umaban, scratched FROM race_results ORDER BY umaban").all()).toEqual([
      { umaban: 1, scratched: 0 },
      { umaban: 2, scratched: 1 },
    ]);
    db.close();
  });

  it("列は INTEGER・NULL 可・既定値なし(旧い行を 0 にしない。0 は『記録済みで取消・除外ではない』、NULL は『記録なし』)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    const column = (db.prepare("PRAGMA table_info(race_results)").all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]).find((c) => c.name === "scratched");
    expect(column).toEqual({ cid: 7, name: "scratched", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
    db.close();
  });

  it("0013 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    expect(() => db.exec(read(FILE))).toThrow(/duplicate column/i);
    db.close();
  });

  it("migration は追加の1文だけで、索引も UPDATE も含まない(書き込み行を増やさない・旧い行を埋め直さない)", () => {
    const sql = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql.trim()).toBe("ALTER TABLE race_results ADD COLUMN scratched INTEGER;");
  });
});
