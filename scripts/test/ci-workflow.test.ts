/**
 * テストの関門のワークフロー(.github/workflows/ci.yml)の静的な不変条件テスト(Issue #248)。
 *
 * 背景: Issue #248 で exe 版をアーカイブし、exe のビルドと dev-latest への公開を止めた。それまで
 * ルートの `pnpm typecheck` と `pnpm test`(packages/core・scripts/ のテスト。Issue #287 で packages/app を削除した)を
 * CI で走らせていたのは build-windows.yml だけだった(deploy-cloud.yml の check ジョブは
 * cloud/ のテストしか走らせない)。build-windows.yml を消すとそれらが CI から消えるため、
 * 「テストの関門だけ」を残した ci.yml(ubuntu-latest)を新設した。本テストはその形を固定する。
 *
 * 注意: これは yml のテキストへの検査であり、GitHub Actions の式を実際に評価するものではない。
 * ci.yml が本物の CI で緑になるかは、push 後に Actions の run で確認する。
 *
 * 検証する不変条件:
 * 1. 起動条件: push は作業ブランチ 1 本だけ。タグ・ワイルドカードを含まず、workflow_dispatch を併設する。
 *    トップレベルの `on:` のキーは push・pull_request・workflow_dispatch だけ(pull_request_target・schedule などを足せない。Issue #255)。
 *    pull_request は作業ブランチ宛ての PR 1 本だけ(Issue #310: Dependabot の PR で関門を走らせる。秘密を参照せず、権限は contents: read のまま)。
 * 2. 権限は contents: read のみ(リリースへ書き込まない)。
 * 3. runner は ubuntu-latest(Windows ではない)。
 * 4. ジョブは verify と cloud-verify の 2 つ。各ジョブの全ステップの名前と出現順序が期待する配列と完全一致する(挿入・削除・並べ替えを一括で検出する)。
 * 5. 関門の 2 コマンドが完全一致で、型検査 → テストの順に並ぶ(Issue #287 で app のビルドを外した。代わりの守りは deploy-cloud.yml の check ジョブ)。
 *    ルートの `pnpm typecheck`/`pnpm test` は `-r` 付きの下位互換ではない(Issue #38)。
 * 6. 依存のインストールは `--frozen-lockfile`。
 * 7. verify の関門のステップは無条件に実行される(if: が無い)・失敗を握りつぶさない(continue-on-error が無い)。
 *    ワークフロー全体で秘密(secrets.)を参照しない。
 * 11. (Issue #310)cloud-verify ジョブは pull_request のときだけ走り(ファイル全体で `if:` はこの 1 つだけ)、cloud/ の型検査・テスト・スモークを
 *    deploy-cloud.yml の check・smoke と同じコマンドで走らせる。秘密も書き込み権限も持たない(上の 2・7 がワークフロー全体にかかる)。
 * 8. exe の公開が戻っていない: リポジトリの全ワークフローに action-gh-release と contents: write が無く、
 *    build-windows.yml が存在しない。
 * 9. 検査する側の自己検証(正の対照): コメント除去・ステップ名抽出が、合成テキストで期待どおりに働く。
 * 10. (Issue #288)app のビルドを外した代わりの守り: deploy-cloud.yml の check ジョブが cloud の型検査(pnpm run typecheck)とテスト(pnpm test)を
 *     無条件で走らせ、deploy が check を待つ。スモークを別ジョブ(smoke)に分けても、この守りが黙って消えない。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");
/** 改行を LF に正規化して読む(checkout 次第で CRLF になりうる)。 */
function readTextLf(filePath: string): string {
  return readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

const ALLOWED_BRANCH = "claude/issue-order-processing-wjgpdd";

/** コメント行(行頭が # の行)を除いた本文。 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** 6 スペースインデントの `- name:` 行から、ステップ名を出現順に列挙する。 */
function extractAllStepNames(yml: string): string[] {
  return [...yml.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

/** ステップ名で該当ステップのブロック(次のステップ直前まで)を返す。見つからなければ例外。 */
function extractStep(yml: string, stepName: string): string {
  const steps = yml.split(/\n(?=      - name: )/);
  const found = steps.find((s) => s.startsWith(`      - name: ${stepName}`));
  if (found === undefined) {
    throw new Error(`ステップが見つかりません: ${stepName}`);
  }
  return found;
}

/** ステップブロックから `run:` の単一行コマンドを返す。 */
function extractRunLine(stepBlock: string): string {
  const m = stepBlock.match(/^\s*run:\s+(.+)$/m);
  if (m?.[1] === undefined) {
    throw new Error(`run: が見つかりません:\n${stepBlock}`);
  }
  return m[1].trim();
}

/**
 * トップレベルの `on:` の直下のキー(2 スペースインデントの `push:`・`workflow_dispatch:` など)を、出現順に返す。
 * 次のトップレベルのキー(インデント 0)で止まる。`on:` が無ければ空配列。コメント除去済みの本文を渡す。
 */
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

const STEP_NAMES = {
  checkout: "リポジトリを取得",
  pnpm: "pnpm をセットアップ",
  node: "Node.js をセットアップ",
  install: "依存をインストール",
  typecheck: "型検査を実行",
  test: "テストを実行",
} as const;

describe("検査する側の自己検証(正の対照。検出器が空振りしていないことの確認)", () => {
  const sample = [
    "jobs:",
    "  verify:",
    "    steps:",
    "      # コメントの中の - name: は数えない",
    "      - name: 一つ目",
    "        run: pnpm one",
    "      - name: 二つ目",
    "        # run: pnpm commented-out",
    "        run: pnpm two",
  ].join("\n");

  it("extractAllStepNames は実コード上のステップ名だけを出現順に返す", () => {
    expect(extractAllStepNames(sample)).toEqual(["一つ目", "二つ目"]);
  });

  it("withoutComments はコメント行だけを落とし、実コード行は残す", () => {
    const stripped = withoutComments(sample);
    expect(stripped).not.toContain("commented-out");
    expect(stripped).toContain("run: pnpm two");
    expect(stripped).toContain("run: pnpm one");
  });

  it("extractStep/extractRunLine はステップごとの run を取り違えない", () => {
    expect(extractRunLine(extractStep(sample, "一つ目"))).toBe("pnpm one");
    expect(extractRunLine(extractStep(sample, "二つ目"))).toBe("pnpm two");
  });

  it("extractOnKeys は on: 直下のキーだけを出現順に返す(深い階層のキー・次のトップレベルのキー・コメントは数えない。on: が無ければ空)", () => {
    const yml = ["name: x", "on:", "  push:", "    branches:", "      - main", "  # pull_request:", "  pull_request:", "  workflow_dispatch:", "", "permissions:", "  contents: read"].join("\n");
    expect(extractOnKeys(withoutComments(yml))).toEqual(["push", "pull_request", "workflow_dispatch"]);
    expect(extractOnKeys("name: x\njobs:\n  a:\n")).toEqual([]);
  });
});

describe("ci.yml(テストの関門。exe は公開しない)", () => {
  const ymlPath = path.join(WORKFLOWS_DIR, "ci.yml");

  it("ci.yml が存在する(以降の検査が、ファイルが無いまま空振りしない前提)", () => {
    expect(existsSync(ymlPath)).toBe(true);
  });

  const yml = existsSync(ymlPath) ? readTextLf(ymlPath) : "";
  const code = withoutComments(yml);

  it("起動条件: push の対象ブランチは作業ブランチ 1 本だけで、タグやワイルドカードを含まない。workflow_dispatch を併設する", () => {
    const m = /\n {2}push:\n {4}branches:\n((?: {6}- .+\n)+)/.exec(yml);
    expect(m).not.toBeNull();
    const branches = m![1]!.trim().split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim());
    expect(branches).toEqual([ALLOWED_BRANCH]);
    expect(code).not.toMatch(/\n {4}tags:/);
    expect(code).toContain("\n  workflow_dispatch:");
  });

  it("起動条件(Issue #255・#310): トップレベルの on: のキーは push・pull_request・workflow_dispatch だけ(pull_request_target・schedule などを足せない)", () => {
    // push の形は上のテストが固定している。ここは「ほかのトリガが無い」ことを、on: 直下のキーの全数で固定する。
    expect(extractOnKeys(code)).toEqual(["push", "pull_request", "workflow_dispatch"]);
    // pull_request_target は秘密と書き込み権限を持った状態で PR のコードを動かしうるので、名前の出現そのものを禁じる
    expect(code).not.toContain("pull_request_target");
  });

  it("起動条件(Issue #310): pull_request の対象ブランチは作業ブランチ 1 本だけ(main などへの PR では走らない)。types・paths の絞り込みも付けない", () => {
    const m = /\n {2}pull_request:\n {4}branches:\n((?: {6}- .+\n)+)/.exec(yml);
    expect(m).not.toBeNull();
    const branches = m![1]!.trim().split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim());
    expect(branches).toEqual([ALLOWED_BRANCH]);
    // Dependabot の PR は opened/synchronize/reopened(既定)で走れば足りる。paths で絞ると、文書だけの PR で関門が走らず緑の印が付かない
    expect(code).not.toMatch(/\n {4}(types|paths|paths-ignore|branches-ignore):/);
  });

  it("concurrency のキーに github.ref を含み(PR では refs/pull/N/merge になり、作業ブランチへの push の run と互いに取り消し合わない)、cancel-in-progress は true", () => {
    expect(code).toMatch(/\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/);
  });

  it("権限は contents: read のみで、書き込み権限が無い", () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code).not.toMatch(/: write/);
  });

  it("runner は ubuntu-latest で、Windows のジョブが無い", () => {
    expect([...code.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((m) => (m[1] ?? "").trim())).toEqual(["ubuntu-latest", "ubuntu-latest"]);
    expect(code).not.toMatch(/windows/i);
  });

  it("ジョブは verify と cloud-verify の 2 つだけ(増減・改名を検出する)", () => {
    expect([...code.slice(code.indexOf("\njobs:\n")).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])).toEqual(["verify", "cloud-verify"]);
  });

  it("verify: 全ステップの名前と出現順序が期待する配列と完全一致する(挿入・削除・並べ替えを一括で検出する)", () => {
    expect(extractAllStepNames(extractJob(yml, "verify"))).toEqual([
      STEP_NAMES.checkout,
      STEP_NAMES.pnpm,
      STEP_NAMES.node,
      STEP_NAMES.install,
      STEP_NAMES.typecheck,
      STEP_NAMES.test,
    ]);
  });

  it("関門の 2 コマンドが完全一致で、型検査 → テストの順に並ぶ(ルートの pnpm typecheck / pnpm test。-r 付きで代替しない)。app のビルドは無い(Issue #287)", () => {
    const verify = extractJob(yml, "verify");
    expect(extractRunLine(extractStep(verify, STEP_NAMES.typecheck))).toBe("pnpm typecheck");
    expect(extractRunLine(extractStep(verify, STEP_NAMES.test))).toBe("pnpm test");
    const index = (name: string): number => verify.indexOf(`      - name: ${name}`);
    expect(index(STEP_NAMES.install)).toBeGreaterThanOrEqual(0);
    expect(index(STEP_NAMES.install)).toBeLessThan(index(STEP_NAMES.typecheck));
    expect(index(STEP_NAMES.typecheck)).toBeLessThan(index(STEP_NAMES.test));
  });

  it("依存のインストールは --frozen-lockfile", () => {
    expect(extractRunLine(extractStep(extractJob(yml, "verify"), STEP_NAMES.install))).toBe("pnpm install --frozen-lockfile");
  });

  it("pnpm と Node.js は package.json の packageManager と Node 24.22.1 に従う(pnpm はバージョン未指定・Node は Issue #441 で 24.22.1 に固定)", () => {
    // SHA と版数は Dependabot が更新するので固定しない(形と一致の検査は actions-pinned.test.ts)
    const verify = extractJob(yml, "verify");
    expect(extractStep(verify, STEP_NAMES.pnpm)).toMatch(/uses: pnpm\/action-setup@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(extractStep(verify, STEP_NAMES.pnpm)).not.toMatch(/^\s+version:/m);
    expect(extractStep(verify, STEP_NAMES.node)).toMatch(/node-version: 24\.22\.1$/m);
  });

  it("verify の関門のステップは無条件に実行され(if: が無い)、失敗を握りつぶさず(continue-on-error が無い)、ワークフロー全体で秘密を参照しない", () => {
    // 前提固定: 本文が空のまま「無い」を主張する空振りにしない。
    const verify = withoutComments(extractJob(yml, "verify"));
    expect(verify).toContain("run: pnpm test");
    expect(verify).not.toMatch(/^\s+if:/m);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toContain("secrets.");
    expect(code).not.toMatch(/\$\{\{\s*secrets/);
  });

  describe("cloud-verify ジョブ(Issue #310: pull_request のときだけ。cloud/ の型検査・テスト・スモーク)", () => {
    const job = extractJob(yml, "cloud-verify");
    const jobCode = withoutComments(job);

    it("ファイル全体の if: はこのジョブの `if: github.event_name == 'pull_request'` の 1 つだけ(push では走らない=deploy-cloud.yml の check と重複しない。verify は無条件のまま)", () => {
      expect([...code.matchAll(/^\s+if:\s*(.+)$/gm)].map((m) => (m[1] ?? "").trim())).toEqual(["github.event_name == 'pull_request'"]);
      expect(jobCode).toMatch(/^ {4}if: github\.event_name == 'pull_request'$/m);
    });

    it("ステップの名前と順序が完全一致する", () => {
      expect(extractAllStepNames(job)).toEqual([
        STEP_NAMES.checkout,
        STEP_NAMES.pnpm,
        STEP_NAMES.node,
        "依存をインストール(cloud)",
        "型検査(cloud)",
        "テスト(cloud)",
        "ローカルスモークテスト(cloud)",
      ]);
    });

    it("cloud/ で、deploy-cloud.yml の check・smoke と同じコマンドを走らせる(frozen-lockfile のインストール → 型検査 → テスト → スモーク。cloud のロックファイルでキャッシュ)", () => {
      const run = (name: string): string => extractRunLine(extractStep(job, name));
      expect(run("依存をインストール(cloud)")).toBe("pnpm install --ignore-workspace --frozen-lockfile");
      expect(run("型検査(cloud)")).toBe("pnpm run typecheck");
      expect(run("テスト(cloud)")).toBe("pnpm test");
      expect(run("ローカルスモークテスト(cloud)")).toBe("pnpm run smoke");
      for (const name of ["依存をインストール(cloud)", "型検査(cloud)", "テスト(cloud)", "ローカルスモークテスト(cloud)"]) {
        expect(extractStep(job, name), `${name} は cloud/ で実行する`).toContain("working-directory: cloud");
      }
      expect(extractStep(job, STEP_NAMES.node)).toContain("cache-dependency-path: cloud/pnpm-lock.yaml");
      expect(extractStep(job, STEP_NAMES.node)).toMatch(/node-version: 24\.22\.1$/m);
    });

    it("同じ手順が deploy-cloud.yml の check・smoke にもある(コマンドの食い違いを検出する)", () => {
      const deployCode = withoutComments(readTextLf(path.join(WORKFLOWS_DIR, "deploy-cloud.yml")));
      for (const cmd of ["pnpm install --ignore-workspace --frozen-lockfile", "pnpm run typecheck", "pnpm test", "pnpm run smoke"]) {
        expect(deployCode, cmd).toContain(`run: ${cmd}\n`);
        expect(jobCode, cmd).toContain(`run: ${cmd}\n`);
      }
    });

    it("失敗を握りつぶさない(continue-on-error が無い)。秘密も書き込み権限も無い(ワークフロー全体の contents: read のまま)", () => {
      expect(jobCode).not.toMatch(/continue-on-error/);
      expect(jobCode).not.toContain("secrets.");
      expect(jobCode).not.toMatch(/permissions:/);
      expect(jobCode).not.toMatch(/: write/);
    });
  });
});

describe("exe の公開が戻っていない(Issue #248: 公開を止め、運用を web に一本化した)", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("前提: 検査対象のワークフローが 3 つある(ci・deploy-cloud・research。Issue #290 で cloudflare-spike を削除し、Issue #395 で手動実行の research を足した)。空振りしていない", () => {
    expect([...files].sort()).toEqual(["ci.yml", "deploy-cloud.yml", "research.yml"]);
  });

  it("build-windows.yml が存在しない", () => {
    expect(existsSync(path.join(WORKFLOWS_DIR, "build-windows.yml"))).toBe(false);
  });

  it.each(files)("%s にリリースへの公開(action-gh-release)と contents: write が無い", (file) => {
    const code = withoutComments(readTextLf(path.join(WORKFLOWS_DIR, file)));
    expect(code).not.toContain("action-gh-release");
    expect(code).not.toMatch(/contents:\s*write/);
  });
});

/** `jobs:` 直下の job の本文(次の job の直前まで)。見つからなければ例外。 */
function extractJob(yml: string, jobId: string): string {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start < 0) {
    throw new Error(`job が見つかりません: ${jobId}`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** job 本文から、`- name:` で始まるステップ(名前の一部が一致)の本文を返す。見つからなければ例外。 */
function extractJobStep(job: string, nameFragment: string): string {
  const lines = job.split("\n");
  const start = lines.findIndex((l) => /^\s+- name:/.test(l) && l.includes(nameFragment));
  if (start < 0) {
    throw new Error(`ステップが見つかりません: ${nameFragment}`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s+- name:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("app のビルドを外した代わりの守り(Issue #287・#288: ci.yml のヘッダが述べる『代わりの検出』が、deploy-cloud.yml に残っている)", () => {
  // ci.yml のヘッダ(Issue #287): renderer 由来の共有部分に node 組込みの import を混ぜる破綻は、app のビルドの代わりに、
  // deploy-cloud.yml の check ジョブの cloud の型検査(tsconfig.client.json が Node の型を持たない)と、cloud のテスト
  // (test/client-bundle.test.ts・test/import-guard.test.ts)が検出する。check から型検査かテストを外すと、その検出が黙って消える。
  // (Issue #288 で check から smoke を別ジョブに分けても、型検査とテストは check に残る。smoke はこの検出に関与しない)
  const deployYml = readTextLf(path.join(WORKFLOWS_DIR, "deploy-cloud.yml"));

  it("deploy-cloud.yml の check ジョブが、cloud の pnpm run typecheck と pnpm test を無条件で走らせる(if: が無く、continue-on-error が無い)", () => {
    const check = extractJob(deployYml, "check");
    const code = withoutComments(check);
    const runs = [...code.matchAll(/^\s+run: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
    expect(runs).toContain("pnpm run typecheck");
    expect(runs).toContain("pnpm test");
    expect(code).not.toMatch(/^\s+if:/m);
    expect(code).not.toMatch(/continue-on-error/);
    // 型検査・テストは cloud/ で実行する(ルートの tsconfig ではなく、cloud の tsconfig.client.json を含む検査)
    expect(extractJobStep(check, "型検査")).toContain("working-directory: cloud");
    expect(extractJobStep(check, "テスト")).toContain("working-directory: cloud");
  });

  it("その検出が型検査で働く前提: cloud の typecheck は client 用の tsconfig(Node の型を持たない)を含む", () => {
    const pkg = JSON.parse(readTextLf(path.join(ROOT, "cloud", "package.json"))) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck"]).toContain("tsc -p tsconfig.client.json");
  });

  it("deploy ジョブは check の成功を待つ(check が失敗した状態で本番へ出ない。needs は単独指定でも配列指定でもよい)", () => {
    const deploy = extractJob(deployYml, "deploy");
    const m = /^ {4}needs:[ \t]*(.+)$/m.exec(withoutComments(deploy));
    expect(m).not.toBeNull();
    const needs = m![1]!
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim());
    expect(needs).toContain("check");
  });

  it("検出器の確認(空振りでない): extractJob・extractJobStep は job・ステップごとの本文を取り違えない", () => {
    const sample = ["jobs:", "  a:", "    steps:", "      - name: x1", "        run: one", "      - name: x2", "        run: two", "  b:", "    needs: a"].join("\n");
    expect(extractJob(sample, "a")).toContain("steps:");
    expect(extractJob(sample, "a")).not.toContain("needs");
    expect(extractJob(sample, "b")).toContain("needs: a");
    expect(() => extractJob(sample, "c")).toThrow();
    expect(extractJobStep(extractJob(sample, "a"), "x1")).toContain("run: one");
    expect(extractJobStep(extractJob(sample, "a"), "x1")).not.toContain("run: two");
    expect(() => extractJobStep(extractJob(sample, "a"), "zzz")).toThrow();
  });
});
