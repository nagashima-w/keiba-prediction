import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Issue #171(#169-a)AC-a5: デプロイのワークフロー(.github/workflows/deploy-cloud.yml)のうち、**シェルのスクリプトとして実際に
 * 動かして**確かめるステップの検査。
 *   1. database_id が仮の値(ゼロ UUID)でないことの確認 … 仮の値なら失敗する。実際の wrangler.toml の値では通る
 *   2. D1 の権限確認 … API の応答本文を出力せず、ステータスコードだけで判定する(curl は偽物に差し替える。ネットワークへは出ない)
 *   3. (Issue #174)R2 の権限確認 … 2 と同じ作法。バケット名は cloud/wrangler.toml の bucket_name から読む
 *
 * yml の `run: |` の本文を取り出して `bash -e` で実行する(GitHub Actions の既定のシェルと同じ `bash -e`)。
 * yml のテキスト検査(ステップの順序・env など)は scripts/test/cloud-deploy-workflow.test.ts が担う。
 * 限界: GitHub Actions のランナー(ubuntu-latest)そのものではなく、手元の bash と偽の curl での実行である。
 * Windows のランナーには bash の保証がないため、Windows ではこのテストを飛ばす(cloud の check ジョブは ubuntu で走る)。
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = readFileSync(path.join(REPO, ".github", "workflows", "deploy-cloud.yml"), "utf-8").replace(/\r\n/g, "\n");
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const REAL_LOOKING_ID = "11111111-2222-4333-8444-555555555555";
const FAKE_TOKEN = "fake-api-token-for-test-0001";
const FAKE_ACCOUNT = "fake-account-id-0001";
const BODY_CANARY = "RESPONSE-BODY-CANARY-DO-NOT-PRINT";

const bashAvailable = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

/** deploy ジョブの、指定したステップの `run: |` の本文(インデントを外したもの)。 */
function runScript(nameFragment: string): string {
  const lines = yml.split("\n");
  const deployStart = lines.findIndex((l) => l === "  deploy:");
  expect(deployStart, "deploy ジョブがある").toBeGreaterThanOrEqual(0);
  const start = lines.findIndex((l, i) => i > deployStart && /^\s+- name:/.test(l) && l.includes(nameFragment));
  expect(start, `ステップ『${nameFragment}』がある`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s+- name:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const step = lines.slice(start, end);
  const runIndex = step.findIndex((l) => /^\s+run: \|$/.test(l));
  expect(runIndex, `ステップ『${nameFragment}』に run: | がある`).toBeGreaterThanOrEqual(0);
  // `run: |` の本文は、`run:` より深くインデントされた行(と、その間の空行)。次のステップの前のコメント(浅いインデント)は含めない。
  const runIndent = /^\s*/.exec(step[runIndex]!)![0].length;
  const body: string[] = [];
  for (const line of step.slice(runIndex + 1)) {
    if (line.trim() !== "" && /^\s*/.exec(line)![0].length <= runIndent) {
      break;
    }
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1]!.trim() === "") {
    body.pop();
  }
  const indent = /^\s*/.exec(body[0]!)![0].length;
  return body.map((l) => l.slice(indent)).join("\n");
}

const workDirs: string[] = [];
afterAll(() => {
  for (const dir of workDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-deploy-steps-"));
  workDirs.push(dir);
  return dir;
}

interface Result {
  readonly status: number | null;
  readonly output: string;
}

function runBash(script: string, cwd: string, env: Record<string, string> = {}, pathPrefix?: string): Result {
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env, ...(pathPrefix === undefined ? {} : { PATH: `${pathPrefix}${path.delimiter}${process.env["PATH"]}` }) },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** wrangler.toml の database_id の行だけを持つリポジトリ風のディレクトリ(cloud/wrangler.toml)。 */
function repoWithToml(tomlBody: string): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, "cloud"));
  writeFileSync(path.join(dir, "cloud", "wrangler.toml"), tomlBody);
  return dir;
}

const d1Block = (id: string): string => `name = "x"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "keiba-cloud-db"\ndatabase_id = "${id}"\nmigrations_dir = "migrations"\n`;

  /** 偽の curl: -o の出力先に本文(目印)を書き、-w の出力として STUB_STATUS を出す。呼ばれた引数を ARGS_FILE に残す。 */
  function stubBin(): { dir: string; argsFile: string } {
    const dir = tempDir();
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const argsFile = path.join(dir, "args.txt");
    const curl = `#!/bin/bash
printf '%s\\n' "$@" > "${argsFile}"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then printf '%s' "${BODY_CANARY}" > "$out"; fi
# 本物の curl は、接続できなかったときも -w の http_code として 000 を出力して、終了コード 7 などで終わる。
printf '%s' "$STUB_STATUS"
if [ "$STUB_STATUS" = "000" ]; then exit 7; fi
`;
    writeFileSync(path.join(bin, "curl"), curl);
    chmodSync(path.join(bin, "curl"), 0o755);
    return { dir: bin, argsFile };
  }


describe.skipIf(!bashAvailable)("AC-a5: database_id が仮の値でないことの確認(deploy ジョブのステップを実際に実行する)", () => {
  const script = (): string => runScript("database_id が仮の値でないことを確認");

  it("前提: ステップのスクリプトを取り出せている(空振りでない)", () => {
    expect(script()).toContain("cloud/wrangler.toml");
    expect(script().length).toBeGreaterThan(100);
  });

  it("仮の値(ゼロ UUID)なら失敗する(終了コードが 0 でない)。理由は日本語で出る", () => {
    const r = runBash(script(), repoWithToml(d1Block(PLACEHOLDER_ID)));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("仮の値");
  });

  it("実際の値(UUID)なら通る(終了コード 0)", () => {
    const r = runBash(script(), repoWithToml(d1Block(REAL_LOOKING_ID)));
    expect(r.status).toBe(0);
  });

  it("コメント行にゼロ UUID があっても、本物の行(database_id = ...)で判定する(コメントで誤って落ちない・誤って通らない)", () => {
    const withComment = `# database_id = "${PLACEHOLDER_ID}"\n${d1Block(REAL_LOOKING_ID)}`;
    expect(runBash(script(), repoWithToml(withComment)).status).toBe(0);
    const placeholderWithRealComment = `# database_id = "${REAL_LOOKING_ID}"\n${d1Block(PLACEHOLDER_ID)}`;
    expect(runBash(script(), repoWithToml(placeholderWithRealComment)).status).not.toBe(0);
  });

  it("database_id の行が無い・UUID の形でないなら失敗する(確認できないまま進まない)", () => {
    expect(runBash(script(), repoWithToml('name = "x"\n')).status).not.toBe(0);
    expect(runBash(script(), repoWithToml(d1Block("not-a-uuid"))).status).not.toBe(0);
    expect(runBash(script(), repoWithToml(d1Block(""))).status).not.toBe(0);
  });

  it("リポジトリの実際の cloud/wrangler.toml の database_id は、仮の値ではなく、このガードを通る", () => {
    const r = runBash(script(), REPO);
    expect(r.status, r.output).toBe(0);
  });
});

describe.skipIf(!bashAvailable)("AC-a5: D1 の権限確認(偽の curl で、ステータスコードだけを出力することを確かめる)", () => {
  const script = (): string => runScript("D1 の権限を確認");

  function run(status: string): Result & { args: string } {
    const { dir, argsFile } = stubBin();
    const r = runBash(script(), repoWithToml(d1Block(REAL_LOOKING_ID)), { STUB_STATUS: status, CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT }, dir);
    let args = "";
    try {
      args = readFileSync(argsFile, "utf-8");
    } catch {
      args = "";
    }
    return { ...r, args };
  }

  it("200 なら通る。D1 の取得 API(アカウント・database_id)へ、トークン付きで1回だけ問い合わせる", () => {
    const r = run("200");
    expect(r.status, r.output).toBe(0);
    expect(r.args).toContain(`/accounts/${FAKE_ACCOUNT}/d1/database/${REAL_LOOKING_ID}`);
    expect(r.args).toContain(`Authorization: Bearer ${FAKE_TOKEN}`);
    // 応答の本文はファイルにも標準出力にも出さない(出力先は /dev/null)
    expect(r.args).toMatch(/-o\n\/dev\/null\n/);
    expect(r.output).not.toContain(BODY_CANARY);
  });

  it.each([
    ["401", "権限"],
    ["403", "権限"],
    ["404", "見つかりません"],
    ["500", "HTTP 500"],
    ["000", "HTTP 000"],
  ])("HTTP %s なら失敗し(終了コード 0 でない)、ステータスコードを含む案内を日本語で出す。本文・トークン・アカウント ID は出さない", (status, hint) => {
    const r = run(status);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(hint);
    expect(r.output).toContain(status);
    expect(r.output).not.toContain(BODY_CANARY);
    expect(r.output).not.toContain(FAKE_TOKEN);
    expect(r.output).not.toContain(FAKE_ACCOUNT);
  });

  it("対照: 本文を表示する変異(出力先をファイルにして cat する)では、目印が出力に出る(検査が空振りでないことの確認)", () => {
    const mutated = script().replace("-o /dev/null", '-o "$RUNNER_TEMP_OUT"').replace(/(\n\s*)case /, '$1cat "$RUNNER_TEMP_OUT"; case ');
    expect(mutated).not.toBe(script());
    const { dir } = stubBin();
    const out = path.join(tempDir(), "body.json");
    const r = runBash(mutated, repoWithToml(d1Block(REAL_LOOKING_ID)), { STUB_STATUS: "200", RUNNER_TEMP_OUT: out, CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT }, dir);
    expect(r.output).toContain(BODY_CANARY);
  });

  it("前提: bash と偽の curl の組(実行環境)が動いている", () => {
    expect(execFileSync("bash", ["-c", "echo ok"], { encoding: "utf-8" }).trim()).toBe("ok");
  });
});

const r2Block = (name: string): string => `name = "x"\n\n[[r2_buckets]]\nbinding = "ANALYSIS_DETAIL"\nbucket_name = "${name}"\n`;
const R2_TEST_BUCKET = "test-bucket-for-steps";

describe.skipIf(!bashAvailable)("Issue #174: R2 の権限確認(偽の curl で、ステータスコードだけを出力することを確かめる)", () => {
  const script = (): string => runScript("R2 の権限を確認");

  function run(status: string, toml: string = r2Block(R2_TEST_BUCKET)): Result & { args: string; called: boolean } {
    const { dir, argsFile } = stubBin();
    const r = runBash(script(), repoWithToml(toml), { STUB_STATUS: status, CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT }, dir);
    let args = "";
    let called = true;
    try {
      args = readFileSync(argsFile, "utf-8");
    } catch {
      args = "";
      called = false;
    }
    return { ...r, args, called };
  }

  it("前提: ステップのスクリプトを取り出せている(空振りでない)", () => {
    expect(script()).toContain("cloud/wrangler.toml");
    expect(script()).toContain("/r2/buckets/");
    expect(script().length).toBeGreaterThan(100);
  });

  it("200 なら通る。R2 の取得 API(アカウント・wrangler.toml の bucket_name)へ、トークン付きで問い合わせる。本文は /dev/null へ", () => {
    const r = run("200");
    expect(r.status, r.output).toBe(0);
    expect(r.called).toBe(true);
    expect(r.args).toContain(`/accounts/${FAKE_ACCOUNT}/r2/buckets/${R2_TEST_BUCKET}`);
    expect(r.args).toContain(`Authorization: Bearer ${FAKE_TOKEN}`);
    expect(r.args).toMatch(/-o\n\/dev\/null\n/);
    expect(r.output).not.toContain(BODY_CANARY);
  });

  it("バケット名は wrangler.toml から読む(別の名前にすると、問い合わせ先も変わる)。コメント行の bucket_name は見ない", () => {
    const other = run("200", r2Block("another-bucket-name"));
    expect(other.args).toContain("/r2/buckets/another-bucket-name");
    expect(other.args).not.toContain(R2_TEST_BUCKET);
    const withComment = run("200", `# bucket_name = "commented-out-bucket"\n${r2Block(R2_TEST_BUCKET)}`);
    expect(withComment.args).toContain(`/r2/buckets/${R2_TEST_BUCKET}`);
    expect(withComment.args).not.toContain("commented-out-bucket");
  });

  it("リポジトリの実際の cloud/wrangler.toml の bucket_name(keiba-cloud-r2)を読んで問い合わせる", () => {
    const { dir, argsFile } = stubBin();
    const r = runBash(script(), REPO, { STUB_STATUS: "200", CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT }, dir);
    expect(r.status, r.output).toBe(0);
    expect(readFileSync(argsFile, "utf-8")).toContain(`/accounts/${FAKE_ACCOUNT}/r2/buckets/keiba-cloud-r2`);
  });

  it("bucket_name の行が無い・バケット名の形でない(記号・大文字・短すぎ・長すぎ)なら、API を呼ばずに失敗する(URL に不正な値を渡さない)", () => {
    for (const toml of [
      'name = "x"\n',
      r2Block(""),
      r2Block("ab"),
      r2Block("UPPER-case-bucket"),
      r2Block("bad/slash/bucket"),
      r2Block("bad bucket name"),
      r2Block("a".repeat(64)),
    ]) {
      const r = run("200", toml);
      expect(r.status, `${toml}`).not.toBe(0);
      expect(r.called, `${toml} では curl を呼ばない`).toBe(false);
      expect(r.output).toContain("bucket_name");
    }
  });

  it.each([
    ["401", "権限"],
    ["403", "権限"],
    ["404", "見つかりません"],
    ["500", "HTTP 500"],
    ["000", "HTTP 000"],
  ])("HTTP %s なら失敗し(終了コード 0 でない)、ステータスコードを含む案内を日本語で出す。本文・トークン・アカウント ID は出さない", (status, hint) => {
    const r = run(status);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(hint);
    expect(r.output).toContain(status);
    expect(r.output).not.toContain(BODY_CANARY);
    expect(r.output).not.toContain(FAKE_TOKEN);
    expect(r.output).not.toContain(FAKE_ACCOUNT);
  });

  it("403 の案内は、原因を権限不足と断定せず、R2 の未有効化の可能性も挙げる(ステータスコードだけでは区別できない)。404 の案内は管轄(jurisdiction)にも触れる", () => {
    expect(run("403").output).toContain("有効化");
    expect(run("404").output).toContain("jurisdiction");
  });

  it("対照: 本文を表示する変異(出力先をファイルにして cat する)では、目印が出力に出る(検査が空振りでないことの確認)", () => {
    const mutated = script().replace("-o /dev/null", '-o "$RUNNER_TEMP_OUT"').replace(/(\n\s*)case /, '$1cat "$RUNNER_TEMP_OUT"; case ');
    expect(mutated).not.toBe(script());
    const { dir } = stubBin();
    const out = path.join(tempDir(), "body.json");
    const r = runBash(mutated, repoWithToml(r2Block(R2_TEST_BUCKET)), { STUB_STATUS: "200", RUNNER_TEMP_OUT: out, CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT }, dir);
    expect(r.output).toContain(BODY_CANARY);
  });
});
