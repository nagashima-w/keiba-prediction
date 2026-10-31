/**
 * 取得済みの血統ページ(fetch.ts の出力)を読んで NDJSON(gzip)にする(Issue #542 手順 2)。開発用。ネットワークには出ない。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/pedigree/parse.ts <fetch の出力ディレクトリ> --out <file.ndjson.gz>
 * 1 行 1 頭(馬 ID・馬の名前・父・母・父の父・父の母・母の父・母の母。各祖先は id・name・country。注意点は issues)。
 * 読めなかったページは出力に入れず、理由つきで数えて `<file>.rejects.ndjson` に残す。
 */

import { parsePedParseArgs, PED_PARSE_USAGE, runPedParse } from "./parse-lib.js";

const parsed = parsePedParseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.message}\n${PED_PARSE_USAGE}`);
  process.exit(2);
}
runPedParse({ ...parsed.value, log: (m) => console.log(m) });
