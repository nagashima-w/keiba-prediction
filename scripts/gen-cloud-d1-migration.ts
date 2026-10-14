/**
 * クラウド版(cloud/)の D1 の migration 0001 の「凍結」の確認(Issue #171・#169-a で生成物として導入、Issue #197 で凍結に変更)。
 *
 * ## 経緯
 * 0001 は、exe の `new AnalysisStore()`(better-sqlite3)を作った直後の `sqlite_master` のダンプとして**生成**していた
 * (CREATE 文を手で写さないため)。Issue #197(#196-a)で exe の `analysis_horses` に `highlights_json`・`concerns_json` を足したとき、
 * 生成物の 0001 にも同じ列が入ってしまい、後から足す 0006 の `ALTER TABLE ... ADD COLUMN` と重複する(`duplicate column name`)ことが分かった。
 * また、適用済みの 0001 を書き換えても、本番の D1 には効かない(wrangler は d1_migrations で適用済みを飛ばす)。
 * そのため **0001 は凍結した**: このファイルはもう 0001 を生成しない。
 *
 * ## 運用
 * - exe のスキーマ(`analysis-store.ts`)に列・表を足したら、**新しい migration(0006 以降)を手で足す**(`ALTER TABLE ... ADD COLUMN` など。追加のみ)。
 * - exe と D1 の構造の一致は、`scripts/test/cloud-d1-schema.test.ts` の AC-a1(0001〜最新を流した構造 = exe の最終スキーマ + 宣言した追加分)が守る。
 * - 0001 を誤って書き換えていないかは、凍結したハッシュ({@link FROZEN_INIT_MIGRATION_SHA256})との一致で検出する。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/gen-cloud-d1-migration.ts --check  # コミット済みの 0001 が凍結したハッシュと一致するか確かめる(差があれば終了コード 1)
 * (書き出しの機能は無い。0001 を書き換えることになるため)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 凍結した 0001 の SHA-256(改行は LF に正規化した内容の値)。
 * 再現: `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('cloud/migrations/0001_init.sql','utf8').replace(/\r\n/g,'\n')).digest('hex'))"`
 * (v1.19.26 までの生成物。この値を書き換えるのは、0001 を意図して変える〈本番に適用済みの migration を壊す〉ときだけ。通常は新しい migration を足す)
 */
export const FROZEN_INIT_MIGRATION_SHA256 = "488de280f2f37eed93e5a78451b913890e7a10554cdc6fe10e9aa3f9a1ebb45e";

/** 文字列の SHA-256(16進)。改行の違い(CRLF)で値が変わらないよう、CRLF は LF にそろえてから計算する。 */
export function sha256OfLf(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf-8").digest("hex");
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
  if (!process.argv.includes("--check")) {
    console.error("このスクリプトは 0001 を書き出さない(凍結済み)。使い方: pnpm tsx scripts/gen-cloud-d1-migration.ts --check");
    process.exit(2);
  }
  const current = existsSync(INIT_MIGRATION_PATH) ? readFileSync(INIT_MIGRATION_PATH, "utf-8") : null;
  if (current === null || sha256OfLf(current) !== FROZEN_INIT_MIGRATION_SHA256) {
    console.error("cloud/migrations/0001_init.sql が、凍結した内容と一致しません。0001 は書き換えず、新しい migration を足してください");
    process.exit(1);
  }
  console.log("cloud/migrations/0001_init.sql は凍結した内容のままです");
}

// 直接実行されたときだけ動く(テストから import されたときは何もしない)。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
