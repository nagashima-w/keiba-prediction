import { defineConfig } from "vitest/config";

// cloud/ のテスト専用の設定。ルートの vitest.config.ts(scripts/test のみ)とは独立している。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
