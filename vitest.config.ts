import { defineConfig } from "vitest/config";

// リポジトリルート直下の scripts/ 配下(パッケージに属さない調査・計測スクリプト)専用の
// vitest 設定(Issue #38)。scripts/ はどの workspace package にも属さないため、
// packages/core・packages/app それぞれの vitest.config.ts(test.include: "test/**/*.test.ts"、
// 各パッケージディレクトリ基準)ではテストできない。
//
// `packages/**` を巻き込まないことを明示するため、include は `scripts/` 配下限定にする
// (packages/core・packages/app のテストは各パッケージの `pnpm test`(`pnpm -r test`)が担当し、
// ここで二重に実行しない)。
export default defineConfig({
  test: {
    include: ["scripts/test/**/*.test.ts"],
  },
});
