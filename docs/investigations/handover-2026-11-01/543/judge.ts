// #543 判定: いまの本番の設定にそろえ、候補ごとに 1 か所だけ変えて計算し直す(計画は Issue #543 のコメント)
import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, judgeRaceBets } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
const [file, out] = process.argv.slice(2);
const rows = replayableRows(loadAllocationDataset(file!).rows);
const ALL_ON = { wide: true, trio: true, quinella: true, exacta: true, trifecta: true, bracketQuinella: true };
const BASE = { bankroll: 20000, perRaceCap: 3000, kellyFraction: 0.5, evThreshold: 1.0, minHitProb: 0.05, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2, includeComboOdds: true, include: ALL_ON };
function scaleAdjust(k: number) {
  return (h: any) => {
    if (typeof h.prior !== "number" || typeof h.adjusted_prob !== "number") return h.adjusted_prob;
    return Math.min(0.99, Math.max(0.01, h.prior + k * (h.adjusted_prob - h.prior)));
  };
}
const CANDS: Record<string, any> = {
  base: {},
  A1: { include: { wide: false, trio: false, quinella: false, exacta: false, trifecta: false, bracketQuinella: false } },
  A2: { include: { ...ALL_ON, quinella: false, exacta: false } },
  A3: { include: { ...ALL_ON, trifecta: false } },
  B1: { evThreshold: 1.2 }, B2: { evThreshold: 1.5 }, B3: { evThreshold: 2.0 },
  C1: { kellyFraction: 0.25 },
  // LLM の補正の幅を k 倍にする(#543 の下調べ 2 の後に足した候補)
  D1: { adjustProb: scaleAdjust(1.5) },
  D2: { adjustProb: scaleAdjust(2.0) },
};
const res: any[] = [];
for (const row of rows) {
  const r: any = { race: row.race_id, date: row.kaisai_date, v: {} };
  for (const [name, ov] of Object.entries(CANDS)) {
    const bets = replayedBets(row, { ...BASE, ...ov });
    if (bets === null) { r.v[name] = null; continue; }
    let stake = 0, ret = 0, n = 0, hits = 0, unj = 0;
    for (const j of judgeRaceBets(row, bets)) {
      if (j.judgment.outcome === "unjudged" || j.judgment.outcome === "unknownBetType") { unj++; continue; }
      stake += j.bet.stake; ret += j.payout; n++; if (j.judgment.outcome === "hit") hits++;
    }
    r.v[name] = { stake, ret, n, hits, unj };
  }
  res.push(r);
}
writeFileSync(out!, JSON.stringify(res));
console.log("rows", rows.length);
