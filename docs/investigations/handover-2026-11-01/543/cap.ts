import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, judgeRaceBets } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
const [file, out] = process.argv.slice(2);
const rows = replayableRows(loadAllocationDataset(file!).rows);
const CAPS = [1000, 1500, 2000, 2500, 3000];
const res: any[] = [];
for (const row of rows) {
  const r: any = { race: row.race_id, date: row.kaisai_date, v: {} };
  for (const c of CAPS) {
    // いまの本番の設定にそろえる: 総資金 20,000・ケリー係数 0.5・単勝/複勝 2 点まで
    const bets = replayedBets(row, { bankroll: 20000, perRaceCap: c, kellyFraction: 0.5, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2 });
    if (bets === null) { r.v[c] = null; continue; }
    let stake = 0, ret = 0, n = 0, hits = 0;
    for (const j of judgeRaceBets(row, bets)) {
      if (j.judgment.outcome === "unjudged" || j.judgment.outcome === "unknownBetType") continue;
      stake += j.bet.stake; ret += j.payout; n++; if (j.judgment.outcome === "hit") hits++;
    }
    r.v[c] = { stake, ret, n, hits };
  }
  res.push(r);
}
writeFileSync(out!, JSON.stringify(res));
console.log("rows", rows.length);
