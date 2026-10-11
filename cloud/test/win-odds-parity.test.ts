import { describe, expect, it } from "vitest";

import { buildMixedCandidates } from "../../packages/app/src/shared/mixed-candidates";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { estimateFairWinOdds, estimateWinProbabilities, WIN_PROB_TOP_FINISH_COUNT } from "../../packages/core/src/ev/win-odds-estimate";
import { runCloudAnalysis, type CloudAnalysisDeps } from "../src/pipeline";
import { ALL_BETS_SETTINGS, FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #247: 画面・Discord の想定単勝オッズが、配分の単勝候補と「同じ関数・同じ入力」であることの固定。
 *  (a) 勝率の推定に使う上位着数は、配分(`buildMixedCandidates`)の `topFinishCount` と同じ
 *  (b) 実際の分析(フィクスチャ)の `rows` の補正後の3着内率から求めた勝率と、保存した D1 の行〈`record.horses`〉から求めた勝率が一致する
 *  (c) 配分の単勝候補の EV(= 勝率 × オッズ)が、`estimateWinProbabilities` の勝率 × オッズに一致する
 */

async function analyzeFixture(): Promise<{ result: Awaited<ReturnType<typeof runCloudAnalysis>>; record: AnalysisRecord }> {
  const { race } = await scrapeFixtureRace();
  const saved: AnalysisRecord[] = [];
  const deps: CloudAnalysisDeps = {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: async (record) => {
      saved.push(record);
      return { id: saved.length, detail: "stored" };
    },
    allocationSettings: ALL_BETS_SETTINGS,
    llmSkipReason: "parity: LLM なし",
    now: FIXED_NOW,
  };
  const result = await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
  expect(saved).toHaveLength(1);
  return { result, record: saved[0]! };
}

describe("想定単勝オッズと配分の同一性(Issue #247)", () => {
  it("(a) 勝率の推定に使う上位着数は、配分の topFinishCount と同じ", async () => {
    const { result } = await analyzeFixture();
    expect(buildMixedCandidates(result, { betTypes: ["win"] }).topFinishCount).toBe(WIN_PROB_TOP_FINISH_COUNT);
  });

  it("(b) rows の補正後の3着内率から求めた勝率 = 保存した D1 の行(record.horses)の補正後の3着内率から求めた勝率(16頭。ビット一致)", async () => {
    const { result, record } = await analyzeFixture();
    expect(result.rows).toHaveLength(16);
    const fromRows = estimateFairWinOdds(result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb })));
    const fromRecord = estimateFairWinOdds(record.horses.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb })));
    expect(fromRows.every((e) => e.winProb !== null && e.fairWinOdds !== null), "前提: 判定可能な入力").toBe(true);
    expect(fromRecord).toEqual(fromRows);
    // LLM なし: 補正後の3着内率 = prior
    expect(result.rows.every((r) => r.adjustedProb === r.prior)).toBe(true);
    // 均等(1/16)に潰れていない
    const probs = fromRows.map((e) => e.winProb!);
    expect(Math.max(...probs) - Math.min(...probs)).toBeGreaterThan(0.05);
  });

  it("(c) 配分の単勝候補の EV は、推定した勝率 × 実際の単勝オッズに一致する(閾値を下げて全頭ぶんの候補を取る)", async () => {
    const { result } = await analyzeFixture();
    const win = estimateWinProbabilities(result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb })));
    expect(win).not.toBeNull();
    const built = buildMixedCandidates(result, { betTypes: ["win"], evConfig: { threshold: 0 } });
    const winCandidates = built.candidates.filter((c) => c.betType === "win");
    expect(winCandidates.length, "前提: 単勝の候補が複数ある(退化させない)").toBeGreaterThan(5);
    for (const c of winCandidates) {
      const umaban = c.umabans[0]!;
      expect(c.odds).toBe(result.rows.find((r) => r.umaban === umaban)!.winOdds);
      expect(c.ev).toBe(win!.get(umaban)! * c.odds);
    }
  });
});
