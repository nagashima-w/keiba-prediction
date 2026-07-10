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
//
// 【Electron 内蔵 Node とバンドル依存の engines 不整合に注意】
// 元バグ: core が直接依存していた undici ^8(engines Node>=22.19.0)が Electron 34 の内蔵 Node(20.18.x)と
// 非互換で、undici の fetch を「呼び出す」と Electron 内でのみ実行時失敗した(素の Node22 で回る CI/テストでは
// 検出できない)。core の既定 fetch は動的 import 経由でのみ undici に到達する経路だった。
// 対策は2層:
//   (a) 主: HttpClient / Discord 送信へ Electron の net.fetch を注入(net-fetch-adapter)。Chromium の
//       ネットワークスタックを使い、システムプロキシ・OS TLS に従い、Node バージョンに依存しない。
//   (b) 従: core の undici を cheerio 互換の ^7(undici 7.28, engines Node>=20.18.1)へ整合。ワークスペースが
//       単一の undici 7 へ dedupe されるため、将来 net.fetch 注入を忘れた経路が混入しても Electron 内で壊れない。
// なお cheerio は `import * as undici from "undici"`(eager)で undici を取り込むため、undici を external に
// すると起動時 require が走る。整合後は互換の undici 7 なので external にはせずインライン維持で問題ない。
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
// 注: net.fetch 注入の回帰ガードは、ビルド後バンドルの正規表現走査では実バンドル形態
// (esbuild のインライン化で `require_undici2()` 等になる)と一致せず実効性が無かったため、ここには置かない。
// 代わりに packages/app/test/net-fetch-injection-guard.test.ts が app main のソースを走査し、
// HttpClient / sendDiscordNotification が fetch(net.fetch アダプタ)注入付きで使われることを検証する。

console.log("main / preload のバンドルが完了しました (dist/main, dist/preload)");
