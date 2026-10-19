import { defineConfig } from "vitest/config";
import { CORE_RESEARCH_TEST_FILES } from "./vitest.research-tests.js";

// 確率の質の測定のテスト(packages/core 側)だけを走らせる vitest 設定(Issue #395。#390 D-4)。
// ルートの `pnpm test:research` が `pnpm -r test:research` 経由で呼ぶ。普段の設定(vitest.config.ts)はこの一覧を除いている。
export default defineConfig({
  test: {
    include: [...CORE_RESEARCH_TEST_FILES],
  },
});
