/**
 * 全部の検証を流すスクリプト(scripts/verify-all.sh)の、段の形と CI との対応の静的・動的テスト(Issue #606・#620)。
 *
 * 背景: #606 で、レビュー担当は全部のテストと smoke を流さず、実装担当がこのスクリプトを流す分担にした。#620 でテストを 3 層
 * (ユニット/インテグレーション/全件と smoke)に分け、既定では速い検査(ユニットの全件と、関係するインテグレーション)だけを流し、
 * 全件と smoke は push 後の CI で確かめる形にした。`--full` は CI が流す段をそのまま全部流す(従来の挙動)。
 * 「CI に段を足したのにスクリプト(--full)に足し忘れる」と、全件の検証だけが CI より甘くなる(CLAUDE.md 鉄則 9 の再発)ので、
 * このテストは CI の run: のコマンドと `--full` の段を突き合わせ、片方だけに足すと赤くなるようにする。
 *
 * 検証する不変条件:
 * 1. ci.yml と deploy-cloud.yml の deploy 以外のジョブの run: のうち、依存のインストール以外のコマンド(作業ディレクトリつき)が、
 *    `--full --dry-run` の出力に 1 つ残らず現れる(CI → スクリプト)。
 * 2. `--full --dry-run` の出力の段(確率の質の `--research` の段を除く)は、どれも CI の run: に現れる(スクリプト → CI。CI に無い検証を黙って足さない)。
 * 3. 段の順序: ルートの型検査 → ルートのテスト → cloud の型検査 → テスト → dry-run → D1 の migration(ローカル)の順(deploy-cloud.yml の check ジョブの順)で、
 *    smoke は最後。
 * 3b. 既定(--full 無し)の形: smoke と cloud の全件(`pnpm test`)を流さず、ユニットの全件(`pnpm run test:unit`)と関係するインテグレーション、
 *    `deploy:dry`、D1 の migration を流す。CI に無い段は、ユニットの全件と関係するインテグレーションの 2 つだけ。
 * 4. `--research` を付けたときだけ `pnpm test:research` の段が足され、その script がルートの package.json に実在する。
 * 5. SMOKE_PORT は環境変数でも `--smoke-port` でも渡せ、引数が環境変数に優先する。指定が無いときは出力しない。
 * 6. 失敗の伝播: 全段を `true` に差し替えると 0 で終わり、どの 1 段を `false` にしても 0 以外で終わる(その段だけが終了コード 1、ほかは 0)。
 * 7. 不明な引数は終了コード 2。
 * 8. 検査する側の自己検証(正の対照): ワークフローの run: 抽出が合成テキストで期待どおりに働き、
 *    CI の突き合わせが「スクリプトに足し忘れた段」「複数行の run:」を実際に検出する。
 *
 * スクリプトの実体(pnpm typecheck 等)は、15 分以上かかるのでここでは流さない。`--dry-run` と、`VERIFY_ALL_STUB` による差し替えを使う。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "verify-all.sh");

function readTextLf(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf8").replace(/\r\n/g, "\n");
}

/** コメント行(行頭が # の行)を除く。 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

interface CiRun {
  job: string;
  dir: string;
  cmd: string;
}

/** deploy ジョブ以外の各ジョブの run: を、作業ディレクトリつきで列挙する。複数行の run: は multiline=true で返す。 */
function extractRuns(yml: string): Array<CiRun & { multiline: boolean }> {
  const text = withoutComments(yml);
  const jobsAt = text.indexOf("\njobs:\n");
  const body = jobsAt >= 0 ? text.slice(jobsAt + "\njobs:\n".length) : text;
  const jobBlocks = body.split(/^(?=  [A-Za-z][\w-]*:\s*$)/m);
  const out: Array<CiRun & { multiline: boolean }> = [];
  for (const block of jobBlocks) {
    const head = /^ {2}([A-Za-z][\w-]*):\s*$/m.exec(block);
    if (!head) continue;
    const job = head[1] ?? "";
    if (job === "deploy") continue;
    for (const step of block.split(/^(?= {6}- name:)/m)) {
      const run = /^ {8}run:\s*(.*)$/m.exec(step);
      if (!run) continue;
      const wd = /^ {8}working-directory:\s*(\S+)\s*$/m.exec(step);
      const value = (run[1] ?? "").trim();
      out.push({ job, dir: wd?.[1] ?? ".", cmd: value, multiline: value === "|" || value === ">" });
    }
  }
  return out;
}

const INSTALL = /^pnpm install\b/;

interface Stage {
  id: string;
  dir: string;
  cmd: string;
}

/** `--dry-run` の出力を段に分解する。 */
function parseStages(out: string): Stage[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("STAGE "))
    .map((l) => {
      const m = /^STAGE (\S+) \| (.*?) \| (.*)$/.exec(l);
      if (!m) throw new Error(`段の行が読めない: ${l}`);
      return { id: m[1] ?? "", dir: m[2] ?? "", cmd: m[3] ?? "" };
    });
}

function runScript(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? "/tmp", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** CI の run: のうち、スクリプトの段に無いものを返す(インストールは対象外)。 */
function missingInScript(runs: CiRun[], stages: Stage[]): CiRun[] {
  return runs.filter((r) => !INSTALL.test(r.cmd) && !stages.some((s) => s.dir === r.dir && s.cmd === r.cmd));
}

const CI_RUNS = [
  ...extractRuns(readTextLf(".github", "workflows", "ci.yml")),
  ...extractRuns(readTextLf(".github", "workflows", "deploy-cloud.yml")),
];
const DRY = parseStages(runScript(["--dry-run", "--full"]).stdout);
const DRY_DEFAULT = parseStages(runScript(["--dry-run"]).stdout);
const DRY_RESEARCH = parseStages(runScript(["--dry-run", "--research"]).stdout);
const DRY_FULL_RESEARCH = parseStages(runScript(["--dry-run", "--full", "--research"]).stdout);

describe("verify-all.sh は CI の run: を覆う", () => {
  it("前提: CI の run: を抽出できていて、複数行の run: は deploy 以外のジョブに無い", () => {
    // 抽出が空なら、以降の「全部覆っている」は何も検査していない。
    expect(CI_RUNS.length).toBeGreaterThanOrEqual(10);
    expect(CI_RUNS.filter((r) => r.multiline)).toEqual([]);
    expect(CI_RUNS.some((r) => r.cmd === "pnpm typecheck" && r.dir === ".")).toBe(true);
    expect(CI_RUNS.some((r) => r.cmd === "pnpm run smoke" && r.dir === "cloud")).toBe(true);
    expect(CI_RUNS.some((r) => r.job === "deploy")).toBe(false);
  });

  it("CI の run:(インストール以外)は、すべて --full --dry-run の段に現れる", () => {
    const nonInstall = CI_RUNS.filter((r) => !INSTALL.test(r.cmd));
    expect(nonInstall.length).toBeGreaterThanOrEqual(7);
    expect(missingInScript(CI_RUNS, DRY)).toEqual([]);
  });

  it("--full --dry-run の段(--research を除く)は、すべて CI の run: に現れる", () => {
    expect(DRY.length).toBe(7);
    expect(DRY_DEFAULT.length).toBe(7);
    const stray = DRY.filter((s) => !CI_RUNS.some((r) => r.dir === s.dir && r.cmd === s.cmd));
    expect(stray).toEqual([]);
  });

  it("段の順序: ルート → cloud、型検査 → テスト → dry-run → D1 の migration → smoke", () => {
    expect(DRY.map((s) => s.id)).toEqual([
      "root-typecheck",
      "root-test",
      "cloud-typecheck",
      "cloud-test",
      "cloud-deploy-dry",
      "cloud-d1-migrate-local",
      "cloud-smoke",
    ]);
  });

  it("既定(--full 無し)の形: smoke と cloud の全件を流さず、ユニットの全件・関係するインテグレーション・deploy:dry・D1 の migration を流す", () => {
    expect(DRY_DEFAULT.map((s) => s.id)).toEqual([
      "root-typecheck",
      "root-test",
      "cloud-typecheck",
      "cloud-test-unit",
      "cloud-test-integration-related",
      "cloud-deploy-dry",
      "cloud-d1-migrate-local",
    ]);
    expect(DRY_DEFAULT.some((s) => s.id === "cloud-smoke" || s.id === "cloud-test")).toBe(false);
    expect(DRY_DEFAULT.some((s) => /\bsmoke\b/.test(s.cmd))).toBe(false);
    expect(DRY_DEFAULT.find((s) => s.id === "cloud-test-unit")).toEqual({ id: "cloud-test-unit", dir: "cloud", cmd: "pnpm run test:unit" });
    // CI に無い段は、ユニットの全件と関係するインテグレーションの 2 つだけ(それ以外は CI と同じコマンド)。
    const notInCi = DRY_DEFAULT.filter((s) => !CI_RUNS.some((r) => r.dir === s.dir && r.cmd === s.cmd)).map((s) => s.id);
    expect(notInCi).toEqual(["cloud-test-unit", "cloud-test-integration-related"]);
    // --full の段は、既定の段に cloud の全件と smoke を足し、ユニットと関係するインテグレーションを外したもの。
    expect(DRY.map((s) => s.id).filter((id) => !DRY_DEFAULT.some((d) => d.id === id))).toEqual(["cloud-test", "cloud-smoke"]);
  });

  it("test:unit・test:integration が cloud の package.json にあり、test は全件のまま、CI は test:unit を使わない", () => {
    const pkg = JSON.parse(readTextLf("cloud", "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test"]).toBe("vitest run");
    expect(pkg.scripts["test:unit"]).toContain("--exclude");
    expect(pkg.scripts["test:integration"]).toContain(".integration.test.ts");
    expect(CI_RUNS.some((r) => /test:(unit|integration)/.test(r.cmd))).toBe(false);
  });

  it("関係するインテグレーションの段のスクリプトが実在する", () => {
    const stage = DRY_DEFAULT.find((s) => s.id === "cloud-test-integration-related");
    expect(stage?.cmd).toBe("node ../scripts/verify-related-integration.mjs");
    expect(() => readTextLf("scripts", "verify-related-integration.mjs")).not.toThrow();
  });

  it("--research を付けたときだけ pnpm test:research の段が足され、その script が実在する", () => {
    expect(DRY.some((s) => s.cmd === "pnpm test:research")).toBe(false);
    expect(DRY_DEFAULT.some((s) => s.cmd === "pnpm test:research")).toBe(false);
    const extra = DRY_RESEARCH.filter((s) => !DRY_DEFAULT.some((d) => d.id === s.id));
    expect(extra).toEqual([{ id: "root-test-research", dir: ".", cmd: "pnpm test:research" }]);
    expect(DRY_RESEARCH.length).toBe(DRY_DEFAULT.length + 1);
    expect(DRY_FULL_RESEARCH.length).toBe(DRY.length + 1);
    const pkg = JSON.parse(readTextLf("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:research"]).toBeTruthy();
    // 普段の test から外している(だから --research が要る)。
    expect(pkg.scripts["test"]).not.toContain("probability-quality");
  });
});

describe("verify-all.sh の引数と環境変数", () => {
  it("SMOKE_PORT: 環境変数で渡せる・引数が環境変数に優先する・指定が無ければ出さない", () => {
    expect(runScript(["--dry-run"], { SMOKE_PORT: "18814" }).stdout).toContain("SMOKE_PORT=18814\n");
    expect(runScript(["--dry-run", "--smoke-port", "19001"], { SMOKE_PORT: "18814" }).stdout).toContain("SMOKE_PORT=19001\n");
    expect(runScript(["--dry-run", "--smoke-port", "19001"], { SMOKE_PORT: "18814" }).stdout).not.toContain("SMOKE_PORT=18814");
    expect(runScript(["--dry-run"]).stdout).not.toContain("SMOKE_PORT=");
  });

  it("不明な引数は終了コード 2、--smoke-port の値が無いのも 2", () => {
    expect(runScript(["--nonexistent"]).code).toBe(2);
    expect(runScript(["--smoke-port"]).code).toBe(2);
  });
});

describe("verify-all.sh の失敗の伝播(コマンドを true/false に差し替えて流す)", () => {
  const MODES: Array<{ name: string; flags: string[]; stages: Stage[] }> = [
    { name: "既定", flags: ["--research"], stages: DRY_RESEARCH },
    { name: "--full", flags: ["--full", "--research"], stages: DRY_FULL_RESEARCH },
  ];
  for (const mode of MODES) {
    it(`${mode.name}: 全段を true に差し替えると 0 で終わり、全段が終了コード 0`, () => {
      const r = runScript(mode.flags, { VERIFY_ALL_STUB: "1" });
      expect(r.code).toBe(0);
      expect(mode.stages.length).toBeGreaterThanOrEqual(8);
      for (const s of mode.stages) {
        expect(r.stdout).toMatch(new RegExp(`^${s.id}\\s+終了コード=0 `, "m"));
      }
      expect(r.stdout).toContain("全段成功");
    });

    for (const stage of mode.stages) {
      it(`${mode.name}: ${stage.id} だけが失敗しても 0 以外で終わり、その段だけが終了コード 1 になる`, () => {
        const r = runScript(mode.flags, { VERIFY_ALL_STUB: "1", VERIFY_ALL_FAIL_STAGE: stage.id });
        expect(r.code).toBe(1);
        expect(r.stdout).toMatch(new RegExp(`^${stage.id}\\s+終了コード=1 `, "m"));
        const others = mode.stages.filter((s) => s.id !== stage.id);
        expect(others.length).toBe(mode.stages.length - 1);
        for (const s of others) {
          expect(r.stdout).toMatch(new RegExp(`^${s.id}\\s+終了コード=0 `, "m"));
        }
      });
    }
  }
});

describe("検査する側の自己検証(正の対照)", () => {
  const SYNTHETIC = `name: x
on: push
jobs:
  verify:
    steps:
      - name: 取得
        uses: a/b@1
      - name: 依存
        run: pnpm install --frozen-lockfile
      - name: 新しい検査
        working-directory: cloud
        run: pnpm run lint-new
  deploy:
    steps:
      - name: 本番
        run: pnpm exec wrangler deploy
  other:
    steps:
      - name: 複数行
        run: |
          echo a
`;

  it("run: の抽出: deploy を除き、作業ディレクトリと複数行を読む", () => {
    const runs = extractRuns(SYNTHETIC);
    expect(runs).toEqual([
      { job: "verify", dir: ".", cmd: "pnpm install --frozen-lockfile", multiline: false },
      { job: "verify", dir: "cloud", cmd: "pnpm run lint-new", multiline: false },
      { job: "other", dir: ".", cmd: "|", multiline: true },
    ]);
  });

  it("CI に足した段をスクリプトに足し忘れると、突き合わせが検出する", () => {
    const runs = extractRuns(SYNTHETIC);
    const missing = missingInScript(runs, DRY);
    expect(missing.map((r) => r.cmd)).toContain("pnpm run lint-new");
    // 足してあれば検出しない。
    const withIt = [...DRY, { id: "x", dir: "cloud", cmd: "pnpm run lint-new" }];
    expect(missingInScript(runs.filter((r) => r.cmd === "pnpm run lint-new"), withIt)).toEqual([]);
  });
});
