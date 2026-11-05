#!/usr/bin/env node
// SubagentStop フック(Issue #607 B): tdd-implementer が作業を終えたら、作業した worktree で
// 型検査と、変えたファイルに関係するテストを流す。全部のテストは流さない(30 分を超えるため)。
//
// 流すもの(変えたファイルに応じて):
//   ルートの pnpm typecheck / cloud の pnpm run typecheck(変更があれば常に)
//   vitest related: ルート(scripts/test)・packages/core(test/)・cloud(test/)。それぞれの vitest 設定に合わせ、
//     そのパッケージの中で流す。cloud のテストは core を相対 import するため、cloud は cloud/ と packages/core/src の変更を渡す。
//     ルートのテストも core を import するため、ルートは scripts/・packages/・ルートの vitest*.ts の変更を渡す。
//
// 振る舞い:
//   - agent_type が tdd-implementer 以外なら何もしない(ログには残す)。
//   - worktree の決め方(Issue #617): 実装担当は `cd /home/user/wt-XXX && ...` と打ち、シェルの作業場所は呼び出しのたびに
//     メインへ戻るため、入力の cwd も記録の cwd も作業場所を指さない。そこで、まず agent_transcript_path の記録の中身から探す:
//     Edit・Write・MultiEdit・NotebookEdit の file_path がメイン以外の worktree の中にあれば、最後のものを採る。
//     無ければ Bash のコマンドに出てくるメイン以外の worktree のパス(最後の出現)を採る。
//     それでも決まらなければ、入力の cwd が「メインの作業ツリー以外の worktree」ならそれ、違えば記録の最後の cwd。
//     どれも決まらない・メインの作業ツリー(git worktree list の先頭)なら流さない。
//   - 変更 = merge-base(HEAD, ベース) から HEAD と作業ツリー(未追跡を含む)まで。変更が無ければ何もしない。
//   - 失敗: stop_hook_active が偽なら、要約を標準エラー出力へ出して終了コード 2(実装担当が作業を続ける)。
//     真(2 回目)なら止めず、結果をログと systemMessage に残して終了コード 0。
//   - 時間の上限(既定 600 秒)を超えたら「流しきれなかった」と残して止めない。
//
// 環境変数(テスト・調整用):
//   HOOK_BASE_REF            ベース(既定 origin/claude/issue-order-processing-wjgpdd)
//   HOOK_LOG_DIR             ログの置き場(既定 $CLAUDE_PROJECT_DIR/.claude/hook-logs)
//   HOOK_VERIFY_TIMEOUT_SEC  全体の上限秒(既定 600)
//   HOOK_VERIFY_STUB=1       全段のコマンドを HOOK_VERIFY_STUB_CMD(既定 true)に置き換える(どの段が選ばれたかはログに残る)
//   HOOK_VERIFY_FAIL_STAGE   その id の段だけ false に置き換える(HOOK_VERIFY_STUB と併用)
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_AGENT = "tdd-implementer";
const DEFAULT_BASE = "origin/claude/issue-order-processing-wjgpdd";
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function logDir() {
  return process.env.HOOK_LOG_DIR ?? path.join(process.env.CLAUDE_PROJECT_DIR ?? path.resolve(HERE, "../.."), ".claude", "hook-logs");
}

let logFile = null;
function log(line) {
  try {
    mkdirSync(logDir(), { recursive: true });
    logFile ??= path.join(logDir(), "implementer-verify.log");
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ログに書けなくてもフックは止めない
  }
}

/** transcript の最後の cwd。読めなければ null。 */
export function lastCwdFromTranscript(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || !l.includes('"cwd"')) continue;
      try {
        const o = JSON.parse(l);
        if (typeof o?.cwd === "string" && o.cwd) return o.cwd;
      } catch {
        // 次の行へ
      }
    }
  } catch {
    // 読めない
  }
  return null;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** dir から見える git worktree の一覧(実在するパス。先頭がメインの作業ツリー)。取れなければ空。 */
export function listWorktrees(dir) {
  if (!dir || !existsSync(dir)) return [];
  const list = git(dir, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return [];
  return list.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9))
    .filter((p) => existsSync(p))
    .map((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    });
}

/** text の中で wt(の直後が区切り)が最後に出る位置。無ければ -1。wt-60 と wt-604 のような接頭辞の取り違えを避ける。 */
function lastIndexOfPath(text, wt) {
  let from = text.length;
  for (;;) {
    const i = text.lastIndexOf(wt, from);
    if (i < 0) return -1;
    const next = text[i + wt.length];
    if (next === undefined || !/[A-Za-z0-9_.-]/.test(next)) return i;
    from = i - 1;
    if (from < 0) return -1;
  }
}

/** text の中に最後に出るメイン以外の worktree(パスが長いものを優先)。 */
function lastWorktreeIn(text, others) {
  let best = null;
  for (const wt of others) {
    const i = lastIndexOfPath(text, wt);
    if (i >= 0 && (best === null || i > best.i || (i === best.i && wt.length > best.wt.length))) best = { i, wt };
  }
  return best?.wt ?? null;
}

/**
 * 記録(JSONL)の tool_use から作業した worktree を探す。大きな記録でも遅くならないよう、"tool_use" を含む行だけを JSON にする。
 * Edit 系の file_path を優先し(最後のもの)、無ければ Bash の command(最後のもの)。メインの作業ツリーは除く。
 */
export function worktreeFromTranscriptActions(file, worktrees) {
  const others = worktrees.slice(1);
  if (others.length === 0) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let fromEdit = null;
  let fromBash = null;
  for (const l of text.split("\n")) {
    if (!l.includes('"tool_use"')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.input !== "object" || b.input === null) continue;
      if (EDIT_TOOLS.has(b.name)) {
        const fp = b.input.file_path ?? b.input.notebook_path;
        if (typeof fp === "string") fromEdit = lastWorktreeIn(fp, others) ?? fromEdit;
      } else if (b.name === "Bash" && typeof b.input.command === "string") {
        fromBash = lastWorktreeIn(b.input.command, others) ?? fromBash;
      }
    }
  }
  return fromEdit ?? fromBash;
}

/** dir が属する git worktree のルート。メインの作業ツリー(git worktree list の先頭)なら null。 */
export function linkedWorktreeRoot(dir) {
  if (!dir || !existsSync(dir)) return null;
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const list = git(dir, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return null;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const entries = list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9)));
  const root = real(top.stdout.trim());
  if (entries.length === 0 || root === entries[0]) return null;
  return entries.includes(root) ? root : null;
}

/** 変えたファイル(ルートからの相対パス)。base が決まらなければ HEAD からの変更だけ。 */
function changedFiles(root, baseRef) {
  let base = git(root, ["merge-base", "HEAD", baseRef]);
  const note = base.status === 0 ? "" : ` (merge-base 失敗: ${baseRef}。HEAD からの変更だけを見る)`;
  const baseSha = base.status === 0 ? base.stdout.trim() : "HEAD";
  const diff = git(root, ["diff", "--name-only", baseSha]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const set = new Set([...diff.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean));
  return { files: [...set].filter((f) => existsSync(path.join(root, f))).sort(), note, baseSha };
}

/** 変えたファイルから流す段を決める。 */
export function planStages(root, files) {
  const code = files.filter((f) => CODE_EXT.test(f));
  const abs = (f) => path.join(root, f);
  const rootFiles = code.filter((f) => /^(?:scripts|packages)\//.test(f) || /^vitest[^/]*\.ts$/.test(f));
  const coreFiles = code.filter((f) => f.startsWith("packages/core/"));
  const cloudFiles = code.filter((f) => f.startsWith("cloud/") || f.startsWith("packages/core/src/"));
  const stages = [
    { id: "root-typecheck", dir: root, cmd: ["pnpm", "typecheck"] },
    { id: "cloud-typecheck", dir: path.join(root, "cloud"), cmd: ["pnpm", "run", "typecheck"] },
  ];
  const related = (id, dir, fs) =>
    fs.length > 0 && stages.push({ id, dir, cmd: ["pnpm", "exec", "vitest", "related", "--run", "--passWithNoTests", ...fs.map(abs)] });
  related("root-related", root, rootFiles);
  related("core-related", path.join(root, "packages/core"), coreFiles);
  related("cloud-related", path.join(root, "cloud"), cloudFiles);
  return stages;
}

function tail(text, n) {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    log("入力の JSON を読めなかった");
    return 0;
  }
  const hasTranscript = typeof input?.agent_transcript_path === "string" && input.agent_transcript_path !== "";
  log(
    `入力 agent_type=${input?.agent_type ?? "(なし)"} cwd=${input?.cwd ?? "(なし)"} ` +
      `agent_transcript_path=${hasTranscript ? "あり" : "なし"} stop_hook_active=${String(input?.stop_hook_active)}`,
  );
  if (input?.agent_type !== TARGET_AGENT) {
    log(`対象外のサブエージェント。何もしない`);
    return 0;
  }

  const transcriptCwd = hasTranscript ? lastCwdFromTranscript(input.agent_transcript_path) : null;
  const t0Pick = Date.now();
  const fromActions = hasTranscript ? worktreeFromTranscriptActions(input.agent_transcript_path, listWorktrees(input.cwd ?? transcriptCwd)) : null;
  const fromCwd = fromActions ? null : linkedWorktreeRoot(input.cwd);
  const fromTranscript = fromActions || fromCwd ? null : linkedWorktreeRoot(transcriptCwd);
  const root = fromActions ?? fromCwd ?? fromTranscript;
  log(
    `worktree 判定: transcript の操作から=${fromActions ?? "なし"} / 入力の cwd から=${fromCwd ?? "なし"} / transcript の最後の cwd=${transcriptCwd ?? "なし"} → ` +
      `採用=${root ?? "なし"}(${fromActions ? "transcript の操作" : fromCwd ? "入力の cwd" : fromTranscript ? "transcript" : "決まらない、またはメインの作業ツリー"}) ` +
      `判定 ${Date.now() - t0Pick} ms`,
  );
  if (!root) {
    log("worktree を決められない(またはメインの作業ツリー)ので流さない");
    return 0;
  }

  const baseRef = process.env.HOOK_BASE_REF ?? DEFAULT_BASE;
  const { files, note, baseSha } = changedFiles(root, baseRef);
  log(`変更 ${files.length} 件 (base=${baseSha.slice(0, 8)})${note}`);
  if (files.length === 0) {
    log("変更が無いので何も流さない");
    return 0;
  }

  const stages = planStages(root, files);
  const limitMs = Number(process.env.HOOK_VERIFY_TIMEOUT_SEC ?? 600) * 1000;
  const started = Date.now();
  const results = [];
  let timedOut = false;
  for (const st of stages) {
    const remaining = limitMs - (Date.now() - started);
    if (remaining <= 0) {
      timedOut = true;
      results.push({ ...st, code: null, out: "(時間切れで流していない)", sec: 0 });
      continue;
    }
    const stub = process.env.HOOK_VERIFY_STUB === "1";
    const argv = stub
      ? ["sh", "-c", process.env.HOOK_VERIFY_FAIL_STAGE === st.id ? "false" : (process.env.HOOK_VERIFY_STUB_CMD ?? "true")]
      : st.cmd;
    const t0 = Date.now();
    const r = spawnSync(argv[0], argv.slice(1), { cwd: st.dir, encoding: "utf8", timeout: remaining, maxBuffer: 64 * 1024 * 1024 });
    const sec = Math.round((Date.now() - t0) / 100) / 10;
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error && r.error.code !== "ETIMEDOUT" ? `起動できない: ${r.error.message}` : ""}`;
    const to = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    if (to) timedOut = true;
    results.push({ ...st, code: to ? null : (r.status ?? 1), out: to ? "(時間切れで打ち切った)" : out, sec });
    log(`STAGE ${st.id} | ${path.relative(root, st.dir) || "."} | ${st.cmd.join(" ")} | ${to ? "時間切れ" : `終了コード ${r.status}`} | ${sec} 秒`);
  }

  const failed = results.filter((r) => r.code !== null && r.code !== 0);
  if (failed.length === 0 && !timedOut) {
    log("すべて成功");
    return 0;
  }

  const body = [
    ...(timedOut ? [`上限(${limitMs / 1000} 秒)に達し、流しきれなかった段があります(止めはしません)。`] : []),
    ...results.map((r) => `- ${r.id}: ${r.code === null ? "流しきれなかった" : r.code === 0 ? "成功" : `失敗(終了コード ${r.code})`}`),
    ...failed.map((r) => `\n[${r.id} の出力の末尾]\n${tail(r.out, 40)}`),
  ].join("\n");
  const summary = body.length > 8000 ? `${body.slice(0, 8000)}\n…(省略)` : body;
  try {
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(path.join(logDir(), "implementer-verify-last.txt"), `worktree: ${root}\n${body}\n`);
  } catch {
    // 書けなくても続ける
  }
  log(`結果: 失敗=${failed.map((f) => f.id).join(",") || "なし"} 時間切れ=${timedOut} 詳細は implementer-verify-last.txt`);

  if (failed.length === 0) return 0; // 時間切れだけなら止めない
  if (input.stop_hook_active === true) {
    log("2 回目(stop_hook_active が真)なので止めずに終える");
    process.stdout.write(JSON.stringify({ systemMessage: `実装担当の終了時の検証が失敗したまま終わりました(${root})。詳細: ${path.join(logDir(), "implementer-verify-last.txt")}` }));
    return 0;
  }
  process.stderr.write(
    `終了時の自動検証(型検査と関係するテスト)が失敗しました。直してから終えてください。\nworktree: ${root}\n${summary}\n`,
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try {
    code = main();
  } catch (e) {
    log(`フック自身の例外: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(code);
}
