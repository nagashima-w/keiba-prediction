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
 * 走査対象は `packages/app/src`・`packages/app/test` の**ハードコードではなく**、
 * `packages/app/tsconfig.json` の `include` 配列そのものから導出する(TypeScript コンパイラ
 * (`typescript`パッケージ)の `parseConfigFileTextToJson` で実際に tsconfig.json をパースする。
 * 独自の JSONC パーサを持たない)。`include` が将来増減しても、tsc が rootDir 判定に使う入力と
 * このガードの走査対象が乖離しない構造にするため(以前のバージョンは `src`/`test` の2エントリを
 * 決め打ちしており、`vite.config.ts`/`vitest.config.ts`(`include` の残り3エントリ)を素通し
 * していた。code-reviewer 指摘)。
 *
 * `include` の各エントリについて、全 `.ts`/`.tsx` の相対 import 指定子(`import`/`export`の
 * `from "..."`・動的`import("...")`・副作用のみの`import "..."`)をファイル自身のディレクトリ
 * 基準で解決し、`packages/app` の外を指すものが0件であることを構造的に固定する。
 * `readFileSync`等の単なるパス文字列は対象外(import指定子のみを見る)。
 * triple-slash reference directive(`/// <reference path="..." />`)は対象外
 * (現時点でリポジトリ内に使用例が0件のため実害は無いが、将来 `.d.ts` を追加する際の
 * 抜け穴になりうる。実装は変更しない)。
 *
 * スコープ外: `packages/core` への同種ガードは今回入れない(boss裁定・Issue #38)。
 *
 * 【Issue #57 で追記】上記は package 境界(`packages/app` の外を指さないこと)のガードであり、
 * `packages/app` 内部の層(`shared`/`renderer`/`main`)の向きは別問題として最下部の describe で
 * 追加した(「`shared/**` の相対 import を自身のディレクトリ基準で解決すると、すべて
 * `packages/app/src/shared` 配下を指す」)。パーサ(`extractRelativeImportSpecifiers`)・
 * 判定ロジック(`findOutOfScopeRelativeImports`)は複製せず、`scopeRoot` を差し替えて再利用する。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(currentDir, "..");
const tsconfigPath = path.join(appRoot, "tsconfig.json");

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
 * `packages/app/tsconfig.json` の `include` 配列を、TypeScript コンパイラ自身のパーサで
 * 読み取る(tsconfig.json は `//` コメントを含む JSONC のため、素の `JSON.parse` では読めない。
 * 独自のJSONCパーサを実装せず、tsc が実際に使うのと同じパーサを使うことで、パース結果の
 * 乖離そのものをあり得なくする)。
 */
function loadTsconfigIncludeEntries(configPath: string): string[] {
  const text = readFileSync(configPath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(configPath, text);
  if (parsed.error !== undefined) {
    throw new Error(`tsconfig.json のパースに失敗しました: ${configPath}`);
  }
  const include: unknown = parsed.config?.include;
  if (!Array.isArray(include) || !include.every((e) => typeof e === "string")) {
    throw new Error(`tsconfig.json に include 配列がありません: ${configPath}`);
  }
  return include as string[];
}

/**
 * tsconfig.json の `include` エントリ(ディレクトリ・単一ファイルが混在する)から、
 * 対象拡張子のソースファイルをすべて読み込む。ディレクトリは再帰的に走査し、
 * 単一ファイルはそのエントリ自体を対象拡張子かどうかで判定する。
 */
function collectScopedSourceFiles(
  rootDir: string,
  includeEntries: readonly string[],
  extensions: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of includeEntries) {
    const full = path.join(rootDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      for (const [file, content] of readSourceFiles(full, extensions)) {
        out.set(file, content);
      }
    } else if (stat.isFile() && extensions.some((ext) => full.endsWith(ext))) {
      out.set(full, readFileSync(full, "utf8"));
    }
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
export function findOutOfScopeRelativeImports(
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

describe("走査対象がtsconfig.jsonのincludeから正しく導出されること(code-reviewer指摘: src/testの決め打ちを解消)", () => {
  it("packages/app/tsconfig.jsonのincludeが現在の5エントリと一致すること(前提固定・空振り防止)", () => {
    // このassert自体はincludeが変わったら追随して直す必要があるが、走査ロジック
    // (collectScopedSourceFiles)側は決め打ちではなくincludeを直接読むため、
    // このテストを更新し忘れても本体の再発防止機能(下のdescribe)は追随し続ける。
    const includeEntries = loadTsconfigIncludeEntries(tsconfigPath);
    expect(includeEntries).toEqual(["src", "test", "scripts", "vite.config.ts", "vitest.config.ts"]);
  });

  it("include配列の全エントリ(ディレクトリ+設定ファイル単体)が走査対象ファイル集合に反映されること", () => {
    const includeEntries = loadTsconfigIncludeEntries(tsconfigPath);
    const files = collectScopedSourceFiles(appRoot, includeEntries, [".ts", ".tsx"]);

    // 決め打ちのsrc/testだけを見ていた旧実装だと、以下の2つの単一ファイルエントリは
    // 走査対象に入らない(code-reviewerが実証したギャップそのもの)。ここで直接
    // 存在を固定することで、将来再びsrc/testの決め打ちに戻す変更をRedにする。
    expect(files.has(path.join(appRoot, "vite.config.ts"))).toBe(true);
    expect(files.has(path.join(appRoot, "vitest.config.ts"))).toBe(true);
    // src/testも引き続き含まれること(範囲を広げただけで、既存の走査が失われていないこと)。
    expect(
      [...files.keys()].some((f) => f.startsWith(path.join(appRoot, "src") + path.sep)),
    ).toBe(true);
    expect(
      [...files.keys()].some((f) => f.startsWith(path.join(appRoot, "test") + path.sep)),
    ).toBe(true);
  });
});

describe("packages/appの相対importがpackages/appの外を指していないこと(Issue #38再発防止)", () => {
  it("tsconfig.jsonのinclude全エントリ(.ts/.tsx)の相対importをすべて解決しても、packages/appの外を指すものが0件であること", () => {
    const includeEntries = loadTsconfigIncludeEntries(tsconfigPath);
    const files = collectScopedSourceFiles(appRoot, includeEntries, [".ts", ".tsx"]);
    // 前提固定: 走査対象が実在すること(空振り防止。0件のMapに対して0件の違反を主張しても無意味)。
    expect(files.size).toBeGreaterThan(0);

    const violations = findOutOfScopeRelativeImports(files, appRoot);
    expect(violations).toEqual([]);
  });
});

/**
 * Issue #57: 層内の逆依存ガード(`shared` → `renderer`/`main`)。
 *
 * ルール: `packages/app/src/shared/**` の相対 import 指定子を自身のディレクトリ基準で
 * 解決すると、すべて `packages/app/src/shared` 配下を指す(非相対 import は
 * `extractRelativeImportSpecifiers` が既に除外済みのため対象外)。`renderer`/`main` を
 * 名指しする言い回しにしないことで、将来 `preload` 等の層が増えても列挙漏れなく機能する。
 *
 * 検出器(パーサ+判定ロジック)は複製しない。上の2つのdescribeが使っている
 * `extractRelativeImportSpecifiers`・`findOutOfScopeRelativeImports` を、`scopeRoot` を
 * `packages/app/src/shared` に差し替えてそのまま再利用する。
 */
describe("shared配下の相対importがshared配下の外を指していないこと(Issue #57)", () => {
  const sharedDir = path.join(appRoot, "src", "shared");

  describe("合成Mapに対するpositive control(検出器が生きていることの常設証拠。M1〜M4)", () => {
    // 「toEqual([])だけのテスト」は検出器自体を壊しても永久に緑になる(boss裁定)。
    // 実際に違反を含む合成入力を用意し、検出器が違反を検知できることを常に固定する。
    it("M1: 型import(renderer)を含む合成ファイルが違反として検出されること", () => {
      const files = new Map([
        [
          path.join(sharedDir, "analysis-types.ts"),
          'import type { X } from "../renderer/verify-format.js";',
        ],
      ]);
      const violations = findOutOfScopeRelativeImports(files, sharedDir);
      expect(violations).toEqual([
        { file: path.join(sharedDir, "analysis-types.ts"), specifier: "../renderer/verify-format.js" },
      ]);
    });

    it("M2: 値import(renderer)を含む合成ファイルが違反として検出されること", () => {
      const files = new Map([
        [
          path.join(sharedDir, "analysis-types.ts"),
          'import { formatYen } from "../renderer/verify-format.js";',
        ],
      ]);
      const violations = findOutOfScopeRelativeImports(files, sharedDir);
      expect(violations).toEqual([
        { file: path.join(sharedDir, "analysis-types.ts"), specifier: "../renderer/verify-format.js" },
      ]);
    });

    it("M3: 動的import(main)を含む合成ファイルが違反として検出されること", () => {
      const files = new Map([
        [path.join(sharedDir, "analysis-types.ts"), 'const m = await import("../main/logger.js");'],
      ]);
      const violations = findOutOfScopeRelativeImports(files, sharedDir);
      expect(violations).toEqual([
        { file: path.join(sharedDir, "analysis-types.ts"), specifier: "../main/logger.js" },
      ]);
    });

    it("M4: 副作用のみのimport(main)を含む合成ファイルが違反として検出されること", () => {
      const files = new Map([
        [path.join(sharedDir, "analysis-types.ts"), 'import "../main/logger.js";'],
      ]);
      const violations = findOutOfScopeRelativeImports(files, sharedDir);
      expect(violations).toEqual([
        { file: path.join(sharedDir, "analysis-types.ts"), specifier: "../main/logger.js" },
      ]);
    });

    it("誤検知しないこと(shared内の兄弟import・非相対importは違反にならない)", () => {
      const files = new Map([
        [
          path.join(sharedDir, "analysis-types.ts"),
          [
            'import type { X } from "./settings.js";',
            'import { allocateBets } from "@keiba/core/ev/bet-allocation";',
            'import { readFileSync } from "node:fs";',
            'import { useState } from "react";',
          ].join("\n"),
        ],
      ]);
      expect(findOutOfScopeRelativeImports(files, sharedDir)).toEqual([]);
    });
  });

  it("実ファイル走査: shared配下が空でなく、shared/analysis-types.tsが走査対象に含まれること(空振り防止)", () => {
    const files = readSourceFiles(sharedDir, [".ts"]);
    expect(files.size).toBeGreaterThan(0);
    expect(files.has(path.join(sharedDir, "analysis-types.ts"))).toBe(true);
  });

  it("shared配下(.ts)の相対importをすべて解決しても、shared配下の外を指すものが0件であること", () => {
    const files = readSourceFiles(sharedDir, [".ts"]);
    const violations = findOutOfScopeRelativeImports(files, sharedDir);
    expect(violations).toEqual([]);
  });
});
