/**
 * replay.ts の出力から指標の表(Markdown)を出す(Issue #661 段階 1)。#656 の report.ts を土台に、前半・後半・人気の帯・単勝以外・規則の判定を足した。
 * 使い方: pnpm tsx report.ts <dataset> <outDir> <id>...   最初の id が基準(今の本番 = w50)。
 */
import { readFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, judgeRaceBets } from "../../../scripts/allocation-dataset.js";
import type { AllocationRowBet } from "../../../cloud/src/allocation-export-format.js";
import { betMinRank, bandOf, frontHalfDates, popularityRanks, POPULARITY_BANDS } from "./sharpen.js";

const [file, outDir, ...ids] = process.argv.slice(2) as [string, string, ...string[]];
const rows = replayableRows(loadAllocationDataset(file).rows);
if (new Set(rows.map((r) => r.analysis_id)).size !== rows.length) throw new Error("analysis_id が重複");
if (rows.some((r) => r.kaisai_date === null)) throw new Error("開催日の無い行がある");
const front = frontHalfDates(rows.map((r) => r.kaisai_date as string));

interface Cell { bets: number; stake: number; ret: number; exp: number; act: number }
const zero = (): Cell => ({ bets: 0, stake: 0, ret: 0, exp: 0, act: 0 });
const TYPES = ["win", "place", "wide", "quinella", "bracketQuinella", "trio", "exacta", "trifecta"];
const HIGH_PAYOUT = 10000; // 「高配当」= 1 点で払戻 1 万円以上(結果を見る前に固定)

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface BetRec { type: string; stake: number; ret: number; exp: number; act: number; band: string }
interface RaceRec { venue: string; half: "front" | "back"; recs: BetRec[] }
let unknownBand = 0;
function perRace(bets: Record<string, AllocationRowBet[] | null>): RaceRec[] {
  return rows.map((row) => {
    const b = bets[String(row.analysis_id)] ?? [];
    const ranks = popularityRanks(row.horses.map((h) => ({ umaban: h.umaban, winOdds: h.win_odds })));
    const waku = new Map(row.horses.map((h) => [h.umaban, h.wakuban ?? row.result.horses.find((r) => r.umaban === h.umaban)?.wakuban ?? 0] as const));
    const recs: BetRec[] = [];
    for (const j of judgeRaceBets(row, b)) {
      const o = j.judgment.outcome;
      if (o === "unjudged" || o === "unknownBetType") continue;
      const rank = betMinRank(j.bet.bet_type, j.bet.combo_key, ranks, waku);
      if (rank === null) unknownBand++;
      recs.push({ type: j.bet.bet_type, stake: j.bet.stake, ret: j.payout, exp: o === "refund" || j.bet.ev === null || j.bet.odds === null ? 0 : j.bet.ev / j.bet.odds, act: o === "hit" ? 1 : 0, band: rank === null ? "不明" : bandOf(rank) });
    }
    return { venue: row.venue_kind, half: front.has(row.kaisai_date as string) ? "front" : "back", recs };
  });
}
const sum = (rs: BetRec[], f: (r: BetRec) => boolean = () => true): Cell => {
  const c = zero();
  for (const r of rs) if (f(r)) { c.bets++; c.stake += r.stake; c.ret += r.ret; c.exp += r.exp; c.act += r.act; }
  return c;
};
const pct = (x: number | null): string => (x === null ? "-" : (x * 100).toFixed(1) + "%");
const rate = (c: Cell): number | null => (c.stake === 0 ? null : c.ret / c.stake);
const ratio = (c: Cell): number | null => (c.act === 0 ? null : c.exp / c.act);
const fmtRatio = (c: Cell): string => (c.act === 0 ? "-" : (c.exp / c.act).toFixed(2));

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
  return pct(rate(sum([...rs].sort((a, b) => b.ret - a.ret).slice(k))));
}

const lines: string[] = [];
const results = ids.map((id) => ({
  id,
  races: perRace(JSON.parse(readFileSync(`${outDir}/${id}.json`, "utf8"))),
  meta: JSON.parse(readFileSync(`${outDir}/${id}.meta.json`, "utf8")) as { rows: number; nullRaces: number[]; touchedRaces: number[] },
}));
const SCOPES = [
  { key: "all", label: "全体", f: (_: RaceRec) => true },
  { key: "central", label: "中央", f: (r: RaceRec) => r.venue === "central" },
  { key: "nar", label: "地方", f: (r: RaceRec) => r.venue === "nar" },
  { key: "front", label: "前半", f: (r: RaceRec) => r.half === "front" },
  { key: "back", label: "後半", f: (r: RaceRec) => r.half === "back" },
] as const;

lines.push(`\n### 区分(前半・後半の境目は日付。前半 ${front.size} 日)\n`);
lines.push("| 区分 | レース数 |", "|---|---|");
for (const s of SCOPES) lines.push(`| ${s.label} | ${results[0]!.races.filter(s.f).length} |`);
const days = [...new Set(rows.map((r) => r.kaisai_date as string))].sort();
lines.push(`\n前半の日付: ${days.filter((d) => front.has(d))[0]}〜${days.filter((d) => front.has(d)).at(-1)}、後半: ${days.filter((d) => !front.has(d))[0]}〜${days.at(-1)}`);

lines.push("\n### 計算し直せなかった行(null)と、本番モデルへ委ねた/呼び直した行\n");
lines.push("| 買い方 | 計算し直せなかった行 | A: 尖らせず本番モデルへ委ねた行 / B: 元の確率で呼び直した行 |", "|---|---|---|");
for (const r of results) lines.push(`| ${r.id} | ${r.meta.nullRaces.length} | ${r.meta.touchedRaces.length} |`);

for (const scope of SCOPES) {
  lines.push(`\n### ${scope.label}\n`);
  lines.push("| 買い方 | 点数 | 賭け金 | 払戻 | 回収率 | 95%区間 | 上位1除 | 上位3除 | 上位5除 | 見込み的中 | 実的中 | 見込み/実 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { id, races } of results) {
    const rs = races.filter(scope.f);
    const all = rs.flatMap((r) => r.recs);
    const c = sum(all);
    lines.push(`| ${id} | ${c.bets} | ${c.stake} | ${c.ret} | ${pct(rate(c))} | ${bootstrap(rs, 7)} | ${dropTop(all, 1)} | ${dropTop(all, 3)} | ${dropTop(all, 5)} | ${c.exp.toFixed(1)} | ${c.act} | ${fmtRatio(c)} |`);
  }
}
for (const scope of SCOPES.slice(0, 3)) {
  lines.push(`\n### 券種別(${scope.label}): 点数 / 回収率 / 見込み÷実的中(実的中)\n`);
  lines.push(`| 買い方 | ${TYPES.join(" | ")} |`, `|---|${TYPES.map(() => "---").join("|")}|`);
  for (const { id, races } of results) {
    const all = races.filter(scope.f).flatMap((r) => r.recs);
    lines.push(`| ${id} | ${TYPES.map((t) => { const c = sum(all, (r) => r.type === t); return c.bets === 0 ? "-" : `${c.bets} / ${pct(rate(c))} / ${fmtRatio(c)}(${c.act})`; }).join(" | ")} |`);
  }
}
lines.push("\n### 単勝以外の券種だけ(単勝の確率も候補で動くため、参考)\n");
lines.push("| 区分 | 買い方 | 点数 | 賭け金 | 払戻 | 回収率 | 見込み的中 | 実的中 | 見込み/実 |", "|---|---|---|---|---|---|---|---|---|");
for (const scope of SCOPES) for (const { id, races } of results) {
  const c = sum(races.filter(scope.f).flatMap((r) => r.recs), (r) => r.type !== "win");
  lines.push(`| ${scope.label} | ${id} | ${c.bets} | ${c.stake} | ${c.ret} | ${pct(rate(c))} | ${c.exp.toFixed(1)} | ${c.act} | ${fmtRatio(c)} |`);
}
lines.push(`\n### 人気の帯(買い目に含む馬の単勝人気の一番低いもの。枠連は枠に入る馬のうち一番低いもの。人気が決まらない買い目は「不明」。全体)\n`);
lines.push("| 帯 | 買い方 | 点数 | 賭け金 | 払戻 | 回収率 | 見込み的中 | 実的中 | 見込み/実 |", "|---|---|---|---|---|---|---|---|---|");
for (const band of [...POPULARITY_BANDS, "不明"]) for (const { id, races } of results) {
  const c = sum(races.flatMap((r) => r.recs), (r) => r.band === band);
  if (band === "不明" && c.bets === 0) continue;
  lines.push(`| ${band} | ${id} | ${c.bets} | ${c.stake} | ${c.ret} | ${pct(rate(c))} | ${c.exp.toFixed(1)} | ${c.act} | ${fmtRatio(c)} |`);
}
lines.push(`\n### 高配当(1 点で払戻 ${HIGH_PAYOUT} 円以上。賭け金を含む。全体)\n`);
lines.push("| 買い方 | 的中のうち高配当の点数 | その払戻の合計 | 払戻全体に占める割合 | (後から足した見方)払戻が賭け金の 20 倍以上の点数 | その払戻の合計 | 払戻全体に占める割合 |", "|---|---|---|---|---|---|---|");
for (const { id, races } of results) {
  const all = races.flatMap((r) => r.recs);
  const hi = all.filter((r) => r.ret >= HIGH_PAYOUT);
  const tot = all.reduce((a, r) => a + r.ret, 0);
  const s = hi.reduce((a, r) => a + r.ret, 0);
  const x20 = all.filter((r) => r.stake > 0 && r.ret >= 20 * r.stake);
  const s20 = x20.reduce((a, r) => a + r.ret, 0);
  lines.push(`| ${id} | ${hi.length} | ${s} | ${tot === 0 ? "-" : pct(s / tot)} | ${x20.length} | ${s20} | ${tot === 0 ? "-" : pct(s20 / tot)} |`);
}
// 基準(最初の id)との差の対ブートストラップ
lines.push("\n### 回収率の差(各買い方 − " + ids[0] + ")の対ブートストラップ 95% 区間と、差が正になった割合\n");
lines.push(`| 買い方 | ${SCOPES.map((s) => s.label).join(" | ")} |`, `|---|${SCOPES.map(() => "---").join("|")}|`);
for (const r of results.slice(1)) {
  const cells = SCOPES.map((scope) => {
    const idx = results[0]!.races.map((x, i) => (scope.f(x) ? i : -1)).filter((i) => i >= 0);
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
// 決め方の規則の機械的な適用(全券種の合計・全体。w100 は参考で対象外)
const base = results[0]!;
const bc = sum(base.races.flatMap((r) => r.recs));
lines.push(`\n### 決め方の規則の適用(基準 ${base.id}: 回収率 ${pct(rate(bc))}・見込み/実 ${fmtRatio(bc)})\n`);
lines.push("条件: (1) 全体の回収率が基準以上(点推定)、(2) 全体の |見込み/実 − 1| が基準より小さい(実的中 0 は不可)。条件を満たす候補のうち、変える量が最小のもの(A は τ が小さい順、B は w が 0.5 に近い順)。\n");
lines.push("| 候補 | 回収率 | 見込み/実 | (1) | (2) | 前半の回収率差の符号 | 後半の回収率差の符号 | 満たす |", "|---|---|---|---|---|---|---|---|");
const qualified: string[] = [];
for (const r of results.slice(1)) {
  if (r.id === "w100") continue;
  const c = sum(r.races.flatMap((x) => x.recs));
  const ok1 = (rate(c) ?? -1) >= (rate(bc) ?? Infinity);
  const rc = ratio(c), rb = ratio(bc);
  const ok2 = rc !== null && rb !== null && Math.abs(rc - 1) < Math.abs(rb - 1);
  const sign = (h: "front" | "back"): string => {
    const x = sum(r.races.filter((q) => q.half === h).flatMap((q) => q.recs)), y = sum(base.races.filter((q) => q.half === h).flatMap((q) => q.recs));
    const d = (rate(x) ?? 0) - (rate(y) ?? 0);
    return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pt`;
  };
  if (ok1 && ok2) qualified.push(r.id);
  lines.push(`| ${r.id} | ${pct(rate(c))} | ${fmtRatio(c)} | ${ok1 ? "○" : "×"} | ${ok2 ? "○" : "×"} | ${sign("front")} | ${sign("back")} | ${ok1 && ok2 ? "○" : "×"} |`);
}
const order = ["A12", "A14", "A16", "B25", "B00"];
const pickA = order.filter((i) => i.startsWith("A") && qualified.includes(i))[0];
const pickB = order.filter((i) => i.startsWith("B") && qualified.includes(i))[0];
lines.push(`\n規則を満たす候補: ${qualified.length === 0 ? "なし → 実装しない" : qualified.join("・")}。A の中の最小: ${pickA ?? "なし"}、B の中の最小: ${pickB ?? "なし"}(A と B の両方に残る場合は、規則だけでは決まらない)。`);
if (unknownBand > 0) lines.push(`\n(人気の帯が決まらなかった買い目: 延べ ${unknownBand} 点)`);
console.log(lines.join("\n"));
