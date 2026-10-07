import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// cloud/ のテスト専用の設定。ルートの vitest.config.ts(scripts/test のみ)とは独立している。
//
// alias: core(相対 import で取り込む)の依存は、packages/core/node_modules が CI(cloud/ だけをインストールする)に無いため、
// このディレクトリの node_modules へ向ける。undici はスタブ。tsconfig.json の paths・wrangler.toml の [alias] と同じ対応。
// ★実測(#162 段階2a): packages/core/node_modules の無い配置でも、vitest(Vite の解決)は cloud/node_modules へ辿り着いて alias 無しで通った。
//   つまり vitest の alias は必須ではなく、解決の挙動に依存しないための明示。**CI にだけ効くのは tsconfig の paths(型検査)と wrangler.toml の [alias](バンドル)**。
export default defineConfig({
  resolve: {
    alias: {
      undici: here("./src/undici-stub.ts"),
      "iconv-lite": here("./node_modules/iconv-lite"),
      cheerio: here("./node_modules/cheerio"),
      // Issue #176: runAnalysis(app)が import する core のサブパス(@keiba/core/pipeline ほか)。tsconfig の paths・wrangler.toml の [alias] と同じ対応。
      "@keiba/core": here("../packages/core/src"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // タイムアウト(テスト・フックとも 30 秒): cloud のテストは、パイプライン全体や本物の workerd(ローカルの D1・R2)を走らせるため、1 本 1〜4 秒かかる
    // (手元で、race-day-pre-race.test.ts の「失敗が続けば…」が約 4 秒)。CI では並列で遅くなり、6b6de58 の run で既定の 5 秒を超えた(Test timed out in 5000ms)。
    // テストの内容・期待値は変えない。特定のテストだけでなく、cloud の設定全体で扱う(テストが増えるたびに並列の負荷が上がるため)。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
