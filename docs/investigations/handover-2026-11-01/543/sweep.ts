import { writeFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, replayedBets, judgeRaceBets } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
const [file, out] = process.argv.slice(2);
const ds = loadAllocationDataset(file!);
const rows = replayableRows(ds.rows);
const BANKS = [5000, 10000, 20000, 30000, 50000, 100000];
const CAPS: (number | null)[] = [null, 1e9]; // null = 書き出しの行の設定のまま
const settings: Record<string, number> = {};
const res: any[] = [];
for (const row of rows) {
  const s: any = (row as any).allocation?.settings ?? {};
  const key = `${s.bankroll}/${s.per_race_cap}/${s.max_win_bets}/${s.min_hit_prob}`;
  settings[key] = (settings[key] ?? 0) + 1;
  const r: any = { race: row.race_id, date: row.kaisai_date, venue: row.venue_kind, v: {} };
  for (const b of BANKS) for (const c of CAPS) {
    const ov: any = { bankroll: b, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2 };
    if (c !== null) ov.perRaceCap = c;
    const bets = replayedBets(row, ov);
    const k = `${b}|${c === null ? "row" : "nocap"}`;
    if (bets === null) { r.v[k] = null; continue; }
    let stake = 0, ret = 0, n = 0, hits = 0, unj = 0;
    for (const j of judgeRaceBets(row, bets)) {
      if (j.judgment.outcome === "unjudged" || j.judgment.outcome === "unknownBetType") { unj++; continue; }
      stake += j.bet.stake; ret += j.payout; n++;
      if (j.judgment.outcome === "hit") hits++;
    }
    r.v[k] = { stake, ret, n, hits, unj };
  }
  res.push(r);
}
writeFileSync(out!, JSON.stringify(res));
console.log("rows", rows.length, "settings", JSON.stringify(settings));
