/**
 * 普段の `pnpm test` から外す、ルート(scripts/test)の研究用テストの一覧(Issue #395。#390 D-4)。
 *
 * ## 何のための一覧か
 * 確率の質の測定(#41・#156 の `scripts/probability-quality-41/`・`scripts/probability-quality-41-llm/`)のテストは、
 * 測定を再実行するときにだけ要る。普段の CI(`ci.yml` の verify)からは外し、`pnpm test:research` と
 * 手動実行のワークフロー(`.github/workflows/research.yml`)で走らせる。
 * 通常の設定(`vitest.config.ts`)はこの一覧を exclude に、研究用の設定(`vitest.research.config.ts`)は include に使う。
 * 同じ配列を両方が参照するので、片方だけ直してどちらにも走らないテストが生まれることはない。
 *
 * ## 含めないもの
 * `scripts/test/probability-quality-regression.test.ts` は名前に反して **production の prior の回帰の検査**
 * (prior が意図せず変わったことを普段の CI で検出する経路)なので、普段の CI に残す。
 * そのため glob は `probability-quality-41-*` に絞ってある(`probability-quality-*` ではない)。
 *
 * 一覧の整合は `scripts/test/research-split-guard.test.ts` が固定している。
 */
export const RESEARCH_TEST_GLOBS: readonly string[] = ["scripts/test/probability-quality-41-*.test.ts"];
