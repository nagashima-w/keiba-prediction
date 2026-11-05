/**
 * Issue #620: テストの層(ユニット/インテグレーション)の分け方のガード。
 *
 * 基準: 本物の workerd を開く(`wrangler` を import する・`local-bindings.ts` 経由で開く)、または `wrangler` を子プロセスで実行する
 * (サブコマンドを問わない。`deploy --dry-run` を含む)テストは、ファイル名が `*.integration.test.ts` でなければならない。
 * そうでないテストは、その名前にしてはならない(ユニットの層は偽の D1・DO だけで速く回す)。
 * 対象の選び方は、コメントを除いたソースの import と実行を見る(散文の「wrangler」の言及には反応しない)。相対 import は再帰的にたどる。
 *
 * もう 1 つ: package.json の `test:unit` と `test:integration` が、実際に選ぶファイルの集合を `vitest list` で取り、
 * 重ならないこと・合わせて全件(`test` が選ぶ集合)になること・インテグレーションの集合がファイル名の基準と一致することを固定する。
 * (`vitest run integration` のような部分一致だと、名前に integration を含むだけのユニットまで拾う。)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(CLOUD, "test");
const SELF = "test-layers.test.ts";
const SUFFIX = ".integration.test.ts";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** wrangler 自体を直接使うか(import、または .bin/wrangler の組み立て)。 */
function usesWranglerDirectly(code: string): boolean {
  return /(?:from\s*|import\s*\(\s*)["']wrangler["']/.test(code) || /["']\.bin["']\s*,\s*["']wrangler["']|\.bin\/wrangler/.test(code);
}

function relativeImports(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) out.push(m[1]!);
  return out;
}

function resolveTs(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(cand) && cand.endsWith(".ts")) return cand;
  }
  return null;
}

/** test/ 直下の .ts のうち、本物の workerd を開く・wrangler を実行するもの(推移的)。 */
function heavyFiles(): Set<string> {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF).map((f) => path.join(TEST_DIR, f));
  const code = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf-8"))]));
  const heavy = new Set(files.filter((f) => usesWranglerDirectly(code.get(f)!)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      if (heavy.has(f)) continue;
      const deps = relativeImports(code.get(f)!).map((s) => resolveTs(f, s));
      if (deps.some((d) => d !== null && heavy.has(d))) {
        heavy.add(f);
        changed = true;
      }
    }
  }
  return heavy;
}

const allTestFiles = (): string[] => readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts") && f !== SELF).sort();

describe("Issue #620: テストの層の分け方", () => {
  const heavy = heavyFiles();
  const heavyTests = allTestFiles().filter((f) => heavy.has(path.join(TEST_DIR, f)));

  it("前提: 本物の workerd を開く・wrangler を実行するテストが見つかる(0 件なら検出が壊れている)", () => {
    expect(heavyTests.length).toBeGreaterThan(50);
    expect(heavyTests).toContain("d1-schema.integration.test.ts");
    expect(heavyTests).toContain("bundle-guard.integration.test.ts");
    expect(heavyTests).toContain("analysis-repository.integration.test.ts");
  });

  it("前提: wrangler の言及が散文だけのテストは対象にならない", () => {
    expect(heavyTests).not.toContain("import-guard.test.ts");
    expect(heavyTests).not.toContain("client-bundle.test.ts");
    expect(heavyTests).not.toContain("llm-sender.test.ts");
    expect(heavyTests).not.toContain("migration-0005.test.ts"); // node:sqlite のユニット
  });

  it("本物の workerd を開く・wrangler を実行するテストは、すべて *.integration.test.ts である", () => {
    const wrong = heavyTests.filter((f) => !f.endsWith(SUFFIX));
    expect(wrong).toEqual([]);
  });

  it("*.integration.test.ts は、すべて本物の workerd を開く・wrangler を実行するテストである", () => {
    const named = allTestFiles().filter((f) => f.endsWith(SUFFIX));
    expect(named.length).toBeGreaterThan(0);
    const wrong = named.filter((f) => !heavy.has(path.join(TEST_DIR, f)));
    expect(wrong).toEqual([]);
  });

  describe("package.json の test:unit・test:integration", () => {
    const pkg = JSON.parse(readFileSync(path.join(CLOUD, "package.json"), "utf-8")) as { scripts: Record<string, string> };
    const listOf = (script: string): string[] => {
      const cmd = pkg.scripts[script];
      expect(cmd).toBeTypeOf("string");
      expect(cmd!.startsWith("vitest run")).toBe(true);
      // 引用符は shell が外すので、同じ引数列を作る(`vitest run <args>` → `vitest list --filesOnly <args>`)。
      const args = [...cmd!.slice("vitest run".length).matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
      const out = execFileSync(path.join(CLOUD, "node_modules", ".bin", "vitest"), ["list", "--filesOnly", ...args], { cwd: CLOUD, encoding: "utf-8" });
      return out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts")).sort();
    };
    const unit = listOf("test:unit");
    const integration = listOf("test:integration");
    const all = listOf("test");

    it("test:unit と test:integration は重ならず、合わせて test の全件になる", () => {
      expect(unit.length).toBeGreaterThan(0);
      expect(integration.length).toBeGreaterThan(0);
      expect(unit.filter((f) => integration.includes(f))).toEqual([]);
      expect([...unit, ...integration].sort()).toEqual(all);
    });

    it("test:integration は *.integration.test.ts の接尾辞だけを選ぶ(`vitest run integration` のような名前の部分一致ではない)", () => {
      expect(integration.filter((f) => !f.endsWith(SUFFIX))).toEqual([]);
      expect(unit.filter((f) => f.endsWith(SUFFIX))).toEqual([]);
      expect(integration.length).toBe(heavyTests.length);
    });
  });
});
