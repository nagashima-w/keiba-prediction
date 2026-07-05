/**
 * フィクスチャ取得スクリプト。
 *
 * docs/phase1-scraping-plan.md「フィクスチャ取得計画」に沿って、対象ページを
 * `fixtures/` 配下に計画書の命名規則で保存する。取得はコアの HttpClient を再利用し、
 * リクエスト間隔はデフォルト(最低1.5秒)・User-Agent明示に従う。
 *
 * 引数の解釈と「URL・ファイル名・エンコーディング」の決定は、テスト済みの純関数
 * (parseFetchArgs / planFixtureTargets)に委譲する。これらはライブラリの公開APIでは
 * なく取得スクリプト専用の内部ユーティリティのため、index.js 経由ではなく
 * scraper/fixture-plan.js を直接importする。本ファイルは実IO(HTTP取得・
 * ファイル書き込み)の薄いシェルに徹する。
 *
 * 保存形式について:
 *   フィクスチャは「デコード済みUTF-8テキスト」として保存する(生バイト列ではない)。
 *   HttpClient.fetchText はレスポンスをContent-Type/指定エンコーディングでデコードした
 *   JS文字列を返し、パーサーはそのJS文字列を入力とする。フィクスチャも同じ文字列を
 *   そのままUTF-8で書き出すことで、テスト入力と本番入力の形を一貫させる。
 *   EUC-JPページ(db.netkeiba.com)も取得時にデコード済みのため、保存物はUTF-8になる。
 *
 * 実行方法(ネットワーク解除後、オーケストレーターが1回のみ実行する):
 *   pnpm tsx scripts/fetch-fixtures.ts \
 *     --date 20260628 \
 *     --race 202605020811 --race 202601020811 \
 *     --horse 2019105219
 *
 * - --date  YYYYMMDD  : レース一覧サブHTMLを取得(1回のみ)
 * - --race  <race_id> : 競馬新聞・追い切り・厩舎コメントを取得(複数指定可)
 * - --horse <horse_id>: 馬個別ページを取得(複数指定可, EUC-JP)
 *
 * 注意: 現環境はnetkeibaに到達できないため、このスクリプトはここでは実行しない。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient } from "../packages/core/src/index.js";
import {
  parseFetchArgs,
  planFixtureTargets,
} from "../packages/core/src/scraper/fixture-plan.js";

/** フィクスチャ保存先ディレクトリ(リポジトリルート直下の fixtures/)。 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

async function main(): Promise<void> {
  const args = parseFetchArgs(process.argv.slice(2));
  const targets = planFixtureTargets(args);

  if (targets.length === 0) {
    console.error(
      "取得対象がありません。--date / --race / --horse のいずれかを指定してください。",
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  // HttpClientのデフォルト(最低1.5秒間隔・UA明示)にレート制限を任せる。
  const client = new HttpClient();

  console.error(`${targets.length}件のフィクスチャを取得します...`);
  for (const target of targets) {
    const outPath = path.join(FIXTURES_DIR, target.filename);
    console.error(`GET ${target.url}`);
    const body = await client.fetchText(
      target.url,
      target.encoding ? { encoding: target.encoding } : {},
    );
    await writeFile(outPath, body, "utf-8");
    console.error(`  → 保存: ${outPath} (${body.length}文字)`);
  }
  console.error("完了しました。");
}

main().catch((error: unknown) => {
  console.error("取得中にエラーが発生しました:", error);
  process.exitCode = 1;
});
