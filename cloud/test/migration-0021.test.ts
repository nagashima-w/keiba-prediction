import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migration 0021(Issue #360): baba_fetches.dropped_json の追加。追加のみ・既存の行は NULL のまま・1回しか適用できない。
 * 旧い Worker(この列を知らない)の INSERT/UPDATE は、列を指定しないので壊れない(共存)。
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0021_baba_diagnostics.sql";
/** 0021 より前の migration(番号順)。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0021")
  .sort();

describe("migration 0021: 行のある DB への適用", () => {
  it("前提: 0021 より前は 0001〜0020 の20本", () => {
    expect(BEFORE).toHaveLength(20);
    expect(BEFORE[19]).toBe("0020_trainer_results.sql");
  });

  it("適用前の行は残り、dropped_json は NULL。以後は JSON 文字列を書ける。ほかの列は変わらない", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) db.exec(read(file));
    db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped) VALUES ('20261017', 1, 2, 'no-today-venues', '2026-10-16T23:00:00.000Z', 0, 3)").run();
    expect((db.prepare("PRAGMA table_info(baba_fetches)").all() as { name: string }[]).map((c) => c.name)).not.toContain("dropped_json"); // 前提: 適用前は列が無い

    db.exec(read(FILE));

    expect(db.prepare("SELECT * FROM baba_fetches").all()).toEqual([
      { kaisai_date: "20261017", attempted_at: 1, finished_at: 2, result: "no-today-venues", api_fetched_at: "2026-10-16T23:00:00.000Z", venues_saved: 0, venues_dropped: 3, dropped_json: null },
    ]);
    db.prepare("UPDATE baba_fetches SET dropped_json = ? WHERE kaisai_date = '20261017'").run("[]");
    expect(db.prepare("SELECT dropped_json FROM baba_fetches").get()).toEqual({ dropped_json: "[]" });
    db.close();
  });

  it("列は TEXT で NULL 可(旧い Worker の claim の INSERT は列を指さないので通る)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    const column = (db.prepare("PRAGMA table_info(baba_fetches)").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[]).find((c) => c.name === "dropped_json");
    expect(column).toEqual({ cid: expect.any(Number), name: "dropped_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES ('20261018', 5)").run();
    expect(db.prepare("SELECT dropped_json FROM baba_fetches").get()).toEqual({ dropped_json: null });
    db.close();
  });

  it("1回しか適用できない(同じ ALTER を2回流すと失敗する。wrangler は d1_migrations で適用済みを飛ばす)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) db.exec(read(file));
    expect(() => db.exec(read(FILE))).toThrow(/duplicate column/i);
    db.close();
  });

  it("追加のみ: 破壊的な文(DROP・DELETE・UPDATE 等)を含まず、ALTER は 1 文だけ", () => {
    const code = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    expect(code.match(/ALTER TABLE/gi)).toHaveLength(1);
    expect(code).toMatch(/ALTER TABLE baba_fetches ADD COLUMN dropped_json TEXT;/);
  });
});
