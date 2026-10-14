import { describe, expect, it } from "vitest";

import { collectGradeWinnerTrend } from "../../packages/core/src/analyzer/grade-winner-trend";
import type { BuildPromptInput } from "../../packages/core/src/analyzer/build-prompt";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { runCloudAnalysis, type CloudAnalysisDeps } from "../src/pipeline";
import {
  ALL_BETS_SETTINGS,
  FIXED_NOW,
  GOLDEN,
  GRADE_WINNER_RESPONSE,
  KAISAI_DATE,
  RACE_ID,
  sameDayDetailOf,
  scrapeFixtureRace,
  stubAnalyze,
  viaJson,
} from "./pipeline-fixtures";

/**
 * Issue #176(#164-a)AC-a5: クラウド版(cloud/)から runAnalysis が、フィクスチャで最後まで通る。
 * 出力は exe 側の golden(変更前のコミットで生成)と一致する。LLM は使わない(analyze: null)か、確定的なスタブ。実 API・実 netkeiba には触れない。
 */

async function depsFor(overrides: Partial<CloudAnalysisDeps> = {}) {
  const { race, urls } = await scrapeFixtureRace();
  const saved: AnalysisRecord[] = [];
  const scrapeCalls: string[] = [];
  const deps: CloudAnalysisDeps = {
    scrape: async (raceId) => {
      scrapeCalls.push(raceId);
      return race;
    },
    analyze: null,
    saveAnalysis: async (record) => {
      saved.push(record);
      return { id: saved.length, detail: "stored" };
    },
    allocationSettings: ALL_BETS_SETTINGS,
    llmSkipReason: "golden: LLM なし",
    now: FIXED_NOW,
    ...overrides,
  };
  return { deps, saved, scrapeCalls, urls };
}

describe("クラウド版から runAnalysis(analyze: null)が最後まで通る(Issue #176 AC-a5)", () => {
  it("前提: フィクスチャの取得は 25 本(出馬表 1・戦績 16・調教 1・単勝複勝 1・組合せ 6)で、16頭が出走する", async () => {
    const { race, urls } = await scrapeFixtureRace();
    expect(urls).toHaveLength(25);
    expect(race.horses).toHaveLength(16);
  });

  it("結果・保存レコードが、exe 側の golden(noLlmAllBets)と完全に一致する", async () => {
    const { deps, saved } = await depsFor();
    const result = await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
    expect(saved).toHaveLength(1);
    expect(viaJson(result)).toEqual(GOLDEN.noLlmAllBets.result);
    expect(viaJson(saved[0])).toEqual(GOLDEN.noLlmAllBets.record);
  });

  it("配分は多点(betCount > 1)で、全券種のオッズが入っている(退化した入力ではない)", async () => {
    const { deps, saved } = await depsFor();
    const result = await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
    const bets = saved[0]!.allocation?.bets ?? [];
    expect(bets.length).toBeGreaterThan(1);
    expect(result.rows).toHaveLength(16);
    expect(result.llmUsed).toBe(false);
    expect(Object.keys(result.trifectaCombo ?? {}).length).toBeGreaterThan(1000);
  });

  it("kaisaiDate が保存レコードに入り、近似日付にならない", async () => {
    const { deps, saved } = await depsFor();
    const result = await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
    expect(saved[0]!.kaisaiDate).toBe("20260628");
    expect(result.dateApproximate).toBe(false);
    expect(result.date).toBe("2026/06/28");
  });

  it.each([
    ["null", null],
    ["空文字", ""],
    ["ハイフン区切り", "2026-06-28"],
    ["7桁", "2026062"],
  ])("kaisaiDate が %s のときは、取得も保存もせずに拒否する(当日日付での近似に落とさない)", async (_name, bad) => {
    const { deps, saved, scrapeCalls } = await depsFor();
    await expect(runCloudAnalysis(RACE_ID, bad as never, deps)).rejects.toThrow(/kaisaiDate/);
    expect(scrapeCalls).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("LLM スタブ + 非同期のバッチ読み出し + 重賞傾向でも、exe 側の golden(llmStubSameDayGrade)と一致する(非同期の deps・前のレースだけのバッチ)", async () => {
    const captured: BuildPromptInput[] = [];
    const batches: (readonly string[])[] = [];
    const { deps, saved } = await depsFor({
      llmSkipReason: undefined,
      analyze: stubAnalyze(captured),
      modelName: "claude-stub-fixed",
      getRaceResultDetails: async (ids) => {
        batches.push([...ids]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Map(ids.map((id) => [id, sameDayDetailOf(id)]));
      },
      getGradeWinnerTrend: (raceId, conditions, cutoffDate) =>
        collectGradeWinnerTrend(raceId, conditions, cutoffDate, {
          fetcher: { fetchText: async () => GRADE_WINNER_RESPONSE() },
        }),
    });
    const result = await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.race.sameDayTrend).not.toBeNull(); // 前提: 当日傾向が実際に入っている
    expect(captured[0]!.race.gradeWinnerTrend).not.toBeNull(); // 前提: 重賞傾向が実際に入っている
    expect(viaJson(result)).toEqual(GOLDEN.llmStubSameDayGrade.result);
    expect(viaJson(saved[0])).toEqual(GOLDEN.llmStubSameDayGrade.record);
    expect(viaJson(captured[0])).toEqual(GOLDEN.llmStubSameDayGrade.promptInput);
  });
});
