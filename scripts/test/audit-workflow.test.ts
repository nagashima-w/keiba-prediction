/**
 * 毎日の依存の脆弱性の監査(.github/workflows/audit.yml)の静的な不変条件テスト(Issue #498)。
 *
 * 背景: 脆弱性が公表されてから対応を始めるまでの時間を短くするため、毎日 1 回、ルートと cloud/(別の lockfile)の両方に `pnpm audit` をかける。
 * Dependabot alerts はユーザーにしか見えないので、Claude が毎朝(日本時間 04:23)ワークフローの結果を読んで気づけるようにする。固定するのは次のとおり。
 * 1. 起動は schedule(1 本。日本時間 03 時台。分は 0 以外)と workflow_dispatch だけ。push・pull_request では走らせない(main の lockfile を毎日見る)。
 * 2. 権限は contents: read だけ。secret・環境変数・書き込みを持たない。
 * 3. ジョブは 2 つ(ルート・cloud)。片方が赤でももう片方の結果が出る。ジョブ名は Claude が読む(どちらの lockfile かが名前で分かる)ので固定する。
 * 4. 依存をインストールしない(`pnpm audit` は lockfile だけを見る。インストールスクリプトを走らせない)。
 * 5. 閾値は low 以上(1 件でも失敗)。緩めるフラグ・失敗を握りつぶす書き方を持たない。`pnpm audit` の終了コードは `set +e` で受け、
 *    scripts/ci/audit-report.ts が AUDIT-OK / AUDIT-FAIL / AUDIT-UNAVAILABLE に分類する(分類の挙動は audit-report.test.ts)。
 *
 * 全 `uses:` の SHA 固定・版数のコメント・許可リストは actions-pinned.test.ts が、contents: write の不在は ci-workflow.test.ts が、
 * node-version の版は cloud-config-guard.test.ts が、audit.yml を含む全ワークフローに対して検査する。
 *
 * 限界: これは yml のテキストへの検査である。schedule は既定ブランチ(main)のファイルでしか動かないので、毎日の実行が始まるのは main への取り込み後で、
 * 実際に緑になるか(Actions の run)は、取り込み後の workflow_dispatch で確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const YML_PATH = path.join(ROOT, ".github", "workflows", "audit.yml");

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

/** `jobs:` 直下の job の id を出現順に返す(2 スペースインデントの `id:`)。 */
function extractJobIds(code: string): string[] {
  const section = code.split("\njobs:\n")[1] ?? "";
  return [...section.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]!);
}

/** `jobs:` 直下の job の本文(次の job の直前まで)。見つからなければ例外。 */
function extractJob(code: string, jobId: string): string {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start < 0) throw new Error(`job が見つかりません: ${jobId}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** job の本文から、6 スペースインデントの `- name:` のステップ名を出現順に返す。 */
function extractStepNames(job: string): string[] {
  return [...job.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

/** job の本文から、名前で始まるステップのブロック(次のステップの直前まで)を返す。 */
function extractStep(job: string, stepName: string): string {
  const steps = job.split(/\n(?=      - name: )/);
  const found = steps.find((s) => s.trimStart().startsWith(`- name: ${stepName}`));
  if (found === undefined) throw new Error(`ステップが見つかりません: ${stepName}`);
  return found;
}

/** ステップのブロックから、`run: |` の複数行のスクリプト(インデントを除いたもの)を返す。 */
function extractRunBlock(step: string): string[] {
  const lines = step.split("\n");
  const start = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  if (start < 0) throw new Error(`run: | が見つかりません:\n${step}`);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith("          ")) break;
    out.push(l.slice(10));
  }
  return out;
}

const STEP = {
  checkout: "リポジトリを取得",
  pnpm: "pnpm をセットアップ",
  node: "Node.js をセットアップ",
  audit: "依存の脆弱性を監査",
} as const;

describe("検査する側の自己検証(正の対照。検出器が空振りしていない)", () => {
  const sample = [
    "name: x",
    "on:",
    "  schedule:",
    '    - cron: "1 2 * * *"',
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  a:",
    "    steps:",
    "      - name: 一つ目",
    "        run: |",
    "          set +e",
    "          echo hi",
    "      - name: 二つ目",
    "        run: echo two",
    "  b:",
    "    steps:",
    "      - name: 三つ目",
  ].join("\n");

  it("extractOnKeys・extractJobIds・extractStepNames は、対象だけを出現順に読む", () => {
    expect(extractOnKeys(sample)).toEqual(["schedule", "workflow_dispatch"]);
    expect(extractJobIds(sample)).toEqual(["a", "b"]);
    expect(extractStepNames(extractJob(sample, "a"))).toEqual(["一つ目", "二つ目"]);
    expect(extractStepNames(extractJob(sample, "b"))).toEqual(["三つ目"]);
  });

  it("extractRunBlock は run: | の本文だけを、次のステップの直前まで読む", () => {
    expect(extractRunBlock(extractStep(extractJob(sample, "a"), "一つ目"))).toEqual(["set +e", "echo hi"]);
  });
});

describe("audit.yml(毎日の依存の脆弱性の監査)", () => {
  it("存在する(以降の検査が、ファイルが無いまま空振りしない前提)", () => {
    expect(existsSync(YML_PATH)).toBe(true);
  });

  const yml = existsSync(YML_PATH) ? readTextLf(YML_PATH) : "";
  const code = withoutComments(yml);

  it("起動は schedule と workflow_dispatch だけ(push・pull_request・pull_request_target・workflow_run では走らない)", () => {
    expect(extractOnKeys(code)).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("schedule は cron が 1 本で、日本時間の 03 時台(UTC の 18 時台)・分は 0 以外(毎時 0 分は混む)。Claude の確認(04:23 JST)より前に結果が出る", () => {
    const crons = [...code.matchAll(/^\s*- cron: ["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1]!);
    expect(crons).toHaveLength(1);
    const m = /^(\d+) (\d+) \* \* \*$/.exec(crons[0]!);
    expect(m, `cron は「分 時 * * *」(毎日): ${crons[0]}`).not.toBeNull();
    const minute = Number(m![1]);
    const hourUtc = Number(m![2]);
    expect(minute).not.toBe(0);
    expect(minute).toBeLessThan(60);
    // 日本時間(UTC+9)に直すと 03 時台
    expect((hourUtc + 9) % 24).toBe(3);
  });

  it("権限は contents: read だけで、書き込み権限・secrets・環境変数・トークンを持たない", () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(code.match(/^\s*permissions:/gm)).toHaveLength(1);
    expect(code).not.toMatch(/write/);
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/TOKEN|API_KEY|ANTHROPIC/i);
    expect(code).not.toMatch(/^\s*env:/m);
  });

  it("同時実行は 1 本にまとめる(手動実行とスケジュールが重なっても 1 本。公開しないので古い run は取り消してよい)", () => {
    expect(code).toMatch(/^concurrency:\n {2}group: audit-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true$/m);
  });

  it("ジョブは audit-root と audit-cloud の 2 つ(この順)。名前は「監査(ルート)」「監査(cloud)」(Claude が失敗したジョブ名で、どちらの lockfile かを読む)", () => {
    expect(extractJobIds(code)).toEqual(["audit-root", "audit-cloud"]);
    expect(extractJob(code, "audit-root")).toMatch(/\n {4}name: 監査\(ルート\)\n/);
    expect(extractJob(code, "audit-cloud")).toMatch(/\n {4}name: 監査\(cloud\)\n/);
  });

  describe.each([
    { jobId: "audit-root", label: "root", workingDir: null, scriptPath: "scripts/ci/audit-report.ts" },
    { jobId: "audit-cloud", label: "cloud", workingDir: "cloud", scriptPath: "../scripts/ci/audit-report.ts" },
  ])("$jobId", ({ jobId, label, workingDir, scriptPath }) => {
    const job = extractJob(code, jobId);

    it("ubuntu-latest・タイムアウト付き。ステップは 取得 → pnpm → Node → 監査 の 4 つだけ(依存のインストールを挟まない)", () => {
      expect(job).toMatch(/\n {4}runs-on: ubuntu-latest\n/);
      expect(job).toMatch(/\n {4}timeout-minutes: \d+\n/);
      expect(extractStepNames(job)).toEqual([STEP.checkout, STEP.pnpm, STEP.node, STEP.audit]);
      expect(job).not.toMatch(/pnpm install|npm (ci|install)/);
    });

    it("Node は 24.22.1(ci.yml・deploy-cloud.yml と同じ)。pnpm は packageManager に従う(版を指定しない)。キャッシュは使わない(インストールしない)", () => {
      expect(extractStep(job, STEP.node)).toMatch(/\n {10}node-version: 24\.22\.1\n/);
      expect(extractStep(job, STEP.node)).not.toMatch(/cache:/);
      expect(extractStep(job, STEP.pnpm)).not.toMatch(/with:|version:/);
    });

    it(`監査のステップは、\`set +e\` で pnpm audit の終了コードを受け、audit-report.ts(ラベル ${label})に分類させる(スクリプトの終了コードがステップの結果になる)`, () => {
      const step = extractStep(job, STEP.audit);
      expect(extractRunBlock(step)).toEqual([
        "set +e",
        'pnpm audit --json > "$RUNNER_TEMP/audit.json" 2> "$RUNNER_TEMP/audit.err"',
        "code=$?",
        `node ${scriptPath} ${label} "$RUNNER_TEMP/audit.json" "$code" "$RUNNER_TEMP/audit.err"`,
      ]);
      if (workingDir === null) {
        expect(step).not.toMatch(/working-directory:/);
      } else {
        expect(step).toMatch(new RegExp(`\\n {8}working-directory: ${workingDir}\\n`));
      }
    });
  });

  it("cloud の監査だけが working-directory: cloud を持つ(ルートの監査を 2 回走らせていない。ワークフロー全体で working-directory の行は 1 つ)", () => {
    expect(code.match(/^\s*working-directory:/gm)).toHaveLength(1);
    expect(extractJob(code, "audit-root")).not.toContain("working-directory");
  });

  it("閾値は low 以上: 緩めるフラグ(--audit-level・--ignore・--ignore-unfixable・--ignore-registry-errors・--prod・--dev)と、失敗を握りつぶす書き方(continue-on-error・|| true)が無い", () => {
    expect(code).toMatch(/pnpm audit --json/);
    expect(code.match(/pnpm audit/g)).toHaveLength(2);
    expect(code).not.toMatch(/--audit-level|--ignore|--prod\b|--dev\b|-P\b|-D\b|--fix/);
    expect(code).not.toContain("continue-on-error");
    expect(code).not.toMatch(/\|\|\s*(true|:)/);
    expect(code).not.toMatch(/^\s*if:/m);
  });

  it("分類のスクリプトは、素の node で実行する(CI は依存をインストールしないので tsx を使えない)。スクリプトが実在する", () => {
    expect(code).not.toMatch(/\btsx\b/);
    expect(code.match(/node (\.\.\/)?scripts\/ci\/audit-report\.ts /g)).toHaveLength(2);
    expect(existsSync(path.join(ROOT, "scripts", "ci", "audit-report.ts"))).toBe(true);
  });

  it("artifact のアップロードを使わない(許可リスト外の action を増やさない)。uses は checkout・pnpm/action-setup・setup-node だけ", () => {
    expect(code).not.toContain("upload-artifact");
    const actions = [...code.matchAll(/^\s*(?:- )?uses:\s*([^@\s]+)@/gm)].map((m) => m[1]);
    expect(actions).toHaveLength(6);
    expect([...new Set(actions)].sort()).toEqual(["actions/checkout", "actions/setup-node", "pnpm/action-setup"]);
  });
});
