/**
 * 実測結果から report を作るコマンド(Issue #159〈#21-A〉)。数値を手で書き写さないための道具。
 *
 * 使い方(リポジトリのルートで):
 *   # ジョブログから結果ブロックを切り出して JSON にする(ログは `gh run view --log` や MCP の get_job_logs の出力)
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts extract <job.log> > <result.json>
 *   # 結果 JSON を Markdown にして標準出力へ
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts markdown <result.json>
 *   # report.md の生成節(印の間)を、結果 JSON から作り直して上書きする
 *   pnpm tsx scripts/cloudflare-spike/render-report.ts update <result.json> <report.md>
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
  const generated = demoteHeadings(renderMarkdown(readJson(a)), 2);
  writeFileSync(b, replaceGeneratedBlock(readFileSync(b, "utf-8"), generated));
  console.log(`更新しました: ${b}`);
} else {
  console.error("使い方: render-report.ts extract <log> | markdown <json> | update <json> <report.md>");
  process.exit(2);
}
