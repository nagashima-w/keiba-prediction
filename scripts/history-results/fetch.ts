/**
 * 過去の結果の取得(Issue #532 段階 1)。開発用のスクリプトで、本番の Worker・D1 には載せない。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/history-results/fetch.ts --from 2021-11 --to 2026-10 --out <ディレクトリ> [--central] [--nar-jpn] [--limit N] [--max-consecutive-failures N] [--interval-ms N] [--newest-first]
 * 中央の全レース(`--central`)と、地方は交流重賞 Jpn1〜3 だけ(`--nar-jpn`)の結果ページを、gzip で `<ディレクトリ>/raw/…` に保存する
 * (どちらも付けなければ両方)。途中で止めても、再実行で続きから取る(取得済みのファイルは取らない)。取れなかったものは
 * `<ディレクトリ>/errors.ndjson` に残り、再実行でもう一度試す。取った生のデータはリポジトリに入れない(出力先はリポジトリの外に指定する)。
 *
 * 取得の失敗(HTTP エラー・保存前の検査の不合格)が連続 20 件になったら、アクセス制限を疑って打ち切り、終了コード 1 で終わる(再実行で続きから)。
 * HTTP 400・403・429 が返ったら、アクセスを制限された可能性があるので、その場で打ち切る(終了コード 1)。
 * netkeiba への実リクエストを出す。HttpClient の最低間隔(`--interval-ms`、既定 10000ms。1500 未満は不可)を守り、1 プロセスで直列に取る。
 * (1500ms で約 273 リクエストを出したところで HTTP 400 を返されたため、既定を 10 秒に広げた。`--limit` で 1 日の件数を区切り、
 * `--newest-first` で新しい年から取る。)
 * 依存: ルートの devDependencies の cheerio(開発用の結果パーサが使う。本番には入らない)。
 * 解析は parse.ts(ネットワークには出ない)。
 */

import { HttpClient } from "../../packages/core/src/scraper/http-client.js";
import { abortMessage, FETCH_USAGE, parseFetchArgs, runFetch } from "./fetch-lib.js";

const parsed = parseFetchArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.message}\n${FETCH_USAGE}`);
  process.exit(2);
}

/** 今日(JST)の YYYYMMDD。 */
const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

const { intervalMs, ...fetchArgs } = parsed.value;
const client = new HttpClient({ minIntervalMs: intervalMs });
const stats = await runFetch({
  ...fetchArgs,
  today,
  fetchText: (url) => client.fetchText(url, { encoding: "utf-8" }),
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
