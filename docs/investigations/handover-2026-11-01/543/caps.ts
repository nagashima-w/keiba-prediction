import { loadAllocationDataset } from "/home/user/keiba-prediction/scripts/allocation-dataset.ts";
const ds = loadAllocationDataset(process.argv[2]!);
const m = new Map<string, Set<string>>();
for (const r of ds.rows as any[]) { const s = r.allocation?.settings; if (!s) continue; const k = `${s.bankroll}/${s.per_race_cap}/λ${s.kelly_fraction}/ev${s.ev_threshold}`; if (!m.has(r.kaisai_date)) m.set(r.kaisai_date, new Set()); m.get(r.kaisai_date)!.add(k); }
for (const [d, s] of [...m].sort()) console.log(d, [...s].join(" "));
