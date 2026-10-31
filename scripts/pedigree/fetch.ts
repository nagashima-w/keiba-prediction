/**
 * 血統ページの取得(Issue #542 手順 2)。開発用のスクリプトで、本番の Worker・D1 には載せない。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/pedigree/fetch.ts --out <ディレクトリ> [--races <#532 の parse の出力.ndjson.gz>]... [--ids <1 行 1 ID のファイル>]... [--limit N] [--max-consecutive-failures N] [--interval-ms N]
 * 馬の ID の一覧(`--ids` の馬が先、`--races` は日付の新しい順。重複は除く)から、`https://db.netkeiba.com/horse/ped/<馬 ID>/` を
 * 1 頭 1 リクエストで取り、gzip で `<ディレクトリ>/raw/ped/<馬 ID>.html.gz` に保存する。途中で止めても、再実行で続きから取る(取得済みは取らない)。
 * 取れなかったものは `<ディレクトリ>/errors.ndjson` に残り、再実行でもう一度試す。取った生のデータはリポジトリに入れない(出力先はリポジトリの外に指定する)。
 *
 * HTTP 400・403・429 が返ったら、アクセスを制限された可能性があるので、その場で打ち切る(終了コード 1)。
 * 取得の失敗が連続 20 件になったら、アクセス制限を疑って打ち切り、終了コード 1 で終わる。
 * netkeiba への実リクエストを出す。HttpClient の最低間隔(`--interval-ms`、既定 10000ms。1500 未満は不可)を守り、1 プロセスで直列に取る
 * (間隔はプロセス内だけの保証。#532 の取得と同時に走らせると、合算の速さは上がる)。
 * 解析は parse.ts(ネットワークには出ない)。
 */

import { HttpClient } from "../../packages/core/src/scraper/http-client.js";
import { abortMessage } from "../history-results/fetch-lib.js";
import { collectHorseIds, createPedFetchText, parsePedFetchArgs, PED_FETCH_USAGE, runPedFetch } from "./fetch-lib.js";

const parsed = parsePedFetchArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.message}\n${PED_FETCH_USAGE}`);
  process.exit(2);
}

const { intervalMs, raceFiles, idFiles, ...fetchArgs } = parsed.value;
const collected = collectHorseIds({ raceFiles, idFiles });
console.log(
  `取る馬 ${collected.ids.length} 頭(重複で除いた ${collected.duplicates}・horseId が無い ${collected.nullHorseIds}・形が不正で除いた ${collected.invalid.length}${
    collected.invalid.length > 0 ? `: ${collected.invalid.slice(0, 5).join(", ")}` : ""
  })`,
);
const client = new HttpClient({ minIntervalMs: intervalMs });
const stats = await runPedFetch({
  ...fetchArgs,
  horseIds: collected.ids,
  fetchText: createPedFetchText(client),
  log: (m) => console.log(m),
});
const abortText = abortMessage(stats);
if (abortText !== null) {
  console.error(abortText);
  process.exitCode = 1;
}
if (stats.errors > 0) {
  console.log(`エラーが ${stats.errors} 件あります。${parsed.value.outDir}/errors.ndjson を見て、もう一度実行すると取れなかったものを試します。`);
}
