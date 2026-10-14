import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: migration 0017(馬場の API の取得の試み `baba_fetches` と、競馬場ごとの当日の値 `baba_conditions`)を、
 * **既に行のある D1**(0001〜0016 の適用済み。本番の状態)に適用しても、既存の表・行が壊れないことの確認(追加のみの migration。migration-0016.test.ts と同じ作法)。
 */
installFetchTrap();

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf-8");
const FILE = "0017_baba.sql";
/** 0017 より前の migration(番号順)。0017 が増えても、この一覧は 0017 より前だけに保つ。 */
const BEFORE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f < "0017")
  .sort();

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
}

describe("migration 0017: 行のある DB への適用", () => {
  it("前提: 0017 より前は 0001〜0016 の16本", () => {
    expect(BEFORE).toHaveLength(16);
    expect(BEFORE[0]).toBe("0001_init.sql");
    expect(BEFORE[15]).toBe("0016_result_wakuban.sql");
  });

  it("適用前は 2 表が無く、適用後は既存の行が変わらず、2 表が空で作られる", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of BEFORE) {
      db.exec(read(file));
    }
    db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, scratched) VALUES ('202603020211', 1, 1, 150, 0)").run();
    const tablesOf = (): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tablesOf()).not.toContain("baba_fetches");
    expect(tablesOf()).not.toContain("baba_conditions");
    const before = db.prepare("SELECT * FROM race_results").all();
    expect(before).toHaveLength(1);

    db.exec(read(FILE));

    expect(tablesOf()).toEqual(expect.arrayContaining(["baba_fetches", "baba_conditions"]));
    expect(db.prepare("SELECT * FROM race_results").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM baba_fetches").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM baba_conditions").get()).toEqual({ n: 0 });
    db.close();
  });

  it("baba_fetches: 開催日が主キー(1 日 1 行)。試みの時刻だけが NOT NULL で、結果の列は NULL 可(NULL = 完了を記録できなかった)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    const columns = db.prepare("PRAGMA table_info(baba_fetches)").all() as unknown as Column[];
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["kaisai_date", "TEXT", 1, 1],
      ["attempted_at", "INTEGER", 1, 0],
      ["finished_at", "INTEGER", 0, 0],
      ["result", "TEXT", 0, 0],
      ["api_fetched_at", "TEXT", 0, 0],
      ["venues_saved", "INTEGER", 0, 0],
      ["venues_dropped", "INTEGER", 0, 0],
    ]);
    db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES ('20261012', 1)").run();
    expect(() => db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at) VALUES ('20261012', 2)").run()).toThrow(/UNIQUE|PRIMARY/i);
    db.close();
  });

  it("baba_conditions: (開催日, 場コード)が主キー(1 競馬場 1 行)。値の列は NULL 可、識別・計測日時・保存時刻は NOT NULL", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of [...BEFORE, FILE]) {
      db.exec(read(file));
    }
    const columns = db.prepare("PRAGMA table_info(baba_conditions)").all() as unknown as Column[];
    const notNull = columns.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(notNull).toEqual(["kaisai_date", "venue_code", "venue_name", "measured_at", "saved_at"]);
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["kaisai_date", "venue_code"]);
    expect(columns.map((c) => c.name)).toEqual([
      "kaisai_date",
      "venue_code",
      "venue_name",
      "measured_at",
      "cushion",
      "turf_condition",
      "turf_goal_condition",
      "turf_corner4_condition",
      "turf_goal_moisture",
      "turf_corner4_moisture",
      "dirt_condition",
      "dirt_goal_condition",
      "dirt_corner4_condition",
      "dirt_goal_moisture",
      "dirt_corner4_moisture",
      "rainfall_mm",
      "used_course",
      "turf_length",
      "turf_state_text",
      "raw_json",
      "saved_at",
    ]);
    db.close();
  });

  it("migration は CREATE TABLE の 2 文だけ(既存の表を ALTER・DROP・UPDATE・DELETE しない)", () => {
    const sql = read(FILE).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const statements = sql.split(";").map((s) => s.trim()).filter((s) => s !== "");
    expect(statements).toHaveLength(2);
    expect(statements.every((s) => /^CREATE TABLE baba_(fetches|conditions) \(/.test(s))).toBe(true);
    expect(sql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE)\b/i);
  });

  it("migration の本文に URL・ホスト名を書かない", () => {
    expect(read(FILE)).not.toMatch(/https?:\/\//i);
  });
});
