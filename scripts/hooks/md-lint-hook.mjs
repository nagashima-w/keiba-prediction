#!/usr/bin/env node
// PostToolUse フック(Issue #607 A): Edit・Write・MultiEdit で md を書き換えたら、書き換えた行だけに
// yomiyasu の lint(.claude/skills/yomiyasu/scripts/yomiyasu_lint.py)をかけ、候補があれば書き手へ返す。
//
// - 書き込みは止めない(常に終了コード 0)。候補が無いとき・対象外のときは何も出さない。
// - 「書き換えた行」= git diff -U0 HEAD で足された行。git 管理外・未追跡の md は全体。
//   lint の行番号を元のファイルと揃えるため、足されていない行は空行に置き換えた一時ファイルにかける。
// - 対象外: 過去の記録として残す文書(docs/versioning.md・docs/lessons-learned.md・docs/investigations/・
//   *investigation*.md)と .claude/skills/ の中。
// - lint は PYTHONDONTWRITEBYTECODE=1 で呼ぶ(__pycache__ を作らない)。
//
// 入力: 標準入力の JSON(tool_name・tool_input.file_path)。出力: additionalContext を持つ JSON。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINT = path.resolve(HERE, "../../.claude/skills/yomiyasu/scripts/yomiyasu_lint.py");

/** リポジトリのルートからの相対パスが対象外か。 */
export function isExcluded(rel) {
  return (
    rel === "docs/versioning.md" ||
    rel === "docs/lessons-learned.md" ||
    rel.startsWith("docs/investigations/") ||
    rel.startsWith(".claude/skills/") ||
    /investigation[^/]*\.md$/.test(rel)
  );
}

/** `git diff -U0` の出力から、足された行の番号(1 始まり)の集合を取り出す。 */
export function addedLineNumbers(diff) {
  const added = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) added.add(start + i);
  }
  return added;
}

/**
 * lint の出力から候補のブロック(`L<行> [区分] 規則: …` と引用の行)を取り出す。keep があれば、書き換えた行の候補だけ残す。
 * 文書全体で決まる候補(箇条書きの比率など)は、空行に置き換えた一時ファイルでは意味を持たないので、行が書き換え対象に無ければ落ちる。
 */
export function keptBlocks(out, keep) {
  return out
    .split(/\n\n+/)
    .filter((b) => /^L\d+ \[/.test(b))
    .filter((b) => keep === null || keep.has(Number(/^L(\d+) /.exec(b)?.[1])));
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!TOOLS.has(input?.tool_name)) return;
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath.toLowerCase().endsWith(".md")) return;
  const abs = path.resolve(input.cwd ?? process.cwd(), filePath);
  if (!existsSync(abs)) return;

  const dir = path.dirname(abs);
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  const root = top.status === 0 ? top.stdout.trim() : null;
  const rel = root ? path.relative(root, abs).split(path.sep).join("/") : null;
  if (rel && isExcluded(rel)) return;

  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  let keep = null; // null = 全体
  if (root) {
    const tracked = git(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
    if (tracked) {
      const diff = git(root, ["diff", "-U0", "HEAD", "--", rel]);
      if (diff.status !== 0) return;
      keep = addedLineNumbers(diff.stdout);
      if (keep.size === 0) return;
    }
  }
  const body = keep ? lines.map((l, i) => (keep.has(i + 1) ? l : "")).join("\n") : text;

  const tmp = mkdtempSync(path.join(tmpdir(), "md-lint-hook-"));
  try {
    const tmpFile = path.join(tmp, "target.md");
    writeFileSync(tmpFile, body);
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    let r = spawnSync("python3", ["-I", "-B", LINT, tmpFile], { cwd: root ?? dir, encoding: "utf8", env });
    if (r.error) r = spawnSync("python", ["-I", "-B", LINT, tmpFile], { cwd: root ?? dir, encoding: "utf8", env });
    if (r.error || r.status !== 0) return;
    const out = r.stdout;
    if (!out.includes("見直し候補:") || /見直し候補:\s*0件/.test(out)) return;
    const blocks = keptBlocks(out, keep);
    if (blocks.length === 0) return;
    const scope = keep ? "書き換えた行だけ" : "ファイル全体";
    const context =
      `yomiyasu の検査(${rel ?? abs}。${scope}。行番号は元のファイルのもの)で見直し候補が${blocks.length}件出ました。` +
      `直すかどうかは文脈で判断してください。\n\n${blocks.join("\n\n")}`;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // フックの失敗で書き込みを妨げない
  }
  process.exit(0);
}
