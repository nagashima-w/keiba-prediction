import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Issue #269: migration 0016(`race_results.wakuban`。結果ページの各馬の枠番。枠連の買い目の返還の判定が読む)を、
 * **既に結果の行がある D1**(0001〜0015 の適用済み。本番の状態)に適用しても、既存の行が壊れず、新しい列が NULL
 * (=枠番の記録なし〈旧い行〉)で読めることの確認(追加のみの migration の、本番への適用の想定。migration-0013.test.ts と同じ作法)。
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0016_result_wakuban.sql";
/** 0016 より前の migration(番号順)。0016 が増えても、この一覧は 0016 より前だけに保つ。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0016")
  .sort();

describe("migration 0016: 行のある DB への適用", () => {
  it("前提: 0016 より前は 0001〜0015 の15本", () => {
    expect(BEFORE).toHaveLength(15);
    expect(BEFORE[0]).toBe("0001_init.sql");
    expect(BEFORE[14]).toBe("0015_monthly_reports.sql");
  });

  it("適用前は列が無く、適用後は既存の行が残り wakuban は NULL(記録なし)。以後は枠番を書ける。scratched など他の列は変わらない", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, scratched) VALUES ('202603020211', 1, 1, 150, 0), ('202603020211', 2, NULL, NULL, 1)").run();
    // 前提: 適用前は列が無い(適用後の NULL が「列が元からあった」ことの偽の証拠にならない)。
    expect((db.prepare("PRAGMA table_info(race_results)").all() as { name: string }[]).map((c) => c.name)).not.toContain("wakuban");

    db.exec(read(FILE));

    expect(db.prepare("SELECT umaban, finish_position, place_payout, scratched, wakuban FROM race_results ORDER BY umaban").all()).toEqual([
      { umaban: 1, finish_position: 1, place_payout: 150, scratched: 0, wakuban: null },
      { umaban: 2, finish_position: null, place_payout: null, scratched: 1, wakuban: null },
    ]);
    db.prepare("UPDATE race_results SET wakuban = 3 WHERE umaban = 2").run();
    expect(db.prepare("SELECT umaban, wakuban FROM race_results ORDER BY umaban").all()).toEqual([
      { umaban: 1, wakuban: null },
      { umaban: 2, wakuban: 3 },
    ]);
    db.close();
  });

  it("列は INTEGER・NULL 可・既定値なし(旧い行に枠番を作らない。NULL は『記録なし』)で、race_results の末尾に足される", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    const columns = db.prepare("PRAGMA table_info(race_results)").all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
    const column = columns.find((c) => c.name === "wakuban");
    expect(column).toMatchObject({ name: "wakuban", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
    expect(columns[columns.length - 1]!.name).toBe("wakuban");
    db.close();
  });

  it("0016 は1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    expect(() => db.exec(read(FILE))).toThrow(/duplicate column/i);
    db.close();
  });

  it("migration は追加の1文だけで、索引も UPDATE も含まない(書き込み行を増やさない・旧い行を埋め直さない)", () => {
    const sql = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql.trim()).toBe("ALTER TABLE race_results ADD COLUMN wakuban INTEGER;");
  });
});
