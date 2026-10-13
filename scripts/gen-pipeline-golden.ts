/**
 * runAnalysis の golden JSON を生成する(Issue #176〈#164-a〉AC-a1)。
 *
 * 使い方: `pnpm tsx scripts/gen-pipeline-golden.ts`(リポジトリルートで)。
 * 出力: `packages/core/test/golden/pipeline-golden.json`。
 *
 * **golden は、runAnalysis を変更する前のコミット(b821c97〈v1.19.9〉)で生成した。** 変更後のコードで再生成して
 * 差分が出たら、それは exe の出力が変わったことを意味する(意図した変更でない限り golden を更新してはいけない)。
 * **Issue #250 で一度だけ再生成した**: スナップショットの race にグレード(`grade`)を足したため、G3 のレース(ラジオNIKKEI賞)の
 * raceSnapshot.race に `"grade": "G3"` が加わった(差分はその 3 か所のみ。`git diff` で確認済み)。
 * **Issue #295 で再生成した**(`PROMPT_VERSION` が "2026-10-13.1" → "2026-10-13.2" になった): 差分は LLM のシナリオの `record.promptVersion` の 1 行のみ(プロンプト本文・スナップショットは、当日の馬場の値が無いので不変)。
 * **Issue #296 で再生成した**: 組合せの配分を計算した 2 シナリオ(`noLlmAllBets`・`llmStubSameDayGrade`)の `record.raceSnapshot` に `comboStats`(券種ごとの EV プラスの点数)が加わった(差分はその 2 か所の追加 52 行のみ。削除行なし。`git diff` で確認済み)。
 * 入力はすべてリポジトリ内のフィクスチャと固定の合成値(実ネットワーク・実 API には触れない。時刻は固定)。
 * 検証は `packages/core/test/analysis/analysis-pipeline-golden.test.ts`。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeGolden } from "../packages/core/test/golden/pipeline-golden-scenarios.js";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "test",
  "golden",
  "pipeline-golden.json",
);

const golden = await computeGolden();
writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`, "utf-8");
console.log(`wrote ${OUT}`);
