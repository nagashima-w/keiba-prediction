// アプリアイコン生成スクリプト。
//
// packages/app/build/icon.svg(デザインソース)を、配布に必要なラスタ形式へ変換する:
//   - packages/app/build/icon.ico … Windows exe/ウィンドウ用のマルチ解像度アイコン(electron-builder が参照)
//   - packages/app/build/icon.png … 1024px の PNG(汎用・ドキュメント用)
//
// システム依存(ImageMagick 等)を避けるため、ラスタライズは @resvg/resvg-js(Rust製・prebuilt)、
// ICO パックは png-to-ico(純JS)を用いる。いずれも devDependency で、実行時依存は増やさない。
// 生成物(ico/png)はリポジトリにコミットするため、通常のビルド/CI ではこのスクリプトは走らせない。
//
// 使い方: リポジトリルートで `pnpm gen:icon`。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../packages/app/build");
const svg = readFileSync(resolve(buildDir, "icon.svg"));

/** 指定幅で SVG を PNG バッファにレンダリングする。 */
function renderPng(width) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  return r.render().asPng();
}

// Windows の .ico に含める解像度(小さいタスクバー表示から大アイコンまで)。
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map(renderPng);
const ico = await pngToIco(icoPngs);
writeFileSync(resolve(buildDir, "icon.ico"), ico);

// 汎用 PNG(1024px)。
writeFileSync(resolve(buildDir, "icon.png"), renderPng(1024));

console.log(`generated: icon.ico (${icoSizes.join(",")}px), icon.png (1024px)`);
