/**
 * 地方(NAR)3連複オッズの軸馬別AJAXフラグメント(`odds_get_form.html?type=b7&jiku=1`)を
 * 1件だけ取得し、フィクスチャとして保存する単発スクリプト(機能D-2b-B・Issue #33 第1段・AC6)。
 *
 * `scripts/bench-allocation.ts` / `scripts/bench-combo-odds-key.ts` と同じ流儀:
 * - 単発の調査・検証専用であり、CI からは呼ばない
 * - `pnpm --filter` 等のビルド・テストパイプラインに組み込まれていない
 *
 * ## 目的(boss着手前ゲート・AC6)
 *
 * `parse-nar-combo-odds.ts` は通常ページ(`odds/index.html?type=b7`)とAJAXフラグメント
 * (`odds_get_form.html?type=b7&jiku=N`)を同じコードパスでパースする設計だが、この前提
 * (「`jiku=1` のフラグメントが、通常ページに埋め込まれた軸1のテーブルと同じ組合せ集合を
 * 返すか」)は #32 時点では未検証だった(#32・#13 で検証したのは `jiku=2` のみ)。
 * 本スクリプトはこの唯一の未検証前提を最初に反証しにいくためのもの(#33ブリーフ「鉄則6」)。
 *
 * ## 対象・保存先
 *
 * - race_id: `202654071210`(地方・高知10R ファイナルレース、12頭。#13・#32で使用した
 *   既存の実測対象と同一レースにすることで、`nar_odds_b7_202654071210.html`
 *   〈通常ページ=軸1固定〉と直接比較できるようにする)
 * - jiku: `1`
 * - URL: `https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=1`
 * - 保存先: `fixtures/nar_odds_b7_jiku1_202654071210.html`
 *
 * ## 取得記録
 *
 * - 実行者: tdd-implementer(boss着手前ゲート合意・2026-08-07 Go）
 * - 取得日時: 実行時に本スクリプトのログへ出力される(`docs/wide-trio-odds-investigation.md` §12へ転記する)
 * - リクエスト数: 1件(`HttpClient` 既定: 最低1.5秒間隔・UA明示。#33の実リクエスト上限2件のうち1件を使用)
 *
 * ## 再実行手順
 *
 *   pnpm tsx scripts/fetch-nar-trio-axis-fixture.ts
 *
 * 既存ファイルがあれば上書きする(取得日時を再確認したい場合の再実行を妨げないため)。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient } from "../packages/core/src/index.js";

/** フィクスチャ保存先ディレクトリ(リポジトリルート直下の fixtures/)。 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const RACE_ID = "202654071210";
const JIKU = 1;
const URL = `https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=${RACE_ID}&jiku=${JIKU}`;
const OUT_PATH = path.join(FIXTURES_DIR, `nar_odds_b7_jiku${JIKU}_${RACE_ID}.html`);

async function main(): Promise<void> {
  const client = new HttpClient();
  console.error(`GET ${URL}`);
  const body = await client.fetchText(URL);
  // 解析より先に保存する(#13・#32で計3回繰り返した「取得したが保存しなかった」失敗の再発防止。
  // AC10「構造的に保存が先」)。
  writeFileSync(OUT_PATH, body, "utf-8");
  console.error(`取得日時: ${new Date().toISOString()}`);
  console.error(`保存: ${OUT_PATH} (${body.length}文字)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
