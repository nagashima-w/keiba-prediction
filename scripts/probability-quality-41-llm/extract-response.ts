/**
 * #156(#41-B)サブエージェントのトランスクリプト(JSONL)から最終メッセージを取り出して保存する CLI
 * (オフライン)。検証と保存の本体は `transcript.ts` の `saveExtractedResponse`。
 *
 * ## 実行
 *   pnpm tsx scripts/probability-quality-41-llm/extract-response.ts \
 *       --work-dir <作業ディレクトリ> --case case-07 --attempt 1 --transcript <トランスクリプトの JSONL>
 * 終了コード: 保存したら 0、無効(許していないツール使用・全文を読んでいない等)なら 4(何も書かない)。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { saveExtractedResponse } from "./transcript.js";

function value(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${name} が必要です`);
  }
  return v;
}

function main(): void {
  const argv = process.argv.slice(2);
  const result = saveExtractedResponse({
    workDir: path.resolve(value(argv, "--work-dir")),
    caseId: value(argv, "--case"),
    attempt: Number(value(argv, "--attempt")),
    transcriptPath: path.resolve(value(argv, "--transcript")),
  });
  if (result.ok) {
    console.error(`保存しました: ${result.savedPath}(${result.chars}文字)`);
    return;
  }
  console.error("無効な応答です(何も書いていません):");
  for (const reason of result.reasons) {
    console.error(`  - ${reason}`);
  }
  process.exitCode = 4;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
