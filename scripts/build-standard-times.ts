/**
 * 基準タイム表(`packages/core/src/scorer/standard-times.ts`)を、netkeiba の全戦績(馬ごとの JSON)から作り直す(Issue #353〈#274-B〉)。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/build-standard-times.ts --out packages/core/src/scorer/standard-times.ts \
 *     --source "raw342+raw348+raw274(中央の芝・ダの走・重複除去)" --date 2026-10-17 <ディレクトリ>...
 * 各ディレクトリに `results_<馬ID>.json`(`ajax_horse_results` の応答。`parseHorseResults` が読む形)が並んでいること。
 * 規則は `scripts/standard-times-build.ts` の先頭。元データはリポジトリに入れない(この表を作り直すときだけ、取得し直して使う)。
 * ネットワークには出ない(ローカルのファイルを読むだけ)。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseHorseResults, excludeNonStartResults } from "../packages/core/src/scraper/parse-horse-results.js";
import { buildStandardTimeTable, DEFAULT_MIN_RUNS, renderStandardTimesModule, type StandardTimeRun } from "./standard-times-build.js";

function parseArgs(argv: string[]): { out: string | null; source: string; date: string; dirs: string[] } {
  let out: string | null = null;
  let source = "(未指定)";
  let date = new Date().toISOString().slice(0, 10);
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") out = argv[++i] ?? null;
    else if (a === "--source") source = argv[++i] ?? source;
    else if (a === "--date") date = argv[++i] ?? date;
    else dirs.push(a);
  }
  return { out, source, date, dirs };
}

const args = parseArgs(process.argv.slice(2));
if (args.dirs.length === 0) {
  console.error("使い方: pnpm tsx scripts/build-standard-times.ts [--out <ファイル>] [--source <出典>] [--date YYYY-MM-DD] <ディレクトリ>...");
  process.exit(2);
}

const runs: StandardTimeRun[] = [];
for (const dir of args.dirs) {
  for (const f of readdirSync(dir).sort()) {
    const m = /^results_(.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      for (const result of excludeNonStartResults(parseHorseResults(readFileSync(path.join(dir, f), "utf-8")))) {
        runs.push({ horseId: m[1]!, result });
      }
    } catch (e) {
      console.error(`読めないファイルを飛ばした: ${path.join(dir, f)} (${(e as Error).message})`);
    }
  }
}

const built = buildStandardTimeTable(runs);
const text = renderStandardTimesModule(built.table, {
  generatedAt: args.date,
  source: args.source,
  runs: built.runs,
  dateRange: built.dateRange,
  minRuns: DEFAULT_MIN_RUNS,
});
if (args.out === null) {
  process.stdout.write(text);
} else {
  writeFileSync(args.out, text, "utf-8");
}
console.error(`走 ${built.runs}・区分 ${Object.keys(built.table.standards).length}・補正 ${Object.keys(built.table.offsets).length}・期間 ${built.dateRange[0]} 〜 ${built.dateRange[1]}`);
