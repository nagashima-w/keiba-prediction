/**
 * #664: #663 の条件(BASHIRA で市場が見落としやすいと確かめたもの)を、手元の過去の結果(hist)から作る旗にする。
 * 定義は docs/investigations/stat-features-664/plan.md §2。純粋な部分(`computeFlags`・`buildFeatureRows`)をテストする
 * (scripts/test/stat-features-664.test.ts)。ファイルの読み書きは末尾の main。
 *
 * 使い方: pnpm tsx scripts/stat-features-664/features.ts <hist.ndjson.gz> <出力.ndjson.gz>
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import type { RaceRecord, RecordHorse } from "../../packages/core/src/scraper/race-record.js";

export const FLAG_NAMES = [
  "noprev", "turf2dirt", "dirt2turf", "rest180", "mid1w", "distUp400", "filly", "age7", "wLight", "wHeavy",
  "eastInWest", "westInEast", "foreignJC", "foreignJCnoLemaire", "foreignJCnoLD", "gain4",
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Record<FlagName, 0 | 1>;

export interface RunInfo {
  date: string;
  courseType: string;
  distance: number;
  finish: number | null;
  /** 4 角(通過順の最後)の位置。無ければ null。 */
  pos4: number | null;
  jockeyId: string | null;
}
export interface CurInfo {
  date: string;
  venueName: string | null;
  courseType: string;
  distance: number;
  sex: string | null;
  age: number | null;
  bodyWeight: number | null;
  trainerArea: string | null;
  jockeyId: string | null;
  jockeyName: string | null;
}

const EAST_VENUES = new Set(["東京", "中山", "新潟", "福島"]);
const WEST_VENUES = new Set(["京都", "阪神", "中京", "小倉"]);

export function daysBetween(a: string, b: string): number {
  const t = (s: string): number => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000);
}

/** ルメール(C.ルメール)と M.デムーロの jockeyId。2015 年に通年免許を取った(hist の名前は 3 文字に切れ、表記もゆれるので ID で見分ける)。 */
export const LEMAIRE_ID = "05339";
export const M_DEMUROU_ID = "05212";

/**
 * hist の騎手名は 3 文字に切れている。外国人騎手とみなすのは、(1) カタカナだけの名前(ルメー・レーン)、
 * (2) 同姓の区別に付く全角の頭文字 + カタカナ(Ｍデム・Ｃ．ル・Ａルメ・Ｈドイ)。日本人騎手は漢字なのでどちらにも当たらない。
 * 日本在住か短期免許かの区別はできない。
 */
export function isForeignName(name: string | null): boolean {
  return name !== null && /^(?:[Ａ-Ｚ][．.]?)?[ァ-ヶー]+$/.test(name);
}

const b = (x: boolean): 0 | 1 => (x ? 1 : 0);

export function computeFlags(cur: CurInfo, prev: RunInfo | null): Flags {
  const flatPrev = prev !== null && prev.courseType !== "障";
  const days = prev === null ? null : daysBetween(prev.date, cur.date);
  const jockeyChanged = prev !== null && prev.jockeyId !== null && cur.jockeyId !== null && prev.jockeyId !== cur.jockeyId;
  const foreignJC = jockeyChanged && isForeignName(cur.jockeyName);
  return {
    noprev: b(prev === null),
    turf2dirt: b(flatPrev && prev!.courseType === "芝" && cur.courseType === "ダ"),
    dirt2turf: b(flatPrev && prev!.courseType === "ダ" && cur.courseType === "芝"),
    rest180: b(days !== null && days >= 180),
    mid1w: b(days !== null && days >= 8 && days <= 14),
    distUp400: b(flatPrev && cur.distance - prev!.distance >= 400),
    filly: b(cur.sex === "牝"),
    age7: b(cur.age !== null && cur.age >= 7),
    wLight: b(cur.bodyWeight !== null && cur.bodyWeight < 420),
    wHeavy: b(cur.bodyWeight !== null && cur.bodyWeight >= 520),
    eastInWest: b(cur.trainerArea === "美浦" && cur.venueName !== null && WEST_VENUES.has(cur.venueName)),
    westInEast: b(cur.trainerArea === "栗東" && cur.venueName !== null && EAST_VENUES.has(cur.venueName)),
    foreignJC: b(foreignJC),
    foreignJCnoLemaire: b(foreignJC && cur.jockeyId !== LEMAIRE_ID),
    foreignJCnoLD: b(foreignJC && cur.jockeyId !== LEMAIRE_ID && cur.jockeyId !== M_DEMUROU_ID),
    gain4: b(flatPrev && prev!.pos4 !== null && prev!.finish !== null && prev!.pos4 - prev!.finish >= 5),
  };
}

export type FeatureRow = { raceId: string; umaban: number } & Flags;

const ran = (h: RecordHorse): boolean => h.finishStatus !== "取消" && h.finishStatus !== "除外";

/**
 * 時間順に走査して、1 頭 1 行を出す。取消・除外は行を出さず、「直近の 1 走」にも入れない。
 * 障害のレースにも行を出す(#649 の fit.py が障害のレースを除かないので、足す前と同じ行の集合にそろえる。障害のレースの芝ダ替わりは 0)。
 */
export function buildFeatureRows(records: readonly RaceRecord[]): FeatureRow[] {
  const sorted = [...records].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.raceId < y.raceId ? -1 : 1));
  const last = new Map<string, RunInfo>();
  const out: FeatureRow[] = [];
  for (const rec of sorted) {
    const horses = rec.horses.filter(ran);
    for (const h of horses) {
      const prev = h.horseId === null ? null : (last.get(h.horseId) ?? null);
      const cur: CurInfo = {
        date: rec.date, venueName: rec.venueName, courseType: rec.courseType ?? "", distance: rec.distance ?? 0, sex: h.sex, age: h.age,
        bodyWeight: h.bodyWeight, trainerArea: h.trainerArea, jockeyId: h.jockeyId, jockeyName: h.jockeyName,
      };
      out.push({ raceId: rec.raceId, umaban: h.umaban, ...computeFlags(cur, prev) });
    }
    for (const h of horses) {
      if (h.horseId === null) continue;
      last.set(h.horseId, {
        date: rec.date, courseType: rec.courseType ?? "", distance: rec.distance ?? 0, finish: h.finish,
        pos4: h.passing.length > 0 ? h.passing[h.passing.length - 1]! : null, jockeyId: h.jockeyId,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (inPath === undefined || outPath === undefined) throw new Error("使い方: features.ts <hist.ndjson.gz> <出力.ndjson.gz>");
  const records: RaceRecord[] = [];
  for await (const line of createInterface({ input: createReadStream(inPath).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (line.trim() !== "") records.push(JSON.parse(line) as RaceRecord);
  }
  const rows = buildFeatureRows(records);
  const gz = createGzip();
  gz.pipe(createWriteStream(outPath));
  for (const r of rows) gz.write(`${JSON.stringify(r)}\n`);
  gz.end();
  console.log(`特徴量 ${rows.length} 行`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("features.ts")) await main();
