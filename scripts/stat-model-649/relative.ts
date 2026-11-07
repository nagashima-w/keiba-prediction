/**
 * #652: 主な項目を、そのレースの中での相対値(平均との差・1 番手との差・順位 0〜1)にした特徴量を作る。
 * 項目: prior(ロジット)・タイム指数・近走着順・騎手成績(いずれも寄与=補正値)・騎手の市場比の指標・斤量。
 * 入力は replay.ts と extras.ts の出力。レースの全頭(走った馬)で相対値を取る。
 *
 * 使い方: pnpm tsx scripts/stat-model-649/relative.ts <replay.ndjson.gz> <extras.ndjson.gz> <出力.ndjson.gz>
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { logit, relativeStats } from "./lib.js";

interface ReplayRow {
  raceId: string;
  umaban: number;
  prior: number;
  contrib: Record<string, number>;
}
interface ExtraRow {
  raceId: string;
  umaban: number;
  jEdge: number;
  burden: number | null;
}

async function readAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const line of createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (line.trim() !== "") out.push(JSON.parse(line) as T);
  }
  return out;
}

async function main(): Promise<void> {
  const [replayPath, extraPath, outPath] = process.argv.slice(2);
  if (replayPath === undefined || extraPath === undefined || outPath === undefined) throw new Error("使い方: relative.ts <replay> <extras> <出力>");
  const replay = await readAll<ReplayRow>(replayPath);
  const extras = new Map((await readAll<ExtraRow>(extraPath)).map((e) => [`${e.raceId}|${e.umaban}`, e]));
  const races = new Map<string, ReplayRow[]>();
  for (const r of replay) {
    const l = races.get(r.raceId) ?? [];
    l.push(r);
    races.set(r.raceId, l);
  }
  const items: Array<[string, (r: ReplayRow, e: ExtraRow | undefined) => number]> = [
    ["prior", (r) => logit(Math.min(1 - 1e-4, Math.max(1e-4, r.prior)))],
    ["timeIndex", (r) => r.contrib["タイム指数"] ?? 0],
    ["recentForm", (r) => r.contrib["近走着順"] ?? 0],
    ["jockey", (r) => r.contrib["騎手成績"] ?? 0],
    ["jEdge", (_, e) => e?.jEdge ?? 0],
    ["burden", (_, e) => e?.burden ?? 55],
  ];
  const gz = createGzip();
  gz.pipe(createWriteStream(outPath));
  let rows = 0;
  for (const [raceId, rs] of races) {
    const rel = items.map(([, f]) => relativeStats(rs.map((r) => f(r, extras.get(`${r.raceId}|${r.umaban}`)))));
    rs.forEach((r, i) => {
      const o: Record<string, number | string> = { raceId, umaban: r.umaban };
      items.forEach(([name], k) => {
        o[`rel_${name}_mean`] = rel[k]![i]!.diffMean;
        o[`rel_${name}_top`] = rel[k]![i]!.diffTop;
        o[`rel_${name}_rank`] = rel[k]![i]!.rank;
      });
      gz.write(`${JSON.stringify(o)}\n`);
      rows += 1;
    });
  }
  await new Promise<void>((resolve) => gz.end(resolve));
  process.stderr.write(`レース ${races.size}・出力 ${rows} 行\n`);
}

void main();
