// Electron の main / preload プロセスを esbuild で CommonJS(.cjs)にバンドルするスクリプト。
//
// なぜ esbuild で CJS 化するか:
// - プロジェクトは ESM("type": "module")だが、sandbox 有効の preload は CommonJS が必要。
//   main も含めて .cjs に統一することで ESM/CJS 混在の実行時トラブルを避ける。
// - @keiba/core(ESM)を main へインライン取り込みできるため、配布物に core を別途含めなくてよい。
//
// external 指定:
// - electron … 実行環境が提供するため常に external。
// - better-sqlite3 … ネイティブモジュール。バンドルせず node_modules から実行時 require し、
//   electron-builder が Windows 向けに rebuild + 同梱する。
import { readFile } from "node:fs/promises";

import { build } from "esbuild";

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "better-sqlite3"],
};

await build({
  ...common,
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main/main.cjs",
});

await build({
  ...common,
  entryPoints: ["src/preload/preload.ts"],
  outfile: "dist/preload/preload.cjs",
});

// 回帰防止のガード: DB 未使用の骨格段階では main に better-sqlite3 の require が残ってはならない
// (バレル import への逆戻りで native 依存を巻き込むとここで気づける)。
const mainBundle = await readFile("dist/main/main.cjs", "utf8");
if (mainBundle.includes("better-sqlite3")) {
  throw new Error(
    "dist/main/main.cjs に better-sqlite3 への参照が含まれています。" +
      "@keiba/core のバレル import ではなく narrow import(@keiba/core/scorer/config)を使ってください。",
  );
}

console.log("main / preload のバンドルが完了しました (dist/main, dist/preload)");
