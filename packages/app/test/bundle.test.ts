import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// main プロセスを実際のビルドと同じ設定で esbuild バンドルし(メモリ上・書き出しなし)、
// scorer 設定の narrow import により native 依存(better-sqlite3)が取り込まれないことを検証する。
// バレル(@keiba/core)経由に戻ると ev/scraper 一式が入り、この検証が失敗する。
describe("main バンドルの native 依存除去", () => {
  it("main バンドルに better-sqlite3 への参照が含まれない", async () => {
    const result = await build({
      entryPoints: [path.join(currentDir, "../src/main/main.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      write: false,
      // 実ビルドと同じ external。もし better-sqlite3 が取り込まれていれば
      // require("better-sqlite3") として出力に現れるため、文字列検査で検出できる。
      external: ["electron", "better-sqlite3"],
    });

    const output = result.outputFiles.map((f) => f.text).join("\n");
    expect(output).not.toContain("better-sqlite3");
  });
});
