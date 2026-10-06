/**
 * runAnalysis の golden JSON を生成する(Issue #176〈#164-a〉AC-a1)。
 *
 * 使い方: `pnpm tsx scripts/gen-pipeline-golden.ts`(リポジトリルートで)。
 * 出力: `packages/app/test/golden/pipeline-golden.json`。
 *
 * **golden は、runAnalysis を変更する前のコミット(b821c97〈v1.19.9〉)で生成した。** 変更後のコードで再生成して
 * 差分が出たら、それは exe の出力が変わったことを意味する(意図した変更でない限り golden を更新してはいけない)。
 * 入力はすべてリポジトリ内のフィクスチャと固定の合成値(実ネットワーク・実 API には触れない。時刻は固定)。
 * 検証は `packages/app/test/analysis-pipeline-golden.test.ts`。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeGolden } from "../packages/app/test/golden/pipeline-golden-scenarios.js";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "app",
  "test",
  "golden",
  "pipeline-golden.json",
);

const golden = await computeGolden();
writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`, "utf-8");
console.log(`wrote ${OUT}`);
