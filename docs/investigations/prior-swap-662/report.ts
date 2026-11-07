/**
 * replay.ts の出力から指標の表(Markdown)を出す(Issue #662 段階 1)。#661 の report.ts を土台に、馬単位の 3着内率の当たり具合と、中央だけでの規則の判定を足した。
 * 使い方: pnpm tsx report.ts <dataset> <outDir> <id>...   最初の id が基準(今の本番 = cur)。
 */
import { readFileSync } from "node:fs";
import { loadAllocationDataset, replayableRows, judgeRaceBets } from "../../../scripts/allocation-dataset.js";
import type { AllocationRowBet } from "../../../cloud/src/allocation-export-format.js";
import { betMinRank, bandOf, frontHalfDates, popularityRanks, POPULARITY_BANDS } from "../combo-sharpen-661/sharpen.js"
import { logLoss } from "./lr.js";

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
  meta: JSON.parse(readFileSync(`${outDir}/${id}.meta.json`, "utf8")) as { rows: number; nullRaces: number[]; fallbackRaces: number[]; fallbackHorses: Array<[number, number]> },
  probs: JSON.parse(readFileSync(`${outDir}/${id}.probs.json`, "utf8")) as Record<string, Record<string, { base: number; p: number }>>,
}));
const SCOPES = [
  { key: "all", label: "全体", f: (_: RaceRec) => true },
  { key: "central", label: "中央", f: (r: RaceRec) => r.venue === "central" },
  { key: "nar", label: "地方", f: (r: RaceRec) => r.venue === "nar" },
  { key: "front", label: "前半", f: (r: RaceRec) => r.half === "front" },
  { key: "back", label: "後半", f: (r: RaceRec) => r.half === "back" },
  { key: "cfront", label: "中央前半", f: (r: RaceRec) => r.venue === "central" && r.half === "front" },
  { key: "cback", label: "中央後半", f: (r: RaceRec) => r.venue === "central" && r.half === "back" },
] as const;

lines.push(`\n### 区分(前半・後半の境目は日付。前半 ${front.size} 日)\n`);
lines.push("| 区分 | レース数 |", "|---|---|");
for (const s of SCOPES) lines.push(`| ${s.label} | ${results[0]!.races.filter(s.f).length} |`);
const days = [...new Set(rows.map((r) => r.kaisai_date as string))].sort();
lines.push(`\n前半の日付: ${days.filter((d) => front.has(d))[0]}〜${days.filter((d) => front.has(d)).at(-1)}、後半: ${days.filter((d) => !front.has(d))[0]}〜${days.at(-1)}`);

lines.push("\n### 計算し直せなかった行(null)と、学習モデル/今のコードの prior が使えず元の確率のままにした行\n");
lines.push("| 買い方 | 計算し直せなかった行 | 元の確率のままにしたレース(replay に無い・5 頭未満) | 中央で差し替えられず adjusted_prob のままの馬(延べ。取消の馬など) |", "|---|---|---|---|");
for (const r of results) lines.push(`| ${r.id} | ${r.meta.nullRaces.length} | ${r.meta.fallbackRaces.length} | ${r.meta.fallbackHorses.length} |`);

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
// ===== 馬単位の 3着内率の当たり具合 =====
interface HorseRec { central: boolean; band: string; y: 0 | 1; p: number; base: number }
const rowByAid = new Map(rows.map((r) => [String(r.analysis_id), r] as const));
function horseRecs(res: (typeof results)[number]): HorseRec[] {
  const out: HorseRec[] = [];
  for (const [aid, ps] of Object.entries(res.probs)) {
    const row = rowByAid.get(aid)!;
    const ranks = popularityRanks(row.horses.map((h) => ({ umaban: h.umaban, winOdds: h.win_odds })));
    const rh = new Map(row.result.horses.map((h) => [h.umaban, h] as const));
    for (const [u, v] of Object.entries(ps)) {
      const r = rh.get(Number(u));
      if (r === undefined || r.scratched === true || r.finish_position === null) continue; // 取消・除外・中止は対象外
      out.push({ central: row.venue_kind === "central", band: bandOf(ranks.get(Number(u))!), y: r.finish_position <= 3 ? 1 : 0, p: v.p, base: v.base });
    }
  }
  return out;
}
const calib = (hs: HorseRec[], pick: (h: HorseRec) => number): { n: number; exp: number; act: number; ll: number } => ({
  n: hs.length, exp: hs.reduce((a, h) => a + pick(h), 0), act: hs.reduce((a, h) => a + h.y, 0), ll: logLoss(hs.map((h) => ({ p: pick(h), y: h.y }))),
});
const fmtCal = (c: { n: number; exp: number; act: number; ll: number }): string => `${c.n} / ${(c.act / c.exp).toFixed(3)} / ${c.ll.toFixed(4)}`;
const hrecs = results.map((r) => ({ id: r.id, hs: horseRecs(r) }));
for (const [label, f] of [["中央(判定の対象)", (h: HorseRec) => h.central], ["地方(参考。lr・rprior は cur と同じ確率のまま)", (h: HorseRec) => !h.central]] as const) {
  lines.push(`\n### 馬単位の 3着内率の当たり具合: ${label}。各セルは「頭数 / 実際÷見込み / 対数損失」(見込み = 確率の合計、実際 = 3着内の頭数。取消・除外・中止の馬は対象外)\n`);
  lines.push(`| 確率 | 全体 | ${POPULARITY_BANDS.join(" | ")} |`, `|---|---|${POPULARITY_BANDS.map(() => "---").join("|")}|`);
  for (const { id, hs } of hrecs) {
    const sub = hs.filter(f);
    lines.push(`| ${id}(寄せたあと) | ${fmtCal(calib(sub, (h) => h.p))} | ${POPULARITY_BANDS.map((b) => fmtCal(calib(sub.filter((h) => h.band === b), (h) => h.p))).join(" | ")} |`);
  }
  lines.push("| (寄せる前の素の確率) | | | | |");
  for (const { id, hs } of hrecs) {
    if (!["cur", "prior50", "rprior50", "lr50", "lr50r2"].includes(id)) continue;
    const sub = hs.filter(f);
    const nm = ({ cur: "adjusted_prob(LLM の補正後)", prior50: "prior(書き出し・当時)", rprior50: "prior(replay・今のコード)", lr50: "学習モデル(replay の入力)", lr50r2: "学習モデル(書き出しの prior と R2 の寄与)" } as Record<string, string>)[id]!;
    lines.push(`| ${nm} | ${fmtCal(calib(sub, (h) => h.base))} | ${POPULARITY_BANDS.map((b) => fmtCal(calib(sub.filter((h) => h.band === b), (h) => h.base))).join(" | ")} |`);
  }
}

// ===== 決め方の規則(中央だけで判定。全券種の合計) =====
const central = results.map((r) => ({ ...r, races: r.races.filter((x) => x.venue === "central") }));
const base = central[0]!;
const bc = sum(base.races.flatMap((r) => r.recs));
lines.push(`\n### 決め方の規則の適用(中央 ${base.races.length} レースだけ。基準 ${base.id}: 回収率 ${pct(rate(bc))}・見込み/実 ${fmtRatio(bc)})\n`);
lines.push("規則(Issue #662。試算の前に固定): `lr50`・`lr100` のうち、(1) 中央の回収率が cur 以上(点推定)、(2) 中央の |見込み/実 − 1| が cur より小さい(実的中 0 は不可)、を両方満たすものがあれば「段階 2 に進む」。無ければ「進まない」。\n");
lines.push("| 候補 | 回収率 | 見込み/実 | (1) | (2) | 中央前半の回収率差 | 中央後半の回収率差 | 満たす |", "|---|---|---|---|---|---|---|---|");
const qualified: string[] = [];
for (const r of central.slice(1)) {
  const c = sum(r.races.flatMap((x) => x.recs));
  const ok1 = (rate(c) ?? -1) >= (rate(bc) ?? Infinity);
  const rc = ratio(c), rb = ratio(bc);
  const ok2 = rc !== null && rb !== null && Math.abs(rc - 1) < Math.abs(rb - 1);
  const sign = (h: "front" | "back"): string => {
    const x = sum(r.races.filter((q) => q.half === h).flatMap((q) => q.recs)), y = sum(base.races.filter((q) => q.half === h).flatMap((q) => q.recs));
    const d = (rate(x) ?? 0) - (rate(y) ?? 0);
    return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pt`;
  };
  const inRule = r.id === "lr50" || r.id === "lr100";
  if (inRule && ok1 && ok2) qualified.push(r.id);
  lines.push(`| ${r.id}${inRule ? "" : "(参考。規則の対象外)"} | ${pct(rate(c))} | ${fmtRatio(c)} | ${ok1 ? "○" : "×"} | ${ok2 ? "○" : "×"} | ${sign("front")} | ${sign("back")} | ${inRule ? (ok1 && ok2 ? "○" : "×") : "-"} |`);
}
lines.push(`\n規則を満たす候補: ${qualified.length === 0 ? "なし → 段階 2 に進まない" : qualified.join("・") + " → 段階 2 に進む"}。`);
if (unknownBand > 0) lines.push(`\n(人気の帯が決まらなかった買い目: 延べ ${unknownBand} 点)`);
console.log(lines.join("\n"));
