/**
 * #653: 馬ごとの戦績の CSV(`horse_runs.csv`)の読み込み(`scripts/market-blindspots-653/horse-runs.ts`)のテスト。
 * `-` を渡すと読まない(生き残りの偏りを避ける版)ことと、hist にあるレースの走を重ねて数えないことを固定する。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtraRuns, NO_HORSE_RUNS } from "../market-blindspots-653/horse-runs.js";

const run = (date: string, raceId: string, finish: number) =>
  JSON.stringify([date, [4, "東京", 3, "4東京3"], "晴", 5, "2歳新馬", raceId, "中央", 17, 8, 17, 2, 1, finish, "騎手", "01043", 55, "芝", 1600, "良", "1:35.9", -0.1, [11, 8], "35.7-34.5", 33.8, [466, 0], "(x)"]);
const csvLine = (horseId: string, json: string) => `${horseId},"${json.replace(/"/g, '""')}"`;

function writeCsv(lines: string[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "hr653-")), "horse_runs.csv");
  writeFileSync(p, ["horse_id,data", ...lines].join("\n"));
  return p;
}

describe("loadExtraRuns(horse_runs.csv の読み込み)", () => {
  const path = writeCsv([
    csvLine("H1", run("2017/10/09", "201705040305", 1)),
    csvLine("H1", run("2024/09/01", "202405010101", 3)),
    csvLine("H2", run("2018/01/01", "201806010101", 0)),
  ]);

  it("hist に無いレースの走だけを返す(hist にある走は重ねない)", () => {
    const got = loadExtraRuns(path, new Set(["202405010101"]));
    expect(got.map((g) => g.run.raceId).sort()).toEqual(["201705040305", "201806010101"]);
    expect(got.find((g) => g.horseId === "H1")?.run.date).toBe("2017-10-09");
  });

  it("着順 0 は finish=null、通過順の最後が pos4 になる", () => {
    const got = loadExtraRuns(path, new Set());
    expect(got).toHaveLength(3);
    const h2 = got.find((g) => g.horseId === "H2")!;
    expect(h2.run.finish).toBeNull();
    expect(got.find((g) => g.run.raceId === "201705040305")!.run.pos4).toBe(8);
  });

  it("NO_HORSE_RUNS(-)を渡すとファイルを読まず、空を返す", () => {
    expect(NO_HORSE_RUNS).toBe("-");
    expect(loadExtraRuns(NO_HORSE_RUNS, new Set())).toEqual([]);
  });
});
