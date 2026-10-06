import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #175: cloud/src が core の**バレル(`packages/core/src/index.ts`)や、better-sqlite3 に依存するモジュール**(`analysis-store.ts`・`cache.ts` など)を
 * 値で import していないことの静的ガード。バレルは `cache.ts`・`analysis-store.ts` を値で巻き込み、Worker のバンドルに better-sqlite3(ネイティブ)が入る。
 * 検査: cloud/src の各ファイルが(推移的に)値で import する core のモジュールの閉包を取り、(1)バレルを含まない (2)better-sqlite3 を import するモジュールを含まない。
 * バンドルの実物の検査は bundle-guard.test.ts(wrangler の dry-run)が行う。これは、バンドルの前にソースの段階で理由つきで落とすための検査。
 *
 * 限界: import の抽出は正規表現(動的な import の式・require の変数は拾わない)。`import type` は型だけで消えるので閉包に含めない。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_SRC = path.resolve(CLOUD, "..", "packages", "core", "src");

/** ソースから、値として import(または re-export)される指定子を取り出す。`import type`・`export type` は除く。 */
export function valueSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;"']*?\bfrom\s*["']([^"']+)["']/g, // import x from / export * from
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g, // import "x"
    /\bimport\(\s*["']([^"']+)["']\s*\)/g, // import("x")
    /\brequire\(\s*["']([^"']+)["']\s*\)/g, // require("x")
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      found.push(match[1]!);
    }
  }
  return found;
}

/** 相対の指定子を、実在するファイルへ解決する(`.js` は `.ts` に読み替える。ディレクトリは index.ts)。 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts"), base];
  return candidates.find((c) => c.endsWith(".ts") && existsSync(c)) ?? null;
}

interface Closure {
  /** 閉包に入った core のモジュール(絶対パス)。 */
  readonly coreFiles: Set<string>;
  /** 値で import された、相対でない指定子(better-sqlite3・@keiba/core など)。 */
  readonly bareSpecifiers: Set<string>;
}

/** `entries` から値の import を辿り、core のモジュールとパッケージ名の閉包を返す(node_modules の中は辿らない)。 */
export function closureOf(entries: readonly string[]): Closure {
  const coreFiles = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (file.startsWith(CORE_SRC + path.sep)) {
      coreFiles.add(file);
    }
    for (const specifier of valueSpecifiers(readFileSync(file, "utf-8"))) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        if (resolved !== null) {
          queue.push(resolved);
        }
      } else {
        bareSpecifiers.add(specifier);
      }
    }
  }
  return { coreFiles, bareSpecifiers };
}

const cloudSources = readdirSync(path.join(CLOUD, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(CLOUD, "src", f));

describe("valueSpecifiers(import の抽出)", () => {
  it("値の import・re-export・副作用 import・動的 import・require を拾い、import type・export type・コメントの中は拾わない", () => {
    const source = `
import { a } from "./a.js";
import b from "../b";
import type { T } from "./type-only.js";
export * from "./reexport.js";
export type { U } from "./type-reexport.js";
import "./side-effect.js";
const x = await import("./dynamic.js");
const y = require("node:fs");
// import { c } from "./commented.js";
/* import { d } from "./block-commented.js"; */
import {
  multi,
  line,
} from "./multi-line.js";
`;
    const found = valueSpecifiers(source).sort();
    expect(found).toEqual(["./a.js", "../b", "./reexport.js", "./side-effect.js", "./dynamic.js", "node:fs", "./multi-line.js"].sort());
  });
});

describe("cloud/src が core から値で import するもの(Issue #175)", () => {
  const { coreFiles, bareSpecifiers } = closureOf(cloudSources);
  const rel = (f: string): string => path.relative(CORE_SRC, f).split(path.sep).join("/");

  it("前提(空振り防止): cloud/src のファイルがあり、core のモジュールを実際に辿れている(codec・ids・パーサを含む)", () => {
    expect(cloudSources.length).toBeGreaterThan(5);
    const names = [...coreFiles].map(rel);
    expect(names).toContain("ev/analysis-store-codec.ts");
    expect(names).toContain("scraper/ids.ts");
    expect(names).toContain("scraper/parse-shutuba.ts");
    expect(coreFiles.size).toBeGreaterThan(5);
  });

  it("core のバレル(src/index.ts)を値で import していない(推移的にも)。@keiba/core の指定も使っていない", () => {
    expect([...coreFiles].map(rel)).not.toContain("index.ts");
    expect([...bareSpecifiers].filter((s) => s === "@keiba/core" || s.startsWith("@keiba/core/"))).toEqual([]);
  });

  it("better-sqlite3 に依存するモジュール(analysis-store.ts・cache.ts など)を、推移的にも値で import していない", () => {
    const names = [...coreFiles].map(rel);
    expect(names).not.toContain("ev/analysis-store.ts");
    expect(names).not.toContain("scraper/cache.ts");
    expect([...bareSpecifiers]).not.toContain("better-sqlite3");
    for (const file of coreFiles) {
      const specifiers = valueSpecifiers(readFileSync(file, "utf-8"));
      expect(specifiers.filter((s) => s === "better-sqlite3"), rel(file)).toEqual([]);
    }
  });

  it("対照: core のバレルや analysis-store.ts を入口にすると、閉包に better-sqlite3 が現れる(検査が、実際に巻き込まれたときに拾えることの確認)", () => {
    for (const entry of ["ev/analysis-store.ts", "index.ts"]) {
      const closure = closureOf([path.join(CORE_SRC, entry)]);
      expect([...closure.bareSpecifiers], entry).toContain("better-sqlite3");
    }
    // 対照の逆: codec だけを入口にした閉包には、better-sqlite3 が現れない
    expect([...closureOf([path.join(CORE_SRC, "ev", "analysis-store-codec.ts")]).bareSpecifiers]).not.toContain("better-sqlite3");
  });
});
