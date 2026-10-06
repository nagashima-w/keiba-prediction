/**
 * 実測結果から report を作るコマンド(Issue #159〈#21-A〉)。数値を手で書き写さないための道具。
 *
 * 使い方(リポジトリのルートで):
 *   # ジョブログから結果ブロックを切り出して JSON にする(ログは `gh run view --log` や MCP の get_job_logs の出力)
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts extract <job.log> > <result.json>
 *   # 結果 JSON を Markdown にして標準出力へ
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts markdown <result.json>
 *   # report.md の生成節(印の間)を、結果 JSON から作り直して上書きする
 *   #   第2ラウンド(#159): 名前なしの節。第3ラウンド(#160): round3 の節(見出しは3段下げる)
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts update <result.json> <report.md> [round3]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { demoteHeadings, replaceGeneratedBlock } from "./report-doc.js";
import { extractResultBlock, renderMarkdown, type SpikeResult } from "./result.js";

function readJson(file: string): SpikeResult {
  return JSON.parse(readFileSync(file, "utf-8")) as SpikeResult;
}

const [command, a, b] = process.argv.slice(2);

if (command === "extract" && a !== undefined) {
  const result = extractResultBlock(readFileSync(a, "utf-8"));
  if (result === null) {
    console.error("ログから結果ブロックを取り出せませんでした");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
} else if (command === "markdown" && a !== undefined) {
  process.stdout.write(`${renderMarkdown(readJson(a))}\n`);
} else if (command === "update" && a !== undefined && b !== undefined) {
  // 名前つきの節(第3ラウンド以降)は、report.md の中で1段深い節に置くので、見出しを3段下げる。
  const name = process.argv[5];
  const generated = demoteHeadings(renderMarkdown(readJson(a)), name === undefined ? 2 : 3);
  writeFileSync(b, replaceGeneratedBlock(readFileSync(b, "utf-8"), generated, name));
  console.log(`更新しました: ${b}${name === undefined ? "" : `(${name})`}`);
} else {
  console.error("使い方: render-report.ts extract <log> | markdown <json> | update <json> <report.md> [名前]");
  process.exit(2);
}
