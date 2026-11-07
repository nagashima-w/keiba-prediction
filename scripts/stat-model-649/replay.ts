/**
 * #649 段階 1: 過去のレースに、**本番と同じ関数**で統計モデルの prior を当て直して、特徴量の表を作る。
 *
 * 入力: 過去の結果ページのレコード(`RaceRecord` の NDJSON を gzip したもの。`scripts/history-results/` の出力。リポジトリに入れない)。
 * 出力: 1 頭 1 行の NDJSON(gzip)。prior・15 項目の寄与・確定オッズ・着順・prior を Plackett–Luce で換算した勝率と 2着内率。
 *
 * 先読みの防ぎ方:
 *  - 各馬の戦績は、過去のレコードを本番と同じ `raceRecordToRuns` で戦績の形にし、本番と同じ `filterRaceDataBefore`・`excludeOwnRaceResults` で
 *    レース日より前の走だけにする。
 *  - 騎手(窓: 前年+当年、当年は**レース日より前の騎乗だけ**)・調教師(窓: 前々年+前年)の年別成績は、手元の過去のレコードの騎乗を `RideIndex` で
 *    レース日より前だけ集計して作る(本番は netkeiba のページの年別成績)。手元の記録は 2024-08 から。窓の古い年は欠ける。
 *  - タイム指数の基準(`STANDARD_TIME_TABLE`)は本番が埋め込んでいる表のまま(2018〜2026-10 の走から作った中央値)。評価のレースの走が含まれる(中央値なので影響は小さいはずだが、
 *    取り除いてはいない)。
 *
 * 使い方: pnpm tsx scripts/stat-model-649/replay.ts <入力.ndjson.gz> <出力.ndjson.gz>
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { DEFAULT_CLOUD_SETTINGS } from "../../cloud/src/settings.js";
import { buildCloudScorerConfig } from "../../cloud/src/scorer-config.js";
import { aggregateTopFinishProbabilities, aggregateWinProbabilities } from "../../packages/core/src/ev/win-odds-estimate.js";
import { PLACKETT_LUCE_MODEL } from "../../packages/core/src/ev/plackett-luce-model.js";
import { classifyTrackWetness } from "../../packages/core/src/scorer/derive-features.js";
import { selectJockeyStats } from "../../packages/core/src/scorer/jockey-stats.js";
import { buildPriorInput, computeFieldPriors } from "../../packages/core/src/scorer/prior.js";
import { excludeOwnRaceResults, filterRaceDataBefore } from "../../packages/core/src/scorer/snapshot-filter.js";
import { selectTrainerStats } from "../../packages/core/src/scorer/trainer-stats.js";
import { raceRecordToRuns } from "../../packages/core/src/scraper/race-record-to-runs.js";
import type { RaceRecord, RecordHorse } from "../../packages/core/src/scraper/race-record.js";
import type { RaceData } from "../../packages/core/src/index.js";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types.js";
import { RideIndex } from "./lib.js";

const config = buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS);

/** 走った馬(取消・除外を除く。中止・失格は走っている)。 */
const ran = (h: RecordHorse): boolean => h.finishStatus !== "取消" && h.finishStatus !== "除外";

async function readRecords(path: string): Promise<RaceRecord[]> {
  const out: RaceRecord[] = [];
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() !== "") out.push(JSON.parse(line) as RaceRecord);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.raceId < b.raceId ? -1 : 1));
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (inPath === undefined || outPath === undefined) {
    throw new Error("使い方: replay.ts <入力.ndjson.gz> <出力.ndjson.gz>");
  }
  const records = await readRecords(inPath);

  // 馬ごとの戦績(新しい順)と、騎手・調教師の騎乗の索引。
  const runsByHorse = new Map<string, HorseRaceResult[]>();
  const jockeys = new RideIndex();
  const trainers = new RideIndex();
  let convertFailed = 0;
  for (const rec of records) {
    const conv = raceRecordToRuns(rec);
    if (!conv.ok) {
      convertFailed += 1;
    } else {
      for (const r of conv.runs) {
        const list = runsByHorse.get(r.horseId) ?? [];
        list.push(r.run);
        runsByHorse.set(r.horseId, list);
      }
    }
    for (const h of rec.horses) {
      if (!ran(h)) continue;
      const placed = h.finish !== null && h.finish <= 3;
      if (h.jockeyId !== null) jockeys.add(h.jockeyId, rec.date, placed);
      if (h.trainerId !== null) trainers.add(h.trainerId, rec.date, placed);
    }
  }
  jockeys.finalize();
  trainers.finalize();
  for (const list of runsByHorse.values()) {
    list.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1));
  }

  const gz = createGzip();
  gz.pipe(createWriteStream(outPath));
  let rows = 0;
  let skipped = 0;
  let plNull = 0;
  for (const rec of records) {
    const horses = rec.horses.filter(ran);
    if (horses.length < 2 || horses.some((h) => h.horseId === null)) {
      skipped += 1;
      continue;
    }
    const dateSlash = rec.date.replace(/-/g, "/");
    const year = Number(rec.date.slice(0, 4));
    const now = new Date(`${rec.date}T12:00:00+09:00`);
    const courseType = rec.courseType;
    const isWet = classifyTrackWetness(rec.going ?? null, courseType)?.isWet ?? false;

    const shutuba = horses.map((h) => ({
      wakuban: h.wakuban ?? 1,
      umaban: h.umaban,
      name: h.horseName,
      horseId: h.horseId as never,
      sex: h.sex ?? "牡",
      age: h.age ?? 3,
      kinryo: h.burden ?? 55,
      jockeyName: h.jockeyName ?? "",
      jockeyId: h.jockeyId,
      stableLocation: h.trainerArea ?? "美浦",
      trainerName: h.trainerName ?? "",
      trainerId: h.trainerId,
      bodyWeight: null,
    }));
    // 本番と同じ先読みの遮断(レース日より前の走だけ。自分自身の走も除く)。
    const raceData = {
      horses: shutuba.map((s) => ({ shutuba: s, results: runsByHorse.get(s.horseId as string) ?? [] })),
    } as unknown as RaceData;
    const cut = excludeOwnRaceResults(filterRaceDataBefore(raceData, dateSlash).raceData, rec.raceId as never).raceData;

    let priors;
    try {
      const inputs = cut.horses.map((hd, i) => {
        const h = horses[i]!;
        const jr = h.jockeyId === null ? undefined : jockeys.records(h.jockeyId, rec.date, [year - 1, year]);
        const tr = h.trainerId === null ? undefined : trainers.records(h.trainerId, rec.date, [year - 2, year - 1]);
        return buildPriorInput({
          horse: hd.shutuba,
          raceResults: hd.results ?? [],
          race: {
            courseType: courseType as never,
            distance: rec.distance as number,
            venueName: rec.venueName ?? "",
            isWet,
            date: dateSlash,
            venueKind: "central",
          },
          fieldSize: horses.length,
          jockeyCourseStats: selectJockeyStats(jr, dateSlash, now),
          trainerStats: selectTrainerStats(tr, dateSlash),
          config,
        });
      });
      priors = computeFieldPriors(inputs);
    } catch (e) {
      skipped += 1;
      process.stderr.write(`skip ${rec.raceId}: ${(e as Error).message}\n`);
      continue;
    }

    // 現行のやり方: 3着内率(prior)を Plackett–Luce で換算した勝率・2着内率(本番と同じ関数)。
    let plWin: Map<number, number> | null = null;
    let plTop2: Map<number, number> | null = null;
    try {
      const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(
        horses.map((h, i) => ({ umaban: h.umaban, placeProb: priors[i]!.prior })),
        3,
      );
      if (ordered !== null) {
        plWin = aggregateWinProbabilities(ordered);
        plTop2 = aggregateTopFinishProbabilities(ordered, 2);
      }
    } catch {
      plWin = null;
    }
    if (plWin === null) plNull += 1;

    horses.forEach((h, i) => {
      const p = priors[i]!;
      const contrib: Record<string, number> = {};
      for (const c of p.contributions) contrib[c.biasName] = c.correction;
      const line = {
        raceId: rec.raceId,
        date: rec.date,
        n: horses.length,
        umaban: h.umaban,
        finish: h.finish,
        status: h.finishStatus,
        winOdds: h.winOdds,
        ninki: h.ninki,
        courseType: rec.courseType,
        prior: p.prior,
        rawPrior: p.rawPrior,
        histLen: (cut.horses[i]!.results ?? []).length,
        contrib,
        plWin: plWin?.get(h.umaban) ?? null,
        plTop2: plTop2?.get(h.umaban) ?? null,
      };
      gz.write(`${JSON.stringify(line)}\n`);
      rows += 1;
    });
  }
  await new Promise<void>((resolve) => gz.end(resolve));
  process.stderr.write(`レース ${records.length}・変換に失敗 ${convertFailed}・飛ばした ${skipped}・PL 換算できず ${plNull}・出力 ${rows} 行\n`);
}

void main();
