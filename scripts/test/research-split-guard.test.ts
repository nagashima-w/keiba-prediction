/**
 * 確率の質の測定のテストを、普段の `pnpm test`(`ci.yml` の verify)から外して `pnpm test:research` に分けた構成の
 * 静的な不変条件テスト(Issue #395。#390 D-4)。
 *
 * ## 何を守るか
 * 1. 外すテストの一覧が、通常の設定の exclude と研究用の設定の include で**同じ配列**を指していること
 *    (片方だけ直して、どちらにも走らないテストが生まれる事故を防ぐ)。
 * 2. 一覧のファイルが実在し、件数が期待どおりであること(古い名前で何も外れていない空振りを防ぐ)。
 * 3. **production の守りは外していないこと**: `probability-quality-regression.test.ts`(production の prior の回帰)、
 *    `brier-decomposition.test.ts`(production の `computeBrierScore` と検証画面との突合を含む)、
 *    `binomial-interval.test.ts`(検証画面の部品)は普段の CI に残す。
 * 4. **型検査は普段の CI に残ること**: 外したテストも `pnpm typecheck`(`tsconfig.scripts.json`・core の tsconfig)の対象のまま。
 *    型検査は軽く、外すとほかのリファクタリングで黙って壊れ、いざ使うときに動かない(#395 のゲートの判断)。
 * 5. `package.json` に `test:research` があり、普段の `test` は変わっていないこと。
 *
 * ワークフロー(`research.yml`)の性質の検査は、`research-workflow.test.ts` にある。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import rootConfig from "../../vitest.config.js";
import rootResearchConfig from "../../vitest.research.config.js";
import coreConfig from "../../packages/core/vitest.config.js";
import coreResearchConfig from "../../packages/core/vitest.research.config.js";
import { RESEARCH_TEST_GLOBS } from "../../vitest.research-tests.js";
import { CORE_RESEARCH_TEST_FILES } from "../../packages/core/vitest.research-tests.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readTextLf(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf-8").replace(/\r\n/g, "\n");
}

/** `*` を 1 つだけ含む glob を、ディレクトリ直下のファイル名の一覧に展開する(node:fs の glob は Node 22 では実験的なので使わない)。 */
function expandSingleStarGlob(glob: string): string[] {
  const stars = glob.split("*").length - 1;
  expect(stars, `glob「${glob}」の * は 1 つだけ`).toBe(1);
  const dir = path.dirname(glob);
  const [prefix, suffix] = path.basename(glob).split("*") as [string, string];
  return readdirSync(path.join(ROOT, dir))
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => `${dir}/${f}`)
    .sort();
}

describe("検出器の確認(空振りでない): glob の展開が実際にファイルを拾う", () => {
  it("scripts/test の probability-quality-41-*.test.ts を拾い、無関係なファイルは拾わない", () => {
    const hits = expandSingleStarGlob("scripts/test/probability-quality-41-*.test.ts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain("scripts/test/probability-quality-41-aggregate.test.ts");
    expect(hits).not.toContain("scripts/test/ci-workflow.test.ts");
  });
});

describe("ルート(scripts/test)の研究用テスト", () => {
  const researchFiles = RESEARCH_TEST_GLOBS.flatMap((g) => expandSingleStarGlob(g));

  it("一覧は glob 1 つで、展開すると 13 ファイル(probability-quality-41 の 13 本)", () => {
    expect(RESEARCH_TEST_GLOBS).toEqual(["scripts/test/probability-quality-41-*.test.ts"]);
    expect(researchFiles).toHaveLength(13);
  });

  it("production の prior の回帰(probability-quality-regression.test.ts)は研究側に入っていない(普段の CI に残す)", () => {
    expect(existsSync(path.join(ROOT, "scripts/test/probability-quality-regression.test.ts"))).toBe(true);
    expect(researchFiles).not.toContain("scripts/test/probability-quality-regression.test.ts");
  });

  it("普段の設定は、既定の exclude を保ったまま研究用の glob を除く。研究用の設定は同じ glob だけを含む", () => {
    const exclude = rootConfig.test?.exclude ?? [];
    for (const g of RESEARCH_TEST_GLOBS) {
      expect(exclude, `普段の設定が ${g} を除いている`).toContain(g);
    }
    expect(exclude, "node_modules を除く既定が残っている").toContain("**/node_modules/**");
    // 完全一致: 余計なファイルを exclude に足すと、どこでも走らないテストが生まれる(含むことだけの検査では素通りする)
    expect(exclude, "exclude は『既定 + 研究用の一覧』だけ").toEqual([...configDefaults.exclude, ...RESEARCH_TEST_GLOBS]);
    expect(rootConfig.test?.include).toEqual(["scripts/test/**/*.test.ts"]);
    expect(rootResearchConfig.test?.include).toEqual([...RESEARCH_TEST_GLOBS]);
  });
});

describe("packages/core の研究用テスト", () => {
  it("一覧は 3 ファイルで、すべて実在する", () => {
    expect([...CORE_RESEARCH_TEST_FILES]).toEqual([
      "test/ev/probability-quality.test.ts",
      "test/ev/brier-quality-report.test.ts",
      "test/ev/paired-brier-comparison.test.ts",
    ]);
    for (const f of CORE_RESEARCH_TEST_FILES) {
      expect(existsSync(path.join(ROOT, "packages", "core", f)), `${f} が実在する`).toBe(true);
    }
  });

  it("production の守りを含むテスト(brier-decomposition・binomial-interval・verify-quality)は研究側に入っていない", () => {
    for (const f of ["test/ev/brier-decomposition.test.ts", "test/ev/binomial-interval.test.ts", "test/ev/verify-quality.test.ts"]) {
      expect(existsSync(path.join(ROOT, "packages", "core", f)), `${f} が実在する`).toBe(true);
      expect([...CORE_RESEARCH_TEST_FILES]).not.toContain(f);
    }
  });

  it("普段の設定は一覧を除き、研究用の設定は一覧だけを含む", () => {
    const exclude = coreConfig.test?.exclude ?? [];
    for (const f of CORE_RESEARCH_TEST_FILES) {
      expect(exclude, `普段の設定が ${f} を除いている`).toContain(f);
    }
    expect(exclude, "node_modules を除く既定が残っている").toContain("**/node_modules/**");
    // 完全一致(ルートと同じ理由)
    expect(exclude, "exclude は『既定 + 研究用の一覧』だけ").toEqual([...configDefaults.exclude, ...CORE_RESEARCH_TEST_FILES]);
    expect(coreConfig.test?.include).toEqual(["test/**/*.test.ts"]);
    expect(coreResearchConfig.test?.include).toEqual([...CORE_RESEARCH_TEST_FILES]);
  });
});

describe("型検査は普段の CI に残る(外したテストも pnpm typecheck の対象)", () => {
  it("tsconfig.scripts.json は scripts 全体を含み、exclude を持たない(研究用テストを含む)", () => {
    const text = readTextLf("tsconfig.scripts.json");
    // コメントを含む JSON(JSONC)なので、// コメントを除いてから読む
    const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { include?: string[]; exclude?: string[] };
    expect(json.include).toEqual(["scripts"]);
    expect(json.exclude).toBeUndefined();
  });

  it("packages/core の tsconfig は src と test を含み、exclude を持たない", () => {
    const json = JSON.parse(readTextLf("packages", "core", "tsconfig.json")) as { include?: string[]; exclude?: string[] };
    expect(json.include).toEqual(["src", "test"]);
    expect(json.exclude).toBeUndefined();
  });

  it("ルートの typecheck は、型検査を再帰(pnpm -r)と scripts の両方に対して実行する(研究用の設定への付け替えが無い)", () => {
    const pkg = JSON.parse(readTextLf("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck"]).toBe("pnpm -r typecheck && tsc -p tsconfig.scripts.json");
  });
});

describe("package.json の scripts", () => {
  it("普段の test は変えていない(ci.yml の `pnpm test` がそのまま普段の範囲になる)", () => {
    const root = JSON.parse(readTextLf("package.json")) as { scripts: Record<string, string> };
    const core = JSON.parse(readTextLf("packages", "core", "package.json")) as { scripts: Record<string, string> };
    expect(root.scripts["test"]).toBe("pnpm -r test && vitest run");
    expect(core.scripts["test"]).toBe("vitest run");
  });

  it("test:research がルートと core にあり、研究用の設定を指す", () => {
    const root = JSON.parse(readTextLf("package.json")) as { scripts: Record<string, string> };
    const core = JSON.parse(readTextLf("packages", "core", "package.json")) as { scripts: Record<string, string> };
    expect(core.scripts["test:research"]).toBe("vitest run -c vitest.research.config.ts");
    expect(root.scripts["test:research"]).toBe("pnpm -r test:research && vitest run -c vitest.research.config.ts");
  });
});
