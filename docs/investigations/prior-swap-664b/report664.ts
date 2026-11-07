/**
 * 決め方の規則の適用と、lr664 と lr の対比較(Issue #664 段階 1b)。表の本体は #662 の report.ts をそのまま使う(最初の id が cur)。
 * 使い方: pnpm tsx report664.ts <dataset> <outDir>     (outDir に cur・lr50・lr100・lr664_50・lr664_100 の出力がある前提)
 * 規則(試算の前に固定): lr664_50・lr664_100 のうち、中央の全券種合計で (1) 回収率が cur 以上(点推定)、(2) |見込み/実−1| が cur より小さい、を両方満たすものがあれば「段階 2 に進む」。
 */
import { readFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, judgeRaceBets } from "../../../scripts/allocation-dataset.js";
import type { AllocationRowBet } from "../../../cloud/src/allocation-export-format.js";
import { pairedRateDiff, rateOf, ratioOf, ruleCheck, type RaceCell } from "./stats664.js";

const [file, outDir] = process.argv.slice(2) as [string, string];
const rows = replayableRows(loadAllocationDataset(file).rows);
const pct = (x: number | null): string => (x === null ? "-" : (x * 100).toFixed(1) + "%");
const fmt2 = (x: number | null): string => (x === null ? "-" : x.toFixed(2));

/** 全レースぶんの RaceCell(買い目ごとの賭け金・払戻・見込み的中・実的中の合計。#662 の report.ts と同じ数え方)。 */
function cells(id: string): RaceCell[] {
  const bets = JSON.parse(readFileSync(`${outDir}/${id}.json`, "utf8")) as Record<string, AllocationRowBet[] | null>;
  return rows.map((row) => {
    let stake = 0, ret = 0, exp = 0, act = 0;
    for (const j of judgeRaceBets(row, bets[String(row.analysis_id)] ?? [])) {
      const o = j.judgment.outcome;
      if (o === "unjudged" || o === "unknownBetType") continue;
      stake += j.bet.stake; ret += j.payout;
      exp += o === "refund" || j.bet.ev === null || j.bet.odds === null ? 0 : j.bet.ev / j.bet.odds;
      act += o === "hit" ? 1 : 0;
    }
    return { stake, ret, exp, act };
  });
}
const IDS = ["cur", "lr50", "lr100", "lr664_50", "lr664_100"] as const;
const all = Object.fromEntries(IDS.map((id) => [id, cells(id)])) as Record<(typeof IDS)[number], RaceCell[]>;
const isCentral = rows.map((r) => r.venue_kind === "central");
const sub = (cs: RaceCell[], keep: boolean[]): RaceCell[] => cs.filter((_, i) => keep[i]);
const central = Object.fromEntries(IDS.map((id) => [id, sub(all[id], isCentral)])) as typeof all;
const sum = (cs: RaceCell[]): RaceCell => cs.reduce((a, r) => ({ stake: a.stake + r.stake, ret: a.ret + r.ret, exp: a.exp + r.exp, act: a.act + r.act }), { stake: 0, ret: 0, exp: 0, act: 0 });

const L: string[] = [];
L.push(`試算のレース: 全体 ${rows.length}・中央 ${central.cur.length}\n`);
L.push("### 中央(判定の対象)の合計\n", "| 候補 | 賭け金 | 払戻 | 回収率 | 見込み/実 | |見込み/実−1| |", "|---|---|---|---|---|---|");
for (const id of IDS) { const c = sum(central[id]); L.push(`| ${id} | ${c.stake} | ${c.ret} | ${pct(rateOf(c))} | ${fmt2(ratioOf(c))} | ${fmt2(ratioOf(c) === null ? null : Math.abs(ratioOf(c)! - 1))} |`); }
L.push("\n### 決め方の規則の適用(基準 cur。中央・全券種合計)\n", "| 候補 | 回収率 | 見込み/実 | (1) 回収率 ≥ cur | (2) 見込み/実が 1 に近い | 満たす |", "|---|---|---|---|---|---|");
const qualified: string[] = [];
for (const id of ["lr664_50", "lr664_100"] as const) {
  const r = ruleCheck(central.cur, central[id]);
  if (r.qualified) qualified.push(id);
  L.push(`| ${id} | ${pct(r.rate)} | ${fmt2(r.ratio)} | ${r.ok1 ? "○" : "×"} | ${r.ok2 ? "○" : "×"} | ${r.qualified ? "○" : "×"} |`);
}
for (const id of ["lr50", "lr100"] as const) {
  const r = ruleCheck(central.cur, central[id]);
  L.push(`| ${id}(参考。規則の対象外) | ${pct(r.rate)} | ${fmt2(r.ratio)} | ${r.ok1 ? "○" : "×"} | ${r.ok2 ? "○" : "×"} | - |`);
}
L.push(`\n規則を満たす候補: ${qualified.length === 0 ? "なし → 段階 2 に進まない" : qualified.join("・") + " → 段階 2 に進む"}。`);
L.push("\n### 回収率の差(b − a)の対ブートストラップ(2,000 回・シード 11)。判定には使わない。中央 / 全体\n", "| a | b | 中央: 点推定 | 中央: 95% 区間 | 中央: 正の割合 | 全体: 点推定 | 全体: 95% 区間 | 全体: 正の割合 |", "|---|---|---|---|---|---|---|---|");
for (const [a, b] of [["lr50", "lr664_50"], ["lr100", "lr664_100"], ["cur", "lr664_50"], ["cur", "lr664_100"], ["cur", "lr50"], ["cur", "lr100"]] as const) {
  const c = pairedRateDiff(central[a], central[b], 11, 2000), g = pairedRateDiff(all[a], all[b], 11, 2000);
  const f = (d: typeof c): string => `${pct(d.point)} | ${pct(d.lo)}〜${pct(d.hi)} | ${pct(d.positiveFrac)}`;
  L.push(`| ${a} | ${b} | ${f(c)} | ${f(g)} |`);
}
console.log(L.join("\n"));
