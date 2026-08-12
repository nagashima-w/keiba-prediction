/**
 * Issue #38 の再発防止ガード。
 *
 * 経緯: `packages/app/test/investigate-combo-odds-real-fetch.test.ts` が
 * `../../../scripts/investigate-combo-odds-real-fetch.ts` を相対 import していたため、
 * `packages/core/src/**` の src ツリー全体が `packages/app` の TypeScript プログラムに
 * rootDir 外として引き込まれ、`pnpm -r typecheck` が TS6059 を60件出す事故が起きた
 * (`packages/app/tsconfig.json` の `rootDir` は `noEmit: true` 下では TS6059 という表明が
 * 唯一の効果であり、`@keiba/core` の `exports`(renderer が native 依存を巻き込まないよう
 * 狭いサブパスのみ公開する方針)を tsc 側で不可迂回にしている実効的な境界のため)。
 *
 * `packages/app/src/**` と `packages/app/test/**` の全 `.ts`/`.tsx` について、相対 import
 * 指定子(`import`/`export`の`from "..."`・動的`import("...")`・副作用のみの`import "..."`)を
 * ファイル自身のディレクトリ基準で解決し、`packages/app` の外を指すものが0件であることを
 * 構造的に固定する。`readFileSync`等の単なるパス文字列は対象外(import指定子のみを見る)。
 *
 * スコープ外: `packages/core` への同種ガードは今回入れない(boss裁定・Issue #38)。
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(currentDir, "..");
const srcDir = path.join(appRoot, "src");
const testDir = path.join(appRoot, "test");

/** ディレクトリ配下の対象拡張子ファイルを再帰的に読み込み、絶対パス→内容のMapを返す。 */
function readSourceFiles(dir: string, extensions: readonly string[]): Map<string, string> {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  const out = new Map<string, string>();
  for (const rel of entries) {
    if (!extensions.some((ext) => rel.endsWith(ext))) continue;
    const full = path.join(dir, rel);
    out.set(full, readFileSync(full, "utf8"));
  }
  return out;
}

/**
 * ソース1ファイル分の内容から、相対 import 指定子("."で始まるもの)だけを抽出する。
 * `readFileSync`等に渡す単なる文字列は対象外(import/export の `from "..."`、動的
 * `import("...")`、副作用のみの `import "...";` の3形だけを見る)。
 */
export function extractRelativeImportSpecifiers(source: string): string[] {
  // (出現位置, 指定子) を集め、最後にソースの出現順に整列させる
  // (3種のパターンを別々に走査するため、パターンをまたぐと出現順が崩れるのを防ぐ)。
  const found: { index: number; specifier: string }[] = [];

  // `import ... from "..."` / `export ... from "..."`(複数行の分割importも対象。
  // `[^;]*?` により文の区切り(セミコロン)を越えて次の import 文へブリッジしないようにする)。
  const fromPattern = /\b(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(fromPattern)) {
    const spec = m[1];
    if (spec !== undefined) found.push({ index: m.index, specifier: spec });
  }

  // 動的 `import("...")`。
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(dynamicPattern)) {
    const spec = m[1];
    if (spec !== undefined) found.push({ index: m.index, specifier: spec });
  }

  // 副作用のみの `import "...";`("from"を伴わない形)。
  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']\s*;/gm;
  for (const m of source.matchAll(sideEffectPattern)) {
    const spec = m[1];
    if (spec !== undefined) found.push({ index: m.index, specifier: spec });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.specifier)
    .filter((spec) => spec.startsWith("./") || spec.startsWith("../"));
}

/**
 * 各ファイルの相対 import 指定子を自身のディレクトリ基準で解決し、`scopeRoot` の外を
 * 指しているものを列挙する。
 */
function findOutOfScopeRelativeImports(
  files: ReadonlyMap<string, string>,
  scopeRoot: string,
): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  for (const [filePath, content] of files) {
    for (const specifier of extractRelativeImportSpecifiers(content)) {
      const resolved = path.resolve(path.dirname(filePath), specifier);
      const rel = path.relative(scopeRoot, resolved);
      const isOutOfScope = rel === "" ? false : rel.startsWith("..") || path.isAbsolute(rel);
      if (isOutOfScope) {
        violations.push({ file: filePath, specifier });
      }
    }
  }
  return violations;
}

describe("extractRelativeImportSpecifiers(テストヘルパーの自己検証)", () => {
  it("単一行の named import から相対指定子を抽出すること", () => {
    const source = 'import { IPC_CHANNELS } from "../src/shared/channels.js";';
    expect(extractRelativeImportSpecifiers(source)).toEqual(["../src/shared/channels.js"]);
  });

  it("複数行に分割された import からも相対指定子を抽出すること", () => {
    const source = [
      "import {",
      "  A,",
      "  B,",
      '} from "../shared/analysis-types.js";',
    ].join("\n");
    expect(extractRelativeImportSpecifiers(source)).toEqual(["../shared/analysis-types.js"]);
  });

  it("import attributes(with構文)付きの import からも相対指定子を抽出すること", () => {
    const source =
      'import NATIVE_EXTERNALS from "../scripts/externals.json" with { type: "json" };';
    expect(extractRelativeImportSpecifiers(source)).toEqual(["../scripts/externals.json"]);
  });

  it("動的importからも相対指定子を抽出すること", () => {
    const source = 'const mod = await import("../shared/foo.js");';
    expect(extractRelativeImportSpecifiers(source)).toEqual(["../shared/foo.js"]);
  });

  it("非相対(パッケージ名・エイリアス)のimportは対象外にすること", () => {
    const source = [
      'import { describe } from "vitest";',
      'import { parseRaceId } from "@keiba/core";',
    ].join("\n");
    expect(extractRelativeImportSpecifiers(source)).toEqual([]);
  });

  it("fromを伴わない副作用のみの相対importからも指定子を抽出すること", () => {
    const source = 'import "./polyfill.js";';
    expect(extractRelativeImportSpecifiers(source)).toEqual(["./polyfill.js"]);
  });

  it("fromを持たない先行するimport文が、後続のimport文のfromへブリッジしないこと", () => {
    const source = ['import "./polyfill.js";', 'import { X } from "../shared/foo.js";'].join(
      "\n",
    );
    expect(extractRelativeImportSpecifiers(source)).toEqual([
      "./polyfill.js",
      "../shared/foo.js",
    ]);
  });

  it("importを含まないソースからは何も抽出しないこと(空振り防止: 前提として非空ソースを渡す)", () => {
    const source = "export const X = 1;\n";
    expect(source.length).toBeGreaterThan(0);
    expect(extractRelativeImportSpecifiers(source)).toEqual([]);
  });
});

describe("packages/appの相対importがpackages/appの外を指していないこと(Issue #38再発防止)", () => {
  it("src/配下・test/配下(.ts/.tsx)の相対importをすべて解決しても、packages/appの外を指すものが0件であること", () => {
    const files = new Map([
      ...readSourceFiles(srcDir, [".ts", ".tsx"]),
      ...readSourceFiles(testDir, [".ts", ".tsx"]),
    ]);
    // 前提固定: 走査対象が実在すること(空振り防止。0件のMapに対して0件の違反を主張しても無意味)。
    expect(files.size).toBeGreaterThan(0);

    const violations = findOutOfScopeRelativeImports(files, appRoot);
    expect(violations).toEqual([]);
  });
});
