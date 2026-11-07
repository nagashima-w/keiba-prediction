/**
 * 1 つの候補で全レースを計算し直し、買い目を JSON に書く(Issue #661 段階 1)。
 * 使い方: pnpm tsx replay.ts <dataset> <outDir> <id>   id は w100・w50(今の本番)・A12・A14・A16(τ = 1.2・1.4・1.6)・B25・B00(組合せの確率だけ w = 0.25・0)。
 * 出力: <outDir>/<id>.json(分析 ID → 買い目。計算し直せなかった行は null)と <outDir>/<id>.meta.json(null の行・本番モデルへ委ねた/呼び直した行)。
 */
import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, type ReplayOverrides } from "../../../scripts/allocation-dataset.js";
import { shrinkTowardMarket } from "../../../packages/core/src/ev/market-shrink.js";
import { PLACKETT_LUCE_MODEL } from "../../../packages/core/src/ev/plackett-luce-model.js";
import { sharpenedPlModel, substituteProbsModel } from "./sharpen.js";

/** 候補の定義(結果を見る前に固定)。 */
export const CANDIDATES: Record<string, { readonly shrinkW: number; readonly tau?: number; readonly comboW?: number }> = {
  w100: { shrinkW: 1 },
  w50: { shrinkW: 0.5 },
  /** 点検用(候補ではない): 自作モデルが τ = 1 で・差し替えが w = 0.5 で、本番モデルの w50 と同じ買い目になること。 */
  A10: { shrinkW: 0.5, tau: 1 },
  B50: { shrinkW: 0.5, comboW: 0.5 },
  A12: { shrinkW: 0.5, tau: 1.2 },
  A14: { shrinkW: 0.5, tau: 1.4 },
  A16: { shrinkW: 0.5, tau: 1.6 },
  B25: { shrinkW: 0.5, comboW: 0.25 },
  B00: { shrinkW: 0.5, comboW: 0 },
};

const [file, outDir, id] = process.argv.slice(2) as [string, string, string];
const cand = CANDIDATES[id];
if (cand === undefined) throw new Error(`未知の候補: ${id}`);
const rows = replayableRows(loadAllocationDataset(file).rows);
const bets: Record<string, unknown> = {};
const nullRaces: number[] = [];
const touchedRaces: number[] = [];
const horsesOf = (row: (typeof rows)[number]) => row.horses.map((h) => ({ umaban: h.umaban, p: h.adjusted_prob, winOdds: h.win_odds }));
for (const row of rows) {
  const overrides: ReplayOverrides = {};
  let touched: (() => number) | null = null;
  if (cand.shrinkW < 1) {
    const mixed = shrinkTowardMarket(horsesOf(row), cand.shrinkW);
    Object.assign(overrides, { adjustProb: (h: { umaban: number }) => mixed.get(h.umaban)! });
  }
  if (cand.tau !== undefined) {
    const m = sharpenedPlModel(cand.tau);
    Object.assign(overrides, { model: m.model });
    touched = m.delegated;
  } else if (cand.comboW !== undefined) {
    const m = substituteProbsModel(shrinkTowardMarket(horsesOf(row), cand.comboW), PLACKETT_LUCE_MODEL);
    Object.assign(overrides, { model: m.model });
    touched = m.fallbacks;
  }
  const b = replayedBets(row, overrides);
  bets[String(row.analysis_id)] = b;
  if (b === null) nullRaces.push(row.analysis_id);
  if (touched !== null && touched() > 0) touchedRaces.push(row.analysis_id);
}
writeFileSync(`${outDir}/${id}.json`, JSON.stringify(bets));
writeFileSync(`${outDir}/${id}.meta.json`, JSON.stringify({ rows: rows.length, nullRaces, touchedRaces }));
console.log(id, rows.length, "races done; null", nullRaces.length, "touched", touchedRaces.length);
