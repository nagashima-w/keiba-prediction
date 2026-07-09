import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// レンダラー(React)のビルド設定。
// - base: "./" … electron が file:// で index.html を読むため相対パスにする。
// - outDir: dist/renderer … main プロセスからの相対パス(../renderer/index.html)に合わせる。
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
});
