/**
 * テストの関門のワークフロー(.github/workflows/ci.yml)の静的な不変条件テスト(Issue #248)。
 *
 * 背景: Issue #248 で exe 版をアーカイブし、exe のビルドと dev-latest への公開を止めた。それまで
 * ルートの `pnpm typecheck` と `pnpm test`(packages/core・packages/app・scripts/ のテスト)を
 * CI で走らせていたのは build-windows.yml だけだった(deploy-cloud.yml の check ジョブは
 * cloud/ のテストしか走らせない)。build-windows.yml を消すとそれらが CI から消えるため、
 * 「テストの関門だけ」を残した ci.yml(ubuntu-latest)を新設した。本テストはその形を固定する。
 *
 * 注意: これは yml のテキストへの検査であり、GitHub Actions の式を実際に評価するものではない。
 * ci.yml が本物の CI で緑になるかは、push 後に Actions の run で確認する。
 *
 * 検証する不変条件:
 * 1. 起動条件: push は作業ブランチ 1 本だけ。タグ・ワイルドカードを含まず、workflow_dispatch を併設する。
 *    トップレベルの `on:` のキーは push と workflow_dispatch だけ(pull_request 系・schedule などを足せない。Issue #255)。
 * 2. 権限は contents: read のみ(リリースへ書き込まない)。
 * 3. runner は ubuntu-latest(Windows ではない)。
 * 4. 全ステップの名前と出現順序が期待する配列と完全一致する(挿入・削除・並べ替えを一括で検出する)。
 * 5. 関門の 3 コマンドが完全一致で、型検査 → テスト → app のビルドの順に並ぶ。
 *    ルートの `pnpm typecheck`/`pnpm test` は `-r` 付きの下位互換ではない(Issue #38)。
 * 6. 依存のインストールは `--frozen-lockfile`。Electron のバイナリは取得しない(env)。
 * 7. 関門のステップは無条件に実行される(if: が無い)・失敗を握りつぶさない(continue-on-error が無い)。
 *    秘密(secrets.)を参照しない。
 * 8. exe の公開が戻っていない: リポジトリの全ワークフローに action-gh-release と contents: write が無く、
 *    build-windows.yml が存在しない。
 * 9. 検査する側の自己検証(正の対照): コメント除去・ステップ名抽出が、合成テキストで期待どおりに働く。
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
  build: "app をビルド",
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

  it("起動条件(Issue #255): トップレベルの on: のキーは push と workflow_dispatch だけ(pull_request・pull_request_target・schedule などを足せない)", () => {
    // push の形は上のテストが固定している。ここは「ほかのトリガが無い」ことを、on: 直下のキーの全数で固定する。
    expect(extractOnKeys(code)).toEqual(["push", "workflow_dispatch"]);
  });

  it("権限は contents: read のみで、書き込み権限が無い", () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code).not.toMatch(/: write/);
  });

  it("runner は ubuntu-latest で、Windows のジョブが無い", () => {
    expect([...code.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((m) => (m[1] ?? "").trim())).toEqual(["ubuntu-latest"]);
    expect(code).not.toMatch(/windows/i);
  });

  it("全ステップの名前と出現順序が期待する配列と完全一致する(挿入・削除・並べ替えを一括で検出する)", () => {
    expect(extractAllStepNames(yml)).toEqual([
      STEP_NAMES.checkout,
      STEP_NAMES.pnpm,
      STEP_NAMES.node,
      STEP_NAMES.install,
      STEP_NAMES.typecheck,
      STEP_NAMES.test,
      STEP_NAMES.build,
    ]);
  });

  it("関門の 3 コマンドが完全一致で、型検査 → テスト → app のビルドの順に並ぶ(ルートの pnpm typecheck / pnpm test。-r 付きで代替しない)", () => {
    expect(extractRunLine(extractStep(yml, STEP_NAMES.typecheck))).toBe("pnpm typecheck");
    expect(extractRunLine(extractStep(yml, STEP_NAMES.test))).toBe("pnpm test");
    expect(extractRunLine(extractStep(yml, STEP_NAMES.build))).toBe("pnpm --filter @keiba/app build");
    const index = (name: string): number => yml.indexOf(`      - name: ${name}`);
    expect(index(STEP_NAMES.install)).toBeGreaterThanOrEqual(0);
    expect(index(STEP_NAMES.install)).toBeLessThan(index(STEP_NAMES.typecheck));
    expect(index(STEP_NAMES.typecheck)).toBeLessThan(index(STEP_NAMES.test));
    expect(index(STEP_NAMES.test)).toBeLessThan(index(STEP_NAMES.build));
  });

  it("依存のインストールは --frozen-lockfile で、Electron のバイナリは取得しない(env で ELECTRON_SKIP_BINARY_DOWNLOAD=1)", () => {
    expect(extractRunLine(extractStep(yml, STEP_NAMES.install))).toBe("pnpm install --frozen-lockfile");
    expect(code).toMatch(/^\s+ELECTRON_SKIP_BINARY_DOWNLOAD:\s*"1"\s*$/m);
  });

  it("pnpm と Node.js は package.json の packageManager と Node 22 に従う(pnpm はバージョン未指定・Node は 22)", () => {
    expect(extractStep(yml, STEP_NAMES.pnpm)).toContain("uses: pnpm/action-setup@v4");
    expect(extractStep(yml, STEP_NAMES.pnpm)).not.toMatch(/^\s+version:/m);
    expect(extractStep(yml, STEP_NAMES.node)).toMatch(/node-version: 22\b/);
  });

  it("関門のステップは無条件に実行され(if: が無い)、失敗を握りつぶさず(continue-on-error が無い)、秘密を参照しない", () => {
    // 前提固定: 本文が空のまま「無い」を主張する空振りにしない。
    expect(code).toContain("jobs:");
    expect(code).toContain("run: pnpm test");
    expect(code).not.toMatch(/^\s+if:/m);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toContain("secrets.");
  });
});

describe("exe の公開が戻っていない(Issue #248: 公開を止め、運用を web に一本化した)", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("前提: 検査対象のワークフローが 3 つある(ci・deploy-cloud・cloudflare-spike)。空振りしていない", () => {
    expect([...files].sort()).toEqual(["ci.yml", "cloudflare-spike.yml", "deploy-cloud.yml"]);
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
