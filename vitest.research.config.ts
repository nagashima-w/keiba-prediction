import { defineConfig } from "vitest/config";
import { RESEARCH_TEST_GLOBS } from "./vitest.research-tests.js";

// 確率の質の測定のテスト(ルート側)だけを走らせる vitest 設定(Issue #395。#390 D-4)。
// `pnpm test:research` が使う。普段の設定(vitest.config.ts)はこの一覧を除いているので、二重には走らない。
// packages/core 側の研究用テストは packages/core/vitest.research.config.ts が担当する。
export default defineConfig({
  test: {
    include: [...RESEARCH_TEST_GLOBS],
  },
});
