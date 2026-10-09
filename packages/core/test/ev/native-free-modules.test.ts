import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #168(#163-a)AC-a3: 切り出した新しいファイルが better-sqlite3 に依存しないことを、機械的に固定する。
 *
 * 理由: クラウド版(cloud/。Cloudflare Workers)は core を相対 import で取り込む。better-sqlite3 は
 * ネイティブ依存で Workers では動かず、**1つでも runtime の import が残るとバンドル(wrangler deploy)が壊れる**。
 * 型だけの import(`import type`)はビルドで消えるので問題ないが、値の import は伝播する
 * (A が B を import し、B が better-sqlite3 を import するなら A も NG)ため、**相対 import の閉包**まで辿って検査する。
 *
 * 検査は文字列の走査(コメントを除いた import / export-from / 動的 import / require の指定子)で、
 * ファイル内に better-sqlite3 の指定子が1つでもあれば NG とする(`import type` も含めて保守的に弾く)。
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** コメント(ブロック・行)を取り除く。文字列リテラル中の `//`(URL など)を壊さないよう、行頭・空白直後の `//` だけを対象にする。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

interface ImportRef {
  readonly specifier: string;
  /** `import type` / `export type` のみ(ビルドで消える)。 */
  readonly typeOnly: boolean;
}

/** import / export-from / 動的 import / require の指定子を集める。 */
export function importRefs(source: string): ImportRef[] {
  const code = stripComments(source);
  const refs: ImportRef[] = [];
  const staticRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of code.matchAll(staticRe)) {
    // `export const x = "..."` などを拾わないよう、`from` を伴うか副作用 import(import "x")のものに限る。
    const head = m[0];
    if (m[1] === "export" && !/\sfrom\s/.test(head)) {
      continue;
    }
    refs.push({ specifier: m[3]!, typeOnly: m[2] !== undefined });
  }
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.push({ specifier: m[1]!, typeOnly: false });
  }
  return refs;
}

export function mentionsNative(source: string): boolean {
  return importRefs(source).some((r) => r.specifier === "better-sqlite3");
}

/** 相対指定子を src 配下の実ファイル(.ts)へ解決する。 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 起点から、値の相対 import の閉包を辿る(既定では `import type` は辿らない)。native を持つファイルを返す。
 * `followTypes: true` のときは型だけの import(`import type`・`export type`)も辿る(型検査が better-sqlite3 の型を解決しに行く経路まで検査する)。
 */
export function closureOf(
  entry: string,
  options: { readonly followTypes?: boolean } = {},
): { visited: string[]; offenders: string[] } {
  const visited: string[] = [];
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.includes(file)) {
      continue;
    }
    visited.push(file);
    const source = readFileSync(file, "utf-8");
    if (mentionsNative(source)) {
      offenders.push(path.relative(SRC, file));
    }
    for (const ref of importRefs(source)) {
      if (ref.typeOnly && options.followTypes !== true) {
        continue;
      }
      const resolved = resolveRelative(file, ref.specifier);
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  return { visited, offenders };
}

describe("検出器の自己検査(空振りを防ぐ)", () => {
  it.each([
    ['import Database from "better-sqlite3";', true],
    ['import type Database from "better-sqlite3";', true],
    ["import Database from 'better-sqlite3'", true],
    ['import {\n  a,\n  b,\n} from "better-sqlite3";', true],
    ['import "better-sqlite3";', true],
    ['export { x } from "better-sqlite3";', true],
    ['const d = await import("better-sqlite3");', true],
    ['const d = require("better-sqlite3");', true],
    ['// import Database from "better-sqlite3";', false],
    ['/* import Database from "better-sqlite3"; */', false],
    [' * better-sqlite3 に依存しない', false],
    ['const NAME = "better-sqlite3";', false],
    ['import { a } from "./other.js";', false],
    ['export const x = 1;', false],
  ])("%j → better-sqlite3 を指す: %s", (source, expected) => {
    expect(mentionsNative(source)).toBe(expected);
  });

  it("コメント除去は、文字列中の // (URL)を壊さない", () => {
    const source = 'const u = "https://example.com/x"; import X from "better-sqlite3";';
    expect(mentionsNative(source)).toBe(true);
  });

  it("対照: 既存の cache.ts と analysis-store.ts は better-sqlite3 を import している(検出器が実物で効く)", () => {
    expect(closureOf(path.join(SRC, "scraper", "cache.ts")).offenders).toContain(path.join("scraper", "cache.ts"));
    expect(closureOf(path.join(SRC, "ev", "analysis-store.ts")).offenders).toContain(
      path.join("ev", "analysis-store.ts"),
    );
  });

  it("対照: native を持つファイルを値で import するファイル(バレル index.ts)は、閉包で NG になる(伝播を検出できる)", () => {
    // index.ts は cache.ts・analysis-store.ts を値で再 export する。cloud がバレルを import してはいけない理由でもある。
    const { offenders } = closureOf(path.join(SRC, "index.ts"));
    expect(offenders).toContain(path.join("scraper", "cache.ts"));
    expect(offenders).toContain(path.join("ev", "analysis-store.ts"));
  });

  it("対照: 型だけを import する verify.ts(`import type`)は NG にならない(型の import は辿らない)", () => {
    expect(closureOf(path.join(SRC, "ev", "verify.ts")).offenders).toEqual([]);
  });
});

const NATIVE_FREE_MODULES = [
  path.join("scraper", "cached-fetcher.ts"),
  path.join("ev", "analysis-store-types.ts"),
  path.join("ev", "analysis-store-codec.ts"),
  // Issue #207(#182-A): 結果の取込フロー(app から core へ移した。クラウド版が相対 import で取り込む)。
  path.join("ev", "result-import.ts"),
];

describe("切り出した新モジュールは better-sqlite3 に依存しない(cloud のバンドルに入れられる)", () => {
  it.each(NATIVE_FREE_MODULES)("%s は実在し、相対 import の閉包にも better-sqlite3 が無い", (relative) => {
    const entry = path.join(SRC, relative);
    expect(existsSync(entry), `${relative} が存在する`).toBe(true);
    const { visited, offenders } = closureOf(entry);
    expect(visited.length).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });

  it("codec・型・CachedFetcher の3ファイルとも、exe の SQLite 実装(cache.ts・analysis-store.ts)を値で import しない", () => {
    for (const relative of NATIVE_FREE_MODULES) {
      const { visited } = closureOf(path.join(SRC, relative));
      const names = visited.map((f) => path.relative(SRC, f));
      expect(names, relative).not.toContain(path.join("scraper", "cache.ts"));
      expect(names, relative).not.toContain(path.join("ev", "analysis-store.ts"));
    }
  });
});

/**
 * Issue #176(#164-a): runAnalysis をクラウドに載せるための狭い入口 `@keiba/core/pipeline`(`src/pipeline.ts`)。
 * バレル(index.ts)は cache.ts・analysis-store.ts を巻き込む。この入口は、**型だけの import も含めて**
 * better-sqlite3 に依存するモジュールを経由しない(cloud の型検査は CI で packages/core/node_modules が無く、型でも
 * better-sqlite3 を解決しに行くと失敗するため)。
 */
describe("狭い入口 @keiba/core/pipeline(Issue #176)", () => {
  const entry = path.join(SRC, "pipeline.ts");

  it("src/pipeline.ts が実在し、閉包(型だけの import も辿る)に better-sqlite3 が無い。バレル・cache.ts・analysis-store.ts も経由しない", () => {
    expect(existsSync(entry), "src/pipeline.ts が存在する").toBe(true);
    const { visited, offenders } = closureOf(entry, { followTypes: true });
    expect(visited.length).toBeGreaterThan(10); // 前提: 閉包を実際に辿れている(空振りでない)
    expect(offenders).toEqual([]);
    const names = visited.map((f) => path.relative(SRC, f));
    for (const forbidden of ["index.ts", path.join("scraper", "cache.ts"), path.join("ev", "analysis-store.ts")]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("package.json の exports に ./pipeline があり、src/pipeline.ts を指す", () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf-8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./pipeline"]).toBe("./src/pipeline.ts");
  });

  it("対照: 型だけの import を辿る設定では、バレル(index.ts)・analysis-store.ts を経由する入口で better-sqlite3 が現れる(followTypes が実物で効く)", () => {
    expect(closureOf(path.join(SRC, "index.ts"), { followTypes: true }).offenders.length).toBeGreaterThan(0);
    // `import type` だけで analysis-store.ts を指す verify.ts は、既定では NG にならないが、followTypes では NG になる
    expect(closureOf(path.join(SRC, "ev", "verify.ts")).offenders).toEqual([]);
    expect(closureOf(path.join(SRC, "ev", "verify.ts"), { followTypes: true }).offenders).toContain(
      path.join("ev", "analysis-store.ts"),
    );
  });
});

/**
 * Issue #193(#179-a): クラウド版の LLM(`@anthropic-ai/sdk`)用の狭い入口 `@keiba/core/llm`(`src/llm.ts`)。
 * `pipeline.ts` に足さない理由: SDK(`anthropic-client.ts`・`model-selection.ts` が値で import)を、runAnalysis の入口(型と純関数だけ)に巻き込まないため。
 * この入口も、**型だけの import も含めて** better-sqlite3 に依存するモジュールを経由しない(cloud の型検査は CI で better-sqlite3 を解決できない)。
 */
describe("狭い入口 @keiba/core/llm(Issue #193)", () => {
  const entry = path.join(SRC, "llm.ts");

  it("src/llm.ts が実在し、閉包(型だけの import も辿る)に better-sqlite3 が無い。バレル・cache.ts・analysis-store.ts も経由しない", () => {
    expect(existsSync(entry), "src/llm.ts が存在する").toBe(true);
    const { visited, offenders } = closureOf(entry, { followTypes: true });
    expect(visited.length).toBeGreaterThan(5); // 前提: 閉包を実際に辿れている(空振りでない)
    expect(offenders).toEqual([]);
    const names = visited.map((f) => path.relative(SRC, f));
    for (const forbidden of ["index.ts", path.join("scraper", "cache.ts"), path.join("ev", "analysis-store.ts")]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("package.json の exports に ./llm があり、src/llm.ts を指す", () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf-8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./llm"]).toBe("./src/llm.ts");
  });

  it("llm.ts は analyze-race・anthropic-client・model-selection を値で辿る(SDK の入口として、実際にそこへ届いている)", () => {
    const { visited } = closureOf(entry);
    const names = visited.map((f) => path.relative(SRC, f));
    for (const required of ["analyzer/analyze-race.ts", "analyzer/anthropic-client.ts", "analyzer/model-selection.ts"]) {
      expect(names, required).toContain(path.join(...required.split("/")));
    }
  });
});

/**
 * Issue #215(#167-A): クラウド移行ファイルの形式。取り込み側(#216。ブラウザと Worker)が import するのは
 * サブパス `@keiba/core/ev/cloud-migration-format` だけで、**この閉包に better-sqlite3・`node:` の組込み・
 * 実 DB の読み出し側(cloud-migration-reader.ts)・バレルが入ってはならない**(過去に `node:zlib` の混入で renderer の CI が落ちた)。
 * 生成器(cloud-migration-lines.ts)も同じ条件を満たす(読み出しはインターフェース越しで、実 DB を知らない)。
 */
describe("移行ファイルの形式 @keiba/core/ev/cloud-migration-format(Issue #215)", () => {
  const FORMAT = path.join("ev", "cloud-migration-format.ts");
  const LINES = path.join("ev", "cloud-migration-lines.ts");
  const READER = path.join("ev", "cloud-migration-reader.ts");

  it.each([FORMAT, LINES])("%s は実在し、閉包(型だけの import も辿る)に better-sqlite3・読み出し側・バレル・analysis-store.ts が無い", (relative) => {
    const entry = path.join(SRC, relative);
    expect(existsSync(entry), `${relative} が存在する`).toBe(true);
    const { visited, offenders } = closureOf(entry, { followTypes: true });
    expect(visited.length).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
    const names = visited.map((f) => path.relative(SRC, f));
    for (const forbidden of ["index.ts", READER, path.join("scraper", "cache.ts"), path.join("ev", "analysis-store.ts")]) {
      expect(names, `${relative} → ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each([FORMAT, LINES])("%s の閉包の import は、すべて相対指定子(node: の組込み・パッケージを一切含まない)", (relative) => {
    const { visited } = closureOf(path.join(SRC, relative), { followTypes: true });
    expect(visited.length).toBeGreaterThanOrEqual(1);
    for (const file of visited) {
      for (const ref of importRefs(readFileSync(file, "utf-8"))) {
        expect(ref.specifier.startsWith("."), `${path.relative(SRC, file)} の import ${ref.specifier}`).toBe(true);
      }
    }
  });

  it("package.json の exports に ./ev/cloud-migration-format があり、src/ev/cloud-migration-format.ts を指す", () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf-8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./ev/cloud-migration-format"]).toBe("./src/ev/cloud-migration-format.ts");
  });

  it("対照: 読み出し側(cloud-migration-reader.ts)は better-sqlite3 を import している(検出器が実物で効く)", () => {
    expect(existsSync(path.join(SRC, READER))).toBe(true);
    expect(closureOf(path.join(SRC, READER), { followTypes: true }).offenders).toContain(READER);
  });
});
