/** replay.ts の出力から指標の表(Markdown)を出す。使い方: pnpm tsx report.ts <dataset> <outDir> <id>... */
import { readFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, judgeRaceBets } from "../../../scripts/allocation-dataset.js";
import type { AllocationRowBet } from "../../../cloud/src/allocation-export-format.js";

const [file, outDir, ...ids] = process.argv.slice(2) as [string, string, ...string[]];
const rows = replayableRows(loadAllocationDataset(file).rows);
if (new Set(rows.map((r) => r.analysis_id)).size !== rows.length) throw new Error("analysis_id が重複");

interface Cell { bets: number; stake: number; ret: number; exp: number; act: number }
const zero = (): Cell => ({ bets: 0, stake: 0, ret: 0, exp: 0, act: 0 });
const TYPES = ["win", "place", "wide", "quinella", "bracketQuinella", "trio", "exacta", "trifecta"];

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface BetRec { type: string; stake: number; ret: number; exp: number; act: number }
function perRace(bets: Record<string, AllocationRowBet[] | null>): { venue: string; recs: BetRec[] }[] {
  return rows.map((row) => {
    const b = bets[String(row.analysis_id)] ?? [];
    const recs: BetRec[] = [];
    for (const j of judgeRaceBets(row, b)) {
      const o = j.judgment.outcome;
      if (o === "unjudged" || o === "unknownBetType") continue;
      recs.push({ type: j.bet.bet_type, stake: j.bet.stake, ret: j.payout, exp: o === "refund" ? 0 : j.bet.ev / j.bet.odds, act: o === "hit" ? 1 : 0 });
    }
    return { venue: row.venue_kind, recs };
  });
}
const sum = (rs: BetRec[], f: (r: BetRec) => boolean = () => true): Cell => {
  const c = zero();
  for (const r of rs) if (f(r)) { c.bets++; c.stake += r.stake; c.ret += r.ret; c.exp += r.exp; c.act += r.act; }
  return c;
};
const pct = (x: number | null): string => (x === null ? "-" : (x * 100).toFixed(1) + "%");
const rate = (c: Cell): number | null => (c.stake === 0 ? null : c.ret / c.stake);

function bootstrap(races: { recs: BetRec[] }[], seed: number): string {
  const per = races.map((r) => sum(r.recs));
  const rnd = mulberry32(seed);
  const rates: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0, g = 0;
    for (let i = 0; i < per.length; i++) { const c = per[Math.floor(rnd() * per.length)]!; s += c.stake; g += c.ret; }
    if (s > 0) rates.push(g / s);
  }
  rates.sort((a, b) => a - b);
  return `${pct(rates[Math.floor(rates.length * 0.025)]!)}〜${pct(rates[Math.floor(rates.length * 0.975)]!)}`;
}
/** 払戻の大きい順に k 点を、賭け金も払戻も除いたときの回収率。 */
function dropTop(rs: BetRec[], k: number): string {
  const sorted = [...rs].sort((a, b) => b.ret - a.ret).slice(k);
  return pct(rate(sum(sorted)));
}

const lines: string[] = [];
const results = ids.map((id) => ({ id, races: perRace(JSON.parse(readFileSync(`${outDir}/${id}.json`, "utf8"))) }));
for (const scope of ["all", "central", "nar"] as const) {
  lines.push(`\n### ${scope === "all" ? "全体" : scope === "central" ? "中央" : "地方"}\n`);
  lines.push("| 買い方 | 点数 | 賭け金 | 払戻 | 回収率 | 95%区間 | 上位1除 | 上位3除 | 上位5除 | 見込み的中 | 実的中 | 見込み/実 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { id, races } of results) {
    const rs = races.filter((r) => scope === "all" || r.venue === scope);
    const all = rs.flatMap((r) => r.recs);
    const c = sum(all);
    lines.push(`| ${id} | ${c.bets} | ${c.stake} | ${c.ret} | ${pct(rate(c))} | ${bootstrap(rs, 7)} | ${dropTop(all, 1)} | ${dropTop(all, 3)} | ${dropTop(all, 5)} | ${c.exp.toFixed(1)} | ${c.act} | ${c.act === 0 ? "-" : (c.exp / c.act).toFixed(2)} |`);
  }
}
for (const scope of ["all", "central", "nar"] as const) {
  lines.push(`\n### 券種別(${scope === "all" ? "全体" : scope === "central" ? "中央" : "地方"}): 点数 / 回収率 / 見込み÷実的中(実的中)\n`);
  lines.push(`| 買い方 | ${TYPES.join(" | ")} |`);
  lines.push(`|---|${TYPES.map(() => "---").join("|")}|`);
  for (const { id, races } of results) {
    const all = races.filter((r) => scope === "all" || r.venue === scope).flatMap((r) => r.recs);
    lines.push(`| ${id} | ${TYPES.map((t) => { const c = sum(all, (r) => r.type === t); return c.bets === 0 ? "-" : `${c.bets} / ${pct(rate(c))} / ${c.act === 0 ? "-" : (c.exp / c.act).toFixed(2)}(${c.act})`; }).join(" | ")} |`);
  }
}
// 基準(最初の id)との差の対ブートストラップ(同じレースを同じ抽出で比べる)
lines.push("\n### 回収率の差(各買い方 − " + ids[0] + ")の対ブートストラップ 95% 区間と、差が正になった割合\n");
lines.push("| 買い方 | 全体 | 中央 | 地方 |");
lines.push("|---|---|---|---|");
for (const r of results.slice(1)) {
  const cells = (["all", "central", "nar"] as const).map((scope) => {
    const idx = rows.map((x, i) => (scope === "all" || x.venue_kind === scope ? i : -1)).filter((i) => i >= 0);
    const a = results[0]!.races.map((x) => sum(x.recs));
    const b = r.races.map((x) => sum(x.recs));
    const rnd = mulberry32(11);
    const ds: number[] = [];
    for (let k = 0; k < 2000; k++) {
      let sa = 0, ga = 0, sb = 0, gb = 0;
      for (let i = 0; i < idx.length; i++) { const j = idx[Math.floor(rnd() * idx.length)]!; sa += a[j]!.stake; ga += a[j]!.ret; sb += b[j]!.stake; gb += b[j]!.ret; }
      if (sa > 0 && sb > 0) ds.push(gb / sb - ga / sa);
    }
    ds.sort((x, y) => x - y);
    return `${pct(ds[Math.floor(ds.length * 0.025)]!)}〜${pct(ds[Math.floor(ds.length * 0.975)]!)}(正の割合 ${pct(ds.filter((d) => d > 0).length / ds.length)})`;
  });
  lines.push(`| ${r.id} | ${cells.join(" | ")} |`);
}
console.log(lines.join("\n"));
