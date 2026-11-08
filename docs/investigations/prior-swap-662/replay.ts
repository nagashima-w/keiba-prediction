/**
 * 1 つの候補で全レースを計算し直し、買い目と馬ごとの 3着内率を JSON に書く(Issue #662 段階 1)。#661 の replay.ts を土台にした。
 * 使い方: pnpm tsx replay.ts <dataset> <replay.ndjson.gz> <coef.json> <contrib-r2.ndjson> <outDir> <id>
 *   coef.json は fit_pre_holdout.py の出力(保留を捨てて学び直したオッズなし版の係数)。
 * 出力: <outDir>/<id>.json(分析 ID → 買い目)・<id>.meta.json(rows・nullRaces・fallback〈学習モデル/今のコードの prior が使えず cur と同じ元の確率にした行〉)・
 *       <id>.probs.json(分析 ID → 馬番 → {base: 寄せる前の確率, p: 寄せたあと〈配分に渡した確率〉})。
 *
 * 候補(結果を見る前に固定。Issue #662):
 *   cur       今の本番。LLM の補正後(adjusted_prob)を 0.5 寄せ。
 *   prior50/100  本番の書き出しの prior(当時のコードで作った値)を 0.5 寄せ/寄せない。
 *   rprior50/100 replay の prior(今のコードで作り直した値。中央だけ。地方は cur と同じ)。
 *   lr50/lr100   学習モデル(オッズなし版。replay の prior と寄与から。中央だけ。地方は cur と同じ)を 0.5 寄せ/寄せない。
 *   lr50r2       参考: 学習モデルへの入力を本番の書き出しの prior と R2 の寄与(当時のコードの寄与)にしたもの。
 * 学習は中央だけなので、地方のレースはどの lr 系・rprior 系でも cur と同じ確率のまま(prior50/100 は書き出しの prior があるので地方にも当てる)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadAllocationDataset, replayableRows, replayedBets, type ReplayOverrides } from "../../../scripts/allocation-dataset.js";
import { shrinkTowardMarket } from "../../../packages/core/src/ev/market-shrink.js";
import type { ShadowModelCoef } from "../../../packages/core/src/ev/stat-shadow-coef.js";
import { contribRecordFromArray, lrTop3, type LrHorse } from "./lr.js";

export type BaseKind = "adjusted" | "prior" | "rprior" | "lr" | "lrR2";
export const CANDIDATES: Record<string, { readonly base: BaseKind; readonly w: number }> = {
  cur: { base: "adjusted", w: 0.5 },
  prior50: { base: "prior", w: 0.5 },
  prior100: { base: "prior", w: 1 },
  rprior50: { base: "rprior", w: 0.5 },
  rprior100: { base: "rprior", w: 1 },
  lr50: { base: "lr", w: 0.5 },
  lr100: { base: "lr", w: 1 },
  lr50r2: { base: "lrR2", w: 0.5 },
};

interface ReplayHorse { prior: number; contrib: Record<string, number> }

/** replay.ndjson.gz から、指定したレースだけを race_id → 馬番 → {prior, contrib} にする。 */
function loadReplayHorses(file: string, raceIds: ReadonlySet<string>): Map<string, Map<number, ReplayHorse>> {
  const out = new Map<string, Map<number, ReplayHorse>>();
  for (const line of gunzipSync(readFileSync(file)).toString("utf8").split("\n")) {
    if (line === "") continue;
    const d = JSON.parse(line) as { raceId: string; umaban: number; prior: number; contrib: Record<string, number> };
    if (!raceIds.has(d.raceId)) continue;
    let m = out.get(d.raceId);
    if (m === undefined) out.set(d.raceId, (m = new Map()));
    m.set(d.umaban, { prior: d.prior, contrib: d.contrib });
  }
  return out;
}

if (process.argv[1]?.endsWith("replay.ts")) {
  const [file, replayFile, coefFile, r2File, outDir, id] = process.argv.slice(2) as [string, string, string, string, string, string];
  const cand = CANDIDATES[id];
  if (cand === undefined) throw new Error(`未知の候補: ${id}`);
  const coef = JSON.parse(readFileSync(coefFile, "utf8")) as ShadowModelCoef;
  const rows = replayableRows(loadAllocationDataset(file).rows);
  const rep = loadReplayHorses(replayFile, new Set(rows.map((r) => r.race_id)));
  const r2 = new Map<number, Record<string, Array<{ biasName: string; correction: number }>>>();
  for (const line of readFileSync(r2File, "utf8").split("\n")) {
    if (line === "") continue;
    const d = JSON.parse(line) as { analysis_id: number; contributions: Record<string, Array<{ biasName: string; correction: number }>> };
    r2.set(d.analysis_id, d.contributions);
  }
  const bets: Record<string, unknown> = {};
  const probs: Record<string, Record<string, { base: number; p: number }>> = {};
  const nullRaces: number[] = [];
  const fallbackRaces: number[] = [];
  const fallbackHorses: Array<[number, number]> = [];
  for (const row of rows) {
    // 寄せる前の確率(馬番 → base)。cur と同じ元の確率(adjusted_prob)で始め、候補の種類に応じて差し替える。
    const base = new Map(row.horses.map((h) => [h.umaban, h.adjusted_prob] as const));
    const central = row.venue_kind === "central";
    const replaced = new Set<number>(); // 差し替えられた馬(中央で cur 以外・prior 以外の候補のとき、残りは adjusted_prob のまま = 取消の馬など)
    if (cand.base === "prior") {
      for (const h of row.horses) base.set(h.umaban, h.prior);
    } else if (central) {
      const rh = rep.get(row.race_id);
      let lrIn: LrHorse[] | null = null;
      if (cand.base === "rprior" || cand.base === "lr") {
        if (rh === undefined) { fallbackRaces.push(row.analysis_id); } else {
          if (cand.base === "rprior") { for (const [u, h] of rh) if (base.has(u)) { base.set(u, h.prior); replaced.add(u); } }
          else lrIn = [...rh].map(([umaban, h]) => ({ umaban, prior: h.prior, contrib: h.contrib }));
        }
      } else if (cand.base === "lrR2") {
        const c = r2.get(row.analysis_id);
        if (c === undefined || rh === undefined) { fallbackRaces.push(row.analysis_id); } else {
          // 学習の頭数は replay に載る(取消を除く)馬。書き出しの馬のうち replay に無い馬は入力から外す(本番と同じ)。
          lrIn = row.horses.filter((h) => rh.has(h.umaban)).map((h) => ({ umaban: h.umaban, prior: h.prior, contrib: contribRecordFromArray(c[String(h.umaban)] ?? []) }));
        }
      }
      if (lrIn !== null) {
        const t = lrTop3(lrIn, coef);
        if (t === null) fallbackRaces.push(row.analysis_id);
        else for (const [u, p] of t) { base.set(u, p); replaced.add(u); }
      }
      for (const h of row.horses) if (cand.base !== "adjusted" && !replaced.has(h.umaban)) fallbackHorses.push([row.analysis_id, h.umaban]);
    }
    const horsesIn = row.horses.map((h) => ({ umaban: h.umaban, p: base.get(h.umaban)!, winOdds: h.win_odds }));
    const mixed = cand.w < 1 ? shrinkTowardMarket(horsesIn, cand.w) : new Map(horsesIn.map((h) => [h.umaban, h.p] as const));
    probs[String(row.analysis_id)] = Object.fromEntries(horsesIn.map((h) => [String(h.umaban), { base: h.p, p: mixed.get(h.umaban)! }]));
    const overrides: ReplayOverrides = { adjustProb: (h) => mixed.get(h.umaban)! };
    const b = replayedBets(row, overrides);
    bets[String(row.analysis_id)] = b;
    if (b === null) nullRaces.push(row.analysis_id);
  }
  writeFileSync(`${outDir}/${id}.json`, JSON.stringify(bets));
  writeFileSync(`${outDir}/${id}.probs.json`, JSON.stringify(probs));
  writeFileSync(`${outDir}/${id}.meta.json`, JSON.stringify({ rows: rows.length, nullRaces, fallbackRaces, fallbackHorses }));
  console.log(id, rows.length, "races done; null", nullRaces.length, "fallback races", fallbackRaces.length, "fallback central horses", fallbackHorses.length);
}
