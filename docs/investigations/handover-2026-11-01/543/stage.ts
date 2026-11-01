// #543 確率の段階ごとの当たり具合: 3 着内率(adjusted_prob)から PL モデルで単勝・組合せの確率を出し、実際と市場と比べる
import { writeFileSync } from "node:fs";
import { loadAllocationDataset } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
import { PLACKETT_LUCE_MODEL } from "/home/user/keiba-prediction/packages/core/src/ev/plackett-luce-model.ts";
const [file, out] = process.argv.slice(2);
const ds = loadAllocationDataset(file!);
const p2 = (n: number) => String(n).padStart(2, "0");
const recs: any[] = [];
let used = 0;
for (const row of ds.rows as any[]) {
  const res = row.result?.horses ?? [];
  const fin = new Map<number, number>();
  for (const h of res) if (h.finish_position != null && !h.scratched) fin.set(h.umaban, h.finish_position);
  if (fin.size < 5) continue;
  const horses = row.horses.filter((h: any) => fin.has(h.umaban) && typeof h.adjusted_prob === "number");
  if (horses.length !== fin.size) continue; // 全頭の確率がそろうレースだけ
  const order = [...fin.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  if (fin.get(order[0]!) !== 1 || fin.get(order[2]!) !== 3 || fin.get(order[1]!) !== 2) continue; // 同着は除く
  used++;
  const dist = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses.map((h: any) => ({ umaban: h.umaban, placeProb: h.adjusted_prob })), 3);
  const win = new Map<number, number>(), top3 = new Map<number, number>();
  const pr: Record<string, Map<string, number>> = { quinella: new Map(), exacta: new Map(), wide: new Map(), trio: new Map(), trifecta: new Map() };
  const add = (m: Map<string, number>, k: string, p: number) => m.set(k, (m.get(k) ?? 0) + p);
  for (const o of dist) {
    const [a, b, c] = o.order as number[]; const p = o.probability;
    win.set(a!, (win.get(a!) ?? 0) + p);
    for (const u of [a!, b!, c!]) top3.set(u, (top3.get(u) ?? 0) + p);
    add(pr.quinella!, [a!, b!].sort((x, y) => x - y).map(p2).join(""), p);
    add(pr.exacta!, p2(a!) + p2(b!), p);
    for (const [x, y] of [[a!, b!], [a!, c!], [b!, c!]]) add(pr.wide!, [x!, y!].sort((s, t) => s - t).map(p2).join(""), p);
    add(pr.trio!, [a!, b!, c!].sort((x, y) => x - y).map(p2).join(""), p);
    add(pr.trifecta!, p2(a!) + p2(b!) + p2(c!), p);
  }
  const base = { date: row.kaisai_date, race: row.race_id, venue: row.venue_kind, n: fin.size };
  // 馬ごと: 3 着内率・単勝
  const winOddsSum = horses.reduce((s: number, h: any) => s + (h.win_odds ? 1 / h.win_odds : 0), 0);
  for (const h of horses) {
    const pos = fin.get(h.umaban)!;
    const fr = res.find((x: any) => x.umaban === h.umaban);
    recs.push({ ...base, t: "horse", u: h.umaban, prior: h.prior, adj: h.adjusted_prob, pl_top3: top3.get(h.umaban) ?? 0, win: win.get(h.umaban) ?? 0,
      odds: h.win_odds, mkt: h.win_odds && winOddsSum ? 1 / h.win_odds / winOddsSum : null, ninki: h.ninki, won: pos === 1 ? 1 : 0, placed: pos <= 3 ? 1 : 0,
      final_odds: fr?.win_odds ?? null, place_odds_min: h.place_odds_min, place_payout: fr?.place_payout ?? null });
  }
  // 組合せ: オッズのある組合せだけ
  const pays = row.result?.combo_payouts ?? {};
  const actual: Record<string, string> = {
    quinella: [order[0]!, order[1]!].sort((x, y) => x - y).map(p2).join(""), exacta: p2(order[0]!) + p2(order[1]!),
    trio: order.slice(0, 3).sort((x, y) => x - y).map(p2).join(""), trifecta: order.slice(0, 3).map(p2).join(""),
  };
  const wideHits = new Set([[0, 1], [0, 2], [1, 2]].map(([i, j]) => [order[i!]!, order[j!]!].sort((x, y) => x - y).map(p2).join("")));
  for (const [t, odds] of Object.entries(row.combos ?? {})) {
    if (!pr[t]) continue;
    const payMap = new Map<string, number>((pays[t] ?? []).map((x: any) => [x[0], x[1]]));
    const hasPay = (pays[t] ?? []).length > 0;
    const sumInv = Object.values(odds as Record<string, number>).reduce((s, o) => s + (o > 0 ? 1 / o : 0), 0);
    for (const [k, o] of Object.entries(odds as Record<string, number>)) {
      if (!(o > 0)) continue;
      const hit = t === "wide" ? wideHits.has(k) : actual[t] === k;
      recs.push({ ...base, t, k, p: pr[t]!.get(k) ?? 0, odds: o, mkt: 1 / o / sumInv, hit: hit ? 1 : 0, pay: hit ? (payMap.get(k) ?? null) : 0, hasPay });
    }
  }
}
writeFileSync(out!, JSON.stringify(recs));
console.log("races", used, "recs", recs.length);
