import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #159 スパイクのワークフロー(.github/workflows/cloudflare-spike.yml)の静的検査。
 *
 * **限界**: これは yml のテキストへの検査であり、GitHub Actions の式が実際にどう評価されるかは
 * 検証できない(`if:` の評価は Actions 上でしか行われない)。ここで固定するのは「印のない push では
 * 何もしない」「共有秘密をログに出さない」「失敗時も Worker を消す」といった、人が yml を書き換える
 * ときに壊しやすい安全装置が、文面として残っていることだけである。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = readFileSync(path.join(ROOT, ".github", "workflows", "cloudflare-spike.yml"), "utf-8");

/** `- name: <名前>` で始まるステップの本文(次のステップ直前まで)を返す。 */
function stepBody(nameFragment: string): string {
  const lines = yml.split("\n");
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

function stepIndex(nameFragment: string): number {
  return yml.split("\n").findIndex((l) => /^\s+- name:/.test(l) && l.includes(nameFragment));
}

describe("起動条件(印のない push では何もしない)", () => {
  it("push の対象ブランチは作業ブランチ1本だけで、タグやワイルドカードは含まない", () => {
    const m = /\n  push:\n    branches:\n((?:      - .+\n)+)/.exec(yml);
    expect(m).not.toBeNull();
    const branches = m![1]!.trim().split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim());
    expect(branches).toEqual(["claude/issue-order-processing-wjgpdd"]);
    expect(yml).not.toMatch(/\n    tags:/);
    expect(yml).toContain("workflow_dispatch:");
  });

  it("ジョブの if は『workflow_dispatch』または『push かつ先端コミットメッセージに [CF-SPIKE]』だけを通す", () => {
    const m = /\n    if: (.+)\n/.exec(yml);
    expect(m).not.toBeNull();
    const cond = m![1]!;
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("github.event_name == 'push'");
    expect(cond).toContain("contains(github.event.head_commit.message, '[CF-SPIKE]')");
    // 条件式の構造: A || (B && C)。印のない push を通す形(印の否定だけ・印の contains が無い等)になっていない
    expect(cond).toMatch(/^\$\{\{ github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && contains\(github\.event\.head_commit\.message, '\[CF-SPIKE\]'\)\) \}\}$/);
  });

  it("同時実行は1本に絞り、実行中の run を途中で打ち切らない(打ち切ると Worker が残る)", () => {
    expect(yml).toMatch(/concurrency:\n\s+group: cloudflare-spike\n\s+cancel-in-progress: false/);
  });

  it("権限は contents: read のみ(リポジトリへ書き戻さない)", () => {
    expect(yml).toMatch(/permissions:\n\s+contents: read/);
    expect(yml).not.toMatch(/contents: write/);
  });
});

describe("Secrets とトークンの関門が、依存のインストールやデプロイより前にある", () => {
  it("Secrets の存在確認 → 依存インストール → トークン・権限の検査 → デプロイ の順", () => {
    const secrets = stepIndex("Secrets の存在");
    const install = stepIndex("依存をインストール");
    const preflight = stepIndex("トークンと権限の検査");
    const deploy = stepIndex("Worker をデプロイ");
    expect(secrets).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(secrets);
    expect(preflight).toBeGreaterThan(install);
    expect(deploy).toBeGreaterThan(preflight);
  });

  it("Secrets の存在確認は2つの Secret 名を名指しして、空なら exit 1 で止まる", () => {
    const body = stepBody("Secrets の存在");
    expect(body).toContain("CLOUDFLARE_API_TOKEN");
    expect(body).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(body).toContain("exit 1");
  });

  it("依存のインストールは spikes/cloudflare で、ワークスペース外・ロックファイル固定", () => {
    const body = stepBody("依存をインストール");
    expect(body).toContain("pnpm install --ignore-workspace --frozen-lockfile");
    expect(body).toContain("spikes/cloudflare");
  });
});

describe("共有秘密をログに出さない", () => {
  it("add-mask でマスクし、--secrets-file に渡したファイルは、デプロイの直後(成否にかかわらず)に削除する", () => {
    expect(yml).toContain("::add-mask::");
    const body = stepBody("Worker をデプロイ");
    const passed = /--secrets-file "(\$\w+)"/.exec(body);
    expect(passed, "--secrets-file に変数でファイルを渡している").not.toBeNull();
    const fileVar = passed![1]!;
    const rm = body.indexOf(`rm -f "${fileVar}"`);
    expect(rm).toBeGreaterThan(body.indexOf("--secrets-file"));
    // デプロイの失敗(終了コード)で rm が飛ばされないよう、rc に退避してから rm し、最後に exit "$rc" で返す
    expect(body).toMatch(/\|\| rc=\$\?/);
    expect(body.indexOf('exit "$rc"')).toBeGreaterThan(rm);
    // マスクは、秘密をファイルや GITHUB_ENV に書くより前に登録する
    expect(body.indexOf("::add-mask::")).toBeLessThan(body.indexOf("printf"));
    expect(body.indexOf("::add-mask::")).toBeLessThan(body.indexOf("GITHUB_ENV"));
  });

  it("set -x(コマンドのエコー)を一切使わない", () => {
    expect(yml).not.toMatch(/set\s+-[a-z]*x/);
    expect(yml).not.toMatch(/\bxtrace\b/);
  });

  it("使う Secrets は CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID の2つだけ(実 Claude API のキー等を使わない)", () => {
    const used = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]));
    expect(yml).not.toMatch(/ANTHROPIC/);
  });
});

describe("後片付け(失敗時も Worker を消す)と結果の出力", () => {
  it("wrangler delete のステップは always() で実行される", () => {
    const body = stepBody("Worker を削除");
    expect(body).toMatch(/if: \$\{\{ always\(\) \}\}/);
    expect(body).toContain("wrangler delete");
  });

  it("削除の確認(残存 Worker の一覧検査と結果ブロックの出力)も always() で、削除より後ろにある", () => {
    const del = stepIndex("Worker を削除");
    const verify = stepIndex("削除の確認");
    expect(verify).toBeGreaterThan(del);
    expect(stepBody("削除の確認")).toMatch(/if: \$\{\{ always\(\) \}\}/);
  });

  it("結果の全文は、ジョブログ(印で挟んだ1行)・step summary・artifact の3か所に出す。ログへの出力は失敗通知より後(末尾)", () => {
    expect(stepBody("削除の確認")).toContain("cleanup-run.ts");
    expect(yml).toContain("actions/upload-artifact");
    // 出力の実体は cleanup-run.ts(配線は fake の Cloudflare API サーバに向けて実行して確認済み。ここは静的な固定)
    const src = readFileSync(path.join(ROOT, "spikes", "cloudflare", "cleanup-run.ts"), "utf-8");
    expect(src).toContain("GITHUB_STEP_SUMMARY");
    expect(src).toContain("console.log(formatResultBlock(result))");
    expect(src.indexOf("::error")).toBeGreaterThan(-1);
    expect(src.indexOf("console.log(formatResultBlock(result))")).toBeGreaterThan(src.indexOf("::error"));
  });

  it("ジョブにタイムアウトがある(Durable Object の探索が暴走しても止まる)", () => {
    expect(yml).toMatch(/timeout-minutes: \d+/);
  });
});
