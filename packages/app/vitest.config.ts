import { defineConfig } from "vitest/config";

// アプリの純ロジック(チャネル定義・IPCハンドラのロジック部分)のみをテスト対象とする。
// Electron 本体の起動や BrowserWindow は対象外(E2Eは不要)。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
