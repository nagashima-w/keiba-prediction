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
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
