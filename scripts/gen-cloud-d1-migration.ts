/**
 * クラウド版(cloud/)の D1 の migration 0001 を、exe の最終スキーマから生成する(Issue #171・#169-a)。
 *
 * 中身は、exe の `new AnalysisStore()`(better-sqlite3)を作った直後の `sqlite_master` のダンプである。
 * **CREATE 文を手で写さない**ための生成スクリプト: 後付けの ALTER で足した列(include_quinella など)は、新規作成の CREATE TABLE に
 * 最初から入っているので、ダンプにも入る。D1 は新規のデータベースなので、ALTER の履歴は要らない。
 * - 対象: 表(8表)と、明示した索引(`idx_analyses_race`)。`sqlite_*`(sqlite_sequence)と自動索引(SQL が無い)は除く
 * - 並び: 表(名前順)→ 索引(名前順)。同じ入力から必ず同じ出力になる(コミット済みの 0001 との一致をテストが固定する)
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/gen-cloud-d1-migration.ts          # cloud/migrations/0001_init.sql を書き出す
 *   pnpm tsx scripts/gen-cloud-d1-migration.ts --check  # 書き出さず、コミット済みのファイルが最新か確かめる(差があれば終了コード 1)
 *
 * D1 専用の追加分(`analyses.detail_key`・索引2つ)は 0002_d1.sql にあり、このスクリプトの対象外。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisStore } from "../packages/core/src/ev/analysis-store.js";

const HEADER = `-- クラウド版(D1)の migration 0001: exe の最終スキーマ(new AnalysisStore() 後の sqlite_master のダンプ)。
-- ★このファイルは scripts/gen-cloud-d1-migration.ts が生成する。手で編集しない(exe のスキーマが変わったら、スクリプトを再実行する)。
-- D1 専用の追加分は 0002_d1.sql にある。migration は追加のみ(既存の表・列を壊さない)。
`;

/** exe の最終スキーマの CREATE 文(表 → 索引。名前順)を、migration 0001 の本文として組み立てる。 */
export function buildInitMigrationSql(): string {
  const store = new AnalysisStore();
  try {
    const rows = store.rawDatabase
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')
          ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    const statements = rows.map((r) => `${r.sql.replace(/[ \t]+$/gm, "").trim()};`);
    return `${HEADER}\n${statements.join("\n\n")}\n`;
  } finally {
    store.close();
  }
}

/** cloud/migrations/0001_init.sql の絶対パス。 */
export const INIT_MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "cloud",
  "migrations",
  "0001_init.sql",
);

function main(): void {
  const generated = buildInitMigrationSql();
  if (process.argv.includes("--check")) {
    const current = existsSync(INIT_MIGRATION_PATH) ? readFileSync(INIT_MIGRATION_PATH, "utf-8").replace(/\r\n/g, "\n") : null;
    if (current !== generated) {
      console.error("cloud/migrations/0001_init.sql が、exe のスキーマから生成した内容と一致しません。pnpm tsx scripts/gen-cloud-d1-migration.ts で再生成してください");
      process.exit(1);
    }
    console.log("cloud/migrations/0001_init.sql は最新です");
    return;
  }
  writeFileSync(INIT_MIGRATION_PATH, generated, "utf-8");
  console.log(`${INIT_MIGRATION_PATH} を書き出しました`);
}

// 直接実行されたときだけ動く(テストから import されたときは何もしない)。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
