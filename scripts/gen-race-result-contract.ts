/**
 * 結果の保存の golden JSON を生成する(Issue #207〈#182-A〉AC-A3)。
 *
 * 使い方: `pnpm tsx scripts/gen-race-result-contract.ts`(リポジトリルートで)。
 * 出力: `packages/core/test/golden/race-result-contract.json`。
 *
 * golden は、exe の `AnalysisStore.saveResult`(codec へ SQL を出した後の実装。出す前と同じ SQL 列であることは
 * `analysis-store-result-sql-sequence.test.ts` が固定)で作る。**exe の保存の挙動を意図して変えたときだけ再生成する**
 * (意図しない差分が出たら、それは exe の出力が変わったことを意味する)。入力はリポジトリ内のフィクスチャと固定の合成値で、
 * 実ネットワークには触れない。検証は `packages/core/test/ev/race-result-contract.test.ts`(exe 側)と cloud/test/result-repository.test.ts(D1 側)。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeRaceResultContract } from "../packages/core/test/golden/race-result-scenarios.js";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "test",
  "golden",
  "race-result-contract.json",
);

const contract = computeRaceResultContract();
writeFileSync(OUT, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
console.log(`wrote ${OUT} (${contract.cases.length} cases)`);
