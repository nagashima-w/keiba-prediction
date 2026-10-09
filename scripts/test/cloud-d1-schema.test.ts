import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../packages/core/src/ev/analysis-store.js";
import { FROZEN_INIT_MIGRATION_SHA256, sha256OfLf } from "../gen-cloud-d1-migration.js";

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
  // 0002 の detail_key(R2 のキー)と、0005 の llm_note(Issue #194。LLM が使われなかった・一部しか使われなかった理由の固定文言)と、
  // 0007 の llm_calls_json(Issue #197 段2。LLM を呼んだ1回ごとの記録。JSON 配列の文字列)。
  // ★0006 の analysis_horses.highlights_json・concerns_json は、exe にもある列なので、ここには書かない。
  analyses: [
    { name: "detail_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "llm_note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "llm_calls_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    // 0008 の exe_analysis_id(Issue #216。exe の keiba.db での分析 id。クラウド移行の冪等性の鍵。web で分析したものは NULL)。
    { name: "exe_analysis_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    // 0009 の start_time(Issue #219。発走時刻の写し。NULL=未確認・''=スナップショットに無い・'HH:MM'=値。検証画面の先読み判定が使う。検証の DO が R2 の詳細から遅延で埋める)。
    { name: "start_time", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ],
};
const D1_EXTRA_INDEXES: Readonly<Record<string, readonly IndexInfo[]>> = {
  analyses: [
    { origin: "c", unique: 0, columns: ["kaisai_date"], name: "idx_analyses_kaisai_date" },
    { origin: "c", unique: 0, columns: ["prompt_version", "race_id"], name: "idx_analyses_prompt_version_race" },
    // 0008(Issue #216): 一覧を分析日時の順にするための索引3つと、exe の分析 id の一意の索引(部分索引。NULL の行は索引に入れない)。
    { origin: "c", unique: 1, columns: ["exe_analysis_id"], name: "idx_analyses_exe_id" },
    { origin: "c", unique: 0, columns: ["analyzed_at"], name: "idx_analyses_analyzed_at" },
    { origin: "c", unique: 0, columns: ["race_id", "analyzed_at"], name: "idx_analyses_race_analyzed" },
    { origin: "c", unique: 0, columns: ["kaisai_date", "analyzed_at"], name: "idx_analyses_kaisai_analyzed" },
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
  // 0004 の中身(Issue #178)。設定の1行(id = 1 に固定)。`id INTEGER PRIMARY KEY` は rowid の別名なので、索引は作られない。
  cloud_settings: {
    columns: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "settings_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
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
  it("0001_init.sql・0002_d1.sql・0003_r2_ops.sql・0004_settings.sql・0005_llm_note.sql・0006_horse_items.sql・0007_llm_calls.sql・0008_migration_import.sql の8本だけで、番号は 0001 から連続している(後から足すときは 0009 以降)", () => {
    expect(FILES).toEqual(["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql", "0008_migration_import.sql"]);
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

describe("0001_init.sql は凍結されている(Issue #197。適用済みのファイルを書き換えない)", () => {
  // 以前は「0001 = exe の sqlite_master のダンプ(生成物)」を固定していた。exe の analysis_horses に列を足す(#197。
  // highlights_json・concerns_json)と、生成物の 0001 にも同じ列が入り、後から足す 0006 の ALTER と重複して
  // `duplicate column name` になる。また適用済みの 0001 を書き換えても本番の D1 には効かない。
  // そこで 0001 は凍結し、exe のスキーマが変わったら新しい migration(0006 以降)を足す。
  // exe との構造の一致は、下の AC-a1(0001〜最新を流した構造 = exe + 宣言した追加分)が守る。
  it("コミット済みの 0001 の内容が、凍結したハッシュと一致する(書き換えたら落ちる)", () => {
    expect(sha256OfLf(readMigration("0001_init.sql"))).toBe(FROZEN_INIT_MIGRATION_SHA256);
  });

  it("対照(検出が空振りでない): 1文字でも変えたら、ハッシュは変わる", () => {
    const original = readMigration("0001_init.sql");
    expect(createHash("sha256").update(original, "utf-8").digest("hex")).toBe(FROZEN_INIT_MIGRATION_SHA256);
    expect(sha256OfLf(`${original} `)).not.toBe(FROZEN_INIT_MIGRATION_SHA256);
    expect(sha256OfLf(original.replace("race_id TEXT NOT NULL", "race_id TEXT"))).not.toBe(FROZEN_INIT_MIGRATION_SHA256);
  });

  it("CRLF で取り出されても(改行の違いだけでは)ハッシュは変わらない(Windows のチェックアウト)", () => {
    const original = readMigration("0001_init.sql");
    expect(original).not.toContain("\r");
    expect(sha256OfLf(original.replace(/\n/g, "\r\n"))).toBe(FROZEN_INIT_MIGRATION_SHA256);
  });

  it("0001 は8表と明示した索引1つ(idx_analyses_race)で、sqlite_* の内部表と自動索引は含まない(D1 に作れない・作る必要がない)", () => {
    const sql = readMigration("0001_init.sql");
    expect(sql).not.toMatch(/sqlite_sequence|sqlite_autoindex/);
    expect((sql.match(/^CREATE TABLE /gm) ?? []).length).toBe(8);
    expect((sql.match(/^CREATE INDEX /gm) ?? []).length).toBe(1);
  });

  it("0001 の analysis_horses には highlights_json・concerns_json が無い(これらは 0006 が足す。凍結後に exe のスキーマが先へ進んだ証拠)", () => {
    const frozen = schemaAfter([readMigration("0001_init.sql")]);
    expect(frozen["analysis_horses"]!.columns.map((c) => c.name)).not.toContain("highlights_json");
    expect(exe["analysis_horses"]!.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["highlights_json", "concerns_json"]));
  });
});

describe("AC-a1: 0001〜0008 を流した構造が、exe の最終スキーマ + 宣言した追加分(列・索引・r2_ops 表)と一致する", () => {
  const sqls = FILES.map(readMigration);

  it("列の集合・型・NOT NULL・既定値・主キー・外部キー・索引が一致する(違いは detail_key・llm_note・llm_calls_json・exe_analysis_id・索引2つ+0008 の4つ・r2_ops 表・cloud_settings 表だけ)", () => {
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
    expect(indexNames).toHaveLength(7);
  });

  it("Issue #173: r2_ops 表が実際に入っている(ym が主キー・class_a と class_b は NOT NULL。宣言だけして 0003 に書き忘れても気づける)", () => {
    const actual = schemaAfter(sqls);
    expect(Object.keys(actual)).toContain("r2_ops");
    expect(Object.keys(exe)).not.toContain("r2_ops");
    expect(actual["r2_ops"]!.columns).toEqual(D1_EXTRA_TABLES["r2_ops"]!.columns);
  });

  it("Issue #178: cloud_settings 表が実際に入っている(id が主キー〈CHECK で 1 に固定〉・settings_json と updated_at は NOT NULL)", () => {
    const actual = schemaAfter(sqls);
    expect(Object.keys(actual)).toContain("cloud_settings");
    expect(Object.keys(exe)).not.toContain("cloud_settings");
    expect(actual["cloud_settings"]!.columns).toEqual(D1_EXTRA_TABLES["cloud_settings"]!.columns);
    expect(sqls[3]).toMatch(/CHECK \(id = 1\)/);
  });

  it("Issue #194: llm_note 列(TEXT・NULL 可)は 0005 だけが足す。0001〜0004 までには無い。追加のみ(ALTER TABLE ... ADD COLUMN だけの1文)", () => {
    const before = schemaAfter(sqls.slice(0, 4));
    expect(before["analyses"]!.columns.map((c) => c.name)).not.toContain("llm_note");
    const after = schemaAfter(sqls);
    expect(after["analyses"]!.columns.find((c) => c.name === "llm_note")).toEqual({ name: "llm_note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["analyses"]!.columns.find((c) => c.name === "llm_note")).toBeUndefined();
    const code = sqls[4]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE analyses ADD COLUMN llm_note TEXT;");
  });

  it("Issue #197: highlights_json・concerns_json 列(TEXT・NULL 可)は 0006 だけが足す。0001〜0005 までには無い。追加のみ(ALTER TABLE ... ADD COLUMN の2文だけ)。exe のスキーマと同じ列なので D1_EXTRA_COLUMNS には宣言しない", () => {
    const before = schemaAfter(sqls.slice(0, 5));
    expect(before["analysis_horses"]!.columns.map((c) => c.name)).not.toContain("highlights_json");
    expect(before["analysis_horses"]!.columns.map((c) => c.name)).not.toContain("concerns_json");
    const after = schemaAfter(sqls);
    for (const name of ["highlights_json", "concerns_json"]) {
      expect(after["analysis_horses"]!.columns.find((c) => c.name === name)).toEqual({ name, type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
      // exe にも同じ列がある(D1 だけの追加分ではない)。
      expect(exe["analysis_horses"]!.columns.find((c) => c.name === name)).toEqual({ name, type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    }
    expect(D1_EXTRA_COLUMNS["analysis_horses"]).toBeUndefined();
    const code = sqls[5]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE analysis_horses ADD COLUMN highlights_json TEXT;\nALTER TABLE analysis_horses ADD COLUMN concerns_json TEXT;");
  });

  it("Issue #197 段2: llm_calls_json 列(TEXT・NULL 可)は 0007 だけが足す。0001〜0006 までには無い。exe には無い D1 専用の列(D1_EXTRA_COLUMNS に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN だけの1文)", () => {
    const before = schemaAfter(sqls.slice(0, 6));
    expect(before["analyses"]!.columns.map((c) => c.name)).not.toContain("llm_calls_json");
    const after = schemaAfter(sqls);
    expect(after["analyses"]!.columns.find((c) => c.name === "llm_calls_json")).toEqual({ name: "llm_calls_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["analyses"]!.columns.find((c) => c.name === "llm_calls_json")).toBeUndefined();
    expect(D1_EXTRA_COLUMNS["analyses"]!.map((c) => c.name)).toContain("llm_calls_json");
    const code = sqls[6]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE analyses ADD COLUMN llm_calls_json TEXT;");
  });

  it("Issue #216: exe_analysis_id 列(INTEGER・NULL 可)と索引4つは 0008 だけが足す。0001〜0007 までには無い。exe には無い D1 専用(D1_EXTRA_COLUMNS・D1_EXTRA_INDEXES に宣言している)。追加のみ(ALTER 1文+CREATE INDEX 4文)。exe_analysis_id の索引は部分索引(NULL の行を入れない=web の分析の書き込み行を増やさない)", () => {
    const before = schemaAfter(sqls.slice(0, 7));
    expect(before["analyses"]!.columns.map((c) => c.name)).not.toContain("exe_analysis_id");
    const after = schemaAfter(sqls);
    expect(after["analyses"]!.columns.find((c) => c.name === "exe_analysis_id")).toEqual({ name: "exe_analysis_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["analyses"]!.columns.find((c) => c.name === "exe_analysis_id")).toBeUndefined();
    const code = sqls[7]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code.split(";").map((x) => x.trim()).filter((x) => x !== "")).toEqual([
      "ALTER TABLE analyses ADD COLUMN exe_analysis_id INTEGER",
      "CREATE UNIQUE INDEX idx_analyses_exe_id ON analyses (exe_analysis_id) WHERE exe_analysis_id IS NOT NULL",
      "CREATE INDEX idx_analyses_analyzed_at ON analyses (analyzed_at)",
      "CREATE INDEX idx_analyses_race_analyzed ON analyses (race_id, analyzed_at)",
      "CREATE INDEX idx_analyses_kaisai_analyzed ON analyses (kaisai_date, analyzed_at)",
    ]);
  });

  const m0008 = sqls[7] ?? "";
  const noImportIds: ReadonlyArray<readonly [string, string]> = [
    ["0008 を丸ごと落とす", ""],
    ["exe_analysis_id の一意索引を一意でなくする", m0008.replace("CREATE UNIQUE INDEX", "CREATE INDEX")],
    ["exe_analysis_id の列の型を変える", m0008.replace("exe_analysis_id INTEGER;", "exe_analysis_id TEXT;")],
    ["analyzed_at の索引を落とす", m0008.replace(/CREATE INDEX idx_analyses_analyzed_at[^;]*;/, "")],
    ["race の索引の列の順を逆にする", m0008.replace("(race_id, analyzed_at)", "(analyzed_at, race_id)")],
    ["宣言していない列を足す", `${m0008}\nALTER TABLE analyses ADD COLUMN undeclared_extra TEXT;\n`],
  ];
  it.each(noImportIds)("Issue #216 対照: 0008 を壊す(%s)と、差分として検出される(置換が実際に効いていることも確かめる)", (_name, mutated) => {
    expect(mutated).not.toBe(m0008);
    expect(diffSchemas(expectedD1Schema(exe), schemaAfter([...sqls.slice(0, 7), mutated])).length).toBeGreaterThan(0);
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
  const [init, d1, ops, settings, note, horseItems, llmCalls, importIds] = sqls as [string, string, string, string, string, string, string, string];
  const mutants: ReadonlyArray<readonly [string, string, string, string, string, string, string, string]> = [
    ["列の型を変える", init.replace("umaban INTEGER NOT NULL,\n        prior REAL NOT NULL", "umaban TEXT NOT NULL,\n        prior REAL NOT NULL"), d1, ops, settings, note, horseItems, llmCalls],
    ["NOT NULL を外す", init.replace("race_id TEXT NOT NULL,\n        analyzed_at TEXT NOT NULL", "race_id TEXT,\n        analyzed_at TEXT NOT NULL"), d1, ops, settings, note, horseItems, llmCalls],
    ["列を落とす", init.replace("        prompt_lookahead_guarded INTEGER\n", "        history_cutoff_date_dummy INTEGER\n"), d1, ops, settings, note, horseItems, llmCalls],
    ["外部キーを落とす", init.replace(/,\n\s+FOREIGN KEY \(analysis_id\) REFERENCES analyses \(id\)\n\s+\);\n\nCREATE TABLE analysis_horses/, "\n      );\n\nCREATE TABLE analysis_horses"), d1, ops, settings, note, horseItems, llmCalls],
    ["宣言していない列を 0002 に足す", init, `${d1}\nALTER TABLE analyses ADD COLUMN undeclared_extra TEXT;\n`, ops, settings, note, horseItems, llmCalls],
    ["宣言していない索引を 0002 に足す", init, `${d1}\nCREATE INDEX idx_undeclared ON analyses (model);\n`, ops, settings, note, horseItems, llmCalls],
    ["索引の列の順を逆にする", init, d1.replace("ON analyses (prompt_version, race_id);", "ON analyses (race_id, prompt_version);"), ops, settings, note, horseItems, llmCalls],
    ["detail_key を落とす", init, d1.replace(/ALTER TABLE analyses ADD COLUMN detail_key TEXT;?/, ""), ops, settings, note, horseItems, llmCalls],
    ["r2_ops の class_a の NOT NULL を外す(Issue #173)", init, d1, ops.replace("class_a INTEGER NOT NULL", "class_a INTEGER"), settings, note, horseItems, llmCalls],
    ["r2_ops の class_b の型を変える(Issue #173)", init, d1, ops.replace("class_b INTEGER NOT NULL", "class_b TEXT NOT NULL"), settings, note, horseItems, llmCalls],
    ["r2_ops の主キーを落とす(Issue #173)", init, d1, ops.replace("ym INTEGER PRIMARY KEY", "ym INTEGER"), settings, note, horseItems, llmCalls],
    ["r2_ops に宣言していない列を足す(Issue #173)", init, d1, ops.replace("class_b INTEGER NOT NULL", "class_b INTEGER NOT NULL, undeclared INTEGER"), settings, note, horseItems, llmCalls],
    ["0003 を丸ごと落とす(Issue #173)", init, d1, "", settings, note, horseItems, llmCalls],
    ["cloud_settings の settings_json の NOT NULL を外す(Issue #178)", init, d1, ops, settings.replace("settings_json TEXT NOT NULL", "settings_json TEXT"), note, horseItems, llmCalls],
    ["cloud_settings の id の主キーを落とす(Issue #178)", init, d1, ops, settings.replace("id INTEGER PRIMARY KEY CHECK (id = 1)", "id INTEGER"), note, horseItems, llmCalls],
    ["cloud_settings に宣言していない列を足す(Issue #178)", init, d1, ops, settings.replace("updated_at TEXT NOT NULL", "updated_at TEXT NOT NULL, undeclared TEXT"), note, horseItems, llmCalls],
    ["0004 を丸ごと落とす(Issue #178)", init, d1, ops, "", note, horseItems, llmCalls],
    ["0005 を丸ごと落とす(Issue #194)", init, d1, ops, settings, "", horseItems, llmCalls],
    ["llm_note の型を変える(Issue #194)", init, d1, ops, settings, note.replace("llm_note TEXT", "llm_note INTEGER"), horseItems, llmCalls],
    ["llm_note を NOT NULL にする(Issue #194。旧い行・理由なしの保存が入らなくなる)", init, d1, ops, settings, note.replace("llm_note TEXT", "llm_note TEXT NOT NULL DEFAULT ''"), horseItems, llmCalls],
    ["0005 に宣言していない列を足す(Issue #194)", init, d1, ops, settings, `${note}\nALTER TABLE analyses ADD COLUMN undeclared_extra TEXT;\n`, horseItems, llmCalls],
    ["0006 を丸ごと落とす(Issue #197)", init, d1, ops, settings, note, "", llmCalls],
    ["highlights_json の型を変える(Issue #197)", init, d1, ops, settings, note, horseItems.replace("highlights_json TEXT", "highlights_json INTEGER"), llmCalls],
    ["concerns_json を NOT NULL にする(Issue #197。項目なしの保存が入らなくなる)", init, d1, ops, settings, note, horseItems.replace("concerns_json TEXT", "concerns_json TEXT NOT NULL DEFAULT ''"), llmCalls],
    ["concerns_json を落とす(Issue #197)", init, d1, ops, settings, note, horseItems.replace(/ALTER TABLE analysis_horses ADD COLUMN concerns_json TEXT;?/, ""), llmCalls],
    ["0006 に宣言していない列を足す(Issue #197)", init, d1, ops, settings, note, `${horseItems}\nALTER TABLE analysis_horses ADD COLUMN undeclared_extra TEXT;\n`, llmCalls],
    ["0007 を丸ごと落とす(Issue #197 段2)", init, d1, ops, settings, note, horseItems, ""],
    ["llm_calls_json の型を変える(Issue #197 段2)", init, d1, ops, settings, note, horseItems, llmCalls.replace("llm_calls_json TEXT", "llm_calls_json INTEGER")],
    ["llm_calls_json を NOT NULL にする(Issue #197 段2。記録なし=キー未登録の保存が入らなくなる)", init, d1, ops, settings, note, horseItems, llmCalls.replace("llm_calls_json TEXT", "llm_calls_json TEXT NOT NULL DEFAULT ''")],
    ["0007 に宣言していない列を足す(Issue #197 段2)", init, d1, ops, settings, note, horseItems, `${llmCalls}\nALTER TABLE analyses ADD COLUMN undeclared_extra TEXT;\n`],
  ];
  it.each(mutants)("対照: %s と、差分として検出される(置換が実際に効いていることも確かめる)", (_name, mutatedInit, mutatedD1, mutatedOps, mutatedSettings, mutatedNote, mutatedHorseItems, mutatedLlmCalls) => {
    // 置換が空振りしていない(元のファイルから変わっている)
    expect(mutatedInit === init && mutatedD1 === d1 && mutatedOps === ops && mutatedSettings === settings && mutatedNote === note && mutatedHorseItems === horseItems && mutatedLlmCalls === llmCalls).toBe(false);
    expect(diffSchemas(expectedD1Schema(exe), schemaAfter([mutatedInit, mutatedD1, mutatedOps, mutatedSettings, mutatedNote, mutatedHorseItems, mutatedLlmCalls, importIds])).length).toBeGreaterThan(0);
  });
});

describe("migration の置き場所", () => {
  it("cloud/migrations がある(wrangler.toml の migrations_dir が指す先)", () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });
});
