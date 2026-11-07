/**
 * #653: 馬ごとの戦績の CSV(`horse_runs.csv`。1 行 1 走)から、hist に無い走を取り出す。
 * パスに `-`(NO_HORSE_RUNS)を渡すと読まない。`horse_runs.csv` にある馬は「本番が 2026 年に分析した馬」で、
 * 2024-08 より前の戦績があること自体が「2026 年まで走り続けた」印になる(生き残りの偏り)ため、外した版を作れるようにしてある。
 */
import { readFileSync } from "node:fs";
import { classFromName, type PrevRun } from "./conditions.js";

export const NO_HORSE_RUNS = "-";

export interface ExtraRun { horseId: string; run: PrevRun }

/** horse_runs.csv は `horse_id,"<JSON を CSV の引用で包んだもの>"` の 1 行 1 走(引用内の " は "")。 */
export function loadExtraRuns(path: string, histRaceIds: ReadonlySet<string>): ExtraRun[] {
  if (path === NO_HORSE_RUNS) return [];
  const out: ExtraRun[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l !== "");
  for (const l of lines.slice(1)) {
    const k = l.indexOf(",");
    const horseId = l.slice(0, k);
    const body = l.slice(k + 1);
    const a = JSON.parse(body.startsWith('"') ? body.slice(1, -1).replace(/""/g, '"') : body) as unknown[];
    const raceId = String(a[5]);
    if (histRaceIds.has(raceId)) continue;
    const passing = a[21] as number[] | null;
    out.push({
      horseId,
      run: {
        date: String(a[0]).replace(/\//g, "-"), raceId, venueName: String((a[1] as unknown[])[1] ?? ""), courseType: String(a[16] ?? ""),
        distance: Number(a[17] ?? 0), going: typeof a[18] === "string" ? (a[18] as string) : null, raceClass: classFromName(String(a[4] ?? "")),
        n: Number(a[7] ?? 0), finish: typeof a[12] === "number" && a[12] > 0 ? (a[12] as number) : null,
        pos4: Array.isArray(passing) && passing.length > 0 ? passing[passing.length - 1]! : null, last3fRank: null,
        marginSec: typeof a[20] === "number" ? Math.max(0, a[20] as number) : null,
        jockeyId: typeof a[14] === "string" ? (a[14] as string) : null, jockeyMark: null, markKnown: false, trainerId: null, trainerKnown: false,
        ninki: typeof a[11] === "number" ? (a[11] as number) : null, jEdge: null,
      },
    });
  }
  return out;
}
