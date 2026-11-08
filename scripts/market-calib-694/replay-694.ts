/** 1 つの買い方(式 + w)で全レースを計算し直し、買い目を JSON に書く。`allocation-shrink-656/replay.ts` と同じ手順。
 * 使い方: pnpm tsx scripts/market-calib-694/replay-694.ts <dataset> <outDir> <id> <fit-coef.json> [f=F1 w=0.5] */
import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, type ReplayOverrides } from "../allocation-dataset.js";
import { loadFitCoef, mixWith, type FormulaId } from "./mix-formula.js";

const [file, outDir, id, coefPath, ...opts] = process.argv.slice(2) as [string, string, string, string, ...string[]];
const kv = Object.fromEntries(opts.map((o) => o.split("=") as [string, string]));
const f = kv["f"] as FormulaId | undefined;
const w = kv["w"] === undefined ? null : Number(kv["w"]);
const fc = loadFitCoef(coefPath);
const rows = replayableRows(loadAllocationDataset(file).rows);
const out: Record<string, unknown> = {};
for (const row of rows) {
  const mixed = f === undefined || w === null ? null : mixWith(row.horses.map((h) => ({ umaban: h.umaban, p: h.adjusted_prob, winOdds: h.win_odds })), w, f, fc);
  const overrides: ReplayOverrides = mixed === null ? {} : { adjustProb: (h) => mixed.get(h.umaban)! };
  out[String(row.analysis_id)] = replayedBets(row, overrides);
}
writeFileSync(`${outDir}/${id}.json`, JSON.stringify(out));
console.log(id, rows.length, "races done");
