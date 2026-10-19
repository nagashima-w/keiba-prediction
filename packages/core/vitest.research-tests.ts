/**
 * 普段の `pnpm test` から外す、packages/core の研究用テストの一覧(Issue #395。#390 D-4)。
 *
 * いずれも確率の質の測定(`buildProbabilityQualityReport`・`buildBrierQualityReport`・`buildPairedBrierComparison`)だけを試す。
 * これらの関数の production の呼び出し元は無く、`scripts/`(確率の質の調査)だけが呼ぶ。
 * 通常の設定(`vitest.config.ts`)は exclude に、研究用の設定(`vitest.research.config.ts`)は include に、この同じ配列を使う。
 *
 * ## 含めないもの(production の守りを含むので、普段の CI に残す)
 * - `test/ev/brier-decomposition.test.ts`: production の `verify.ts` が使う `computeBrierScore` と、検証画面のキャリブレーションとの突合を含む。
 * - `test/ev/binomial-interval.test.ts`: 検証画面の部品(cloud のクライアントが import する)。
 * - `test/ev/verify-quality.test.ts`: production の検証の集計。
 *
 * 一覧の整合は `scripts/test/research-split-guard.test.ts` が固定している。
 */
export const CORE_RESEARCH_TEST_FILES: readonly string[] = [
  "test/ev/probability-quality.test.ts",
  "test/ev/brier-quality-report.test.ts",
  "test/ev/paired-brier-comparison.test.ts",
];
