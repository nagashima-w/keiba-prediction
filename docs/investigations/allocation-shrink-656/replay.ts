/** 1 つの買い方で全レースを計算し直し、買い目を JSON に書く。使い方: pnpm tsx replay.ts <dataset> <outDir> <id> [w=0.5] [t=1.1] */
import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, type ReplayOverrides } from "../../../scripts/allocation-dataset.js";
import { mixProbs } from "./mix.js";

const [file, outDir, id, ...opts] = process.argv.slice(2) as [string, string, string, ...string[]];
const kv = Object.fromEntries(opts.map((o) => o.split("=") as [string, string]));
const w = kv["w"] === undefined ? null : Number(kv["w"]);
const t = kv["t"] === undefined ? null : Number(kv["t"]);
const rows = replayableRows(loadAllocationDataset(file).rows);
const out: Record<string, unknown> = {};
for (const row of rows) {
  const mixed = w === null ? null : mixProbs(row.horses.map((h) => ({ umaban: h.umaban, p: h.adjusted_prob, winOdds: h.win_odds })), w);
  const overrides: ReplayOverrides = {
    ...(t === null ? {} : { evThreshold: t }),
    ...(mixed === null ? {} : { adjustProb: (h) => mixed.get(h.umaban)! }),
  };
  out[String(row.analysis_id)] = replayedBets(row, overrides);
}
writeFileSync(`${outDir}/${id}.json`, JSON.stringify(out));
console.log(id, rows.length, "races done");
