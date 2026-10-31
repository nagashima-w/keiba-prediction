import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../packages/core/test/support/analysis-store.js";
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
    // 0018 の mark_repair_json(Issue #317。印の補修の記録。JSON の文字列。違反が一度も無かった分析は NULL)。
    { name: "mark_repair_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    // 0023 のレースの事実(Issue #389〈#385-B の a〉。分析時点のスナップショットの芝ダ・距離・馬場・グレード・レース名の写し。検証の DO が発走時刻と同じ get で遅延で埋める)と、確認の印 cond_read(NULL=未確認・1=読んだ・0=読めなかった)。
    { name: "course_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "distance", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "track_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "grade", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "race_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "cond_read", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    // 0024 のレースのクラス(Issue #426〈#389 の案 B〉。出馬表・結果ページの RaceData02 から読んだ値。中央は正準ラベル、地方は区分の生のトークン。NULL=未確認。検証の補完と結果の取り込みが NULL の列だけを埋める)。
    { name: "race_class", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ],
  // 0025 の的中確率の下限と、下限で外した買い目の記録(Issue #470)。min_hit_prob=使った下限〈NULL=記録なし〉、below_floor_count=外れた EV プラスの買い目の数〈NULL=配分未到達・旧い行〉、
  // missed_json=外さなかった場合に賭け金が付いた買い目の JSON〈NULL=記録していない・'[]'=外れたが賭け金が付くものは無かった〉。exe のメタ行の INSERT〈24列〉には含めない。
  analysis_allocation_meta: [
    { name: "min_hit_prob", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
    { name: "below_floor_count", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "missed_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    // 0029 の単勝・複勝の点数の上限(Issue #533)。max_win_bets=使った単勝の上限〈0=上限なし。NULL=記録なし=旧い行=上限なし〉、max_place_bets=使った複勝の上限〈同上〉。exe のメタ行の INSERT〈24列〉には含めない。
    { name: "max_win_bets", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "max_place_bets", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
  ],
  // 0011 の win_odds・ninki(Issue #259。結果ページの確定の単勝オッズ・人気。NULL=未取得。exe の codec・移行の形式〈MIGRATION_TABLES〉・共有 golden は読まない・書かない D1 専用の列。結果の補完の段階 2 と取り込みが NULL の列だけを埋める)。
  race_results: [
    { name: "win_odds", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
    { name: "ninki", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    // 0013 の scratched(Issue #72。取消・除外の記録。NULL=記録なし〈旧い行・exe から移行した行〉・0=取消・除外でない・1=取消・除外。検証画面の配分ベースの回収率が、取消・除外の馬への買い目を返還として数える)。
    { name: "scratched", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    // 0016 の wakuban(Issue #269。結果ページの各馬の枠番〈1〜8〉。NULL=記録なし〈旧い行・exe から移行した行〉。枠連の買い目の返還の判定が読む)。
    { name: "wakuban", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
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
  // 0010 の中身(Issue #235)。日報(1 日 1 行。開催日が主キー)。`kaisai_date TEXT PRIMARY KEY` は rowid の別名ではない(TEXT)ので、主キーの自動索引(origin `pk`・名前なし)ができる。
  daily_reports: {
    columns: [
      { name: "body_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "kaisai_date", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "llm_calls_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "race_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "summary", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "total_return", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "total_stake", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["kaisai_date"], name: null }],
  },
  // 0015 の中身(Issue #265・#279)。月報(1 か月 1 行。月 YYYYMM が主キー)。列は daily_reports と同じ(開催日 → 月)。
  monthly_reports: {
    columns: [
      { name: "body_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "llm_calls_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "month", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "race_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "summary", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "total_return", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "total_stake", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["month"], name: null }],
  },
  // 0012 の中身(Issue #226。0011 は #259 が使う)。騎手の年ごとの成績(1 騎手・1 区分で 1 行。年ごとの成績は years_json に `[[年, 騎乗数, 3着内], ...]`)。
  // 主キーは (jockey_id, kind) の複合(TEXT なので rowid の別名ではなく、自動索引〈origin `pk`・名前なし〉ができる)。kind の CHECK は table_info に出ない。
  jockey_results: {
    columns: [
      { name: "fetched_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "jockey_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "years_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["jockey_id", "kind"], name: null }],
  },
  // 0020 の中身(Issue #354)。調教師の年ごとの成績(騎手の 0012 と同じ形。1 調教師・1 区分で 1 行)。主キーは (trainer_id, kind) の複合。
  trainer_results: {
    columns: [
      { name: "fetched_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "trainer_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "years_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["trainer_id", "kind"], name: null }],
  },
  // 0014 の中身(Issue #256 段階A)。各馬の戦績(1 走 1 行。WITHOUT ROWID。主キーは (horse_id, race_key)。副索引なし)と、保存 1 回ごとの集計の記録(主キーは (saved_at, race_id))。
  horse_runs: {
    columns: [
      { name: "data", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "first_seen_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "horse_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "parser_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "race_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      // 0032 の出どころ(Issue #552〈#549-B1〉)。NULL=戦績 API(0014 の行はすべてこれ)、'result'=過去の結果ページから変換した行。
      { name: "source", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["horse_id", "race_key"], name: null }],
  },
  horse_run_saves: {
    columns: [
      { name: "race_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "saved_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { name: "stats_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["saved_at", "race_id"], name: null }],
  },
  // 0022 の中身(Issue #421 段階 1)。レースの条件(負担重量の種別・牝馬限定)の記録。レース 1 件につき 1 行(WITHOUT ROWID。主キーは race_id。副索引なし)。
  race_conditions: {
    columns: [
      { name: "fillies_only", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "race_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "saved_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "weight_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["race_id"], name: null }],
  },
  // 0017 の中身(Issue #294。0021〈Issue #360〉で dropped_json を追加)。馬場の API の取得の試み(開催日が主キー = 1 日 1 行。WITHOUT ROWID。副索引なし)と、競馬場ごとの当日の馬場の値(主キーは (kaisai_date, venue_code)。WITHOUT ROWID。副索引なし)。
  baba_fetches: {
    columns: [
      { name: "api_fetched_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "attempted_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      // 0021 の dropped_json(Issue #360。捨てた競馬場ごとの診断の JSON。NULL=旧版の記録)。
      { name: "dropped_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "finished_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "kaisai_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "result", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "venues_dropped", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "venues_saved", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["kaisai_date"], name: null }],
  },
  // 0026 の中身(Issue #480)。馬場の取得の枠ごとの試み(主キーは (kaisai_date, slot) = 1 枠 1 回の保証。WITHOUT ROWID。副索引なし)。baba_fetches は日の要約として残る。
  baba_fetch_attempts: {
    columns: [
      { name: "api_fetched_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "attempted_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "complete", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dropped_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "finished_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "kaisai_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "result", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "slot", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
      { name: "venues_dropped", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "venues_saved", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["kaisai_date", "slot"], name: null }],
  },
  // 0027 の中身(Issue #519)。開催日ごとの記録(主キーは (track_code, year, kai, nichi)。WITHOUT ROWID。副索引なし)。芝の開催進行の通算・柵の日数を数える材料。
  kaisai_days: {
    columns: [
      { name: "fence", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "kai", type: "INTEGER", notnull: 1, dflt_value: null, pk: 3 },
      { name: "kaisai_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "nichi", type: "INTEGER", notnull: 1, dflt_value: null, pk: 4 },
      { name: "track_code", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "year", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["track_code", "year", "kai", "nichi"], name: null }],
  },
  // 0028 の中身(Issue #526 段階 1b)。出馬表の騎手名と騎手 ID の組(主キーは (jockey_name, jockey_id)。WITHOUT ROWID。副索引なし)。統計モデル用の書き出しが、騎手 ID の無い行を名前から埋める材料。
  jockey_names: {
    columns: [
      { name: "first_seen", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "jockey_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "jockey_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["jockey_name", "jockey_id"], name: null }],
  },
  // 0030 の中身(Issue #540)。出馬表の調教師名と調教師 ID の組(主キーは (trainer_name, trainer_id)。WITHOUT ROWID。副索引なし)。統計モデル用の書き出しが、調教師 ID の無い行を名前から埋める材料。
  trainer_names: {
    columns: [
      { name: "first_seen", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "trainer_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "trainer_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["trainer_name", "trainer_id"], name: null }],
  },
  // 0031 の中身(Issue #551〈#549-A2〉)。過去の結果ページの目録(主キーは race_id。WITHOUT ROWID。副索引なし)。本体は R2 の `race-results/{race_id}.json.gz`。
  race_archive: {
    columns: [
      { name: "fetched_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "parser_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "r2_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "race_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "race_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "raw_bytes", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["race_id"], name: null }],
  },
  baba_conditions: {
    columns: [
      { name: "cushion", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dirt_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dirt_corner4_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dirt_corner4_moisture", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dirt_goal_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "dirt_goal_moisture", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "kaisai_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "measured_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "rainfall_mm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "raw_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "saved_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "turf_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_corner4_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_corner4_moisture", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_goal_condition", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_goal_moisture", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_length", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "turf_state_text", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "used_course", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "venue_code", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "venue_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [],
    indexes: [{ origin: "pk", unique: 1, columns: ["kaisai_date", "venue_code"], name: null }],
  },
  // 0019 の中身(Issue #338〈#335-A1〉)。締切の直前の再計算の結果。回(round)ごとに 1 行(主キーは (analysis_id, round))と、ok の回の買い目(主キーは (analysis_id, round, bet_type, combo_key))。
  // 外部キーは analysis_close.analysis_id → analyses.id と、analysis_close_bets の (analysis_id, round) → analysis_close。副索引なし。exe の SQLite には無い。
  analysis_close: {
    columns: [
      { name: "analysis_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { name: "bankroll", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "bet_unit", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "due_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "ev_threshold", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fallback_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fired_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "include_bracket_quinella", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_combo_odds", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_exacta", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_quinella", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_trifecta", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_trio", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "include_wide", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "kelly_fraction", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "late_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "odds_official_datetime", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "odds_status", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "per_race_cap", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "round", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
      { name: "route", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "skip_reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "unavailable_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [{ table: "analyses", from: "analysis_id", to: "id", on_update: "NO ACTION", on_delete: "NO ACTION" }],
    indexes: [{ origin: "pk", unique: 1, columns: ["analysis_id", "round"], name: null }],
  },
  analysis_close_bets: {
    columns: [
      { name: "analysis_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { name: "bet_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 3 },
      { name: "combo_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 4 },
      { name: "ev", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "odds", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "round", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
      { name: "stake", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ],
    foreignKeys: [
      { table: "analysis_close", from: "analysis_id", to: "analysis_id", on_update: "NO ACTION", on_delete: "NO ACTION" },
      { table: "analysis_close", from: "round", to: "round", on_update: "NO ACTION", on_delete: "NO ACTION" },
    ],
    indexes: [{ origin: "pk", unique: 1, columns: ["analysis_id", "round", "bet_type", "combo_key"], name: null }],
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
  it("0001_init.sql・0002_d1.sql・0003_r2_ops.sql・0004_settings.sql・0005_llm_note.sql・0006_horse_items.sql・0007_llm_calls.sql・0008_migration_import.sql・0009_start_time.sql・0010_daily_reports.sql・0011_win_odds.sql・0012_jockey_results.sql・0013_result_scratched.sql・0014_horse_runs.sql・0015_monthly_reports.sql・0016_result_wakuban.sql・0017_baba.sql・0018_mark_repair.sql・0019_close.sql・0020_trainer_results.sql・0021_baba_diagnostics.sql・0022_race_conditions.sql・0023_race_facts.sql・0024_race_class.sql・0025_min_hit_prob.sql・0026_baba_attempts.sql・0027_kaisai_days.sql・0028_jockey_names.sql・0029_max_bets.sql・0030_trainer_names.sql・0031_race_archive.sql・0032_horse_runs_source.sql の32本だけで、番号は 0001 から連続している(後から足すときは 0033 以降)", () => {
    expect(FILES).toEqual(["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql", "0008_migration_import.sql", "0009_start_time.sql", "0010_daily_reports.sql", "0011_win_odds.sql", "0012_jockey_results.sql", "0013_result_scratched.sql", "0014_horse_runs.sql", "0015_monthly_reports.sql", "0016_result_wakuban.sql", "0017_baba.sql", "0018_mark_repair.sql", "0019_close.sql", "0020_trainer_results.sql", "0021_baba_diagnostics.sql", "0022_race_conditions.sql", "0023_race_facts.sql", "0024_race_class.sql", "0025_min_hit_prob.sql", "0026_baba_attempts.sql", "0027_kaisai_days.sql", "0028_jockey_names.sql", "0029_max_bets.sql", "0030_trainer_names.sql", "0031_race_archive.sql", "0032_horse_runs_source.sql"]);
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

describe("AC-a1: 0001〜0011 を流した構造が、exe の最終スキーマ + 宣言した追加分(列・索引・r2_ops 表)と一致する", () => {
  const sqls = FILES.map(readMigration);

  it("列の集合・型・NOT NULL・既定値・主キー・外部キー・索引が一致する(違いは detail_key・llm_note・llm_calls_json・exe_analysis_id・start_time・race_results の win_odds・ninki・scratched・wakuban・索引2つ+0008 の4つ・r2_ops 表・cloud_settings 表だけ)", () => {
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

  it("Issue #445: WITHOUT ROWID の表の集合が、宣言と一致する(主キーが行の実体になる表。外すと書き込みの行が増える。構造の比較〈列・索引〉には現れないので別に固定する)", () => {
    // 宣言: 0014(horse_runs・horse_run_saves)・0017(baba_fetches・baba_conditions)・0022(race_conditions)・0026(baba_fetch_attempts)・0027(kaisai_days)・0028(jockey_names)・0030(trainer_names)・0031(race_archive)。新しく WITHOUT ROWID の表を足したら、ここにも足す。
    const declared = ["baba_conditions", "baba_fetch_attempts", "baba_fetches", "horse_run_saves", "horse_runs", "jockey_names", "kaisai_days", "race_archive", "race_conditions", "trainer_names"];
    const wrTables = (sqlList: readonly string[]): string[] => {
      const db = openEmptyDb();
      try {
        for (const sql of sqlList) {
          db.exec(sql);
        }
        return (db.prepare("PRAGMA table_list").all() as Array<{ name: string; type: string; wr: number }>)
          .filter((t) => t.type === "table" && t.wr === 1 && !t.name.startsWith("sqlite_"))
          .map((t) => t.name)
          .sort();
      } finally {
        db.close();
      }
    };
    expect(wrTables(sqls)).toEqual(declared);
    // 検出が空振りでない(対照): 0022 の `WITHOUT ROWID` を外すと、構造の比較は一致したまま、この集合だけが変わる
    const stripped = sqls.map((q, i) => (FILES[i] === "0022_race_conditions.sql" ? q.replace(/\)\s*WITHOUT ROWID;/, ");") : q));
    expect(stripped).not.toEqual(sqls);
    expect(wrTables(stripped)).toEqual(declared.filter((t) => t !== "race_conditions"));
    expect(diffSchemas(expectedD1Schema(exe), schemaAfter(stripped))).toEqual([]);
  });

  it("Issue #389: course_type・distance・track_condition・grade・race_name・cond_read の6列は 0023 だけが足す。0001〜0022 までには無い。exe には無い D1 専用(D1_EXTRA_COLUMNS に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN の6文だけ・UPDATE なし・索引なし)", () => {
    const names = ["course_type", "distance", "track_condition", "grade", "race_name", "cond_read"];
    const before = schemaAfter(sqls.slice(0, 22));
    for (const n of names) expect(before["analyses"]!.columns.map((c) => c.name), n).not.toContain(n);
    const after = schemaAfter(sqls);
    for (const n of names) {
      expect(after["analyses"]!.columns.find((c) => c.name === n), n).toEqual(D1_EXTRA_COLUMNS["analyses"]!.find((c) => c.name === n));
      expect(exe["analyses"]!.columns.map((c) => c.name), n).not.toContain(n);
    }
    expect(D1_EXTRA_COLUMNS["analyses"]!.filter((c) => names.includes(c.name))).toHaveLength(6);
    expect(after["analyses"]!.indexes).toEqual(before["analyses"]!.indexes); // 索引は足さない
    const code = sqls[22]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe(
      [
        "ALTER TABLE analyses ADD COLUMN course_type TEXT;",
        "ALTER TABLE analyses ADD COLUMN distance INTEGER;",
        "ALTER TABLE analyses ADD COLUMN track_condition TEXT;",
        "ALTER TABLE analyses ADD COLUMN grade TEXT;",
        "ALTER TABLE analyses ADD COLUMN race_name TEXT;",
        "ALTER TABLE analyses ADD COLUMN cond_read INTEGER;",
      ].join("\n"),
    );
  });

  it("Issue #426: race_class(TEXT・NULL 可)は 0024 だけが足す。0001〜0023 までには無い。exe には無い D1 専用(D1_EXTRA_COLUMNS に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN の1文だけ・UPDATE なし・索引なし)", () => {
    const before = schemaAfter(sqls.slice(0, 23));
    expect(before["analyses"]!.columns.map((c) => c.name)).not.toContain("race_class");
    const after = schemaAfter(sqls);
    expect(after["analyses"]!.columns.find((c) => c.name === "race_class")).toEqual(D1_EXTRA_COLUMNS["analyses"]!.find((c) => c.name === "race_class"));
    expect(after["analyses"]!.columns.find((c) => c.name === "race_class")).toEqual({ name: "race_class", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["analyses"]!.columns.map((c) => c.name)).not.toContain("race_class");
    expect(after["analyses"]!.indexes).toEqual(before["analyses"]!.indexes); // 索引は足さない
    const code = sqls[23]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE analyses ADD COLUMN race_class TEXT;");
  });

  it("Issue #470: min_hit_prob(REAL)・below_floor_count(INTEGER)・missed_json(TEXT)は 0025 だけが足す。0001〜0024 までには無い。exe には無い D1 専用(D1_EXTRA_COLUMNS に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN の3文だけ・UPDATE なし・索引なし・新しい表なし)", () => {
    const names = ["min_hit_prob", "below_floor_count", "missed_json"];
    const before = schemaAfter(sqls.slice(0, 24));
    for (const n of names) expect(before["analysis_allocation_meta"]!.columns.map((c) => c.name), n).not.toContain(n);
    const after = schemaAfter(sqls.slice(0, 25)); // 0025 までを適用した状態(0026 以降の表は含めない)
    for (const n of names) {
      expect(after["analysis_allocation_meta"]!.columns.find((c) => c.name === n), n).toEqual(D1_EXTRA_COLUMNS["analysis_allocation_meta"]!.find((c) => c.name === n));
      expect(exe["analysis_allocation_meta"]!.columns.map((c) => c.name), n).not.toContain(n);
    }
    expect(D1_EXTRA_COLUMNS["analysis_allocation_meta"]).toHaveLength(5); // 0025 の3列 + 0029 の2列(下の Issue #533 のテスト)
    expect(after["analysis_allocation_meta"]!.indexes).toEqual(before["analysis_allocation_meta"]!.indexes); // 索引は足さない
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()); // 新しい表は作らない
    const code = sqls[24]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe(
      [
        "ALTER TABLE analysis_allocation_meta ADD COLUMN min_hit_prob REAL;",
        "ALTER TABLE analysis_allocation_meta ADD COLUMN below_floor_count INTEGER;",
        "ALTER TABLE analysis_allocation_meta ADD COLUMN missed_json TEXT;",
      ].join("\n"),
    );
  });

  it("Issue #480: baba_fetch_attempts は 0026 だけが足す新しい表(主キー (kaisai_date, slot)・WITHOUT ROWID・副索引なし)。0001〜0025 までには無く、exe には無い D1 専用(D1_EXTRA_TABLES に宣言している)。既存の表は変えない(CREATE TABLE の1文だけ)", () => {
    const before = schemaAfter(sqls.slice(0, 25));
    expect(Object.keys(before)).not.toContain("baba_fetch_attempts");
    const after = schemaAfter(sqls.slice(0, 26)); // 0026 までを適用した状態(0027 以降の表は含めない)
    expect(after["baba_fetch_attempts"]).toEqual(D1_EXTRA_TABLES["baba_fetch_attempts"]);
    expect(Object.keys(exe)).not.toContain("baba_fetch_attempts");
    for (const [table, schema] of Object.entries(before)) {
      expect(after[table], table).toEqual(schema); // 既存の表は列も索引も変わらない
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "baba_fetch_attempts"].sort());
    const code = sqls[25]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  });

  it("Issue #519: kaisai_days は 0027 だけが足す新しい表(主キー (track_code, year, kai, nichi)・WITHOUT ROWID・副索引なし)。0001〜0026 までには無く、exe には無い D1 専用(D1_EXTRA_TABLES に宣言している)。既存の表は変えない(CREATE TABLE の1文だけ)", () => {
    const before = schemaAfter(sqls.slice(0, 26));
    expect(Object.keys(before)).not.toContain("kaisai_days");
    const after = schemaAfter(sqls.slice(0, 27)); // 0027 までを適用した状態(0028 以降の表は含めない)
    expect(after["kaisai_days"]).toEqual(D1_EXTRA_TABLES["kaisai_days"]);
    expect(Object.keys(exe)).not.toContain("kaisai_days");
    for (const [table, schema] of Object.entries(before)) {
      expect(after[table], table).toEqual(schema); // 既存の表は列も索引も変わらない
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "kaisai_days"].sort());
    const code = sqls[26]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  });

  it("Issue #526: jockey_names は 0028 だけが足す新しい表(主キー (jockey_name, jockey_id)・WITHOUT ROWID・副索引なし)。0001〜0027 までには無く、exe には無い D1 専用(D1_EXTRA_TABLES に宣言している)。既存の表は変えない(CREATE TABLE の1文だけ)", () => {
    const before = schemaAfter(sqls.slice(0, 27));
    expect(Object.keys(before)).not.toContain("jockey_names");
    const after = schemaAfter(sqls.slice(0, 28)); // 0028 までを適用した状態(0029 の列は含めない)
    expect(after["jockey_names"]).toEqual(D1_EXTRA_TABLES["jockey_names"]);
    expect(Object.keys(exe)).not.toContain("jockey_names");
    for (const [table, schema] of Object.entries(before)) {
      expect(after[table], table).toEqual(schema); // 既存の表は列も索引も変わらない
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "jockey_names"].sort());
    const code = sqls[27]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  });

  it("Issue #540: trainer_names は 0030 だけが足す新しい表(主キー (trainer_name, trainer_id)・WITHOUT ROWID・副索引なし)。0001〜0029 までには無く、exe には無い D1 専用(D1_EXTRA_TABLES に宣言している)。既存の表は変えない(CREATE TABLE の1文だけ)", () => {
    const before = schemaAfter(sqls.slice(0, 29));
    expect(Object.keys(before)).not.toContain("trainer_names");
    const after = schemaAfter(sqls.slice(0, 30)); // 0030 までを適用した状態(0031 以降の表は含めない)
    expect(after["trainer_names"]).toEqual(D1_EXTRA_TABLES["trainer_names"]);
    expect(Object.keys(exe)).not.toContain("trainer_names");
    for (const [table, schema] of Object.entries(before)) {
      expect(after[table], table).toEqual(schema); // 既存の表は列も索引も変わらない
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "trainer_names"].sort());
    const code = sqls[29]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  });

  it("Issue #551: race_archive は 0031 だけが足す新しい表(主キー race_id・WITHOUT ROWID・副索引なし)。0001〜0030 までには無く、exe には無い D1 専用(D1_EXTRA_TABLES に宣言している)。既存の表は変えない(CREATE TABLE の1文だけ)", () => {
    const before = schemaAfter(sqls.slice(0, 30));
    expect(Object.keys(before)).not.toContain("race_archive");
    const after = schemaAfter(sqls.slice(0, 31)); // 0031 までを適用した状態(0032 の列追加は含めない)
    expect(after["race_archive"]).toEqual(D1_EXTRA_TABLES["race_archive"]);
    expect(Object.keys(exe)).not.toContain("race_archive");
    for (const [table, schema] of Object.entries(before)) {
      expect(after[table], table).toEqual(schema); // 既存の表は列も索引も変わらない
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "race_archive"].sort());
    const code = sqls[30]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.match(/\bCREATE TABLE\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  });

  it("Issue #533: max_win_bets(INTEGER)・max_place_bets(INTEGER)は 0029 だけが足す。0001〜0028 までには無い。exe には無い D1 専用(D1_EXTRA_COLUMNS に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN の2文だけ・UPDATE なし・索引なし・新しい表なし)", () => {
    const names = ["max_win_bets", "max_place_bets"];
    const before = schemaAfter(sqls.slice(0, 28));
    for (const n of names) expect(before["analysis_allocation_meta"]!.columns.map((c) => c.name), n).not.toContain(n);
    const after = schemaAfter(sqls.slice(0, 29));
    for (const n of names) {
      expect(after["analysis_allocation_meta"]!.columns.find((c) => c.name === n), n).toEqual(D1_EXTRA_COLUMNS["analysis_allocation_meta"]!.find((c) => c.name === n));
      expect(after["analysis_allocation_meta"]!.columns.find((c) => c.name === n), n).toEqual({ name: n, type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
      expect(exe["analysis_allocation_meta"]!.columns.map((c) => c.name), n).not.toContain(n);
    }
    expect(after["analysis_allocation_meta"]!.indexes).toEqual(before["analysis_allocation_meta"]!.indexes); // 索引は足さない
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()); // 新しい表は作らない
    const code = sqls[28]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe(["ALTER TABLE analysis_allocation_meta ADD COLUMN max_win_bets INTEGER;", "ALTER TABLE analysis_allocation_meta ADD COLUMN max_place_bets INTEGER;"].join("\n"));
  });

  it("Issue #552: horse_runs.source(TEXT・NULL 可)は 0032 だけが足す。0001〜0031 までには無い。exe には無い D1 専用の表の列(D1_EXTRA_TABLES に宣言している)。追加のみ(ALTER TABLE ... ADD COLUMN の1文だけ・UPDATE なし・索引なし・新しい表なし)。WITHOUT ROWID・主キーは変わらない", () => {
    const before = schemaAfter(sqls.slice(0, 31));
    expect(before["horse_runs"]!.columns.map((c) => c.name)).not.toContain("source");
    const after = schemaAfter(sqls.slice(0, 32));
    expect(after["horse_runs"]!.columns.find((c) => c.name === "source")).toEqual({ name: "source", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(after["horse_runs"]!.columns.find((c) => c.name === "source")).toEqual(D1_EXTRA_TABLES["horse_runs"]!.columns.find((c) => c.name === "source"));
    expect(after["horse_runs"]!.columns.filter((c) => c.name !== "source")).toEqual(before["horse_runs"]!.columns); // 既存の列は変わらない
    expect(after["horse_runs"]!.indexes).toEqual(before["horse_runs"]!.indexes); // 主キーのまま・索引は足さない
    expect(after["horse_runs"]!.indexes).toHaveLength(1);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()); // 新しい表は作らない
    for (const [table, schema] of Object.entries(before)) {
      if (table !== "horse_runs") expect(after[table], table).toEqual(schema); // ほかの表は変わらない
    }
    const code = sqls[31]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE horse_runs ADD COLUMN source TEXT;");
  });

  it("Issue #259: win_odds(REAL)・ninki(INTEGER)は 0011 だけが足す。0001〜0010 までには無い。追加のみ(ALTER TABLE ... ADD COLUMN の2文だけ・UPDATE なし)。exe の race_results には無く(D1 専用)、移行の形式の列にも入れない", () => {
    const before = schemaAfter(sqls.slice(0, 10));
    expect(before["race_results"]!.columns.map((c) => c.name)).not.toContain("win_odds");
    expect(before["race_results"]!.columns.map((c) => c.name)).not.toContain("ninki");
    const after = schemaAfter(sqls);
    expect(after["race_results"]!.columns.find((c) => c.name === "win_odds")).toEqual({ name: "win_odds", type: "REAL", notnull: 0, dflt_value: null, pk: 0 });
    expect(after["race_results"]!.columns.find((c) => c.name === "ninki")).toEqual({ name: "ninki", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
    expect(exe["race_results"]!.columns.map((c) => c.name)).not.toContain("win_odds");
    expect(exe["race_results"]!.columns.map((c) => c.name)).not.toContain("ninki");
    expect(after["race_results"]!.indexes).toEqual(before["race_results"]!.indexes); // 索引は足さない
    const code = sqls[10]!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE race_results ADD COLUMN win_odds REAL;\nALTER TABLE race_results ADD COLUMN ninki INTEGER;");
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
