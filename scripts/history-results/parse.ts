/**
 * 取得済みの結果ページ(fetch.ts の出力)を読んで NDJSON(gzip)にする(Issue #532 段階 1)。開発用。ネットワークには出ない。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/history-results/parse.ts <fetch の出力ディレクトリ> --out <file.ndjson.gz>
 * 1 行 1 レース(レースの項目・馬の配列・払戻。`kind` が central か nar か)。読めなかったページは出力に入れず、
 * 理由つきで数えて `<file>.rejects.ndjson` に残す。
 */

import { parseParseArgs, PARSE_USAGE, runParse } from "./parse-lib.js";

const parsed = parseParseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.message}\n${PARSE_USAGE}`);
  process.exit(2);
}
runParse({ ...parsed.value, log: (m) => console.log(m) });
