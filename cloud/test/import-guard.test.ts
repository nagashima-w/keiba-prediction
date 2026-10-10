import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * ソースから、値として import(または re-export)される指定子を取り出す。`import type`・`export type` は除く。
 * `includeTypes: true` のときは型だけの import・re-export も含める(型検査が解決しに行く経路。CI では packages/core/node_modules が無く、
 * 型だけの import でも better-sqlite3 などを解決しに行くと失敗するため。Issue #176)。
 */
export function valueSpecifiers(source: string, options: { readonly includeTypes?: boolean } = {}): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const found: string[] = [];
  const typeGuard = options.includeTypes === true ? "" : "(?!type\\b)";
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:import|export)\\s+${typeGuard}[^;"']*?\\bfrom\\s*["']([^"']+)["']`, "g"), // import x from / export * from
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

/** core の package.json の `exports`(サブパス → ファイル)。`@keiba/core/<サブパス>` の解決に使う(wrangler.toml の [alias]・tsconfig の paths と同じ対応)。 */
const CORE_EXPORTS = (
  JSON.parse(readFileSync(path.join(CORE_SRC, "..", "package.json"), "utf-8")) as { exports: Record<string, string> }
).exports;

/** `@keiba/core/<サブパス>` を core のファイルへ解決する。exports に無いサブパス・バレル(`@keiba/core` そのもの)は null。 */
export function resolveCoreSubpath(specifier: string): string | null {
  if (!specifier.startsWith("@keiba/core/")) {
    return null;
  }
  const target = CORE_EXPORTS[`./${specifier.slice("@keiba/core/".length)}`];
  return target === undefined ? null : path.resolve(CORE_SRC, "..", target);
}

interface Closure {
  /** 閉包に入った core のモジュール(絶対パス)。 */
  readonly coreFiles: Set<string>;
  /** 閉包に入った app(packages/app/src)のモジュール(絶対パス)。runAnalysis を相対 import で取り込むため(Issue #176)。 */
  readonly appFiles: Set<string>;
  /** 値で import された、相対でない指定子(better-sqlite3・@keiba/core など。解決できた `@keiba/core/<サブパス>` は含めない)。 */
  readonly bareSpecifiers: Set<string>;
  /** 解決できなかった `@keiba/core/...` の指定子(exports に無いサブパス)。 */
  readonly unresolvedCoreSpecifiers: Set<string>;
}

const APP_SRC = path.resolve(CLOUD, "..", "packages", "app", "src");

/**
 * `entries` から値の import を辿り、core・app のモジュールとパッケージ名の閉包を返す(node_modules の中は辿らない)。
 * `includeTypes: true` なら型だけの import も辿る(型検査が解決しに行く経路)。
 */
export function closureOf(entries: readonly string[], options: { readonly includeTypes?: boolean } = {}): Closure {
  const coreFiles = new Set<string>();
  const appFiles = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const unresolvedCoreSpecifiers = new Set<string>();
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
    if (file.startsWith(APP_SRC + path.sep)) {
      appFiles.add(file);
    }
    for (const specifier of valueSpecifiers(readFileSync(file, "utf-8"), options)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        if (resolved !== null) {
          queue.push(resolved);
        }
      } else if (specifier.startsWith("@keiba/core/")) {
        const resolved = resolveCoreSubpath(specifier);
        if (resolved === null) {
          unresolvedCoreSpecifiers.add(specifier);
        } else {
          queue.push(resolved);
        }
      } else {
        bareSpecifiers.add(specifier);
      }
    }
  }
  return { coreFiles, appFiles, bareSpecifiers, unresolvedCoreSpecifiers };
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

describe("cloud/src が core から値で import するもの(Issue #175・#176)", () => {
  const { coreFiles, bareSpecifiers, unresolvedCoreSpecifiers } = closureOf(cloudSources);
  const rel = (f: string): string => path.relative(CORE_SRC, f).split(path.sep).join("/");

  it("前提(空振り防止): cloud/src のファイルがあり、core のモジュールを実際に辿れている(codec・ids・パーサ・狭い入口 pipeline を含む)", () => {
    expect(cloudSources.length).toBeGreaterThan(5);
    const names = [...coreFiles].map(rel);
    expect(names).toContain("ev/analysis-store-codec.ts");
    expect(names).toContain("scraper/ids.ts");
    expect(names).toContain("scraper/parse-shutuba.ts");
    expect(names).toContain("pipeline.ts"); // runAnalysis(src/pipeline.ts 経由)が使う狭い入口まで辿れている
    expect(names).toContain("llm.ts"); // LLM の狭い入口(src/llm-sender.ts 経由。Issue #193)まで辿れている
    expect(names).toContain("analyzer/anthropic-client.ts"); // SDK を値で import するモジュールまで届いている(better-sqlite3 は無い、は下の検査)
    expect(coreFiles.size).toBeGreaterThan(5);
  });

  it("core のバレル(src/index.ts)を値で import していない(推移的にも)。`@keiba/core` そのもの(バレル)の指定も、exports に無いサブパスも使っていない", () => {
    expect([...coreFiles].map(rel)).not.toContain("index.ts");
    expect([...bareSpecifiers].filter((s) => s === "@keiba/core")).toEqual([]);
    expect([...unresolvedCoreSpecifiers]).toEqual([]);
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

/** cloud が依存に持つもの(完全一致のパッケージ名・`node:`・`cloudflare:`・`@cloudflare/` の型)だけを許可する。Issue #193 で `@anthropic-ai/sdk`(完全一致)を足した。 */
function isAllowedBareSpecifier(s: string): boolean {
  return (
    ["cheerio", "iconv-lite", "undici", "jose", "@anthropic-ai/sdk"].includes(s) ||
    s.startsWith("node:") ||
    s.startsWith("cloudflare:") ||
    s.startsWith("@cloudflare/")
  );
}

/**
 * Issue #176(#164-a): 型だけの import も含めた閉包の検査。cloud の型検査(tsc)は、CI では 各 package の node_modules が無い配置で動く。
 * 型だけの import(`import type`・`export type`)でも、better-sqlite3 などを解決しに行くと TS2307 で失敗する(`@anthropic-ai/sdk` は Issue #193 で cloud の依存に足した)。
 * だから、型を含めた閉包でも、cloud が持っている依存(cheerio・iconv-lite・jose・@anthropic-ai/sdk・Node の組込み・cloudflare:*)の外を指さないこと。
 */
describe("cloud/src の閉包(型だけの import も含む。Issue #176)", () => {
  const { coreFiles, appFiles, bareSpecifiers, unresolvedCoreSpecifiers } = closureOf(cloudSources, { includeTypes: true });
  const relCore = (f: string): string => path.relative(CORE_SRC, f).split(path.sep).join("/");
  const relApp = (f: string): string => path.relative(APP_SRC, f).split(path.sep).join("/");

  it("前提(空振り防止): runAnalysis の閉包(app の7ファイルと、型だけで繋がる analysis-types.ts)を実際に辿れている", () => {
    expect([...appFiles].map(relApp).sort()).toEqual(
      [
        "main/allocation-record.ts",
        "main/analysis-export.ts",
        "main/analysis-pipeline.ts",
        "main/venue-codes.ts",
        "shared/analysis-types.ts",
        "shared/mixed-candidates.ts",
        "shared/mixed-race-allocation.ts",
        "shared/race-allocation.ts",
      ],
    );
    expect(coreFiles.size).toBeGreaterThan(40);
  });

  it("型だけの import も含めて、バレル・cache.ts・analysis-store.ts・better-sqlite3 を経由しない。exports に無い `@keiba/core/...` も無い", () => {
    const names = [...coreFiles].map(relCore);
    for (const forbidden of ["index.ts", "scraper/cache.ts", "ev/analysis-store.ts"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect([...bareSpecifiers]).not.toContain("better-sqlite3");
    expect([...bareSpecifiers]).not.toContain("@keiba/core");
    expect([...unresolvedCoreSpecifiers]).toEqual([]);
  });

  it("相対でない指定子は、cloud が依存に持つもの(cheerio・iconv-lite・undici〈スタブ〉・jose・@anthropic-ai/sdk〈Issue #193〉・Node の組込み・cloudflare:*・workers の型)だけ。electron・react・better-sqlite3 などを指さない", () => {
    expect([...bareSpecifiers]).toContain("cheerio"); // 前提(空振り防止): 指定子を実際に集めている
    expect([...bareSpecifiers]).toContain("@anthropic-ai/sdk"); // 前提(空振り防止): LLM の入口(src/llm-sender.ts → @keiba/core/llm)を実際に辿り、SDK まで届いている
    expect([...bareSpecifiers].filter((s) => !isAllowedBareSpecifier(s)).sort()).toEqual([]);
  });

  it("許可の述語の自己検査(拒否側を維持する): 許可するのは cloud の依存だけで、SDK を許可しても electron・react・better-sqlite3・バレル・SDK の別パッケージは拒否する", () => {
    for (const ok of ["cheerio", "iconv-lite", "undici", "jose", "@anthropic-ai/sdk", "node:fs", "cloudflare:workers", "@cloudflare/workers-types"]) {
      expect(isAllowedBareSpecifier(ok), ok).toBe(true);
    }
    for (const ng of ["electron", "react", "better-sqlite3", "@keiba/core", "@anthropic-ai/bedrock-sdk", "@anthropic-ai/sdk-extra", "zod", "fs"]) {
      expect(isAllowedBareSpecifier(ng), ng).toBe(false);
    }
  });

  it("閉包が使う `@keiba/core/<サブパス>` は、すべて wrangler.toml の [alias] に1行ずつある(wrangler の alias は完全一致。無いと CI の配置でバンドルが解決に失敗する)。余分な行は無い", () => {
    const wrangler = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
    const aliasSection = wrangler.slice(wrangler.indexOf("[alias]"));
    const aliasEntries = new Map<string, string>();
    for (const m of aliasSection.matchAll(/^"(@keiba\/core\/[^"]+)"\s*=\s*"([^"]+)"/gm)) {
      aliasEntries.set(m[1]!, m[2]!);
    }
    const used = new Set<string>();
    for (const file of [...appFiles, ...coreFiles, ...cloudSources]) {
      for (const specifier of valueSpecifiers(readFileSync(file, "utf-8"), { includeTypes: true })) {
        if (specifier.startsWith("@keiba/core/")) {
          used.add(specifier);
        }
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(4); // 前提(空振り防止): 閉包が実際にサブパスを使っている
    expect([...aliasEntries.keys()].sort()).toEqual([...used].sort());
    for (const [specifier, target] of aliasEntries) {
      // 向け先は、core の exports が指すファイルと同じ(取り違えがない)
      expect(path.resolve(CLOUD, target), specifier).toBe(resolveCoreSubpath(specifier));
    }
  });

  it("対照: 型を含めて辿ると、型だけで better-sqlite3 に依存するモジュール(analysis-store.ts)に届く入口では、そのモジュールが現れる(includeTypes が実物で効く)。実在する core のファイルには、もうその形のものが無い(verify.ts・lookahead-suspicion.ts は #219 で analysis-store-types.ts に切り替えた)ので、一時ファイルで作る", () => {
    // 一時ファイルはリポジトリの中(このテストの隣)に作る。os の一時ディレクトリだと、Windows ではドライブが別になりうる(相対パスが作れない。core の native-free-modules.test.ts と同じ事情)。
    const dir = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-import-guard-"));
    try {
      const entry = path.join(dir, "type-only.ts");
      const relative = path.relative(dir, path.join(CORE_SRC, "ev", "analysis-store.js"));
      expect(path.isAbsolute(relative), "同じドライブで相対パスが作れる").toBe(false);
      const specifier = relative.split(path.sep).join("/");
      expect(specifier.startsWith("."), "指定子は相対パス").toBe(true);
      writeFileSync(entry, `import type { AnalysisStore } from "${specifier}";\nexport type T = AnalysisStore;\n`);
      expect([...closureOf([entry]).coreFiles].map(relCore)).not.toContain("ev/analysis-store.ts");
      expect([...closureOf([entry], { includeTypes: true }).coreFiles].map(relCore)).toContain("ev/analysis-store.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Issue #219: 検証の集計が使う core の入口(verify.ts・lookahead-suspicion.ts・analysis-store-types.ts)は、型を含めて辿っても analysis-store.ts・better-sqlite3 に届かない(クラウドだけを install する CI の型検査が通る)", () => {
    for (const file of ["verify.ts", "lookahead-suspicion.ts", "analysis-store-types.ts", "analysis-store-codec.ts"]) {
      const closure = closureOf([path.join(CORE_SRC, "ev", file)], { includeTypes: true });
      expect([...closure.coreFiles].map(relCore), file).not.toContain("ev/analysis-store.ts");
      expect([...closure.bareSpecifiers], file).not.toContain("better-sqlite3");
    }
  });
});

/** コメントを除いたコードに、Node のグローバル(`Buffer`)を使う箇所があるか。型検査(tsc)で、`types: []` の設定では `Cannot find name 'Buffer'` になる。 */
export function usesNodeGlobal(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return /\bBuffer\b/.test(code);
}

/**
 * Issue #201: **クライアント(cloud/client)の型検査の閉包**(型だけの import も含む)。`tsconfig.client.json` は `types: []`(Node の型なし)で、`paths` は `@keiba/core/*` だけ
 * (undici・iconv-lite・cheerio への向け先も無い)。**esbuild は型だけの import を消し、木も刈る(バンドルは壊れない)が、tsc は閉包の全体を型検査する**ので、
 * 型だけの import の先が node 依存(`undici`・`iconv-lite`・`node:zlib`・`Buffer`)に届くと、`packages/core/node_modules` の無い CI 相当の配置だけで TS2307・TS2591 になる
 * (手元には `packages/core/node_modules` があり、型が解決してしまうので通る。#201 の最初のコミットで CI の「型検査」が落ちた実績。原因は build-prompt.ts → grade-winner-trend.ts〈型だけ〉→ fetch-grade-winner.ts → http-client.ts)。
 * したがって、クライアントの閉包(型を含む)は、**相対でない指定子を1つも持たない**(`@keiba/core/<サブパス>` は paths で解決される)こと、core・app のモジュールが Node のグローバルを使わないこと。
 */
describe("cloud/client の閉包(型だけの import も含む。Issue #201)", () => {
  const clientSources = readdirSync(path.join(CLOUD, "client"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(CLOUD, "client", f));
  const { coreFiles, appFiles, bareSpecifiers, unresolvedCoreSpecifiers } = closureOf(clientSources, { includeTypes: true });
  const relCore = (f: string): string => path.relative(CORE_SRC, f).split(path.sep).join("/");

  it("前提(空振り防止): クライアントのファイルがあり、exe の renderer・core(build-prompt・配分)の閉包を実際に辿れている", () => {
    expect(clientSources.length).toBeGreaterThan(5);
    const names = [...coreFiles].map(relCore);
    expect(names).toContain("analyzer/build-prompt.ts");
    expect(names).toContain("analyzer/clip-variants.ts");
    expect(names).toContain("ev/combo-bet-allocation.ts");
    expect(appFiles.size).toBeGreaterThan(0);
  });

  it("相対でない指定子(undici・iconv-lite・cheerio・node:*・react など)を、型だけの import でも1つも持たない。`@keiba/core/<サブパス>` は exports にあるものだけ。バレルを経由しない", () => {
    expect([...bareSpecifiers].sort()).toEqual([]);
    expect([...unresolvedCoreSpecifiers]).toEqual([]);
    expect([...coreFiles].map(relCore)).not.toContain("index.ts");
  });

  it("閉包の core・app のモジュールが、Node のグローバル(Buffer)を使わない", () => {
    const offenders = [...coreFiles, ...appFiles].filter((f) => usesNodeGlobal(readFileSync(f, "utf-8")));
    expect(offenders.map((f) => path.relative(path.join(CLOUD, ".."), f).split(path.sep).join("/"))).toEqual([]);
  });

  it("対照: 検査は、node 依存に届く入口を拾える(空振りでない)。grade-winner-trend.ts(値で fetch-grade-winner → http-client → undici・iconv-lite、parse-grade-winner → node:zlib)を入口にすると、指定子と Buffer が現れる", () => {
    const entry = path.join(CORE_SRC, "analyzer", "grade-winner-trend.ts");
    const closure = closureOf([entry], { includeTypes: true });
    expect([...closure.bareSpecifiers]).toEqual(expect.arrayContaining(["undici", "iconv-lite", "node:zlib"]));
    expect([...closure.coreFiles].some((f) => usesNodeGlobal(readFileSync(f, "utf-8")))).toBe(true);
    expect(usesNodeGlobal("const b = Buffer.from(x);")).toBe(true);
    expect(usesNodeGlobal("// Buffer の話\nconst x = 1;")).toBe(false);
  });
});
