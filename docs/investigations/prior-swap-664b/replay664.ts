/**
 * 1 つの候補で全レースを計算し直し、買い目と馬ごとの 3着内率を JSON に書く(Issue #664 段階 1b)。#662 の replay.ts と同じ作りで、候補に #664 の学習モデルを足した。
 * 使い方: pnpm tsx replay664.ts <dataset> <replay.ndjson.gz> <coef662.json> <coef664.json> <feat664.ndjson.gz> <extras.ndjson.gz> <outDir> <id>
 * 出力: <outDir>/<id>.json・<id>.meta.json・<id>.probs.json(#662 の report.ts がそのまま読める形)。
 *
 * 候補(結果を見る前に固定。Issue #664 のコメント):
 *   cur        今の本番。LLM の補正後(adjusted_prob)を 0.5 寄せ。
 *   lr50/lr100 #662 の学習モデル(足す前)を 0.5 寄せ/寄せない。
 *   lr664_50/lr664_100 #664 の学習モデル(足した後。旗 14 + 見習の印 5 を足したオッズなし版)を 0.5 寄せ/寄せない。
 * 学習は中央だけなので、地方のレースはどの候補でも cur と同じ確率のまま。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadAllocationDataset, replayableRows, replayedBets, type ReplayOverrides } from "../../../scripts/allocation-dataset.js";
import { shrinkTowardMarket } from "../../../packages/core/src/ev/market-shrink.js";
import type { ShadowModelCoef } from "../../../packages/core/src/ev/stat-shadow-coef.js";
import { lrTop3, type LrHorse } from "../prior-swap-662/lr.js";
import { buildExtra, lr664Top3, type Lr664Horse } from "./lr664.js";

export const CANDIDATES: Record<string, { readonly model: "adjusted" | "lr" | "lr664"; readonly w: number }> = {
  cur: { model: "adjusted", w: 0.5 },
  lr50: { model: "lr", w: 0.5 },
  lr100: { model: "lr", w: 1 },
  lr664_50: { model: "lr664", w: 0.5 },
  lr664_100: { model: "lr664", w: 1 },
};

interface ReplayHorse { prior: number; contrib: Record<string, number> }
function readLines(file: string): string[] {
  return gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter((l) => l !== "");
}

if (process.argv[1]?.endsWith("replay664.ts")) {
  const [file, replayFile, coef662File, coef664File, featFile, extrasFile, outDir, id] = process.argv.slice(2) as [string, string, string, string, string, string, string, string];
  const cand = CANDIDATES[id];
  if (cand === undefined) throw new Error(`未知の候補: ${id}`);
  const coef = JSON.parse(readFileSync(cand.model === "lr664" ? coef664File : coef662File, "utf8")) as ShadowModelCoef;
  const rows = replayableRows(loadAllocationDataset(file).rows);
  const raceIds = new Set(rows.map((r) => r.race_id));
  const rep = new Map<string, Map<number, ReplayHorse>>();
  for (const line of readLines(replayFile)) {
    const d = JSON.parse(line) as { raceId: string; umaban: number; prior: number; contrib: Record<string, number> };
    if (!raceIds.has(d.raceId)) continue;
    let m = rep.get(d.raceId);
    if (m === undefined) rep.set(d.raceId, (m = new Map()));
    m.set(d.umaban, { prior: d.prior, contrib: d.contrib });
  }
  const feat = new Map<string, Record<string, number>>();
  const marks = new Map<string, string | null>();
  if (cand.model === "lr664") {
    for (const line of readLines(featFile)) { const d = JSON.parse(line) as Record<string, number> & { raceId: string; umaban: number }; if (raceIds.has(d.raceId)) feat.set(`${d.raceId}/${d.umaban}`, d); }
    for (const line of readLines(extrasFile)) { const d = JSON.parse(line) as { raceId: string; umaban: number; mark: string | null }; if (raceIds.has(d.raceId)) marks.set(`${d.raceId}/${d.umaban}`, d.mark ?? null); }
  }
  const bets: Record<string, unknown> = {};
  const probs: Record<string, Record<string, { base: number; p: number }>> = {};
  const nullRaces: number[] = [];
  const fallbackRaces: number[] = [];
  const fallbackHorses: Array<[number, number]> = [];
  let noFeatHorses = 0; // 特徴量の行が無く、既定値(noprev=1・ほかは 0)で補った馬の数
  for (const row of rows) {
    const base = new Map(row.horses.map((h) => [h.umaban, h.adjusted_prob] as const));
    const replaced = new Set<number>();
    if (cand.model !== "adjusted" && row.venue_kind === "central") {
      const rh = rep.get(row.race_id);
      if (rh === undefined) fallbackRaces.push(row.analysis_id);
      else {
        let t: Map<number, number> | null;
        if (cand.model === "lr") t = lrTop3([...rh].map(([umaban, h]): LrHorse => ({ umaban, prior: h.prior, contrib: h.contrib })), coef);
        else {
          const input = [...rh].map(([umaban, h]): Lr664Horse => {
            const k = `${row.race_id}/${umaban}`;
            const fr = feat.get(k);
            if (fr === undefined) noFeatHorses++;
            return { umaban, prior: h.prior, contrib: h.contrib, extra: buildExtra(fr, marks.get(k) ?? null) };
          });
          t = lr664Top3(input, coef);
        }
        if (t === null) fallbackRaces.push(row.analysis_id);
        else for (const [u, p] of t) { base.set(u, p); replaced.add(u); }
      }
      for (const h of row.horses) if (!replaced.has(h.umaban)) fallbackHorses.push([row.analysis_id, h.umaban]);
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
  console.log(id, rows.length, "races done; null", nullRaces.length, "fallback races", fallbackRaces.length, "fallback central horses", fallbackHorses.length, "no-feature horses", noFeatHorses);
}
