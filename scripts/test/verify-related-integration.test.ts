/**
 * 手元の検証の「関係するインテグレーション」の選び方の補強(Issue #701)の検査。
 *
 * 背景: `vitest list --changed` は import の依存をたどるだけなので、`cloud/wrangler.toml` や `cloud/migrations/` を
 * import せず readFileSync・wrangler の実行で読むテストは、それらを変えても選ばれない(#698 で 3 本が漏れ、CI で初めて落ちた)。
 * そこで、トリガーのファイルが差分にあるときに足す固定の一覧(scripts/verify-related-config.mjs)を持つ。
 * このテストは次を固定する。
 * 1. 判定(pickExtraTargets / buildTargets)の表: 何が差分にあれば一覧が足され、何なら足されないか。
 * 2. 一覧が古くならない: cloud/test の *.integration.test.ts の本文(コメント行を除く)を検索して、wrangler.toml・migrations・
 *    smoke のファイルを読むものを見つけ、一覧に無ければ赤。一覧に実在しない名前が残っても赤。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLOUD_TEST = path.join(ROOT, "cloud", "test");
const CONFIG_PATH = path.join(ROOT, "scripts", "verify-related-config.mjs");

interface Config {
  ALWAYS_RELATED: readonly string[];
  isTriggerFile(file: string): boolean;
  isSourceFile(file: string): boolean;
  SOURCE_READERS: readonly string[];
  pickExtraTargets(changedAll: readonly string[]): string[];
  buildTargets(input: { affected: readonly string[]; direct: readonly string[]; changedAll: readonly string[] }): string[];
}
const cfg = (await import(CONFIG_PATH)) as Config;

/** #698 で漏れた 3 本。 */
const LEAKED_IN_698 = [
  "test/bundle-guard.integration.test.ts",
  "test/result-repository-bundle.integration.test.ts",
  "test/d1-schema.integration.test.ts",
];

/** src を読むテストの代表(#680 で漏れた)。 */
const LEAKED_IN_680 = "test/bundle-guard.integration.test.ts";

/** コメント行(行頭が `*`・`//`・`/**`)を除いた本文。 */
function codeLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
}

/** 検索の形: 設定・migration・smoke を読む(import ではなく文字列のパスや wrangler の実行で)テストか。 */
function readsWatchedFiles(src: string): boolean {
  const code = codeLines(src);
  return [
    /wrangler\.toml/, // 設定を読む・configPath に渡す
    /["'/]migrations["'/]/, // migrations ディレクトリを読む(path.join の引数・相対パスのどちらも)
    /migrations["',\s]+apply/, // wrangler d1 migrations apply
    /getPlatformProxy/, // 本物の wrangler 設定を開く
    /\.bin["',\s]+wrangler/, // wrangler の実行
    /(readFileSync|path\.join|pathFromMeta)\([^\n]*smoke[-\w]*\.ts/, // smoke のファイルを読む
  ].some((re) => re.test(code));
}

/**
 * 検索の形(Issue #717): `cloud/src`・`packages/core/src` のソースを本文として読む・バンドルの入口に文字列で書くテストか。
 * import 文・export-from 文・動的 import・vi.mock の行は、import のつながりで選ばれるので除く。
 * 限界: 文字列の検索なので、src を別名の関数や変数だけを経由して読むテストは拾えない(#701 と同じ)。
 */
function readsSourceFiles(src: string): boolean {
  const code = codeLines(src)
    .split("\n")
    .filter((l) => !/^\s*(import|export)\b[^\n]*\bfrom\b/.test(l) && !/^\s*\}\s*from\b/.test(l) && !/\bimport\(|vi\.mock\(/.test(l))
    .join("\n");
  return [
    /["']src["']/, // path.join(CLOUD, "src", ...) や readdirSync(path.join(ROOT, "src"))
    /["']\.{1,2}\/src\//, // バンドルの入口に書く './src/x'・'../src/x'
    /["']packages["']\s*,\s*["']core["']/, // core のソースを path.join で読む
    /packages\/core\/src/, // バンドルの入口に書く core のパス
  ].some((re) => re.test(code));
}

function integrationTests(): string[] {
  return readdirSync(CLOUD_TEST)
    .filter((f) => f.endsWith(".integration.test.ts"))
    .sort();
}

describe("関係するインテグレーションの補強: 判定(Issue #701)", () => {
  it("一覧は空でなく、重複が無く、#698 で漏れた 3 本を必ず含む", () => {
    expect(cfg.ALWAYS_RELATED.length).toBeGreaterThan(0);
    expect(new Set(cfg.ALWAYS_RELATED).size).toBe(cfg.ALWAYS_RELATED.length);
    for (const t of LEAKED_IN_698) expect(cfg.ALWAYS_RELATED, t).toContain(t);
  });

  it.each([
    ["cloud/wrangler.toml", true],
    ["cloud/migrations/0050_x.sql", true],
    ["cloud/migrations/0001_init.sql", true],
    ["cloud/smoke.ts", true],
    ["cloud/smoke-worker.ts", true],
    ["cloud/smoke-modules.d.ts", true],
    ["cloud/src/handler.ts", false],
    ["cloud/migration/0050_x.sql", false],
    ["cloud/test/smoke-helper.test.ts", false],
    ["wrangler.toml", false],
    ["docs/migrations/note.md", false],
  ])("トリガー判定: %s → %s", (file, expected) => {
    expect(cfg.isTriggerFile(file)).toBe(expected);
  });

  it("トリガーが差分にあれば一覧の全部が足され、無ければ空(対照つき)", () => {
    for (const f of ["cloud/wrangler.toml", "cloud/migrations/0050_x.sql", "cloud/smoke.ts"]) {
      expect(cfg.pickExtraTargets(["cloud/client/a.ts", f]), f).toEqual([...cfg.ALWAYS_RELATED]);
    }
    expect(cfg.pickExtraTargets(["cloud/client/a.ts", "docs/x.md"])).toEqual([]);
    expect(cfg.pickExtraTargets([])).toEqual([]);
  });

  it("buildTargets: import で選ばれたものは残り、トリガー時だけ一覧が足される。インテグレーション以外は含めない", () => {
    const affected = ["test/a.integration.test.ts", "test/unit-a.test.ts"];
    const direct = ["test/b.integration.test.ts"];
    const without = cfg.buildTargets({ affected, direct, changedAll: ["cloud/client/a.ts"] });
    expect(without).toEqual(["test/a.integration.test.ts", "test/b.integration.test.ts"]);
    const withTrigger = cfg.buildTargets({ affected, direct, changedAll: ["cloud/wrangler.toml"] });
    expect(withTrigger).toEqual([...new Set([...without, ...cfg.ALWAYS_RELATED])].sort());
    expect(withTrigger.length).toBeGreaterThan(without.length);
  });
});

describe("関係するインテグレーションの補強: src を読むテスト(Issue #717)", () => {
  it.each([
    ["cloud/src/race-day-do.ts", true],
    ["cloud/src/client-bundle.generated.ts", true],
    ["cloud/src/sub/x.ts", true],
    ["packages/core/src/ev/verify.ts", true],
    ["cloud/client/app.ts", false],
    ["cloud/test/a.test.ts", false],
    ["cloud/src/readme.md", false],
    ["packages/core/test/a.test.ts", false],
    ["packages/core/src/ev/note.md", false],
    ["scripts/src/a.ts", false],
  ])("src のトリガー判定: %s → %s", (file, expected) => {
    expect(cfg.isSourceFile(file)).toBe(expected);
  });

  it("一覧は空でなく重複が無く、bundle-guard を含む", () => {
    expect(cfg.SOURCE_READERS.length).toBeGreaterThan(0);
    expect(new Set(cfg.SOURCE_READERS).size).toBe(cfg.SOURCE_READERS.length);
    expect(cfg.SOURCE_READERS).toContain(LEAKED_IN_680);
  });

  it("src が差分にあれば SOURCE_READERS の全部が足され、設定の一覧は足されない。無ければ空(対照つき)", () => {
    for (const f of ["cloud/src/race-day-do.ts", "packages/core/src/ev/verify.ts"]) {
      const got = cfg.pickExtraTargets(["docs/x.md", f]);
      expect(got, f).toEqual([...cfg.SOURCE_READERS]);
    }
    // 設定の一覧にしか無いテスト(src は読まない)は、src の変更では足されない
    const onlyConfig = cfg.ALWAYS_RELATED.filter((t) => !cfg.SOURCE_READERS.includes(t));
    expect(onlyConfig.length).toBeGreaterThan(0);
    expect(cfg.pickExtraTargets(["cloud/src/a.ts"])).not.toContain(onlyConfig[0]);
    expect(cfg.pickExtraTargets(["cloud/client/a.ts", "docs/x.md"])).toEqual([]);
  });

  it("設定と src の両方が差分にあれば、和集合が重複なく足される", () => {
    const got = cfg.pickExtraTargets(["cloud/wrangler.toml", "cloud/src/a.ts"]);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual([...new Set([...cfg.ALWAYS_RELATED, ...cfg.SOURCE_READERS])].sort());
  });

  it("buildTargets: src の変更で SOURCE_READERS が足される", () => {
    const got = cfg.buildTargets({ affected: [], direct: [], changedAll: ["cloud/src/race-day-do.ts"] });
    expect(got).toEqual([...cfg.SOURCE_READERS].sort());
  });

  const readers = integrationTests().filter((f) => readsSourceFiles(readFileSync(path.join(CLOUD_TEST, f), "utf-8")));

  it("前提: 検索は 0 件でなく、#680 で漏れた bundle-guard を見つける(空振り防止)", () => {
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.map((r) => `test/${r}`)).toContain(LEAKED_IN_680);
  });

  it("検索で見つかった、src を読むテストは、すべて SOURCE_READERS にある", () => {
    const missing = readers.map((r) => `test/${r}`).filter((r) => !cfg.SOURCE_READERS.includes(r));
    expect(missing, "scripts/verify-related-config.mjs の SOURCE_READERS に足す").toEqual([]);
  });

  it("SOURCE_READERS はすべて実在し、検索の形に合う(古い名前を残さない)", () => {
    const existing = new Set(integrationTests().map((f) => `test/${f}`));
    expect(cfg.SOURCE_READERS.filter((t) => !existing.has(t))).toEqual([]);
    expect(cfg.SOURCE_READERS.filter((t) => !readers.map((r) => `test/${r}`).includes(t))).toEqual([]);
  });

  it("検索の自己検証: 合成のソースで、読むものは拾い、import・コメントだけは拾わない", () => {
    expect(readsSourceFiles('readFileSync(path.join(CLOUD, "src", "worker.ts"), "utf-8")')).toBe(true);
    expect(readsSourceFiles('readdirSync(path.join(ROOT, "src"))')).toBe(true);
    expect(readsSourceFiles("'export { X } from \"./src/x\";',")).toBe(true);
    expect(readsSourceFiles('path.join(CLOUD, "..", "packages", "core", "src", "ev", "verify.ts")')).toBe(true);
    expect(readsSourceFiles('import { a } from "../src/a";\n} from "../src/b";\nconst m = await import("../src/c");')).toBe(false);
    expect(readsSourceFiles(' * "src" を言及\n// path.join(CLOUD, "src")')).toBe(false);
  });
});

describe("関係するインテグレーションの補強: 一覧が古くならない(Issue #701)", () => {
  const readers = integrationTests().filter((f) => readsWatchedFiles(readFileSync(path.join(CLOUD_TEST, f), "utf-8")));

  it("前提: 検索は 0 件でなく、#698 で漏れた 3 本を見つける(検索の空振り防止)", () => {
    expect(readers.length).toBeGreaterThan(0);
    for (const t of LEAKED_IN_698) expect(readers.map((r) => `test/${r}`), t).toContain(t);
  });

  it("検索で見つかった、設定・migration・smoke を読むテストは、すべて一覧にある", () => {
    const missing = readers.map((r) => `test/${r}`).filter((r) => !cfg.ALWAYS_RELATED.includes(r));
    expect(missing, "一覧(scripts/verify-related-config.mjs の ALWAYS_RELATED)に足す").toEqual([]);
  });

  it("一覧のテストはすべて実在し、*.integration.test.ts で、検索の形に合う(古い名前を残さない)", () => {
    const existing = new Set(integrationTests().map((f) => `test/${f}`));
    const stale = cfg.ALWAYS_RELATED.filter((t) => !existing.has(t));
    expect(stale).toEqual([]);
    const notReaders = cfg.ALWAYS_RELATED.filter((t) => !readers.map((r) => `test/${r}`).includes(t));
    expect(notReaders).toEqual([]);
  });

  it("検索の自己検証: 合成のソースで、読むものは拾い、コメントだけの言及は拾わない", () => {
    expect(readsWatchedFiles('readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8")')).toBe(true);
    expect(readsWatchedFiles('path.join(ROOT, "migrations", "0035_x.sql")')).toBe(true);
    expect(readsWatchedFiles('pathFromMeta("../migrations/0019_close.sql", import.meta.url)')).toBe(true);
    expect(readsWatchedFiles('execFileSync(WRANGLER, ["d1", "migrations", "apply"])')).toBe(true);
    expect(readsWatchedFiles('readFileSync(path.join(CLOUD, "smoke-worker.ts"), "utf-8")')).toBe(true);
    expect(readsWatchedFiles(" * wrangler.toml と migrations/ をコメントで言及\n// smoke.ts\nconst x = 1;")).toBe(false);
  });
});

describe("関係するインテグレーション: 基点が取れないとき(Issue #626〈#620 の記録〉)", () => {
  it("基点の ref が存在しない(merge-base が取れない)ときは、0 件で成功せず、0 以外で終わって基点を知らせる", () => {
    const missing = "refs/heads/no-such-base-626";
    // 前提: その ref は実在しない
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", missing], { cwd: ROOT }).status).not.toBe(0);
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "verify-related-integration.mjs")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, VERIFY_BASE: missing }, timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(missing);
    expect(r.stdout).not.toContain("関係するインテグレーションのテストなし");
  });
});
