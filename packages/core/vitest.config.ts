import { configDefaults, defineConfig } from "vitest/config";
import { CORE_RESEARCH_TEST_FILES } from "./vitest.research-tests.js";

// Issue #395: 確率の質の測定のテスト(`vitest.research-tests.ts` の一覧)は、普段の `pnpm test` から外した。
// 走らせるには `pnpm test:research`(`vitest.research.config.ts`)を使う。型検査は外していない。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...CORE_RESEARCH_TEST_FILES],
  },
});
