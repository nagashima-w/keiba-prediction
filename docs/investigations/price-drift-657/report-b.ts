/**
 * #657-0b の集計。使い方: pnpm tsx docs/investigations/price-drift-657/report-b.ts <dataset> <r2horses.ndjson> <feat664.ndjson.gz>
 * 計画は plan-0b.md。Markdown を標準出力へ。乱数は固定。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadAllocationDataset } from "../../../scripts/allocation-dataset.js";
import { bandDropFlags, marketTop3Probs, marketWinProbs, weightBand, wilson } from "./drift-b.js";
import { ninkiBand } from "./drift.js";

const [dsFile, r2File, featFile] = process.argv.slice(2) as [string, string, string];
const rows = loadAllocationDataset(dsFile).rows.filter((r) => r.allocation !== null && r.has_odds);
const r2 = new Map<number, Map<number, Record<string, unknown>>>();
for (const l of readFileSync(r2File, "utf8").split("\n").filter(Boolean)) {
  const d = JSON.parse(l) as { analysis_id: number; horses: Array<Record<string, unknown> & { umaban: number }> };
  r2.set(d.analysis_id, new Map(d.horses.map((h) => [h.umaban, h])));
}
const wanted = new Set(rows.map((r) => r.race_id));
const feats = new Map<string, Record<string, number>>();
const FEAT_KEYS = ["noprev", "turf2dirt", "dirt2turf", "rest180", "mid1w", "distUp400", "filly", "age7", "wLight", "wHeavy", "eastInWest", "westInEast", "foreignJC", "foreignJCnoLemaire", "foreignJCnoLD", "gain4"];
for (const l of gunzipSync(readFileSync(featFile)).toString("utf8").split("\n")) {
  if (l === "") continue;
  const o = JSON.parse(l) as Record<string, number | string>;
  if (wanted.has(o["raceId"] as string)) feats.set(`${o["raceId"]}:${o["umaban"]}`, o as unknown as Record<string, number>);
}
const cut = rows.map((r) => r.analyzed_at).sort()[Math.floor(rows.length / 2)]!;

interface H {
  race: number; half: 0 | 1; ninki: number; ratio: number; dropMain: boolean; dropAbs: boolean;
  cat: Record<string, string>; qWin: number; q3: number | null; win: number; top3: number;
}
const hs: H[] = [];
let r2Missing = 0;
rows.forEach((row, ri) => {
  const fin = new Map(row.result.horses.map((h) => [h.umaban, h] as const));
  const ok = row.horses.filter((h) => {
    const f = fin.get(h.umaban);
    return f !== undefined && f.scratched !== true && typeof h.win_odds === "number" && h.win_odds > 0 && typeof f.win_odds === "number" && f.win_odds > 0 && h.ninki !== null;
  });
  if (ok.length === 0) return;
  const qW = marketWinProbs(ok.map((h) => fin.get(h.umaban)!.win_odds!));
  const q3 = marketTop3Probs(qW);
  const info = r2.get(row.analysis_id);
  if (info === undefined) r2Missing++;
  const base = ok.map((h) => ({ ninki: h.ninki!, ratio: fin.get(h.umaban)!.win_odds! / h.win_odds! }));
  ok.forEach((h, i) => {
    const f = fin.get(h.umaban)!;
    const x = info?.get(h.umaban);
    const ft = feats.get(`${row.race_id}:${h.umaban}`);
    const cat: Record<string, string> = { "人気帯": ninkiBand(h.ninki!) };
    if (x !== undefined) {
      cat["性別"] = String(x["sex"]);
      const age = Number(x["age"]); cat["年齢"] = age >= 6 ? "6-" : String(age);
      const k = Number(x["kinryo"]); cat["斤量"] = k <= 54 ? "-54" : k <= 56 ? "55-56" : "57-";
      cat["馬体重"] = weightBand(typeof x["bodyWeight"] === "number" ? (x["bodyWeight"] as number) : null);
      cat[`騎手:${x["jockeyName"]}`] = "1"; cat[`調教師:${x["trainerName"]}`] = "1";
    }
    if (ft !== undefined) for (const k of FEAT_KEYS) if (ft[k] === 1) cat[`特徴:${k}`] = "1";
    hs.push({ race: ri, half: row.analyzed_at < cut ? 0 : 1, ninki: h.ninki!, ratio: base[i]!.ratio, dropMain: false, dropAbs: base[i]!.ratio <= 0.75, cat, qWin: qW[i]!, q3: q3 === null ? null : q3[i]!, win: f.finish_position === 1 ? 1 : 0, top3: f.finish_position !== null && f.finish_position <= 3 ? 1 : 0 });
  });
});

// 主の定義は全レースをまとめた人気帯ごとの下位 10%
bandDropFlags(hs.map((h) => ({ ninki: h.ninki, ratio: h.ratio }))).forEach((f, i) => { hs[i]!.dropMain = f; });

const f3 = (x: number): string => x.toFixed(3);
const pc = (x: number): string => (x * 100).toFixed(1) + "%";
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

type DropKey = "dropMain" | "dropAbs";
const raceCount = Math.max(...hs.map((h) => h.race)) + 1;
function byRace(xs: H[]): H[][] { const m: H[][] = Array.from({ length: raceCount }, () => []); for (const h of xs) m[h.race]!.push(h); return m.filter((a) => a.length > 0); }
function boot(rs: H[][], stat: (xs: H[]) => number): string {
  const rnd = mulberry32(657); const vs: number[] = [];
  for (let b = 0; b < 2000; b++) { const s: H[] = []; for (let i = 0; i < rs.length; i++) s.push(...rs[Math.floor(rnd() * rs.length)]!); const v = stat(s); if (Number.isFinite(v)) vs.push(v); }
  vs.sort((a, b) => a - b);
  return `${f3(vs[Math.floor(vs.length * 0.025)]!)}〜${f3(vs[Math.floor(vs.length * 0.975)]!)}`;
}

function commonality(sel: H[], key: DropKey, label: string, flagOut: Map<string, string>): string[] {
  const out = [`\n#### 共通点(${label}。下がった馬の割合。基準 = 人気帯の構成を揃えた期待の割合)\n`];
  const n = sel.length, d = sel.filter((h) => h[key]).length;
  out.push(`全体: ${n} 頭中 ${d} 頭が下がった(${pc(d / n)})。\n`, "| 区分 | N | 下がった | 割合 (Wilson 95%) | 基準率との関係 |", "|---|---|---|---|---|");
  const bandRate: Record<string, number> = {};
  for (const b of ["1-3", "4-6", "7-"]) { const g = sel.filter((h) => ninkiBand(h.ninki) === b); bandRate[b] = g.filter((h) => h[key]).length / g.length; }
  const cats = new Map<string, Map<string, H[]>>();
  for (const h of sel) for (const [k, v] of Object.entries(h.cat)) {
    const group = k.startsWith("騎手:") ? "騎手" : k.startsWith("調教師:") ? "調教師" : k.startsWith("特徴:") ? k : k;
    const name = group === k ? v : k.split(":")[1]!;
    const m = cats.get(group) ?? new Map(); const a = m.get(name) ?? []; a.push(h); m.set(name, a); cats.set(group, m);
  }
  let tested = 0, outside = 0; const flaggedNames: string[] = [];
  for (const [group, m] of [...cats].sort((a, b) => a[0].localeCompare(b[0]))) {
    const minN = group === "騎手" || group === "調教師" ? 30 : 1;
    for (const [name, xs] of [...m].sort((a, b) => b[1].length - a[1].length)) {
      if (xs.length < minN) continue;
      // 基準率: 人気帯ごとの全体の割合を、その区分の馬の人気帯の構成で平均した期待(人気帯の構成の違いを除く)
      const base = xs.reduce((a, h) => a + bandRate[ninkiBand(h.ninki)]!, 0) / xs.length;
      const x = xs.filter((h) => h[key]).length; const [lo, hi] = wilson(x, xs.length);
      if (group === "人気帯") { out.push(`| 人気帯=${name} | ${xs.length} | ${x} | ${pc(x / xs.length)} | (定義上の基準) |`); continue; }
      tested++; const rel = lo > base ? "高い" : hi < base ? "低い" : "含む";
      if (rel !== "含む") { outside++; flaggedNames.push(`${group}=${name}(${rel})`); flagOut.set(`${group}=${name}`, rel); }
      if (rel !== "含む" || group === "人気帯" || group === "年齢" || group === "性別" || group === "斤量" || group === "馬体重" || group.startsWith("特徴:")) out.push(`| ${group}=${name} | ${xs.length} | ${x} | ${pc(x / xs.length)} (${pc(lo)}〜${pc(hi)}) | 人気帯構成を揃えた期待 ${pc(base)} に対し${rel} |`);
    }
  }
  out.push(`\n検定した区分 ${tested} 個、基準率を区間が外れた区分 ${outside} 個(偶然の期待 ${(tested * 0.05).toFixed(1)} 個)。外れた区分: ${flaggedNames.join("、") || "なし"}`);
  return out;
}
const coveredRaces = new Set(hs.filter((h) => Object.keys(h.cat).some((k) => k.startsWith("特徴:"))).map((h) => h.race));
function covered(h: H): boolean { return coveredRaces.has(h.race); }

function calibration(sel: H[], key: DropKey): string[] {
  const out = ["| 群 | 人気帯 | N 頭 | Σ勝率見込み | 1 着数 | 1 着/見込み (95%) | Σ3着内見込み | 3着内数 | 3着内/見込み (95%) |", "|---|---|---|---|---|---|---|---|---|"];
  for (const [gl, gf] of [["下がった", (h: H) => h[key]], ["それ以外", (h: H) => !h[key]]] as const) {
    for (const bd of ["全体", "1-3", "4-6", "7-"]) {
      const xs = sel.filter((h) => gf(h) && (bd === "全体" || ninkiBand(h.ninki) === bd));
      if (xs.length === 0) continue;
      const rs = byRace(xs);
      const rW = (a: H[]): number => a.reduce((s, h) => s + h.win, 0) / a.reduce((s, h) => s + h.qWin, 0);
      const x3 = xs.filter((h) => h.q3 !== null);
      const r3 = (a: H[]): number => { const b = a.filter((h) => h.q3 !== null); return b.reduce((s, h) => s + h.top3, 0) / b.reduce((s, h) => s + h.q3!, 0); };
      out.push(`| ${gl} | ${bd} | ${xs.length} | ${xs.reduce((s, h) => s + h.qWin, 0).toFixed(1)} | ${xs.reduce((s, h) => s + h.win, 0)} | ${f3(rW(xs))} (${boot(rs, rW)}) | ${x3.reduce((s, h) => s + h.q3!, 0).toFixed(1)} | ${x3.reduce((s, h) => s + h.top3, 0)} | ${f3(r3(xs))} (${boot(rs, r3)}) |`);
    }
  }
  return out;
}

console.log(`# #657-0b 結果(分析日の中央 ${cut})\n馬 ${hs.length} 頭、レース ${new Set(hs.map((h) => h.race)).size}。R2 が読めなかった分析 ${r2Missing} 件、特徴量のあるレース ${coveredRaces.size}。`);
const flagsBy = new Map<string, Map<string, string>>();
for (const key of ["dropMain", "dropAbs"] as DropKey[]) {
  for (const [label, sel] of [["全体", hs], ["前半", hs.filter((h) => h.half === 0)], ["後半", hs.filter((h) => h.half === 1)]] as const) {
    console.log(`\n## ${key === "dropMain" ? "主(人気帯内の下位 10%)" : "副(r ≤ 0.75)"} — ${label}`);
    const fl = new Map<string, string>();
    console.log(commonality(sel, key, label, fl).join("\n"));
    flagsBy.set(`${key}:${label}`, fl);
    console.log("\n#### 来るか\n" + calibration(sel, key).join("\n"));
  }
}

console.log("\n## 前半・後半の両方で、全体と同じ向きに基準を外れた区分(共通点の候補。区間はレースの相関を無視しているので外れる数は多めに出る)");
for (const key of ["dropMain", "dropAbs"]) {
  const a = flagsBy.get(`${key}:全体`)!, b = flagsBy.get(`${key}:前半`)!, c = flagsBy.get(`${key}:後半`)!;
  const both = [...a].filter(([k, v]) => b.get(k) === v && c.get(k) === v).map(([k, v]) => `${k}(${v})`);
  console.log(`- ${key === "dropMain" ? "主" : "副"}: ${both.join("、") || "なし"}`);
}
