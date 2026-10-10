import { describe, expect, it } from "vitest";
import { computeVerifyReportByPromptVersion, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { computePromptVersionSummaries, summarizePromptVersions } from "../src/verify-versions";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";

/**
 * Issue #220: 版別比較の射影(`verify-versions.ts`)。core の `computeVerifyReportByPromptVersion` の結果から、**画面が使う項目だけ**を残す(保存・配信の大きさを版の数に比例させすぎない)。
 * exe の結果との一致(同じ射影を exe の結果にも適用して JSON 往復で比べる)は、ルートの `scripts/test/cloud-verify-parity.test.ts`。
 */

function analysisRow(id: number, raceId: string, promptVersion: string | null, additionalInstruction: string | null = null): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion, additionalInstruction, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
}

/** 版 b(2 レース)・版 a(1 レース。追加指示あり)・版不明(1 レース)。1 レース 1 分析で、1 番の馬が複勝圏。 */
function rows(): VerifyReadRows {
  const analyses = [
    analysisRow(1, "202606030801", "b"),
    analysisRow(2, "202606030802", "b", "逃げ馬を重視"),
    analysisRow(3, "202606030803", "a", "逃げ馬を重視"),
    analysisRow(4, "202606030804", null),
  ];
  const horses = analyses.flatMap((a) => [
    { analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.55 - a.id * 0.1, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null },
    { analysisId: a.id, umaban: 2, prior: 0.2, adjusted_prob: 0.15, place_odds_min: 5, ev: 0.8, is_positive: 0, contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null },
  ]);
  const results = analyses.flatMap((a) => [
    { raceId: a.raceId, umaban: 1, finishPosition: a.id % 2 === 0 ? 1 : 5, placePayout: a.id % 2 === 0 ? 300 : null, winPayout: null },
    { raceId: a.raceId, umaban: 2, finishPosition: 2, placePayout: 150, winPayout: null },
  ]);
  return { analyses, horses, allocationMeta: [], bets: [], results, comboPayouts: [], comboImports: [] };
}

describe("computePromptVersionSummaries", () => {
  const source = buildVerifySource(rows());
  const summaries = computePromptVersionSummaries(source);

  it("前提(空振り防止): 3 つの版(a・b・版不明)があり、版ごとに集計件数が違う", () => {
    expect(summaries.map((s) => [s.promptVersion, s.includedAnalysisCount])).toEqual([["a", 1], ["b", 2], [null, 1]]);
  });

  it("版は昇順で、版不明(null)は末尾(core の並びのまま)", () => {
    expect(summaries.map((s) => s.promptVersion)).toEqual(["a", "b", null]);
  });

  it("追加指示は版内の重複しない値(非 null は昇順、なし〈null〉は末尾)", () => {
    expect(summaries.map((s) => s.additionalInstructions)).toEqual([["逃げ馬を重視"], ["逃げ馬を重視", null], [null]]);
  });

  it("画面が使う項目だけを持つ(完全な VerifyReport を持ち込まない)", () => {
    for (const s of summaries) {
      expect(Object.keys(s).sort()).toEqual(["additionalInstructions", "bet", "calibration", "includedAnalysisCount", "overconfidenceGaps", "promptVersion"]);
      expect(Object.keys(s.bet).sort()).toEqual(["betCount", "recoveryRate", "totalReturn", "totalStake"]);
    }
  });

  it("値は core の版別レポートと同じ(集計件数・回収率の 4 値・帯・過信バイアスの添字の対応)", () => {
    const full = computeVerifyReportByPromptVersion(source, PRODUCTION_VERIFY_CONFIG);
    expect(full).toHaveLength(3);
    full.forEach((f, i) => {
      const s = summaries[i]!;
      expect(s.promptVersion).toBe(f.promptVersion);
      expect(s.includedAnalysisCount).toBe(f.report.includedAnalysisCount);
      expect(s.bet).toEqual({ betCount: f.report.bet.betCount, totalStake: f.report.bet.totalStake, totalReturn: f.report.bet.totalReturn, recoveryRate: f.report.bet.recoveryRate });
      expect(s.calibration).toEqual(f.report.calibration);
      expect(s.overconfidenceGaps).toEqual(f.report.trend.calibrationBias.map((b) => b.overconfidenceGap));
    });
    // 前提(空振り防止): 回収率に差があり(版 a は複勝圏外のみ=0 点、版 b は的中あり)、帯に件数が入っている
    expect(summaries[0]!.bet.betCount).toBe(1);
    expect(summaries[0]!.bet.recoveryRate).not.toBe(summaries[1]!.bet.recoveryRate);
    expect(summaries.every((s) => s.calibration.some((b) => b.predictedCount > 0))).toBe(true);
    expect(summaries.every((s) => s.calibration.length === 20 && s.overconfidenceGaps.length === 20)).toBe(true);
    expect(summaries.some((s) => s.overconfidenceGaps.some((g) => g !== null))).toBe(true);
  });

  it("過信バイアスが帯より短い入力でも、帯と同じ長さに揃える(足りない分は null。exe の添字の対応と同じ)", () => {
    const full = computeVerifyReportByPromptVersion(source, PRODUCTION_VERIFY_CONFIG);
    const shortened = full.map((f) => ({ ...f, report: { ...f.report, trend: { ...f.report.trend, calibrationBias: f.report.trend.calibrationBias.slice(0, 5) } } }));
    const out = summarizePromptVersions(shortened);
    for (const s of out) {
      expect(s.overconfidenceGaps).toHaveLength(20);
      expect(s.overconfidenceGaps.slice(5)).toEqual(Array.from({ length: 15 }, () => null));
    }
  });

  it("分析が 0 件なら空配列", () => {
    expect(computePromptVersionSummaries(buildVerifySource({ analyses: [], horses: [], allocationMeta: [], bets: [], results: [], comboPayouts: [], comboImports: [] }))).toEqual([]);
  });

  it("JSON 往復で変わらない(kv・API に載せる形)", () => {
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries);
  });
});
