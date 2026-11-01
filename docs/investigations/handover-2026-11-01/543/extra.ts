// #543 の追加の集計: D1・D2 の 3 着内の Brier(前半・後半)と、基準の設定で判定できなかった買い目の内訳
import { loadAllocationDataset, replayableRows, replayedBets, judgeRaceBets } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
const [file] = process.argv.slice(2);
const rows = replayableRows(loadAllocationDataset(file!).rows);
const ALL_ON = { wide: true, trio: true, quinella: true, exacta: true, trifecta: true, bracketQuinella: true };
const BASE = { bankroll: 20000, perRaceCap: 2000, kellyFraction: 0.5, evThreshold: 1.0, minHitProb: 0.05, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2, includeComboOdds: true, include: ALL_ON };
const dates = [...new Set(rows.map((r: any) => r.kaisai_date))].sort();
const mid = dates[Math.floor(dates.length / 2)]!;
const unj = new Map<string, number>();
const brier: Record<string, { s: number; n: number }> = {};
const add = (k: string, p: number, y: number) => { const b = (brier[k] ??= { s: 0, n: 0 }); b.s += (p - y) ** 2; b.n += 1; };
for (const row of rows as any[]) {
  const bets = replayedBets(row, BASE);
  for (const j of bets === null ? [] : judgeRaceBets(row, bets)) {
    if (j.judgment.outcome === "unjudged" || j.judgment.outcome === "unknownBetType") {
      const key = `${j.bet.betType ?? j.bet.bet_type}:${j.judgment.outcome}:${(j.judgment as any).reason ?? ""}`;
      unj.set(key, (unj.get(key) ?? 0) + 1);
    }
  }
  const half = row.kaisai_date < mid ? "前半" : "後半";
  const fin = new Map<number, number | null>((row.result?.horses ?? []).map((x: any) => [x.umaban, x.finish_position]));
  for (const h of row.horses ?? []) {
    const fp = fin.get(h.umaban);
    if (typeof h.prior !== "number" || typeof h.adjusted_prob !== "number" || typeof fp !== "number") continue;
    const y = fp >= 1 && fp <= 3 ? 1 : 0;
    for (const [name, k] of [["統計モデル", 0], ["補正後(k=1)", 1], ["D1(k=1.5)", 1.5], ["D2(k=2)", 2]] as const) {
      add(`${half} ${name}`, Math.min(0.99, Math.max(0.01, h.prior + k * (h.adjusted_prob - h.prior))), y);
    }
  }
}
console.log("判定できなかった買い目:", [...unj.entries()].sort((a, b) => b[1] - a[1]));
for (const [k, v] of Object.entries(brier)) console.log(k, (v.s / v.n).toFixed(5), v.n);
