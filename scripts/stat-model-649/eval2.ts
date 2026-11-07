/**
 * #652: `fit2.py` の scores.csv を評価する(材料ごとの効き・レース単位のモデル・ハンデ戦)。
 *
 * 使い方: pnpm tsx scripts/stat-model-649/eval2.ts <scores.csv> [出力.json]
 *
 * 列の種類:
 *  - `<モデル>_<目的>`(ログオッズ。目的 = win / top2 / top3): レース内で合計 1・2・3 になるロジットシフトで確率にする。
 *  - `p_<モデル>_win`(確率。レース単位で学習したモデルの、レース内のソフトマックス): そのまま使う。
 * どの確率も評価の前に [1e-6, 1−1e-6] に切る(#649 の保留の XGBoost の NaN は、CRLF のため最後の列名が一致せず列が読めなかったのが原因。`splitCsvLines`)。
 * 比べるのは (ii) 市場だけ(`market`)との対数損失の差(レース単位ブートストラップ 1,000 回・シード固定の 95% 区間)。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { clampProbs, logLoss, normalizeLogitShift, pairedRaceBootstrap, splitCsvLines } from "./lib.js";

type Obj = "win" | "top2" | "top3";
const OBJS: Obj[] = ["win", "top2", "top3"];
const TARGET: Record<Obj, number> = { win: 1, top2: 2, top3: 3 };

interface Row {
  raceId: string;
  hcap: number;
  y: Record<Obj, number>;
  cols: Record<string, number>;
}

function readScores(path: string): { rows: Row[]; scoreModels: string[]; probModels: string[] } {
  const lines = splitCsvLines(readFileSync(path, "utf8"));
  const head = lines[0]!;
  const scoreCols = head.filter((h) => /^(?!p_).+_(win|top2|top3)$/.test(h) && !/^y_/.test(h) && h !== "plWin" && h !== "plTop2");
  const probCols = head.filter((h) => /^p_.+_win$/.test(h));
  const idx = (n: string): number => {
    const i = head.indexOf(n);
    if (i < 0) throw new Error(`列がありません: ${n}`);
    return i;
  };
  const rows = lines.slice(1).map((f) => {
    const cols: Record<string, number> = {};
    for (const c of [...scoreCols, ...probCols]) cols[c] = Number(f[idx(c)]);
    return {
      raceId: f[idx("raceId")]!,
      hcap: Number(f[idx("hcap")]),
      y: { win: Number(f[idx("y_win")]), top2: Number(f[idx("y_top2")]), top3: Number(f[idx("y_top3")]) },
      cols,
    };
  });
  const models = [...new Set(scoreCols.map((c) => c.replace(/_(win|top2|top3)$/, "")))];
  const probModels = probCols.map((c) => c.replace(/^p_/, "").replace(/_win$/, ""));
  return { rows, scoreModels: models, probModels };
}

const f4 = (x: number): string => x.toFixed(4);

function main(): void {
  const [csv, jsonOut] = process.argv.slice(2);
  if (csv === undefined) throw new Error("使い方: eval2.ts <scores.csv> [出力.json]");
  const { rows, scoreModels, probModels } = readScores(csv);
  const racesMap = new Map<string, Row[]>();
  for (const r of rows) {
    const l = racesMap.get(r.raceId) ?? [];
    l.push(r);
    racesMap.set(r.raceId, l);
  }
  const races = [...racesMap.values()];
  const hcapRace = races.map((rs) => rs[0]!.hcap === 1);
  console.log(`試験(2025-08〜2026-07・保留は使わない): レース ${races.length}(うちハンデ戦 ${hcapRace.filter(Boolean).length})  馬 ${rows.length}`);

  const cache = new Map<string, number[][]>();
  const probs = (name: string, obj: Obj): number[][] => {
    const key = `${name}|${obj}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = races.map((rs) => {
        if (name.startsWith("P:")) return clampProbs(rs.map((r) => r.cols[`p_${name.slice(2)}_win`]!));
        return clampProbs(normalizeLogitShift(rs.map((r) => r.cols[`${name}_${obj}`]!), TARGET[obj]));
      });
      cache.set(key, v);
    }
    return v;
  };
  const ys = (obj: Obj): number[][] => races.map((rs) => rs.map((r) => r.y[obj]));

  /** A − B の頭あたり対数損失の差とブートストラップ区間。subset = 使うレースの印。 */
  const diff = (a: string, b: string, obj: Obj, subset?: boolean[]): { mean: number; lo: number; hi: number; races: number } => {
    const pa = probs(a, obj);
    const pb = probs(b, obj);
    const y = ys(obj);
    const pairs = races
      .map((_, i) => ({ a: pa[i]!.length * logLoss(pa[i]!, y[i]!), b: pb[i]!.length * logLoss(pb[i]!, y[i]!), n: pa[i]!.length, keep: subset === undefined || subset[i]! }))
      .filter((p) => p.keep);
    const bs = pairedRaceBootstrap(pairs, 1000, 652);
    return { mean: bs.meanDiff, lo: bs.ciLow, hi: bs.ciHigh, races: pairs.length };
  };
  const fmt = (d: { mean: number; lo: number; hi: number }): string => `${d.mean >= 0 ? "+" : ""}${f4(d.mean)} [${f4(d.lo)}, ${f4(d.hi)}]`;
  const ll = (name: string, obj: Obj): number => logLoss(probs(name, obj).flat(), ys(obj).flat());
  const report: Record<string, unknown> = {};

  // 1. 全モデル(対数損失と (ii) との差)
  for (const o of OBJS) {
    console.log(`\n## 目的: ${o}(全モデル。差は A − (ii)。負なら市場より良い)`);
    console.log("| モデル | 対数損失 | (ii) 市場だけとの差 |");
    console.log("|---|---|---|");
    const list = [...scoreModels, ...(o === "win" ? probModels.map((m) => `P:${m}`) : [])];
    for (const m of list) {
      const d = m === "market" ? null : diff(m, "market", o);
      console.log(`| ${m} | ${f4(ll(m, o))} | ${d === null ? "—" : fmt(d)} |`);
      (report[`ll_${m}_${o}`] as unknown) = ll(m, o);
      if (d !== null) (report[`dMkt_${m}_${o}`] as unknown) = d;
    }
  }

  // 2. 材料ごとの効き: (iii)−(ii) の足す前後、(iii+g)−(iii)
  const groups = ["jedge", "tedge", "bd", "wt", "mark", "sexage", "rel", "all", "allrel"];
  for (const o of OBJS) {
    console.log(`\n## 材料ごとの効き(${o})。(iii) = lr_odds`);
    console.log("| 材料 | (iii+材料)−(ii) | (iii+材料)−(iii) | (iv+材料: オッズなし)−(ii) | (iv+材料)−(iv) |");
    console.log("|---|---|---|---|---|");
    console.log(`| (足す前) | ${fmt(diff("lr_odds", "market", o))} | — | ${fmt(diff("lr_noodds", "market", o))} | — |`);
    for (const g of groups) {
      const odds = `lr_odds_${g}`;
      const no = `lr_noodds_${g}`;
      if (!scoreModels.includes(odds)) continue;
      const noCell = scoreModels.includes(no) ? fmt(diff(no, "market", o)) : "—";
      const noCell2 = scoreModels.includes(no) ? fmt(diff(no, "lr_noodds", o)) : "—";
      console.log(`| ${g} | ${fmt(diff(odds, "market", o))} | ${fmt(diff(odds, "lr_odds", o))} | ${noCell} | ${noCell2} |`);
    }
  }

  // 3. ハンデ戦とそれ以外
  const nonHcap = hcapRace.map((h) => !h);
  for (const o of OBJS) {
    console.log(`\n## ハンデ戦とそれ以外(${o}): 差は A − (ii)`);
    console.log("| モデル | ハンデ戦 | ハンデ戦以外 |");
    console.log("|---|---|---|");
    for (const m of ["lr_odds", "lr_odds_bd", "lr_odds_wt", "lr_odds_all", "lr_odds_allrel", "lr_noodds", "lr_noodds_all"]) {
      if (!scoreModels.includes(m)) continue;
      console.log(`| ${m} | ${fmt(diff(m, "market", o, hcapRace))} (${hcapRace.filter(Boolean).length} レース) | ${fmt(diff(m, "market", o, nonHcap))} |`);
    }
  }

  // 4. レース単位のモデル(勝率)と、同じ入力のレース内の別形
  console.log("\n## レース単位で学習するモデル(勝率だけ)。差は A − (ii)、B − 同じ入力の LR");
  console.log("| モデル | 対数損失 | (ii) との差 | lr_odds_allrel(または lr_noodds_allrel)との差 |");
  console.log("|---|---|---|---|");
  for (const m of probModels) {
    const ref = m.includes("noodds") ? "lr_noodds_allrel" : m.includes("base") ? "lr_odds" : "lr_odds_allrel";
    console.log(`| ${m} | ${f4(ll(`P:${m}`, "win"))} | ${fmt(diff(`P:${m}`, "market", "win"))} | ${fmt(diff(`P:${m}`, ref, "win"))}(対 ${ref}) |`);
  }
  if (jsonOut !== undefined) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
}

main();
