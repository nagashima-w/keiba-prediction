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

// external 指定は bundle.test.ts と共有(externals.json)してドリフトを防ぐ。
const NATIVE_EXTERNALS = JSON.parse(
  await readFile(new URL("./externals.json", import.meta.url), "utf8"),
);

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: NATIVE_EXTERNALS,
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

// 回帰防止のガード: main は分析パイプラインで better-sqlite3 を正当に使うため、external の
// require として維持されていること(= asarUnpack 同梱の前提が保たれること)を確認する。
// external から外して誤ってインライン展開しようとすると、esbuild が .node バインディングを
// バンドルできず build 自体が失敗するため、ここでは「external require が残っていること」を保証する。
const mainBundle = await readFile("dist/main/main.cjs", "utf8");
if (!/require\(["']better-sqlite3["']\)/.test(mainBundle)) {
  throw new Error(
    "dist/main/main.cjs に better-sqlite3 の external require が見当たりません。" +
      "external 指定(build-electron.mjs / electron-builder.yml の asarUnpack)が壊れていないか確認してください。",
  );
}

console.log("main / preload のバンドルが完了しました (dist/main, dist/preload)");
