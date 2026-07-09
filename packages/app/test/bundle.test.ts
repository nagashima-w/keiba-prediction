import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// external 指定は build-electron.mjs と共有(externals.json)してドリフトを防ぐ。
import NATIVE_EXTERNALS from "../scripts/externals.json" with { type: "json" };

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// Phase4 以降、main プロセスは分析パイプライン(analysis-pipeline / pipeline-deps)で
// better-sqlite3(SQLiteキャッシュ・分析ストア)を正当に利用する。ネイティブモジュールは
// バンドルできないため external に指定し、node_modules から実行時 require + electron-builder が
// asarUnpack で同梱する前提とする。本テストの検証内容は骨格段階の
// 「native 依存がバンドルに入らないこと」から、Phase4 の
// 「better-sqlite3 が external の require として維持され、asarUnpack 同梱の前提が保たれること」へ更新した。
describe("main バンドルの native 依存(better-sqlite3)の external 維持", () => {
  it("main バンドルは better-sqlite3 を external の require として参照する(インライン展開しない)", async () => {
    const result = await build({
      entryPoints: [path.join(currentDir, "../src/main/main.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      write: false,
      // 実ビルド(build-electron.mjs)と同じ external 指定(externals.json を共有)。
      external: NATIVE_EXTERNALS,
    });

    const output = result.outputFiles.map((f) => f.text).join("\n");
    // external が維持されていれば、素の require("better-sqlite3") としてのみ現れる
    // (ネイティブ .node バインディングはバンドルに取り込まれない)。
    expect(output).toMatch(/require\(["']better-sqlite3["']\)/);
  });

  it("electron-builder.yml が better-sqlite3 を asarUnpack で同梱する設定を持つ", () => {
    const yml = readFileSync(
      path.join(currentDir, "../electron-builder.yml"),
      "utf8",
    );
    // asarUnpack セクションに better-sqlite3 の展開グロブがあること
    // (external require の解決先を asar 外に確保するための前提)。
    expect(yml).toContain("asarUnpack:");
    expect(yml).toMatch(/node_modules\/better-sqlite3/);
  });
});
