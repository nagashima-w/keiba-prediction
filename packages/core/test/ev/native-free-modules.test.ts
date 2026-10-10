import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 一時ファイルから対象への import の指定子を、POSIX 区切りの相対パスで作る(Windows でも `closureOf` が辿れる形)。
 * 異なるドライブ(Windows の `C:\\` と `D:\\` など)では相対パスが作れない(`path.relative` が絶対パスを返す)ので、投げる。
 * GitHub の Windows ランナーでは、一時ディレクトリ(C:)とリポジトリ(D:)が別のドライブになりうるため、**一時ファイルはリポジトリの中に作る**(下の対照のテスト)。
 * `pathApi` を差し替えられるのは、Linux 上で Windows のパス(`path.win32`)の挙動を模擬して検査するため。
 */
export function relativeSpecifier(fromDir: string, target: string, pathApi: Pick<typeof path, "relative" | "sep" | "isAbsolute"> = path): string {
  const relative = pathApi.relative(fromDir, target);
  if (pathApi.isAbsolute(relative)) {
    throw new Error(`相対パスを作れません(別のドライブ?): ${fromDir} → ${target}`);
  }
  const posix = relative.split(pathApi.sep).join("/");
  return posix.startsWith(".") ? posix : `./${posix}`;
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
    // `import type` だけで analysis-store.ts を指すファイルは、既定では NG にならないが、followTypes では NG になる。
    // 実在の core のファイルには、もうその形のものが無い(verify.ts・lookahead-suspicion.ts は #219 で analysis-store-types.ts に切り替えた)ので、一時ファイルで作る。
    // 一時ファイルは**リポジトリの中**(このテストの隣)に作る。os の一時ディレクトリだと、Windows の CI ではドライブが別(C: と D:)で相対パスが作れず、辿れない(f98ec2d の CI で失敗した)。
    const dir = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-native-free-"));
    try {
      const entry = path.join(dir, "type-only.ts");
      const specifier = relativeSpecifier(dir, path.join(SRC, "ev", "analysis-store.js"));
      expect(specifier.startsWith("."), "指定子が相対パスで、POSIX 区切りで、バックスラッシュを含まない").toBe(true);
      expect(specifier).not.toContain("\\");
      writeFileSync(entry, `import type { AnalysisStore } from "${specifier}";\nexport type T = AnalysisStore;\n`);
      expect(closureOf(entry).offenders).toEqual([]);
      expect(closureOf(entry, { followTypes: true }).offenders).toContain(path.join("ev", "analysis-store.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("relativeSpecifier: POSIX 区切りの相対パスを作る。Windows のパス(path.win32 で模擬)でも同じドライブなら作れ、別のドライブなら投げる", () => {
    // Linux のパス
    expect(relativeSpecifier("/repo/packages/core/test/ev/.tmp-x", "/repo/packages/core/src/ev/analysis-store.js")).toBe("../../../src/ev/analysis-store.js");
    expect(relativeSpecifier("/repo/a", "/repo/a/b.js")).toBe("./b.js");
    // Windows のパス(path.win32 は Linux でも動く。区切りは \\、ドライブ文字あり)
    const win = path.win32;
    expect(relativeSpecifier("D:\\a\\repo\\packages\\core\\test\\ev\\.tmp-x", "D:\\a\\repo\\packages\\core\\src\\ev\\analysis-store.js", win)).toBe("../../../src/ev/analysis-store.js");
    // 別のドライブ(C: の一時ディレクトリ → D: のリポジトリ)は相対パスにならない=投げる(静かに壊れた指定子を作らない)
    expect(() => relativeSpecifier("C:\\Users\\runner\\AppData\\Local\\Temp\\keiba-x", "D:\\a\\repo\\packages\\core\\src\\ev\\analysis-store.js", win)).toThrow("別のドライブ");
    // 前提(空振り防止): 旧い作り方(os の一時ディレクトリ + split/join)は、別ドライブだと絶対パスのままで、"." で始まらない=辿れない指定子になる
    const old = win.relative("C:\\Temp\\x", "D:\\a\\repo\\src\\ev\\analysis-store.js").split(win.sep).join("/");
    expect(old.startsWith(".")).toBe(false);
  });

  it("Issue #219: 検証の集計(verify.ts)・先読みの判定(lookahead-suspicion.ts)・型の入口(analysis-store-types.ts)は、型だけの import も含めて better-sqlite3 に依存するモジュールを経由しない(クラウドだけを install する CI の型検査が通る)", () => {
    for (const file of ["verify.ts", "lookahead-suspicion.ts", "analysis-store-types.ts"]) {
      const closure = closureOf(path.join(SRC, "ev", file), { followTypes: true });
      expect(closure.visited.length, `${file} の閉包を辿れている`).toBeGreaterThan(1);
      expect(closure.offenders, file).toEqual([]);
    }
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
