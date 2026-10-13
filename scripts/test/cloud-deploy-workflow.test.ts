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
 *
 * Issue #288: check から smoke を別ジョブに分けた(check と smoke は並列、deploy は両方を待つ)。ジョブ構成(3 ジョブ・needs・並列)・各ジョブのコマンド・
 * 『smoke だけが失敗したら deploy が止まる』(公式の記述に基づく静的な検査)を固定する。deploy の if: の式と真理値表は変えていない。
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

/** 応答ファイルの中身をログに出す形(cat / tee)。mask ステップの検査と、その検出が空振りでないことの対照で同じものを使う(Issue #161 の記録)。 */
const DUMPS_FILE_PATTERN = /\b(cat|tee)\b/;

/** 実行トレース(set -x など)を有効にする記述があるか。 */
function tracesCommands(code: string): boolean {
  return /\bset\s+-[a-zA-Z]*x|\b(ba)?sh\s+-[a-zA-Z]*x|xtrace/.test(code);
}

/** URL・サブドメインの変数を、ログに出る形で echo/printf している行。マスク命令と GITHUB_ENV への追記は除く。 */
function leakedLines(code: string): string[] {
  return code.split("\n").filter((line) => {
    if (!/\b(echo|printf)\b/.test(line)) {
      return false;
    }
    if (line.includes("::add-mask::") || /GITHUB_ENV/.test(line)) {
      return false;
    }
    return /\$\{?(url|sub|CF_SUBDOMAIN)\b/i.test(line) || /[a-z0-9}-]\.workers\.dev/i.test(line);
  });
}

/** マスクより前の行のうち、サブドメインの変数($sub / CF_SUBDOMAIN)を出力するもの。 */
function beforeMaskLeaks(code: string): string[] {
  return code.split("\n").filter((line) => /\b(echo|printf)\b/.test(line) && /\$\{?(sub|CF_SUBDOMAIN)\b/i.test(line));
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

/** `jobs:` 直下のジョブ ID を、出現順に列挙する。 */
function jobIds(): string[] {
  const lines = yml.split("\n");
  const start = lines.indexOf("jobs:");
  expect(start, "jobs: がある").toBeGreaterThanOrEqual(0);
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null) ids.push(m[1]!);
  }
  return ids;
}

/** ジョブの `needs:`(`needs: a` も `needs: [a, b]` も受ける)。無ければ null。 */
function needsOf(job: string): string[] | null {
  const m = /^ {4}needs:[ \t]*(.+)$/m.exec(withoutComments(job));
  if (m === null) return null;
  return m[1]!
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** ジョブ内の `run:` の単一行コマンドを、出現順に返す(コメント行は除く)。 */
function runCommands(job: string): string[] {
  return withoutComments(job)
    .split("\n")
    .map((l) => /^\s+run: (.+)$/.exec(l)?.[1]?.trim())
    .filter((c): c is string => c !== undefined);
}

const CLOUD_INSTALL = "pnpm install --ignore-workspace --frozen-lockfile";

describe("ジョブ構成(Issue #288: 型検査・テストの check と、スモークの smoke を並列に走らせ、deploy は両方を待つ)", () => {
  it("jobs: 直下のジョブは check・smoke・deploy の3つだけ(ジョブの増減・改名を検出する)", () => {
    expect(jobIds()).toEqual(["check", "smoke", "deploy"]);
  });

  it("check と smoke は needs を持たない(互いを待たない=並列に走る。直列化の退行を検出する)", () => {
    expect(needsOf(jobBody("check"))).toBeNull();
    expect(needsOf(jobBody("smoke"))).toBeNull();
  });

  it("検出器の確認(空振りでない): needsOf は単独指定・配列指定・指定なしを区別して読む", () => {
    expect(needsOf("  x:\n    needs: check\n")).toEqual(["check"]);
    expect(needsOf("  x:\n    needs: [check, smoke]\n")).toEqual(["check", "smoke"]);
    expect(needsOf("  x:\n    # needs: check\n    runs-on: y\n")).toBeNull();
    expect(jobBody("deploy")).toContain("needs:");
  });
});

describe.each([
  ["check", "型検査・テスト・デプロイの dry-run・D1 の migration(ローカル)"],
  ["smoke", "ローカルスモーク"],
] as const)("%s ジョブ(毎回走る。秘密を持たない): %s", (jobName, _summary) => {

  it("if を持たず(印のない push でも走る)、Secrets を一切参照しない。continue-on-error も付けない(失敗が deploy を止める)", () => {
    const job = jobBody(jobName);
    expect(withoutComments(job)).not.toMatch(/^\s+if:/m);
    expect(job).not.toContain("secrets.");
    expect(job).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(withoutComments(job)).not.toMatch(/continue-on-error/);
  });

  it("cloud/ で、frozen-lockfile のインストールを自分のジョブの中で行う。pnpm・Node(22)・キャッシュ(cloud のロックファイル)も自前で用意する(並列なので他方のジョブの成果物を前提にできない)", () => {
    const job = jobBody(jobName);
    const names = [...job.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]!.trim());
    expect(names.slice(0, 4)).toEqual(["リポジトリを取得", "pnpm をセットアップ", "Node.js をセットアップ", "依存をインストール(cloud)"]);
    expect(stepBody(job, "pnpm をセットアップ")).toContain("uses: pnpm/action-setup@v4");
    const node = stepBody(job, "Node.js をセットアップ");
    expect(node).toMatch(/node-version: 22\b/);
    expect(node).toContain("cache: pnpm");
    expect(node).toContain("cache-dependency-path: cloud/pnpm-lock.yaml");
    const install = stepBody(job, "依存をインストール");
    expect(install).toContain("working-directory: cloud");
    expect(install).toContain(`run: ${CLOUD_INSTALL}`);
  });

  it("ジョブ全体の env に WRANGLER_SEND_METRICS=false を持ち、timeout-minutes を持つ", () => {
    const job = jobBody(jobName);
    expect(job).toMatch(/\n {6}WRANGLER_SEND_METRICS: "false"\n/);
    expect(job).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });
});

describe("check ジョブのコマンド(順序つきで完全一致)", () => {
  it("install → 型検査 → テスト → デプロイの dry-run → D1 の migration(ローカル)の順に、この5つだけを実行する(smoke は含まない)", () => {
    const check = jobBody("check");
    expect(runCommands(check)).toEqual([
      CLOUD_INSTALL,
      "pnpm run typecheck",
      "pnpm test",
      "pnpm run deploy:dry",
      "pnpm exec wrangler d1 migrations apply DB --local",
    ]);
    // 5つのコマンドは、すべて cloud/ で実行する(各ステップに working-directory: cloud がある)
    const stepNames = ["依存をインストール", "型検査", "テスト", "dry-run", "D1 の migration をローカルに適用"];
    for (const n of stepNames) {
      expect(stepBody(check, n), n).toContain("working-directory: cloud");
    }
    // ステップの順序(名前でも固定)
    const idx = stepNames.map((n) => stepIndex(check, n));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("AC-a4: D1 の migration は --local だけで適用する(check は秘密を持たず、本番の D1 に触れない)。--remote は check に無い", () => {
    const check = jobBody("check");
    const step = stepBody(check, "D1 の migration をローカルに適用");
    expect(step).toContain("working-directory: cloud");
    const commands = withoutComments(step).split("\n").filter((l) => /wrangler d1 migrations apply/.test(l));
    expect(commands.map((l) => l.trim())).toEqual(["run: pnpm exec wrangler d1 migrations apply DB --local"]);
    expect(withoutComments(check)).not.toContain("--remote");
    // 適用先は binding 名 DB(wrangler.toml の [[d1_databases]] と同じ)
    expect(readTextLf("cloud", "wrangler.toml")).toMatch(/^binding = "DB"$/m);
  });
});

describe("smoke ジョブのコマンド(順序つきで完全一致)", () => {
  it("install → スモークの2つだけを実行する。スモークは cloud/ で実行する", () => {
    const smoke = jobBody("smoke");
    expect(runCommands(smoke)).toEqual([CLOUD_INSTALL, "pnpm run smoke"]);
    expect(stepBody(smoke, "スモーク")).toContain("working-directory: cloud");
    expect(stepIndex(smoke, "依存をインストール")).toBeLessThan(stepIndex(smoke, "スモーク"));
  });

  it("本番の D1 に触れない(--remote・migrations apply は smoke ジョブに無い。スモークは自分の一時の保存先に自前で適用する〈smoke.ts〉)", () => {
    const smoke = jobBody("smoke");
    expect(withoutComments(smoke)).not.toContain("--remote");
    expect(withoutComments(smoke)).not.toMatch(/migrations apply/);
  });
});

describe("check と smoke の分割で、元の6コマンドが1つも落ちていない(Issue #288 の対応表: 旧 check ジョブの『6コマンドの順序』の保証)", () => {
  it("check の5コマンドと smoke の smoke を合わせると、旧 check ジョブの6コマンド(install・型検査・テスト・dry-run・migration・smoke)がそろう。install は2ジョブとも持つ", () => {
    const all = [...runCommands(jobBody("check")), ...runCommands(jobBody("smoke"))];
    for (const c of [
      CLOUD_INSTALL,
      "pnpm run typecheck",
      "pnpm test",
      "pnpm run deploy:dry",
      "pnpm exec wrangler d1 migrations apply DB --local",
      "pnpm run smoke",
    ]) {
      expect(all, c).toContain(c);
    }
    expect(all.filter((c) => c === CLOUD_INSTALL)).toHaveLength(2);
    expect(all).toHaveLength(7);
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
  it("式の文字列を完全一致で固定する(Issue #248 で廃止した exe の公開ゲートと同じ形に、許可ブランチの限定を足したもの)", () => {
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

  /**
   * Issue #288 の受け入れ条件『smoke だけが失敗したときに deploy が止まる』を、静的に固定する。
   *
   * 根拠(GitHub Actions の公式の記述。2026-10-13 に docs.github.com で確認した原文):
   * - ワークフロー構文(jobs.<job_id>.needs): "If a job fails or is skipped, all jobs that need it are skipped unless the jobs use a conditional expression that causes the job to continue."
   *   (継続させたいときは jobs.<job_id>.if に always() を書く、とも述べている)
   * - 式(Status check functions): "A default status check of `success()` is applied unless you include one of these functions."
   *   (success() は "Returns `true` when all previous steps have succeeded.")
   * したがって deploy の if: に always()・failure()・cancelled() が無ければ、needs の失敗・スキップ・取り消しで deploy はスキップされる。
   * **限界**: これは公式の記述に基づくモデルの評価であり、Actions の実評価ではない(使い捨てブランチでの実験は行わない。Issue #288 の方針)。
   */
  type JobResult = "success" | "failure" | "skipped" | "cancelled";
  /** 公式の記述のモデル: needs の全ジョブが success で、かつ if: の式が true のときだけ deploy が実行される。 */
  function deployRuns(results: Record<string, JobResult>, conditionHolds: boolean): boolean {
    const needs = needsOf(jobBody("deploy"));
    expect(needs, "deploy ジョブに needs: がある").not.toBeNull();
    return needs!.every((n) => results[n] === "success") && conditionHolds;
  }

  it("Issue #288: deploy は check と smoke の両方に依存する(順序は問わない。型検査・テスト・dry-run・migration とスモークの両方を通ったあとだけデプロイする)", () => {
    expect([...needsOf(jobBody("deploy"))!].sort()).toEqual(["check", "smoke"]);
  });

  it("Issue #288: deploy の if: は状態確認の関数(always・failure・cancelled)を含まない。含むと needs の失敗・スキップ後も deploy が走りうる", () => {
    // 前提: 式を取り出せていて、承認印の式として中身がある(空文字の『含まない』にしない)
    expect(deployCondition()).toContain("[PUBLISH-APPROVED]");
    expect(deployCondition()).not.toMatch(/\b(always|failure|cancelled)\s*\(/);
    // 検出器の確認(空振りでない)
    expect("always() && x").toMatch(/\b(always|failure|cancelled)\s*\(/);
    expect("x && !cancelled()").toMatch(/\b(always|failure|cancelled)\s*\(/);
    expect("failure()").toMatch(/\b(always|failure|cancelled)\s*\(/);
  });

  it("Issue #288: 全ジョブに continue-on-error が無い(付くと失敗しても『成功』として needs を通過する)", () => {
    expect(withoutComments(yml)).not.toMatch(/continue-on-error/);
  });

  it.each([
    ["check も smoke も成功", { check: "success", smoke: "success" }, true],
    ["smoke だけが失敗", { check: "success", smoke: "failure" }, false],
    ["check だけが失敗", { check: "failure", smoke: "success" }, false],
    ["両方が失敗", { check: "failure", smoke: "failure" }, false],
    ["smoke がスキップ", { check: "success", smoke: "skipped" }, false],
    ["smoke が取り消し", { check: "success", smoke: "cancelled" }, false],
    ["check がスキップ", { check: "skipped", smoke: "success" }, false],
  ] as const)("Issue #288: %s → deploy が実行される: %s", (_name, results, expected) => {
    // 前提: 基準(両方成功 + 承認印付きの許可ブランチ push)で deploy が実行される。必要な依存が足りないと偽になる評価器の故障で、否定の行が偶然通らない確認
    expect(evaluate({ ref: REF, event: "push", message: STAMP })).toBe(true);
    expect(deployRuns({ check: "success", smoke: "success" }, true)).toBe(true);
    expect(deployRuns(results, evaluate({ ref: REF, event: "push", message: STAMP }))).toBe(expected);
  });
});

describe("deploy ジョブのステップ(秘密・サブドメインの扱いと、デプロイの順序)", () => {
  const deploy = jobBody("deploy");

  it("Secrets の存在確認 → database_id の確認 → サブドメインのマスク → D1 の権限確認 → R2 の権限確認(#174)→ D1 の migration(本番)→ wrangler deploy → 事後確認 の順で、wrangler deploy は1回だけ", () => {
    const names = [
      "Secrets の存在を確認",
      "database_id が仮の値でないことを確認",
      "サブドメインを取得してマスク",
      "D1 の権限を確認",
      "R2 の権限を確認",
      "D1 の migration を本番に適用",
      "Worker をデプロイ",
      "事後確認",
    ];
    const idx = names.map((n) => stepIndex(deploy, n));
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
    }
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // 仮の ID のガードは、リポジトリの取得の後(wrangler.toml を読むため)で、依存のインストールよりも前(早く落ちる)
    expect(idx[1]!).toBeGreaterThan(stepIndex(deploy, "リポジトリを取得"));
    expect(idx[1]!).toBeLessThan(stepIndex(deploy, "依存をインストール"));
    // wrangler を使うステップ(migration・deploy)は、依存のインストールの後
    const install = stepIndex(deploy, "依存をインストール");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(idx[5]!);
    // R2 の権限確認は、本番の D1 への migration(取り消せない変更)よりも前: バケットを使えないまま migration だけが進まない
    expect(idx[4]!).toBeLessThan(idx[5]!);
    // wrangler deploy より前(権限不足を、デプロイの失敗より先に、はっきり知らせる)
    expect(idx[4]!).toBeLessThan(idx[6]!);
    const occurrences = withoutComments(deploy).split("\n").filter((l) => /wrangler deploy/.test(l));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).not.toContain("--dry-run");
  });

  it("AC-a4: 本番への migration の適用(--remote)は、deploy ジョブに1回だけあり、wrangler deploy より前。--local は deploy ジョブに無い", () => {
    const code = withoutComments(yml);
    const remote = code.split("\n").filter((l) => /wrangler d1 migrations apply/.test(l) && l.includes("--remote"));
    expect(remote.map((l) => l.trim())).toEqual(["run: pnpm exec wrangler d1 migrations apply DB --remote"]);
    expect(withoutComments(deploy)).not.toContain("--local");
    // yml 全体で、migrations apply は --local(check)と --remote(deploy)の2回だけ
    expect(code.split("\n").filter((l) => /wrangler d1 migrations apply/.test(l))).toHaveLength(2);
    const step = stepBody(deploy, "D1 の migration を本番に適用");
    expect(step).toContain("working-directory: cloud");
    expect(step).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(step).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    // migration の適用が失敗したら、後続の deploy には進まない(continue-on-error を付けない。ジョブ内のどのステップにも付けない)
    expect(withoutComments(deploy)).not.toMatch(/continue-on-error/);
    expect(stepIndex(deploy, "D1 の migration を本番に適用")).toBeLessThan(stepIndex(deploy, "Worker をデプロイ"));
  });

  it("AC-a5: database_id の確認ステップと D1 の権限確認ステップは、API の応答本文を出力しない(ステータスコードだけ)", () => {
    const permission = withoutComments(stepBody(deploy, "D1 の権限を確認"));
    expect(permission).toContain("%{http_code}");
    expect(permission).toContain("-o /dev/null");
    expect(permission).toContain("/d1/database/");
    // 応答をファイルに書いて表示する・詳細出力・ヘッダ出力をしない
    expect(permission).not.toMatch(/\bcat\b/);
    expect(permission).not.toMatch(/curl[^\n]* (-v|--verbose|-i|--include|-D|--dump-header|--trace|--trace-ascii)\b/);
    // トークンは env から Authorization ヘッダに渡すだけで、echo/printf に出さない
    expect(permission).not.toMatch(/\b(echo|printf)\b[^\n]*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/);
    // 秘密は、このステップの env にだけ渡す
    const raw = stepBody(deploy, "D1 の権限を確認");
    expect(raw).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(raw).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    // database_id の確認は秘密を使わない(リポジトリの値を見るだけ)
    expect(stepBody(deploy, "database_id が仮の値でないことを確認")).not.toContain("secrets.");
  });

  it("Issue #174: R2 の権限確認ステップは、API の応答本文を出力しない(ステータスコードだけ)。秘密はこのステップの env にだけ渡す", () => {
    const raw = stepBody(deploy, "R2 の権限を確認");
    const step = withoutComments(raw);
    expect(step).toContain("%{http_code}");
    expect(step).toContain("-o /dev/null");
    expect(step).toContain("/r2/buckets/");
    expect(step).not.toMatch(/\bcat\b/);
    expect(step).not.toMatch(/curl[^\n]* (-v|--verbose|-i|--include|-D|--dump-header|--trace|--trace-ascii)\b/);
    expect(step).not.toMatch(/\b(echo|printf)\b[^\n]*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/);
    expect(raw).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(raw).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    // 検出の確認(空振りでない): 本文を表示する形は拾える
    expect('curl -o "$out" ...\ncat "$out"').toMatch(/\bcat\b/);
  });

  it("マスクは、wrangler deploy(URL をログに出す)より前にサブドメインに対して登録される", () => {
    const mask = stepBody(deploy, "サブドメインを取得してマスク");
    expect(mask).toContain("::add-mask::");
    expect(mask).toContain("/workers/subdomain");
    // マスクを登録してから GITHUB_ENV に書く(順序)
    expect(mask.indexOf("::add-mask::")).toBeLessThan(mask.indexOf("GITHUB_ENV"));
    // API の応答をそのままログに出さない
    expect(mask).toContain("-o ");
    // 応答を書いたファイル($out)を cat / tee でログに出さない(マスク登録の前に、サブドメインを含む応答が漏れる。Issue #161 の記録)。
    // 検出の確認(空振りでない): 本文を表示する形は拾える
    expect('curl -o "$out" ...\ncat "$out"').toMatch(DUMPS_FILE_PATTERN);
    expect('curl -o "$out" ...\ntee -a "$out"').toMatch(DUMPS_FILE_PATTERN);
    expect(withoutComments(mask)).not.toMatch(DUMPS_FILE_PATTERN);
  });

  it("Secrets は、必要なステップの env にだけ渡す(ジョブ全体の env に置かない)", () => {
    const jobEnv = /\n {4}env:\n((?: {6}.+\n)+)/.exec(deploy.replace(/\n {4}steps:[\s\S]*/, "\n"));
    const jobEnvText = jobEnv === null ? "" : jobEnv[1]!;
    expect(jobEnvText).not.toContain("secrets.");
    expect(stepBody(deploy, "Worker をデプロイ")).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(stepBody(deploy, "Worker をデプロイ")).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  });

  it("事後確認は、認証なしの GET が 302/401/403 のいずれかであることを確かめ、2xx は失敗にする", () => {
    const code = withoutComments(stepBody(deploy, "事後確認"));
    expect(code).toContain("%{http_code}");
    expect(code).toContain("-o /dev/null");
    // case の腕(ラベルと本体)を固定する: 302|401|403 は成功(exit 0)、2xx は失敗(exit 1)。ほかの腕を足せない
    const arms = [...code.matchAll(/^\s+([0-9?|]+)\)\n((?:\s+.+\n)*?)\s+;;/gm)].map((m) => ({ label: m[1]!, body: m[2]! }));
    expect(arms.map((a) => a.label)).toEqual(["302|401|403", "2??"]);
    expect(arms[0]!.body).toContain("exit 0");
    expect(arms[1]!.body).toContain("exit 1");
    // 認証用のヘッダ・クッキー・トークンを付けない(認証なしの確認)
    expect(code).not.toMatch(/-H |--header|--cookie|-b |Authorization|CF_Authorization/);
    // 詳細出力・リダイレクト追従をしない(リダイレクト先の URL が出る)
    expect(code).not.toMatch(/curl[^\n]* (-v|--verbose|-i|--include|-L|--location)\b/);
  });

  it("どのステップにも set -x(実行トレース)が無い。トレースは変数展開後の URL・サブドメインをログに出す", () => {
    expect(tracesCommands("set -x\ncurl x")).toBe(true);
    expect(tracesCommands("set -euxo pipefail")).toBe(true);
    expect(tracesCommands("bash -x script.sh")).toBe(true);
    expect(tracesCommands("set -o xtrace")).toBe(true);
    expect(tracesCommands("set -e\ncurl -sS x")).toBe(false);
    expect(tracesCommands(withoutComments(yml))).toBe(false);
  });

  it("URL・サブドメインの変数(url / sub / CF_SUBDOMAIN。大文字小文字を問わない)を、ログに出す形で echo / printf しない", () => {
    // 検出器の確認(空振りしていない): ログに出る形は検出し、マスク命令と GITHUB_ENV への追記は許す
    expect(leakedLines('echo "$url"')).toHaveLength(1);
    expect(leakedLines("echo ${url}")).toHaveLength(1);
    expect(leakedLines('echo "$URL"')).toHaveLength(1);
    expect(leakedLines('echo "sub=$sub"')).toHaveLength(1);
    expect(leakedLines("printf '%s' \"$sub\"")).toHaveLength(1);
    expect(leakedLines('echo "host: $CF_SUBDOMAIN"')).toHaveLength(1);
    expect(leakedLines('echo "https://x.workers.dev"')).toHaveLength(1);
    expect(leakedLines('echo "::add-mask::$sub"')).toEqual([]);
    expect(leakedLines('echo "CF_SUBDOMAIN=$sub" >> "$GITHUB_ENV"')).toEqual([]);
    // 実物
    expect(leakedLines(withoutComments(yml))).toEqual([]);
  });

  it("マスクの登録(::add-mask::$sub)より前に、サブドメインの変数を出力する行が無い", () => {
    const mask = withoutComments(stepBody(deploy, "サブドメインを取得してマスク")).split("\n");
    const maskLine = mask.findIndex((l) => l.includes("::add-mask::$sub"));
    expect(maskLine).toBeGreaterThan(0);
    const before = mask.slice(0, maskLine).join("\n");
    expect(beforeMaskLeaks('echo "$sub"')).toHaveLength(1);
    expect(beforeMaskLeaks("echo ok")).toEqual([]);
    expect(beforeMaskLeaks(before)).toEqual([]);
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
