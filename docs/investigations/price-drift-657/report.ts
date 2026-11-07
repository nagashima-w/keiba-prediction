/**
 * #657-0 の集計。使い方: pnpm tsx docs/investigations/price-drift-657/report.ts <dataset.ndjson.gz>
 * Markdown の表を標準出力に出す(計画は plan.md)。乱数は固定(mulberry32)。ブートストラップはレース単位 2000 回。
 */
import { loadAllocationDataset, type AllocationRaceRow } from "../../../scripts/allocation-dataset.js";
import { betRecords, horseRatios, ninkiBand, quantile, type BetRecord, type HorseRatio } from "./drift.js";

const file = process.argv[2];
if (file === undefined) throw new Error("dataset を指定");
const all = loadAllocationDataset(file).rows.filter((r) => r.allocation !== null && r.has_odds);
const median = (xs: number[]): number => quantile(xs, 0.5);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** レース単位のブートストラップで統計量の 95% 区間。 */
function boot<T>(units: T[], stat: (us: T[]) => number, seed = 657): string {
  const rnd = mulberry32(seed);
  const vs: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const s: T[] = [];
    for (let i = 0; i < units.length; i++) s.push(units[Math.floor(rnd() * units.length)]!);
    const v = stat(s);
    if (Number.isFinite(v)) vs.push(v);
  }
  vs.sort((a, b) => a - b);
  return `${f2(vs[Math.floor(vs.length * 0.025)]!)}〜${f2(vs[Math.floor(vs.length * 0.975)]!)}`;
}

interface RaceH { hs: HorseRatio[] }
function ratioTable(title: string, races: RaceH[], pick: (h: HorseRatio) => boolean, sel: (h: HorseRatio) => boolean): string[] {
  const filt = (rs: RaceH[], inB: boolean) => rs.flatMap((r) => r.hs.filter((h) => pick(h) && sel(h) === inB).map((h) => h.ratio));
  const a = filt(races, true), b = filt(races, false);
  const diff = (rs: RaceH[]): number => median(filt(rs, true)) - median(filt(rs, false));
  const row = (n: string, xs: number[]) => `| ${n} | ${xs.length} | ${f2(mean(xs))} | ${[0.1, 0.25, 0.5, 0.75, 0.9].map((q) => f2(quantile(xs, q))).join(" | ")} |`;
  return [`\n#### ${title}\n`, "| 区分 | N 頭 | 平均 | p10 | p25 | 中央値 | p75 | p90 |", "|---|---|---|---|---|---|---|---|", row("買い目に入った", a), row("入らなかった", b), `\n中央値の差(入った − 入らなかった)${f2(diff(races))}、95% 区間 ${boot(races, diff)}`];
}

function part1(rows: AllocationRaceRow[], label: string): string[] {
  const races = rows.map((r) => ({ hs: horseRatios(r) }));
  const out: string[] = [`\n### 1. 馬ごとの比(確定 ÷ 分析時点の単勝)— ${label}(${rows.length} レース)`];
  out.push(...ratioTable("全体", races, () => true, (h) => h.types.length > 0));
  for (const band of ["1-3", "4-6", "7-"]) out.push(...ratioTable(`人気 ${band}(分析時点)`, races, (h) => ninkiBand(h.ninki) === band, (h) => h.types.length > 0));
  for (const t of ["win", "place", "wide", "quinella", "trio", "exacta", "trifecta"]) out.push(...ratioTable(`券種 ${t}(その券種の買い目に入った馬 vs 入らなかった馬〈どの券種にも入らない馬〉)`, races.map((r) => ({ hs: r.hs.filter((h) => h.types.includes(t) || h.types.length === 0) })), () => true, (h) => h.types.includes(t)));
  return out;
}

const sumBy = (bs: BetRecord[], f: (b: BetRecord) => number): number => bs.reduce((a, b) => a + f(b), 0);
/** 感度試算に使う e1: 単勝は実測、他は代理。 */
const e1Best = (b: BetRecord): number | null => (b.betType === "win" ? b.e1Measured : b.e1Proxy);

function part3(rows: AllocationRaceRow[], label: string): string[] {
  const per = rows.map((r) => betRecords(r));
  const out: string[] = [`\n### 2・3. 見込みの払戻の分解 — ${label}(${rows.length} レース)\n`, "A = 実際の払戻、E0 = 分析時点のオッズでの見込みの払戻、E1 = 確定オッズでの見込みの払戻(単勝は実測、複勝・組合せは単勝の比の積による感度試算)。E1/E0 がオッズの動きの分、A/E1 が確率の見積もりの分。\n", "| 券種 | 点数 | 賭け金 | A/E0 (95%) | E1/E0 (95%) | A/E1 (95%) |", "|---|---|---|---|---|---|"];
  const groups: Array<[string, (b: BetRecord) => boolean]> = [["全体", () => true], ["単勝(実測)", (b) => b.betType === "win"], ["複勝(感度)", (b) => b.betType === "place"], ["ワイド(感度)", (b) => b.betType === "wide"], ["馬連(感度)", (b) => b.betType === "quinella"], ["三連複(感度)", (b) => b.betType === "trio"], ["馬単(感度)", (b) => b.betType === "exacta"], ["三連単(感度)", (b) => b.betType === "trifecta"], ["枠連", (b) => b.betType === "bracketQuinella"]];
  for (const [name, g] of groups) {
    const races = per.map((bs) => bs.filter((b) => g(b) && e1Best(b) !== null));
    const flat = races.flat();
    if (flat.length === 0) { out.push(`| ${name} | 0 | - | 計算できない | | |`); continue; }
    const st = (rs: BetRecord[][], k: "a0" | "01" | "a1"): number => {
      const bs = rs.flat();
      const A = sumBy(bs, (b) => b.actual), E0 = sumBy(bs, (b) => b.e0), E1 = sumBy(bs, (b) => e1Best(b)!);
      return k === "a0" ? A / E0 : k === "01" ? E1 / E0 : A / E1;
    };
    out.push(`| ${name} | ${flat.length} | ${sumBy(flat, (b) => b.stake)} | ${f2(st(races, "a0"))} (${boot(races, (r) => st(r, "a0"))}) | ${f2(st(races, "01"))} (${boot(races, (r) => st(r, "01"))}) | ${f2(st(races, "a1"))} (${boot(races, (r) => st(r, "a1"))}) |`);
  }
  // 的中側の実測
  out.push("\n的中した買い目だけの確定オッズ ÷ 分析時点のオッズ(実測。選択の偏り: 勝った馬・来た馬の動きに偏る。複勝は分析時点が下限のため払戻との比が下限と実の幅を含む)\n", "| 券種 | 的中数 | 中央値 | 平均 |", "|---|---|---|---|");
  for (const t of ["win", "place", "wide", "quinella", "trio", "exacta", "trifecta", "bracketQuinella"]) {
    const rs = per.flat().filter((b) => b.betType === t && b.hit && b.oddsFinal !== null).map((b) => b.oddsFinal! / b.oddsAnalysis);
    out.push(rs.length === 0 ? `| ${t} | 0 | - | - |` : `| ${t} | ${rs.length} | ${f2(median(rs))} | ${f2(mean(rs))} |`);
  }
  return out;
}

const dates = all.map((r) => r.analyzed_at).sort();
const cut = dates[Math.floor(dates.length / 2)]!;
console.log(`# #657-0 結果(分析日の中央 ${cut} で前半・後半)\n母集団: 配分の記録があり分析時点のオッズがある ${all.length} レース`);
for (const [label, rs] of [["全体", all], ["前半", all.filter((r) => r.analyzed_at < cut)], ["後半", all.filter((r) => r.analyzed_at >= cut)]] as const) {
  console.log(`\n## ${label}`);
  console.log(part1(rs, label).join("\n"));
  console.log(part3(rs, label).join("\n"));
}
