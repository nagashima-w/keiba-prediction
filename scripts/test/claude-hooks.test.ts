// Claude Code のフック2つ(Issue #607)のテスト。入力の JSON を標準入力に与えて、振る舞いを確かめる。
//   A: scripts/hooks/md-lint-hook.mjs        (PostToolUse。md を書き換えたら、書き換えた行だけ yomiyasu の lint にかける)
//   B: scripts/hooks/implementer-verify-hook.mjs (SubagentStop。tdd-implementer の終了時に型検査と関係するテストを流す)
// 重いコマンド(typecheck・vitest)は HOOK_VERIFY_STUB=1 で差し替える(#606 の VERIFY_ALL_STUB と同じ考え方)。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MD_HOOK = path.join(ROOT, "scripts/hooks/md-lint-hook.mjs");
const VERIFY_HOOK = path.join(ROOT, "scripts/hooks/implementer-verify-hook.mjs");

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "claude-hooks-test-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失敗: ${r.stderr}`);
  return r.stdout;
}
function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function newRepo(): string {
  const dir = realTmp();
  sh(dir, "git", ["init", "-q", "-b", "base"]);
  sh(dir, "git", ["config", "user.email", "t@example.com"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  return dir;
}
function realTmp(): string {
  return path.resolve(tmp());
}
function commitAll(dir: string, msg = "c"): void {
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", msg]);
}
function run(script: string, input: unknown, env: Record<string, string> = {}, cwd = ROOT) {
  const r = spawnSync("node", [script], {
    cwd,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------- A
describe("A: md-lint-hook(PostToolUse)", () => {
  const FLAGGED = "ここは古い行です✨";
  const NEW_FLAGGED = "新しい行です。いかがでしたか。";
  const base = `# 題\n\n${FLAGGED}\n\n新しい行です。\n`;
  const edited = `# 題\n\n${FLAGGED}\n\n${NEW_FLAGGED}\n`;

  function edit(dir: string, rel: string, tool = "Edit") {
    return { tool_name: tool, cwd: dir, tool_input: { file_path: path.join(dir, rel) } };
  }
  /** 追跡済みの md(古い行に候補あり)を作って commit し、5 行目だけ書き換える。 */
  function trackedRepo(rel = "docs/a.md"): string {
    const dir = newRepo();
    write(path.join(dir, rel), base);
    commitAll(dir);
    write(path.join(dir, rel), edited);
    return dir;
  }
  function context(out: string): string {
    return (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput
      .additionalContext;
  }

  it("前提: 古い行(L3)の絵文字も新しい行(L5)の定型句も、ファイル全体にかければ候補になる", () => {
    const dir = newRepo();
    write(path.join(dir, "docs/new.md"), edited); // 未追跡 = 全体
    const r = run(MD_HOOK, edit(dir, "docs/new.md"));
    expect(r.code).toBe(0);
    const c = context(r.stdout);
    expect(c).toContain("emoji_prohibited");
    expect(c).toContain("meta_filler");
  });

  it("書き換えた行だけを見る: 新しい行(L5)の候補は返り、前からある行(L3)の候補は返らない", () => {
    const dir = trackedRepo();
    const r = run(MD_HOOK, edit(dir, "docs/a.md"));
    expect(r.code).toBe(0);
    const c = context(r.stdout);
    expect(c).toContain("L5 [WARN] meta_filler");
    expect(c).not.toContain("emoji_prohibited");
    expect(c).not.toContain("L3 ");
    expect(c).toContain("書き換えた行だけ");
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  it("文書全体で決まる候補(箇条書きの比率)は、書き換えた行の候補でなければ返さない", () => {
    const dir = newRepo();
    // 地の文が 300 字を超えて、箇条書きが 25% を超えると excess_list(行は常に L1)が出る
    const list = `# 題\n\n${Array.from({ length: 5 }, (_, i) => `- ${"項目の説明をここに書きます。".repeat(5)}${i}です。`).join("\n")}\n`;
    write(path.join(dir, "l.md"), list);
    // 前提: ファイル全体にかければ excess_list が出る
    expect(context(run(MD_HOOK, edit(dir, "l.md")).stdout)).toContain("excess_list");
    commitAll(dir);
    // 書き換えた行だけで 300 字を超え、そのうち箇条書きが 25% を超える(= 書き換えた行だけにかけても excess_list が出る形)
    write(path.join(dir, "l.md"), `${list}\n${Array.from({ length: 30 }, (_, i) => `${i}番目の確認では差が見つからなかった${["。", "ので記す。", "と読める。"][i % 3]}`).join("")}\n- 項目です。\n`);
    const r = run(MD_HOOK, edit(dir, "l.md"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("新規(未追跡)の md はファイル全体を見る", () => {
    const dir = newRepo();
    write(path.join(dir, "NEW.md"), edited);
    const c = context(run(MD_HOOK, edit(dir, "NEW.md", "Write")).stdout);
    expect(c).toContain("L3 [WARN] emoji_prohibited");
    expect(c).toContain("ファイル全体");
  });

  it("Write と MultiEdit も対象", () => {
    for (const tool of ["Write", "MultiEdit"]) {
      const dir = trackedRepo();
      expect(context(run(MD_HOOK, edit(dir, "docs/a.md", tool)).stdout)).toContain("meta_filler");
    }
  });

  it("候補が無ければ何も出さない(書き換えた行がきれいなとき)", () => {
    const dir = newRepo();
    write(path.join(dir, "a.md"), base);
    commitAll(dir);
    write(path.join(dir, "a.md"), `${base}\n問題のない文です。\n`);
    const r = run(MD_HOOK, edit(dir, "a.md"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("追跡済みで HEAD と差が無ければ何も出さない", () => {
    const dir = newRepo();
    write(path.join(dir, "a.md"), base);
    commitAll(dir);
    expect(run(MD_HOOK, edit(dir, "a.md")).stdout).toBe("");
  });

  it.each([
    "docs/versioning.md",
    "docs/lessons-learned.md",
    "docs/investigations/x.md",
    "docs/wide-trio-odds-investigation.md",
    ".claude/skills/yomiyasu/SKILL.md",
  ])("対象外(過去の記録・skills)は何も出さない: %s", (rel) => {
    const dir = newRepo();
    write(path.join(dir, rel), edited); // 未追跡 = 対象なら全体に候補が出る形
    const r = run(MD_HOOK, edit(dir, rel));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    // 対象外でなければ出る(空振りでないこと)
    write(path.join(dir, "docs/ok.md"), edited);
    expect(run(MD_HOOK, edit(dir, "docs/ok.md")).stdout).not.toBe("");
  });

  it("md 以外のファイル・ほかのツールは何も出さない", () => {
    const dir = newRepo();
    write(path.join(dir, "a.txt"), edited);
    write(path.join(dir, "b.md"), edited);
    expect(run(MD_HOOK, edit(dir, "a.txt")).stdout).toBe("");
    expect(run(MD_HOOK, { tool_name: "Bash", cwd: dir, tool_input: { command: "echo" } }).stdout).toBe("");
    expect(run(MD_HOOK, { tool_name: "Read", cwd: dir, tool_input: { file_path: path.join(dir, "b.md") } }).stdout).toBe("");
    expect(run(MD_HOOK, edit(dir, "b.md")).stdout).not.toBe(""); // 空振りでないこと
  });

  it("壊れた入力・存在しないファイルでも書き込みを止めない(終了コード 0・出力なし)", () => {
    const dir = newRepo();
    expect(run(MD_HOOK, "{壊れた").code).toBe(0);
    const r = run(MD_HOOK, edit(dir, "nothing.md"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("作業場所と lint のフォルダに __pycache__ と .yomiyasu/ を作らない", () => {
    const dir = trackedRepo();
    expect(run(MD_HOOK, edit(dir, "docs/a.md")).stdout).not.toBe("");
    expect(existsSync(path.join(dir, ".yomiyasu"))).toBe(false);
    expect(existsSync(path.join(dir, "__pycache__"))).toBe(false);
    expect(existsSync(path.join(ROOT, ".claude/skills/yomiyasu/scripts/__pycache__"))).toBe(false);
    expect(existsSync(path.join(ROOT, ".yomiyasu"))).toBe(false);
  });
});

// ---------------------------------------------------------------- B
describe("B: implementer-verify-hook(SubagentStop)", () => {
  /** メインの作業ツリー(main)と、そこから作った worktree(wt)。ベースは branch "base"。 */
  function setup() {
    const main = newRepo();
    write(path.join(main, "README.md"), "x\n");
    write(path.join(main, "cloud/.gitkeep"), "");
    write(path.join(main, "packages/core/.gitkeep"), "");
    commitAll(main, "init");
    const wt = path.join(path.resolve(tmp()), "wt");
    sh(main, "git", ["worktree", "add", "-q", "-b", "work", wt]);
    const logDir = path.join(path.resolve(tmp()), "logs");
    return { main, wt: realTmpPath(wt), logDir };
  }
  function realTmpPath(p: string): string {
    return sh(p, "git", ["rev-parse", "--show-toplevel"]).trim();
  }
  const env = (logDir: string, extra: Record<string, string> = {}) => ({
    HOOK_BASE_REF: "base",
    HOOK_LOG_DIR: logDir,
    HOOK_VERIFY_STUB: "1",
    ...extra,
  });
  const stop = (cwd: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "SubagentStop",
    agent_type: "tdd-implementer",
    agent_id: "a1",
    cwd,
    stop_hook_active: false,
    ...extra,
  });
  const logOf = (logDir: string) => (existsSync(path.join(logDir, "implementer-verify.log")) ? readFileSync(path.join(logDir, "implementer-verify.log"), "utf8") : "");
  const stages = (logDir: string) => [...logOf(logDir).matchAll(/STAGE (\S+) \|/g)].map((m) => m[1]);

  it("tdd-implementer 以外(code-reviewer)は、変更があっても何も流さない", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const r = run(VERIFY_HOOK, stop(wt, { agent_type: "code-reviewer" }), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "root-typecheck" }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(stages(logDir)).toEqual([]);
    expect(logOf(logDir)).toContain("agent_type=code-reviewer");
    // 空振りでないこと: 同じ入力で agent_type だけ tdd-implementer にすると流れて失敗する
    expect(run(VERIFY_HOOK, stop(wt), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "root-typecheck" })).code).toBe(2);
  });

  it("変更が無ければ何も流さない(着手前の確認だけを返したとき)", () => {
    const { wt, logDir } = setup();
    const r = run(VERIFY_HOOK, stop(wt), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "root-typecheck" }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(stages(logDir)).toEqual([]);
    expect(logOf(logDir)).toContain("変更が無い");
  });

  it("ログに入力の要点(agent_type・cwd・transcript の有無・stop_hook_active)と採用した worktree を残す。本文は残さない", () => {
    const { wt, logDir } = setup();
    run(VERIFY_HOOK, stop(wt, { last_assistant_message: "秘密の本文" }), env(logDir));
    const log = logOf(logDir);
    expect(log).toContain("agent_type=tdd-implementer");
    expect(log).toContain(`cwd=${wt}`);
    expect(log).toContain("agent_transcript_path=なし");
    expect(log).toContain("stop_hook_active=false");
    expect(log).toContain(`採用=${wt}`);
    expect(log).not.toContain("秘密の本文");
  });

  it("変更があり成功なら、何も返さず終了コード 0。ルートの変更では typecheck 2 つと root-related が流れる", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const r = run(VERIFY_HOOK, stop(wt), env(logDir));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(stages(logDir)).toEqual(["root-typecheck", "cloud-typecheck", "root-related"]);
  });

  it("変更の場所に応じて関係するテストの段が選ばれる(core: root+core+cloud、cloud: cloud だけ)", () => {
    const a = setup();
    write(path.join(a.wt, "packages/core/src/a.ts"), "export {};\n");
    run(VERIFY_HOOK, stop(a.wt), env(a.logDir));
    expect(stages(a.logDir)).toEqual(["root-typecheck", "cloud-typecheck", "root-related", "core-related", "cloud-related"]);
    const b = setup();
    write(path.join(b.wt, "cloud/src/b.ts"), "export {};\n");
    run(VERIFY_HOOK, stop(b.wt), env(b.logDir));
    expect(stages(b.logDir)).toEqual(["root-typecheck", "cloud-typecheck", "cloud-related"]);
  });

  it("作業ブランチにコミット済みの変更も、変更として数える(ベースとの merge-base から)", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    commitAll(wt, "work");
    expect(run(VERIFY_HOOK, stop(wt), env(logDir)).code).toBe(0);
    expect(stages(logDir)).toContain("root-related");
  });

  it("失敗: 1 回目(stop_hook_active が偽)は要約を標準エラー出力に出して終了コード 2。成功した段も一覧に出る", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const r = run(VERIFY_HOOK, stop(wt), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "cloud-typecheck" }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cloud-typecheck: 失敗");
    expect(r.stderr).toContain("root-typecheck: 成功");
    expect(r.stderr).toContain(wt);
  });

  it("失敗: 2 回目(stop_hook_active が真)は止めず終了コード 0。結果をログのファイルと systemMessage に残す", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const e = env(logDir, { HOOK_VERIFY_FAIL_STAGE: "cloud-typecheck" });
    expect(run(VERIFY_HOOK, stop(wt), e).code).toBe(2); // 前提: 同じ状況で 1 回目は止める
    const r = run(VERIFY_HOOK, stop(wt, { stop_hook_active: true }), e);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect((JSON.parse(r.stdout) as { systemMessage: string }).systemMessage).toContain("implementer-verify-last.txt");
    const last = readFileSync(path.join(logDir, "implementer-verify-last.txt"), "utf8");
    expect(last).toContain("cloud-typecheck: 失敗");
    expect(logOf(logDir)).toContain("2 回目");
  });

  it("上限時間を超えたら「流しきれなかった」と残し、止めない(終了コード 0)", () => {
    const { wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const t0 = Date.now();
    const r = run(VERIFY_HOOK, stop(wt), env(logDir, { HOOK_VERIFY_STUB_CMD: "sleep 5", HOOK_VERIFY_TIMEOUT_SEC: "1" }));
    expect(Date.now() - t0).toBeLessThan(4500); // 5 秒の sleep を待たずに打ち切る
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(logDir, "implementer-verify-last.txt"), "utf8")).toContain("流しきれなかった");
  });

  it("入力の cwd がメインの作業ツリーなら、transcript の最後の cwd(worktree)を使う", () => {
    const { main, wt, logDir } = setup();
    write(path.join(wt, "scripts/x.ts"), "export {};\n");
    const tr = path.join(path.resolve(tmp()), "agent.jsonl");
    writeFileSync(tr, [{ cwd: main, type: "user" }, { type: "assistant" }, { cwd: wt, type: "assistant" }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const r = run(VERIFY_HOOK, stop(main, { agent_transcript_path: tr }), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "root-typecheck" }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(wt);
    expect(logOf(logDir)).toContain("agent_transcript_path=あり");
    expect(logOf(logDir)).toContain("(transcript)");
  });

  it("決まった worktree がメインの作業ツリーなら、変更があっても流さない", () => {
    const { main, logDir } = setup();
    write(path.join(main, "scripts/x.ts"), "export {};\n");
    const r = run(VERIFY_HOOK, stop(main), env(logDir, { HOOK_VERIFY_FAIL_STAGE: "root-typecheck" }));
    expect(r.code).toBe(0);
    expect(stages(logDir)).toEqual([]);
    expect(logOf(logDir)).toContain("メインの作業ツリー");
  });

  it("cwd も transcript も無ければ流さずログに残す。壊れた入力でも止めない", () => {
    const { logDir } = setup();
    expect(run(VERIFY_HOOK, { agent_type: "tdd-implementer" }, env(logDir)).code).toBe(0);
    expect(logOf(logDir)).toContain("流さない");
    expect(run(VERIFY_HOOK, "{壊れた", env(logDir)).code).toBe(0);
  });
});
