/**
 * 調教師の成績の縮小の基準 `TRAINER_PLACE_RATE_BASE`(`packages/core/src/scorer/trainer-stats.ts`。現在 0.222)を、取得済みのページから再現する(Issue #354)。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/trainer-base-rate.ts --years 2024,2025 <ディレクトリ>...
 * 各ディレクトリに `trainer_<調教師ID>.html`(`db.netkeiba.com/trainer/result.html?id=…` の本文。`parseJockeyResults` が読む。UTF-8 に直したもののほか、
 * 取得したままの EUC-JP のファイルも読む〈UTF-8 として読めなければ EUC-JP とみなす〉)が並んでいること。
 * 元データ(2026-10-17 に取得した 196 人)はリポジトリに入れない。ネットワークには出ない(ローカルのファイルを読むだけ)。
 * 値は丸めて使う(0.20〜0.25 の範囲では特徴量はほぼ変わらない。根拠は `trainer-stats.ts` の `TRAINER_PLACE_RATE_BASE` の説明)。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJockeyResults, type JockeyYearRecord } from "../packages/core/src/scraper/parse-jockey-results.js";
import { trainerBaseRate } from "./trainer-base-rate-calc.js";

/** UTF-8 として読めればそのまま、読めなければ EUC-JP とみなす。 */
function decode(raw: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("euc-jp").decode(raw);
  }
}

let years: number[] = [];
const dirs: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--years") years = (argv[++i] ?? "").split(",").map(Number);
  else dirs.push(a);
}
if (dirs.length === 0 || years.length === 0 || years.some((y) => !Number.isInteger(y))) {
  console.error("使い方: pnpm tsx scripts/trainer-base-rate.ts --years 2024,2025 <ディレクトリ>...");
  process.exit(2);
}

const trainers: JockeyYearRecord[][] = [];
for (const dir of dirs) {
  for (const f of readdirSync(dir).sort()) {
    if (!/^trainer_.+\.html$/.test(f)) continue;
    try {
      trainers.push(parseJockeyResults(decode(readFileSync(path.join(dir, f)))));
    } catch (e) {
      console.error(`読めないファイルを飛ばした: ${path.join(dir, f)} (${(e as Error).message})`);
    }
  }
}
const r = trainerBaseRate(trainers, years);
console.log(`調教師 ${r.trainers} 人(窓の行あり)・出走 ${r.starts}・3着内 ${r.placed}・3着内率 ${r.rate.toFixed(4)}`);
