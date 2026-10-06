import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../packages/core/src/ev/analysis-store.js";
import { buildInitMigrationSql } from "../gen-cloud-d1-migration.js";

/**
 * Issue #171(#169-a)AC-a1: クラウド版の D1 の表(cloud/migrations/*.sql)が、exe の SQLite(`new AnalysisStore()` の最終スキーマ)と
 * 同じ形であることの固定。違いは「宣言した D1 専用の追加分」だけでなければならない。
 *
 * 置き場所: ルートの `pnpm test`(scripts/test/)。ここなら exe の AnalysisStore(better-sqlite3)と cloud の migration の両方が読める。
 * cloud/ のテストは better-sqlite3 を持たない。exe 側のスキーマが変わったとき(列の追加など)に赤くなるのも、ルートの CI である。
 *
 * 比較の方法: migration を空の SQLite(better-sqlite3 の :memory:)に順に流し、`PRAGMA table_info` / `foreign_key_list` /
 * `index_list` / `index_info` で作った構造を、exe 側の同じ構造と比べる(列の集合・型・NOT NULL・既定値・主キー・外部キー・索引)。
 * D1 の実エンジン(workerd)での適用は cloud/test/d1-schema.test.ts が、wrangler の実コマンドで確かめる。
 *
 * 限界: 比較できるのは構造(列・制約・索引)だけで、値の往復(NULL・浮動小数)は #172(ストア)のテストが担う。
 */

/** better-sqlite3 の Database(ルートには better-sqlite3 が無いので、AnalysisStore が持つ型・クラスを借りる)。 */
type Db = AnalysisStore["rawDatabase"];

/** 空の(表が1つも無い)インメモリ DB。AnalysisStore の Database クラスを借りて作る。 */
function openEmptyDb(): Db {
  const probe = new AnalysisStore();
  try {
    const Ctor = probe.rawDatabase.constructor as new (filename: string) => Db;
    return new Ctor(":memory:");
  } finally {
    probe.close();
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = path.join(ROOT, "cloud", "migrations");

function readMigration(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8").replace(/\r\n/g, "\n");
}

/** migration のファイル名(昇順)。 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}
interface ForeignKeyInfo {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_update: string;
  readonly on_delete: string;
}
interface IndexInfo {
  /** 索引の由来: "c"(CREATE INDEX)・"pk"(主キーの自動索引)・"u"(UNIQUE の自動索引)。 */
  readonly origin: string;
  readonly unique: number;
  readonly columns: readonly string[];
  /** 明示した索引(origin "c")だけ名前を比べる(自動索引の名前は SQLite が付ける)。 */
  readonly name: string | null;
}
interface TableSchema {
  readonly columns: readonly ColumnInfo[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
  readonly indexes: readonly IndexInfo[];
}
type Schema = Readonly<Record<string, TableSchema>>;

/** DB の構造(表ごとの列・外部キー・索引)を、比較できる素の値にする。sqlite_* の内部表は除く。 */
function describeSchema(db: Db): Schema {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: Record<string, TableSchema> = {};
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[])
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyInfo[])
      .map((f) => ({ table: f.table, from: f.from, to: f.to, on_update: f.on_update, on_delete: f.on_delete }))
      .sort((a, b) => a.from.localeCompare(b.from));
    const indexes = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string }>)
      .map((i) => ({
        origin: i.origin,
        unique: i.unique,
        columns: (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ seqno: number; name: string }>)
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name),
        name: i.origin === "c" ? i.name : null,
      }))
      .sort((a, b) => `${a.origin}:${a.columns.join(",")}`.localeCompare(`${b.origin}:${b.columns.join(",")}`));
    out[table] = { columns, foreignKeys, indexes };
  }
  return out;
}

/** 空の DB に、与えた SQL を順に流して、その構造を返す。 */
function schemaAfter(sqls: readonly string[]): Schema {
  const db = openEmptyDb();
  try {
    for (const sql of sqls) {
      db.exec(sql);
    }
    return describeSchema(db);
  } finally {
    db.close();
  }
}

/** exe の最終スキーマ(`new AnalysisStore()` が作る構造)。 */
function exeSchema(): Schema {
  const store = new AnalysisStore();
  try {
    return describeSchema(store.rawDatabase);
  } finally {
    store.close();
  }
}

/**
 * D1 専用の、宣言した追加分(0002 の中身)。**ここに無い違いは、すべて不一致として検出される。**
 * 追加するとき(列・索引)は、この宣言と 0002 を同時に直す。
 */
const D1_EXTRA_COLUMNS: Readonly<Record<string, readonly ColumnInfo[]>> = {
  analyses: [{ name: "detail_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }],
};
const D1_EXTRA_INDEXES: Readonly<Record<string, readonly IndexInfo[]>> = {
  analyses: [
    { origin: "c", unique: 0, columns: ["kaisai_date"], name: "idx_analyses_kaisai_date" },
    { origin: "c", unique: 0, columns: ["prompt_version", "race_id"], name: "idx_analyses_prompt_version_race" },
  ],
};

/**
 * D1 専用の、宣言した追加の表(0003 の中身。Issue #173)。R2 の操作回数のカウンタ(月ごと)。exe の SQLite には無い。
 * `ym INTEGER PRIMARY KEY` は rowid の別名なので、索引(自動索引)は作られない。
 */
const D1_EXTRA_TABLES: Readonly<Record<string, TableSchema>> = {
  r2_ops: {
    columns: [
      { name: "class_a", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "class_b", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "ym", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    ],
    foreignKeys: [],
    indexes: [],
  },
};

/** exe のスキーマに、宣言した D1 専用の追加分(列・索引・表)を足した「期待する D1 の構造」。 */
function expectedD1Schema(exe: Schema): Schema {
  const out: Record<string, TableSchema> = { ...D1_EXTRA_TABLES };
  for (const [table, schema] of Object.entries(exe)) {
    const extraColumns = D1_EXTRA_COLUMNS[table] ?? [];
    const extraIndexes = D1_EXTRA_INDEXES[table] ?? [];
    out[table] = {
      columns: [...schema.columns, ...extraColumns].sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: schema.foreignKeys,
      indexes: [...schema.indexes, ...extraIndexes].sort((a, b) => `${a.origin}:${a.columns.join(",")}`.localeCompare(`${b.origin}:${b.columns.join(",")}`)),
    };
  }
  return out;
}

/** 2つの構造の違いを、人が読める行の一覧にする(空なら一致)。 */
function diffSchemas(expected: Schema, actual: Schema): string[] {
  const diffs: string[] = [];
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const table of [...names].sort()) {
    const e = expected[table];
    const a = actual[table];
    if (e === undefined || a === undefined) {
      diffs.push(`表 ${table}: ${e === undefined ? "期待に無い表が D1 にある" : "D1 に無い"}`);
      continue;
    }
    for (const key of ["columns", "foreignKeys", "indexes"] as const) {
      if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) {
        diffs.push(`表 ${table} の ${key}: 期待 ${JSON.stringify(e[key])} / 実際 ${JSON.stringify(a[key])}`);
      }
    }
  }
  return diffs;
}

const FILES = migrationFiles();
const exe = exeSchema();

describe("migration のファイル構成", () => {
  it("0001_init.sql・0002_d1.sql・0003_r2_ops.sql の3本だけで、番号は 0001 から連続している(後から足すときは 0004 以降)", () => {
    expect(FILES).toEqual(["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql"]);
  });

  it("前提: exe のスキーマは 8 表で、列・外部キー・索引を実際に読めている(空振りでない)", () => {
    expect(Object.keys(exe).sort()).toEqual([
      "analyses",
      "analysis_allocation_meta",
      "analysis_bets",
      "analysis_horses",
      "race_combo_payout_imports",
      "race_combo_payouts",
      "race_result_meta",
      "race_results",
    ]);
    expect(exe["analyses"]!.columns.length).toBe(12);
    expect(exe["analysis_horses"]!.foreignKeys).toHaveLength(1);
    expect(exe["analyses"]!.indexes.some((i) => i.name === "idx_analyses_race")).toBe(true);
  });
});

describe("0001_init.sql は exe の sqlite_master のダンプそのもの(手で写さない)", () => {
  it("コミット済みの 0001 は、生成スクリプトの出力と完全に一致する(生成スクリプト: scripts/gen-cloud-d1-migration.ts)", () => {
    expect(readMigration("0001_init.sql")).toBe(buildInitMigrationSql());
  });

  it("生成物に、sqlite_* の内部表と自動索引は含まれない(D1 に作れない・作る必要がない)", () => {
    const sql = buildInitMigrationSql();
    expect(sql).not.toMatch(/sqlite_sequence|sqlite_autoindex/);
    expect((sql.match(/^CREATE TABLE /gm) ?? []).length).toBe(8);
    expect((sql.match(/^CREATE INDEX /gm) ?? []).length).toBe(1);
  });
});

describe("AC-a1: 0001+0002+0003 を流した構造が、exe の最終スキーマ + 宣言した追加分(列・索引・r2_ops 表)と一致する", () => {
  const sqls = FILES.map(readMigration);

  it("列の集合・型・NOT NULL・既定値・主キー・外部キー・索引が一致する(違いは detail_key・索引2つ・r2_ops 表だけ)", () => {
    const actual = schemaAfter(sqls);
    expect(diffSchemas(expectedD1Schema(exe), actual)).toEqual([]);
  });

  it("宣言した追加分が、実際に D1 の構造に入っている(宣言だけして 0002 に書き忘れても気づける)", () => {
    const actual = schemaAfter(sqls);
    const detail = actual["analyses"]!.columns.find((c) => c.name === "detail_key");
    expect(detail).toEqual({ name: "detail_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["analyses"]!.columns.find((c) => c.name === "detail_key")).toBeUndefined();
    const indexNames = actual["analyses"]!.indexes.filter((i) => i.origin === "c").map((i) => i.name);
    expect(indexNames).toEqual(expect.arrayContaining(["idx_analyses_kaisai_date", "idx_analyses_prompt_version_race", "idx_analyses_race"]));
    expect(indexNames).toHaveLength(3);
  });

  it("Issue #173: r2_ops 表が実際に入っている(ym が主キー・class_a と class_b は NOT NULL。宣言だけして 0003 に書き忘れても気づける)", () => {
    const actual = schemaAfter(sqls);
    expect(Object.keys(actual)).toContain("r2_ops");
    expect(Object.keys(exe)).not.toContain("r2_ops");
    expect(actual["r2_ops"]!.columns).toEqual(D1_EXTRA_TABLES["r2_ops"]!.columns);
  });

  it("0002 の索引の列の順は (prompt_version, race_id)。逆順では dedup の文が索引を使えない", () => {
    const actual = schemaAfter(sqls);
    const pv = actual["analyses"]!.indexes.find((i) => i.name === "idx_analyses_prompt_version_race");
    expect(pv?.columns).toEqual(["prompt_version", "race_id"]);
  });

  /**
   * 対照(検出が空振りでないこと): 次の「壊れた migration」は、いずれも差分を検出する。
   * それぞれが、実際に起こりうる変異(0001 の写し間違い・0002 への無断の追加)に当たる。
   */
  const [init, d1, ops] = sqls as [string, string, string];
  const mutants: ReadonlyArray<readonly [string, string, string, string]> = [
    ["列の型を変える", init.replace("umaban INTEGER NOT NULL,\n        prior REAL NOT NULL", "umaban TEXT NOT NULL,\n        prior REAL NOT NULL"), d1, ops],
    ["NOT NULL を外す", init.replace("race_id TEXT NOT NULL,\n        analyzed_at TEXT NOT NULL", "race_id TEXT,\n        analyzed_at TEXT NOT NULL"), d1, ops],
    ["列を落とす", init.replace("        prompt_lookahead_guarded INTEGER\n", "        history_cutoff_date_dummy INTEGER\n"), d1, ops],
    ["外部キーを落とす", init.replace(/,\n\s+FOREIGN KEY \(analysis_id\) REFERENCES analyses \(id\)\n\s+\);\n\nCREATE TABLE analysis_horses/, "\n      );\n\nCREATE TABLE analysis_horses"), d1, ops],
    ["宣言していない列を 0002 に足す", init, `${d1}\nALTER TABLE analyses ADD COLUMN undeclared_extra TEXT;\n`, ops],
    ["宣言していない索引を 0002 に足す", init, `${d1}\nCREATE INDEX idx_undeclared ON analyses (model);\n`, ops],
    ["索引の列の順を逆にする", init, d1.replace("ON analyses (prompt_version, race_id);", "ON analyses (race_id, prompt_version);"), ops],
    ["detail_key を落とす", init, d1.replace(/ALTER TABLE analyses ADD COLUMN detail_key TEXT;?/, ""), ops],
    ["r2_ops の class_a の NOT NULL を外す(Issue #173)", init, d1, ops.replace("class_a INTEGER NOT NULL", "class_a INTEGER")],
    ["r2_ops の class_b の型を変える(Issue #173)", init, d1, ops.replace("class_b INTEGER NOT NULL", "class_b TEXT NOT NULL")],
    ["r2_ops の主キーを落とす(Issue #173)", init, d1, ops.replace("ym INTEGER PRIMARY KEY", "ym INTEGER")],
    ["r2_ops に宣言していない列を足す(Issue #173)", init, d1, ops.replace("class_b INTEGER NOT NULL", "class_b INTEGER NOT NULL, undeclared INTEGER")],
    ["0003 を丸ごと落とす(Issue #173)", init, d1, ""],
  ];
  it.each(mutants)("対照: %s と、差分として検出される(置換が実際に効いていることも確かめる)", (_name, mutatedInit, mutatedD1, mutatedOps) => {
    // 置換が空振りしていない(元のファイルから変わっている)
    expect(mutatedInit === init && mutatedD1 === d1 && mutatedOps === ops).toBe(false);
    expect(diffSchemas(expectedD1Schema(exe), schemaAfter([mutatedInit, mutatedD1, mutatedOps])).length).toBeGreaterThan(0);
  });
});

describe("migration の置き場所", () => {
  it("cloud/migrations がある(wrangler.toml の migrations_dir が指す先)", () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });
});
