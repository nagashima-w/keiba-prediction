import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPIKE_WORKER_PREFIX } from "../cloudflare-spike/preflight.js";

/**
 * Issue #161(#21-C): 本番デプロイのワークフロー(.github/workflows/deploy-cloud.yml)の静的検査。
 *
 * **限界**: これは yml のテキストへの検査であり、GitHub Actions の式が Actions 上で実際にどう評価されるかは検証
 * できない。ただし `deploy` ジョブの `if:` は、yml から取り出した式の文字列を JS に機械的に翻訳して(contains の
 * 大文字小文字の無視と、dispatch で head_commit が null になることを模した上で)真理値表で評価している。
 * 翻訳と模倣は本テストの前提であり、承認印付き push の実物確認(Actions の run)に代わるものではない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 改行を LF に正規化して読む(Windows のチェックアウトでは CRLF になる)。 */
function readTextLf(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf-8").replace(/\r\n/g, "\n");
}

const yml = readTextLf(".github", "workflows", "deploy-cloud.yml");
const ALLOWED_BRANCH = "claude/issue-order-processing-wjgpdd";

/** `jobs:` 直下の job の本文(次の job の直前まで)。 */
function jobBody(name: string): string {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job『${name}』が見つかる`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** job 本文から、`- name:` で始まるステップの本文を返す。 */
function stepBody(job: string, nameFragment: string): string {
  const lines = job.split("\n");
  const start = lines.findIndex((l) => /^\s+- name:/.test(l) && l.includes(nameFragment));
  expect(start, `ステップ『${nameFragment}』が見つかる`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s+- name:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function stepIndex(job: string, nameFragment: string): number {
  return job.split("\n").findIndex((l) => /^\s+- name:/.test(l) && l.includes(nameFragment));
}

/** コメント行を除いた本文。 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("起動条件", () => {
  it("push の対象ブランチは許可した1本だけで、タグやワイルドカードは含まない。workflow_dispatch を併設する", () => {
    const m = /\n  push:\n    branches:\n((?:      - .+\n)+)/.exec(yml);
    expect(m).not.toBeNull();
    const branches = m![1]!.trim().split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim());
    expect(branches).toEqual([ALLOWED_BRANCH]);
    expect(yml).not.toMatch(/\n    tags:/);
    expect(yml).toContain("\n  workflow_dispatch:");
  });

  it("paths フィルタを持たない(承認印付きの最終コミットが文書・版数だけでも、cloud/ の変更を本番に出すため)", () => {
    expect(withoutComments(yml)).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it("権限は contents: read のみ", () => {
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(yml).not.toMatch(/contents: write/);
  });

  it("同時実行は1本に絞り、実行中のデプロイを途中で打ち切らない", () => {
    expect(yml).toMatch(/\nconcurrency:\n {2}group: deploy-cloud\n {2}cancel-in-progress: false\n/);
  });
});

describe("check ジョブ(毎回走る。秘密を持たない)", () => {
  const check = jobBody("check");

  it("if を持たず(印のない push でも走る)、Secrets を一切参照しない", () => {
    expect(withoutComments(check)).not.toMatch(/^\s+if:/m);
    expect(check).not.toContain("secrets.");
    expect(check).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("cloud/ で、frozen-lockfile のインストール → 型検査 → テスト → デプロイの dry-run → スモークの順に実行する", () => {
    expect(check).toContain("working-directory: cloud");
    const install = stepIndex(check, "依存をインストール");
    const order = ["型検査", "テスト", "dry-run", "スモーク"].map((n) => stepIndex(check, n));
    expect(install).toBeGreaterThanOrEqual(0);
    for (const i of order) {
      expect(i).toBeGreaterThan(install);
    }
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const installStep = stepBody(check, "依存をインストール");
    expect(installStep).toContain("pnpm install --ignore-workspace --frozen-lockfile");
    expect(stepBody(check, "型検査")).toContain("pnpm run typecheck");
    expect(stepBody(check, "テスト")).toContain("pnpm test");
    expect(stepBody(check, "dry-run")).toContain("pnpm run deploy:dry");
    expect(stepBody(check, "スモーク")).toContain("pnpm run smoke");
  });
});

/** `deploy` ジョブの if: の式(`${{ }}` の中身)。 */
function deployCondition(): string {
  const deploy = jobBody("deploy");
  const m = /\n {4}if: \$\{\{ (.+) \}\}\n/.exec(deploy);
  expect(m, "deploy ジョブに if: がある").not.toBeNull();
  return m![1]!;
}

describe("deploy ジョブの条件(許可ブランチの上で、承認印付き push か手動実行のときだけ)", () => {
  it("式の文字列を完全一致で固定する(build-windows.yml の公開ゲートと同じ形に、許可ブランチの限定を足したもの)", () => {
    expect(deployCondition()).toBe(
      `github.ref == 'refs/heads/${ALLOWED_BRANCH}' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && contains(github.event.head_commit.message, '[PUBLISH-APPROVED]') && !contains(github.event.head_commit.message, 'レビュー継続中')))`,
    );
  });

  /** yml の式を JS に翻訳して評価する。contains は大文字小文字を区別しない(Actions と同じ)。message=null は dispatch を模す。 */
  function evaluate(input: { ref: string; event: string; message: string | null }): boolean {
    const js = deployCondition()
      .replace(/github\.event\.head_commit\.message/g, "msg")
      .replace(/github\.event_name/g, "event")
      .replace(/github\.ref/g, "ref")
      .replace(/ == /g, " === ");
    const contains = (haystack: string | null, needle: string): boolean =>
      haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());
    return new Function("ref", "event", "msg", "contains", `return (${js});`)(
      input.ref,
      input.event,
      input.message,
      contains,
    ) as boolean;
  }

  const REF = `refs/heads/${ALLOWED_BRANCH}`;
  const STAMP = "Issue #161: 実装 [PUBLISH-APPROVED]";

  it.each([
    ["許可ブランチ + 承認印付き push", { ref: REF, event: "push", message: STAMP }, true],
    ["許可ブランチ + 手動実行(head_commit は null)", { ref: REF, event: "workflow_dispatch", message: null }, true],
    ["許可ブランチ + 印のない push", { ref: REF, event: "push", message: "Issue #161: 実装" }, false],
    ["許可ブランチ + 承認印とレビュー継続中が両方ある push", { ref: REF, event: "push", message: `${STAMP}\n\n(レビュー継続中)` }, false],
    ["許可ブランチ + レビュー継続中のみの push", { ref: REF, event: "push", message: "Issue #161: x(レビュー継続中)" }, false],
    ["別ブランチ + 承認印付き push", { ref: "refs/heads/claude/other", event: "push", message: STAMP }, false],
    ["別ブランチ + 手動実行(任意のブランチから本番に出せない)", { ref: "refs/heads/claude/other", event: "workflow_dispatch", message: null }, false],
    ["main への手動実行", { ref: "refs/heads/main", event: "workflow_dispatch", message: null }, false],
    ["タグ ref + 承認印付き push", { ref: "refs/tags/v1.0.0", event: "push", message: STAMP }, false],
    ["タグ ref + 手動実行", { ref: "refs/tags/v1.0.0", event: "workflow_dispatch", message: null }, false],
    ["許可ブランチ + 想定外のイベント(pull_request)", { ref: REF, event: "pull_request", message: STAMP }, false],
  ])("%s → %s", (_name, input, expected) => {
    // 前提: 基準となる「通る入力」が通ること(否定の行が、式の評価器の故障で偶然 false になっていない確認)
    expect(evaluate({ ref: REF, event: "push", message: STAMP })).toBe(true);
    expect(evaluate(input)).toBe(expected);
  });

  it("check に依存する(型検査・テスト・dry-run を通ったあとだけデプロイする)", () => {
    expect(jobBody("deploy")).toMatch(/\n {4}needs: check\n/);
  });
});

describe("deploy ジョブのステップ(秘密・サブドメインの扱いと、デプロイの順序)", () => {
  const deploy = jobBody("deploy");

  it("Secrets の存在確認 → サブドメインのマスク → wrangler deploy → 事後確認 の順で、wrangler deploy は1回だけ", () => {
    const names = ["Secrets の存在を確認", "サブドメインを取得してマスク", "Worker をデプロイ", "事後確認"];
    const idx = names.map((n) => stepIndex(deploy, n));
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
    }
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const install = stepIndex(deploy, "依存をインストール");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(idx[2]!);
    const occurrences = withoutComments(deploy).split("\n").filter((l) => /wrangler deploy/.test(l));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).not.toContain("--dry-run");
  });

  it("マスクは、wrangler deploy(URL をログに出す)より前にサブドメインに対して登録される", () => {
    const mask = stepBody(deploy, "サブドメインを取得してマスク");
    expect(mask).toContain("::add-mask::");
    expect(mask).toContain("/workers/subdomain");
    // マスクを登録してから GITHUB_ENV に書く(順序)
    expect(mask.indexOf("::add-mask::")).toBeLessThan(mask.indexOf("GITHUB_ENV"));
    // API の応答をそのままログに出さない
    expect(mask).toContain("-o ");
  });

  it("Secrets は、必要なステップの env にだけ渡す(ジョブ全体の env に置かない)", () => {
    const jobEnv = /\n {4}env:\n((?: {6}.+\n)+)/.exec(deploy.replace(/\n {4}steps:[\s\S]*/, "\n"));
    const jobEnvText = jobEnv === null ? "" : jobEnv[1]!;
    expect(jobEnvText).not.toContain("secrets.");
    expect(stepBody(deploy, "Worker をデプロイ")).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(stepBody(deploy, "Worker をデプロイ")).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  });

  it("事後確認は、認証なしの GET が 302/401/403 のいずれかであることを確かめ、2xx は失敗にする。URL・サブドメインを出力しない", () => {
    const step = stepBody(deploy, "事後確認");
    const code = withoutComments(step);
    expect(code).toContain("%{http_code}");
    expect(code).toContain("-o /dev/null");
    // case の腕(ラベルと本体)を固定する: 302|401|403 は成功(exit 0)、2xx は失敗(exit 1)。ほかの腕を足せない
    const arms = [...code.matchAll(/^\s+([0-9?|]+)\)\n((?:\s+.+\n)*?)\s+;;/gm)].map((m) => ({ label: m[1]!, body: m[2]! }));
    expect(arms.map((a) => a.label)).toEqual(["302|401|403", "2??"]);
    expect(arms[0]!.body).toContain("exit 0");
    expect(arms[1]!.body).toContain("exit 1");
    // 認証用のヘッダ・クッキー・トークンを付けない(認証なしの確認)
    expect(code).not.toMatch(/-H |--header|--cookie|-b |Authorization|CF_Authorization/);
    // 詳細出力・トレース・リダイレクト追従をしない(リダイレクト先の URL が出る)
    expect(code).not.toMatch(/curl[^\n]* (-v|--verbose|-i|--include|-L|--location)\b/);
    expect(code).not.toContain("set -x");
    expect(code).not.toContain("GITHUB_STEP_SUMMARY");
    // URL の変数を echo / printf しない
    expect(code).not.toMatch(/(echo|printf)[^\n]*(\$URL|\$\{URL\}|workers\.dev|\$SUBDOMAIN|\$\{CF_SUBDOMAIN\}|\$CF_SUBDOMAIN)/);
  });

  it("サブドメインを ${{ }} で env に展開しない(ログに出る形で渡さない)", () => {
    expect(yml).not.toMatch(/\$\{\{[^}]*subdomain[^}]*\}\}/i);
  });
});

describe("Worker 名", () => {
  it("本番の Worker 名は wrangler.toml と一致し、スパイクの接頭辞(後片付けが接頭辞で削除する)と衝突しない", () => {
    const toml = readTextLf("cloud", "wrangler.toml");
    const tomlName = /^name = "([^"]+)"$/m.exec(toml)?.[1];
    const ymlName = /^ {6}WORKER_NAME: "?([^"\n]+)"?$/m.exec(yml)?.[1];
    expect(tomlName).toBe("keiba-cloud");
    expect(ymlName).toBe(tomlName);
    expect(SPIKE_WORKER_PREFIX).toBe("keiba-cf-spike-");
    expect(tomlName!.startsWith(SPIKE_WORKER_PREFIX)).toBe(false);
    expect(SPIKE_WORKER_PREFIX.startsWith(tomlName!)).toBe(false);
  });
});
