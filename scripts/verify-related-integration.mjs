#!/usr/bin/env node
// 変えたものに関係する cloud のインテグレーションのテスト(*.integration.test.ts)だけを流す(Issue #620)。
//
// 関係するテスト = (1) `vitest list --filesOnly --changed <基点>` が返す、変更の影響を受けるテストファイルのうち *.integration.test.ts、
//                 (2) 変えたファイルそのものがインテグレーションのテストなら、それも含める。
// 基点: 環境変数 VERIFY_BASE(ref)。無ければ scripts/hooks/implementer-verify-hook.mjs の既定と同じ ref。
//       merge-base(HEAD, 基点) から HEAD・作業ツリー・未追跡までを「変更」とする(作業中にコミットしても差分が空にならない)。
//       merge-base が決まらなければ HEAD からの変更だけ(注意を出す)。
//                 (3) 差分に cloud/wrangler.toml・cloud/migrations/・cloud/smoke*.ts があれば、それらを import せず読むテストの固定の一覧を足す
//                     (import をたどる (1) では選ばれないため。Issue #701。一覧は verify-related-config.mjs)。
// 流すのは cloud/ で `vitest run <ファイル…>`。該当が無ければ何も流さず 0 で終わる。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTargets } from "./verify-related-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD = path.join(ROOT, "cloud");
const DEFAULT_BASE = "origin/claude/issue-order-processing-wjgpdd";
const SUFFIX = ".integration.test.ts";

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

const baseRef = process.env.VERIFY_BASE || DEFAULT_BASE;
const mb = git(["merge-base", "HEAD", baseRef]);
const baseSha = mb.status === 0 ? mb.stdout.trim() : "HEAD";
if (mb.status !== 0) console.error(`注意: merge-base 失敗(${baseRef})。HEAD からの変更だけを見る`);

const diff = git(["diff", "--name-only", baseSha]).stdout.split("\n");
const untracked = git(["ls-files", "--others", "--exclude-standard"]).stdout.split("\n");
// 削除されたファイルもトリガーの判定には使う(changedAll)。流す対象の判定には、実在するものだけ使う(changed)。
const changedAll = [...new Set([...diff, ...untracked].filter(Boolean))];
const changed = changedAll.filter((f) => existsSync(path.join(ROOT, f)));

const vitest = path.join(CLOUD, "node_modules", ".bin", "vitest");
const listed = spawnSync(vitest, ["list", "--filesOnly", "--changed", baseSha], { cwd: CLOUD, encoding: "utf8" });
if (listed.status !== 0) {
  console.error(listed.stdout + listed.stderr);
  process.exit(listed.status ?? 1);
}
const affected = listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts"));
const direct = changed.filter((f) => f.startsWith("cloud/test/") && f.endsWith(SUFFIX)).map((f) => f.slice("cloud/".length));
const targets = buildTargets({ affected, direct, changedAll });

console.log(`基点 ${baseSha.slice(0, 8)}、変更 ${changed.length} 件、関係するインテグレーションのテスト ${targets.length} 件`);
if (targets.length === 0) {
  console.log("関係するインテグレーションのテストなし");
  process.exit(0);
}
const run = spawnSync(vitest, ["run", ...targets], { cwd: CLOUD, stdio: "inherit" });
process.exit(run.status ?? 1);
