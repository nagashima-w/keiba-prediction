/**
 * 確率の質の測定を手動で流すワークフロー(.github/workflows/research.yml)の静的な不変条件テスト(Issue #395。#390 D-4)。
 *
 * 普段の CI(ci.yml の verify)から外した確率の質のテスト(`pnpm test:research`)と、オフラインの集計 2 本を、
 * Actions の画面の「Run workflow」から必要なときにだけ流すためのワークフロー。固定するのは次のとおり。
 * 1. 起動は workflow_dispatch だけ(push・pull_request・schedule では走らない。普段の CI と本番デプロイに干渉しない)。
 * 2. 権限は contents: read だけ。secret も API キーも参照しない(確率の質の測定に実 Claude API は使わない。#41 はサブエージェントの近似)。
 * 3. 手順: 依存のインストール → pnpm test:research → #41 の集計 → #41-llm の集計(--prompt-version 付き)→ git diff --stat。
 * 4. 集計の結果とコミット済みの aggregate.json の差分は、ログに出すだけで、失敗の条件にしない
 *    (#41-llm の aggregate.json は #329 で消した marksDroppedRaceIds の 2 行が残っていて、現状は食い違う。measurement-plan.md に既知の食い違いとして書いた)。
 * 5. artifact のアップロードは使わない(許可リスト外の action を増やさない)。
 *
 * 全 `uses:` の SHA 固定・版数のコメント・許可リストは actions-pinned.test.ts が、contents: write とリリース公開の不在は
 * ci-workflow.test.ts が、research.yml を含む全ワークフローに対して検査する。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const YML_PATH = path.join(ROOT, ".github", "workflows", "research.yml");

function readTextLf(filePath: string): string {
  return readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

/** コメント行(行頭が # の行)を除いた本文。 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** トップレベルの `on:` の直下のキー(2 スペースインデント)を出現順に返す。コメント除去済みの本文を渡す。 */
function extractOnKeys(code: string): string[] {
  const lines = code.split("\n");
  const start = lines.indexOf("on:");
  if (start < 0) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) break;
    const m = /^ {2}([^\s:]+):/.exec(line);
    if (m?.[1] !== undefined) keys.push(m[1]);
  }
  return keys;
}

/** `run:` の単一行コマンドを出現順に返す。 */
function extractRunLines(code: string): string[] {
  return [...code.matchAll(/^\s*(?:- )?run:\s+(.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

describe("検査する側の自己検証(正の対照。検出器が空振りしていない)", () => {
  it("extractOnKeys: on: の直下のキーだけを読み、次のトップレベルのキーで止まる", () => {
    const code = ["name: x", "on:", "  push:", "    branches:", "      - a", "  workflow_dispatch:", "permissions:", "  contents: read"].join("\n");
    expect(extractOnKeys(code)).toEqual(["push", "workflow_dispatch"]);
    expect(extractOnKeys("name: x")).toEqual([]);
  });

  it("extractRunLines: run: の単一行コマンドを出現順に読む", () => {
    expect(extractRunLines(["  - run: a b", "  - name: n", "    run: c"].join("\n"))).toEqual(["a b", "c"]);
  });
});

describe("research.yml(確率の質の測定。手動実行だけ)", () => {
  it("research.yml が存在する(以降の検査が、ファイルが無いまま空振りしない前提)", () => {
    expect(existsSync(YML_PATH)).toBe(true);
  });

  const yml = existsSync(YML_PATH) ? readTextLf(YML_PATH) : "";
  const code = withoutComments(yml);

  it("起動は workflow_dispatch だけ(push・pull_request・pull_request_target・schedule・workflow_run では走らない)", () => {
    expect(extractOnKeys(code)).toEqual(["workflow_dispatch"]);
  });

  it("権限は contents: read だけで、書き込み権限・secrets・環境変数・API キーを持たない", () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(code).not.toMatch(/write/);
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/ANTHROPIC|API_KEY|TOKEN/i);
    expect(code).not.toMatch(/^\s*env:/m);
  });

  it("artifact のアップロードを使わない(許可リスト外の action を増やさない)", () => {
    expect(code).not.toContain("upload-artifact");
  });

  it("ジョブは 1 つで、ubuntu-latest・Node 24・タイムアウト付き。pnpm のキャッシュを使う", () => {
    const jobsSection = code.split("\njobs:\n")[1] ?? "";
    expect(jobsSection, "jobs: の節が読める").not.toBe("");
    expect(jobsSection.match(/^ {2}[A-Za-z0-9_-]+:$/gm)).toEqual(["  research:"]);
    expect(code).toMatch(/runs-on: ubuntu-latest/);
    expect(code).toMatch(/node-version: 24$/m);
    expect(code).toMatch(/timeout-minutes: \d+/);
    expect(code).toMatch(/cache: pnpm/);
  });

  it("手順(run)は、インストール → pnpm test:research → #41 の集計 → #41-llm の集計(版を指定)→ git diff --stat の順", () => {
    expect(extractRunLines(code)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm test:research",
      "pnpm tsx scripts/probability-quality-41/aggregate.ts",
      "pnpm tsx scripts/probability-quality-41-llm/aggregate.ts --prompt-version 2026-07-28.2",
      "git diff --stat",
    ]);
  });

  it("集計の差分は失敗の条件にしない(--exit-code・--quiet・continue-on-error を使わない。差分を失敗にするなら #329 の食い違いで今は赤になる)", () => {
    expect(code).not.toMatch(/--exit-code|--quiet/);
    expect(code).not.toContain("continue-on-error");
    expect(code).not.toMatch(/git diff[^\n]*\|\|/);
  });

  it("--prompt-version に指定した版が、コミット済みの記録(aggregate.json)の版と一致する(指定の取り違えを検出)", () => {
    const m = /--prompt-version (\S+)/.exec(code);
    expect(m?.[1], "ワークフローの --prompt-version が読める").toBeDefined();
    const agg = JSON.parse(readTextLf(path.join(ROOT, "docs", "investigations", "probability-quality-41-llm", "aggregate.json"))) as {
      conditions?: { promptVersion?: string };
    };
    expect(agg.conditions?.promptVersion).toBe(m?.[1]);
  });

  it("ワークフローが実行するスクリプトと、pnpm test:research の定義が実在する", () => {
    expect(existsSync(path.join(ROOT, "scripts", "probability-quality-41", "aggregate.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "scripts", "probability-quality-41-llm", "aggregate.ts"))).toBe(true);
    const pkg = JSON.parse(readTextLf(path.join(ROOT, "package.json"))) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:research"]).toBeDefined();
  });
});
