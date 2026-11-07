/**
 * #653: 過去のレース記録から、条件の 0/1/対象外の表(1 頭 1 行)とレース単位の表を作る。
 * 入力: hist.ndjson.gz(RaceRecord)・horse_runs.csv(馬ごとの戦績。1 行 1 走)・extras.ndjson.gz(#652。騎手の指標など)。リポジトリに入れない。
 * 出力: horses.ndjson.gz・races.ndjson.gz。
 *
 * 使い方: pnpm tsx scripts/market-blindspots-653/build.ts <hist.ndjson.gz> <horse_runs.csv> <extras.ndjson.gz> <出力ディレクトリ>
 */
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import type { RaceRecord, RecordHorse } from "../../packages/core/src/scraper/race-record.js";
import { marketShares } from "../stat-model-649/lib.js";
import { CONDITION_IDS, classFromName, evaluateConditions, styleAverage, type HorseContext, type PrevRun } from "./conditions.js";
import { computeTrends, distanceBand, type TrendRace } from "./trend.js";

const ran = (h: RecordHorse): boolean => h.finishStatus !== "取消" && h.finishStatus !== "除外";
const CLASS_ORDINAL: Record<string, number> = { 新馬: 0, 未勝利: 0, "1勝クラス": 1, "2勝クラス": 2, "3勝クラス": 3, オープン: 4 };
const FIRST_HALF_END = "2025-09-30";
const SECOND_HALF_END = "2026-10-31";

export const halfOf = (date: string): "1" | "2" | "x" => (date <= FIRST_HALF_END ? "1" : date <= SECOND_HALF_END ? "2" : "x");
const minutes = (s: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
};
const dayNumber = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);

async function readNdjson<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const line of createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (line.trim() !== "") out.push(JSON.parse(line) as T);
  }
  return out;
}

interface ExtraRow { raceId: string; umaban: number; jEdge: number; jN: number; tEdge: number; tN: number; burden: number | null; bdMean: number; bdRank: number }

async function main(): Promise<void> {
  const [histPath, runsPath, extrasPath, outDir] = process.argv.slice(2);
  if (histPath === undefined || runsPath === undefined || extrasPath === undefined || outDir === undefined) {
    throw new Error("使い方: build.ts <hist> <horse_runs.csv> <extras> <出力ディレクトリ>");
  }
  const records = (await readNdjson<RaceRecord>(histPath)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.raceId < b.raceId ? -1 : 1));
  const extras = new Map((await readNdjson<ExtraRow>(extrasPath)).map((e) => [`${e.raceId}|${e.umaban}`, e]));

  // 1) 走の材料: hist から。
  const runs = new Map<string, PrevRun[]>();
  const histRaceIds = new Set(records.map((r) => r.raceId));
  const push = (id: string, r: PrevRun): void => {
    const l = runs.get(id) ?? [];
    l.push(r);
    runs.set(id, l);
  };
  for (const rec of records) {
    const horses = rec.horses.filter(ran);
    const times = horses.map((h) => h.timeSec).filter((t): t is number => t !== null);
    const minT = times.length > 0 ? Math.min(...times) : null;
    const l3 = horses.map((h) => h.last3f).filter((t): t is number => t !== null);
    const cls = rec.raceClass === null ? null : (CLASS_ORDINAL[rec.raceClass] ?? null);
    for (const h of horses) {
      if (h.horseId === null) continue;
      const rank = h.last3f === null ? null : 1 + l3.filter((x) => x < (h.last3f as number)).length;
      push(h.horseId, {
        date: rec.date, raceId: rec.raceId, venueName: rec.venueName ?? "", courseType: rec.courseType ?? "", distance: rec.distance ?? 0,
        going: rec.going ?? null, raceClass: cls, n: horses.length, finish: h.finish,
        pos4: h.passing !== null && h.passing.length > 0 ? h.passing[h.passing.length - 1]! : null,
        last3fRank: rank, marginSec: h.timeSec !== null && minT !== null ? Math.max(0, h.timeSec - minT) : null,
        jockeyId: h.jockeyId, jockeyMark: h.jockeyMark ?? null, markKnown: true, trainerId: h.trainerId, trainerKnown: true,
        ninki: h.ninki, jEdge: extras.get(`${rec.raceId}|${h.umaban}`)?.jEdge ?? null,
      });
    }
  }
  // 2) horse_runs.csv(hist に無い走だけ)。
  // horse_runs.csv は `horse_id,"<JSON を CSV の引用で包んだもの>"` の 1 行 1 走(引用内の " は "" )。
  const rows = readFileSync(runsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((l) => {
      const k = l.indexOf(",");
      const body = l.slice(k + 1);
      return [l.slice(0, k), body.startsWith('"') ? body.slice(1, -1).replace(/""/g, '"') : body];
    });
  let extraRuns = 0;
  for (const [horseId, data] of rows.slice(1)) {
    if (horseId === undefined || data === undefined) continue;
    for (const a of [JSON.parse(data) as unknown[]]) {
      const raceId = String(a[5]);
      if (histRaceIds.has(raceId)) continue;
      const date = String(a[0]).replace(/\//g, "-");
      const passing = a[21] as number[] | null;
      const finish = typeof a[12] === "number" && a[12] > 0 ? (a[12] as number) : null;
      const margin = typeof a[20] === "number" ? Math.max(0, a[20] as number) : null;
      push(horseId, {
        date, raceId, venueName: String((a[1] as unknown[])[1] ?? ""), courseType: String(a[16] ?? ""), distance: Number(a[17] ?? 0),
        going: typeof a[18] === "string" ? (a[18] as string) : null, raceClass: classFromName(String(a[4] ?? "")), n: Number(a[7] ?? 0), finish,
        pos4: Array.isArray(passing) && passing.length > 0 ? passing[passing.length - 1]! : null, last3fRank: null, marginSec: margin,
        jockeyId: typeof a[14] === "string" ? (a[14] as string) : null, jockeyMark: null, markKnown: false, trainerId: null, trainerKnown: false,
        ninki: typeof a[11] === "number" ? (a[11] as number) : null, jEdge: null,
      });
      extraRuns += 1;
    }
  }
  for (const l of runs.values()) l.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // 3) その日の傾向(60 分前・40 分前・すべて)。
  const trendRaces: TrendRace[] = [];
  for (const rec of records) {
    const start = minutes(rec.startTime ?? null);
    const horses = rec.horses.filter(ran);
    if (rec.courseType === "障" || start === null || horses.length === 0) continue;
    trendRaces.push({
      raceId: rec.raceId, date: rec.date, venueCode: rec.venueCode, courseType: rec.courseType ?? "", distance: rec.distance ?? 0, startMinutes: start, going: rec.going ?? null,
      horses: horses.map((h) => ({ pos4: h.passing !== null && h.passing.length > 0 ? h.passing[h.passing.length - 1]! : null, finish: h.finish, wakuban: h.wakuban })),
    });
  }
  const trend60 = computeTrends(trendRaces, 60);
  const trend40 = computeTrends(trendRaces, 40);
  const trendAny = computeTrends(trendRaces, null);

  // 4) 出力。
  const gzH = createGzip();
  gzH.pipe(createWriteStream(`${outDir}/horses.ndjson.gz`));
  const gzR = createGzip();
  gzR.pipe(createWriteStream(`${outDir}/races.ndjson.gz`));
  let hRows = 0;
  let rRows = 0;
  let excluded = 0;
  for (const rec of records) {
    const half = halfOf(rec.date);
    const horses = rec.horses.filter(ran);
    const q = marketShares(horses.map((h) => h.winOdds));
    if (rec.courseType === "障" || horses.length < 5 || q === null || half === "x") {
      excluded += 1;
      continue;
    }
    const n = horses.length;
    const month = Number(rec.date.slice(5, 7));
    const maxOdds = Math.max(...horses.map((h) => h.winOdds as number));
    const t60 = trend60.get(rec.raceId) ?? null;
    const t40 = trend40.get(rec.raceId) ?? null;
    const tAny = trendAny.get(rec.raceId) ?? null;
    const dnum = dayNumber(rec.date);
    horses.forEach((h, i) => {
      const prevs = (h.horseId === null ? [] : (runs.get(h.horseId) ?? [])).filter((r) => r.date < rec.date);
      const prev = prevs[0] ?? null;
      const ex = extras.get(`${rec.raceId}|${h.umaban}`);
      const ctx: HorseContext = {
        date: rec.date, courseType: rec.courseType ?? "", distance: rec.distance ?? 0, going: rec.going ?? null, direction: rec.direction ?? null,
        venueName: rec.venueName ?? "", raceClass: rec.raceClass === null ? null : (CLASS_ORDINAL[rec.raceClass] ?? null), n, month,
        spans: rec.raceData02Spans ?? [], sex: h.sex ?? null, age: h.age ?? null, wakuban: h.wakuban ?? null, jockeyId: h.jockeyId,
        jockeyMark: h.jockeyMark ?? null, trainerId: h.trainerId, jEdge: ex?.jEdge ?? null, bodyWeightDiff: h.bodyWeightDiff ?? null,
        oddsRank: 1 + horses.filter((o) => (o.winOdds as number) < (h.winOdds as number)).length,
        worstOddsRank: (h.winOdds as number) === maxOdds, prev,
        daysSince: prev === null ? null : dnum - dayNumber(prev.date), priorRunCount: prevs.length,
        ranAtVenue: prevs.some((r) => r.venueName === (rec.venueName ?? "")), style: styleAverage(prevs), trends: { m60: t60 ?? undefined, m40: t40 ?? undefined, any: tAny ?? undefined },
      };
      const cond = evaluateConditions(ctx, true);
      const finish = h.finish;
      const row = {
        raceId: rec.raceId, date: rec.date, half, n, umaban: h.umaban, finish, win: finish === 1 ? 1 : 0, place3: finish !== null && finish <= 3 ? 1 : 0,
        winOdds: h.winOdds, q: q[i], oddsRank: ctx.oddsRank,
        courseType: rec.courseType, distance: rec.distance, going: rec.going, raceClass: ctx.raceClass, weightType: rec.weightType ?? null, venue: rec.venueName, month,
        wakuban: h.wakuban, sex: h.sex, age: h.age, mark: h.jockeyMark ?? null, burden: h.burden, bodyWeightDiff: h.bodyWeightDiff ?? null,
        jEdge: ex?.jEdge ?? null, jN: ex?.jN ?? null, tEdge: ex?.tEdge ?? null, bdMean: ex?.bdMean ?? null, bdRank: ex?.bdRank ?? null,
        style: ctx.style, daysSince: ctx.daysSince, priorRunCount: ctx.priorRunCount,
        prevFinish: prev?.finish ?? null, prevPosRatio: prev !== null && prev.pos4 !== null && prev.n > 0 ? prev.pos4 / prev.n : null,
        prevMargin: prev?.marginSec ?? null, prevLast3fRank: prev?.last3fRank ?? null, prevN: prev?.n ?? null, prevNinki: prev?.ninki ?? null,
        prevClassDelta: prev !== null && prev.raceClass !== null && ctx.raceClass !== null ? ctx.raceClass - prev.raceClass : null,
        distDelta: prev !== null ? ctx.distance - prev.distance : null,
        jockeyChanged: prev !== null && prev.jockeyId !== null && h.jockeyId !== null ? (prev.jockeyId !== h.jockeyId ? 1 : 0) : null,
        df60: t60?.df ?? null, di60: t60?.di ?? null, shift60: t60?.shift ?? null,
        cond,
      };
      gzH.write(`${JSON.stringify(row)}\n`);
      hRows += 1;
    });

    // レース単位。
    const winners = horses.map((h, i) => ({ h, q: q[i]! })).filter((x) => x.h.finish === 1);
    const placed = horses.map((h, i) => ({ h, q: q[i]! })).filter((x) => x.h.finish !== null && x.h.finish <= 3);
    const sorted = [...q].sort((a, b) => b - a);
    const trif = rec.payouts?.trifecta;
    const quin = rec.payouts?.quinella;
    const t = (d: { df: number | null; di: number | null; shift: string | null } | null) => (d === null ? { df: null, di: null, shift: null } : d);
    gzR.write(`${JSON.stringify({
      raceId: rec.raceId, date: rec.date, half, n, raceClass: rec.raceClass, weightType: rec.weightType ?? null, going: rec.going, band: distanceBand(rec.distance ?? 0),
      courseType: rec.courseType, month, venue: rec.venueName,
      q1: sorted[0], qTop3: sorted[0]! + sorted[1]! + sorted[2]!, entropy: -q.reduce((s, v) => s + v * Math.log(v), 0),
      winnerQ: winners.length === 1 ? winners[0]!.q : null,
      placedUmaban: placed.map((x) => x.h.umaban), placedCount: placed.length,
      trifecta: trif?.state === "parsed" && trif.payouts.length > 0 ? trif.payouts[0]!.payout : null,
      quinella: quin?.state === "parsed" && quin.payouts.length > 0 ? quin.payouts[0]!.payout : null,
      t60: t(t60), t40: t(t40), tAny: t(tAny),
    })}\n`);
    rRows += 1;
  }
  await Promise.all([new Promise<void>((r) => gzH.end(r)), new Promise<void>((r) => gzR.end(r))]);
  process.stderr.write(`hist ${records.length}・horse_runs から足した走 ${extraRuns}・除外レース ${excluded}・馬 ${hRows} 行・レース ${rRows} 行・条件 ${CONDITION_IDS.length} 個\n`);
}

void main();
