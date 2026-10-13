import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runAnalysis, type AnalysisPipelineDeps } from "../../src/analysis/analysis-pipeline.js";
import { classifyLookaheadSuspicion, parseKaisaiDate, type RaceData } from "../../src/index.js";
import { AnalysisStore } from "../support/analysis-store.js";

/**
 * 共有の `runAnalysis` が保存するスナップショット(`buildRaceSnapshot`)の `race.startTime` を、core の先読みリーク疑いの分類
 * (`classifyLookaheadSuspicion`)が読めること(Issue #152 B)。web の検証ストアも同じ形を `extractStartTime` で読む。
 *
 * Issue #287(#285 の段階B)で `packages/app/test/verify-lookahead-wiring.test.ts` の 2 つ目の describe(3 件)を移した。
 * 元のファイルの 1 つ目の describe(6 件)は、exe の `createPipelineDeps`(`getVerifyReport` の配線)の検査で、exe とともに削除した
 * (web の同等は cloud の `verify-core.test.ts` と scripts の `cloud-verify-parity.test.ts`)。
 * 移すにあたって、exe の `createPipelineDeps` の代わりに最小の deps(`scrape`・`analyze: null`・`allocationSettings: null`・`now`・
 * `saveAnalysis`)を作り、保存先は同じファイルを開き直す代わりに、1 つのメモリ上の `AnalysisStore` にした。assert は無変更。
 */

describe("buildRaceSnapshot が保存する race.startTime を core の分類が読めること(Issue #152 B)", () => {
  function loadFixture(fileName: string): RaceData {
    const url = new URL(
      `../../../../docs/investigations/combo-odds-real-fetch/${fileName}`,
      import.meta.url,
    );
    return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
  }

  /** 実フィクスチャのレースを production の保存経路(runAnalysis → deps.saveAnalysis)で保存し、保存済み行を返す。 */
  async function analyzeAndStore(
    raceData: RaceData,
    kaisaiDate: string | null,
    now: Date,
  ): Promise<ReturnType<AnalysisStore["listAnalyses"]>[number]> {
    const store = new AnalysisStore();
    try {
      const deps: AnalysisPipelineDeps = {
        scrape: async () => raceData,
        analyze: null,
        allocationSettings: null,
        now: () => now,
        saveAnalysis: (record) => store.saveAnalysis(record),
      };
      await runAnalysis(
        raceData.raceId,
        kaisaiDate === null ? null : parseKaisaiDate(kaisaiDate),
        deps,
      );
      const stored = store.listAnalyses();
      expect(stored).toHaveLength(1);
      return stored[0]!;
    } finally {
      store.close();
    }
  }

  /** 遮断印を外した写し(旧行を模す)を分類する。印があると発走時刻を見ずに clean になるため。 */
  function classifyWithoutMarkers(stored: Awaited<ReturnType<typeof analyzeAndStore>>) {
    return classifyLookaheadSuspicion({
      ...stored,
      historyCutoffDate: null,
      promptLookaheadGuarded: null,
    });
  }

  it("中央(15:45発走): 保存された race.startTime が分類で読まれ、発走の1分前は clean・発走ちょうどは suspect(unknown に落ちない)", async () => {
    const raw = loadFixture("central-on.json");
    // 前提: フィクスチャは発走時刻を持つ(15:45 JST = 06:45Z)。
    expect(raw.race.startTime).toBe("15:45");

    const before = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T06:44:59.000Z"));
    expect((before.raceSnapshot as { race: { startTime: unknown } }).race.startTime).toBe("15:45");
    expect(classifyWithoutMarkers(before)).toBe("clean");

    const atStart = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T06:45:00.000Z"));
    expect(classifyWithoutMarkers(atStart)).toBe("suspect");
  });

  it("地方(20:50発走): 開催日は raceId から決まり、発走時刻が読まれて前後が判定される", async () => {
    const raw = loadFixture("nar-on.json");
    expect(raw.race.startTime).toBe("20:50");

    // 20:50 JST = 11:50Z。kaisaiDate を渡さない(地方は raceId の月日から決まる)。
    const before = await analyzeAndStore(raw, null, new Date("2026-07-12T11:49:59.000Z"));
    expect(classifyWithoutMarkers(before)).toBe("clean");

    const atStart = await analyzeAndStore(raw, null, new Date("2026-07-12T11:50:00.000Z"));
    expect(classifyWithoutMarkers(atStart)).toBe("suspect");
  });

  it("production で保存した新規分析は両方の遮断印を持ち、発走後に分析しても clean として集計される", async () => {
    const raw = loadFixture("central-on.json");
    const stored = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T07:00:00.000Z"));
    expect(stored.historyCutoffDate).not.toBeNull();
    expect(stored.promptLookaheadGuarded).toBe(true);
    expect(classifyLookaheadSuspicion(stored)).toBe("clean");
    // 印が無ければ同じ行は suspect(印が効いていることの対照。差が0でない)。
    expect(classifyWithoutMarkers(stored)).toBe("suspect");
  });
});
