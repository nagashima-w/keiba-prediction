import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
import { computeVerifyReport, computeVerifyReportByPromptVersion } from "../../src/ev/verify.js";

/**
 * Issue #271: 検証レポートに、補正前(prior=統計モデル)と補正後(AI 補正)の Brier を載せる。
 *
 * 母集団は `calibration`・`priorCalibration` と同じ(結果の着順が確定した馬。取消・着順不明・結果未保存のレース・
 * 同じレースの古い分析は入らない)。Brier は `probability-quality-metrics` の `computeBrierScore` と同じ値(確率と結果{0,1}の二乗誤差の平均)。
 * 手計算の値を直接書き、実装の式を写さない。
 */

function h(umaban: number, prior: number, adjustedProb: number): AnalysisHorseRecord {
  return { umaban, prior, adjustedProb, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null };
}

const sumCount = (bins: readonly { readonly predictedCount: number }[]): number => bins.reduce((a, b) => a + b.predictedCount, 0);

describe("検証レポートの quality(補正前・補正後の Brier)", () => {
  it("手計算の値: 3 頭(複勝圏 2 頭)の補正前・補正後の Brier と評価頭数", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses: [h(1, 0.5, 0.7), h(2, 0.3, 0.2), h(3, 0.1, 0.1)] });
    store.saveResult("R1", [
      { umaban: 1, finishPosition: 1 },
      { umaban: 2, finishPosition: 5 },
      { umaban: 3, finishPosition: 3 },
    ]);
    const { quality } = computeVerifyReport(store);
    // 補正前: (0.5-1)^2 + 0.3^2 + (0.1-1)^2 = 0.25 + 0.09 + 0.81 = 1.15 → 1.15/3
    // 補正後: (0.7-1)^2 + 0.2^2 + (0.1-1)^2 = 0.09 + 0.04 + 0.81 = 0.94 → 0.94/3
    expect(quality.evaluatedCount).toBe(3);
    expect(quality.priorBrier).toBeCloseTo(1.15 / 3, 12);
    expect(quality.adjustedBrier).toBeCloseTo(0.94 / 3, 12);
    // 前提(空振り防止): 補正前と補正後の値は違う(取り違えを弾く)
    expect(Math.abs(quality.priorBrier! - quality.adjustedBrier!)).toBeGreaterThan(0.05);
    store.close();
  });

  it("母集団は calibration と同じ: 着順不明の馬・結果未保存のレース・古い分析は入らず、評価頭数は帯の件数の合計と一致する", () => {
    const store = new AnalysisStore();
    // R1: 馬 2 は着順不明(中止)
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses: [h(1, 0.4, 0.4), h(2, 0.9, 0.9), h(3, 0.2, 0.2)] });
    store.saveResult("R1", [
      { umaban: 1, finishPosition: 2 },
      { umaban: 2, finishPosition: null },
      { umaban: 3, finishPosition: 7 },
    ]);
    // R2: 結果未保存
    store.saveAnalysis({ raceId: "R2", analyzedAt: "t", horses: [h(1, 0.9, 0.9)] });
    // R3: 古い分析(prior 0.9)は新しい分析(prior 0.1)に取って代わられる
    store.saveAnalysis({ raceId: "R3", analyzedAt: "2026-07-01T00:00:00Z", horses: [h(1, 0.9, 0.9)] });
    store.saveAnalysis({ raceId: "R3", analyzedAt: "2026-07-02T00:00:00Z", horses: [h(1, 0.1, 0.1)] });
    store.saveResult("R3", [{ umaban: 1, finishPosition: 9 }]);
    const report = computeVerifyReport(store);
    // 評価対象: R1 の馬 1(0.4 → 複勝圏)・馬 3(0.2 → 圏外)と、R3 の新しい分析の馬 1(0.1 → 圏外)
    // (0.4-1)^2 + 0.2^2 + 0.1^2 = 0.36 + 0.04 + 0.01 = 0.41 → 0.41/3
    expect(report.quality.evaluatedCount).toBe(3);
    expect(report.quality.evaluatedCount).toBe(sumCount(report.calibration));
    expect(report.quality.evaluatedCount).toBe(sumCount(report.priorCalibration));
    expect(report.quality.priorBrier).toBeCloseTo(0.41 / 3, 12);
    expect(report.quality.adjustedBrier).toBeCloseTo(0.41 / 3, 12);
    store.close();
  });

  it("評価できる馬が 0 頭なら Brier は null(0 と書いて「完全な予測」と誤読させない)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses: [h(1, 0.4, 0.4)] }); // 結果未保存
    const { quality } = computeVerifyReport(store);
    expect(quality).toEqual({ evaluatedCount: 0, priorBrier: null, adjustedBrier: null });
    store.close();
  });

  it("補正後の確率が範囲外(1 超)の馬がいると adjustedBrier だけが null になる(丸めて黙って数値にしない)。priorBrier は出る", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses: [h(1, 0.5, 1.2), h(2, 0.3, 0.3)] });
    store.saveResult("R1", [
      { umaban: 1, finishPosition: 1 },
      { umaban: 2, finishPosition: 8 },
    ]);
    const { quality } = computeVerifyReport(store);
    expect(quality.evaluatedCount).toBe(2);
    expect(quality.adjustedBrier).toBeNull();
    // (0.5-1)^2 + 0.3^2 = 0.34 → 0.17
    expect(quality.priorBrier).toBeCloseTo(0.17, 12);
    store.close();
  });

  it("LLM を使わなかった分析(prior == 補正後)なら、2 つの Brier は一致する", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses: [h(1, 0.31, 0.31), h(2, 0.07, 0.07), h(3, 0.8, 0.8)] });
    store.saveResult("R1", [
      { umaban: 1, finishPosition: 3 },
      { umaban: 2, finishPosition: 4 },
      { umaban: 3, finishPosition: 1 },
    ]);
    const { quality } = computeVerifyReport(store);
    expect(quality.evaluatedCount).toBe(3); // 前提: 空振りでない
    expect(quality.adjustedBrier).toBe(quality.priorBrier);
    store.close();
  });

  it("版別の各 report の quality は、その版の分析だけから求める(版をまたいで混ぜない)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "t", promptVersion: "v1", horses: [h(1, 0.5, 0.5)] });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]); // v1: (0.5-1)^2 = 0.25
    store.saveAnalysis({ raceId: "R2", analyzedAt: "t", promptVersion: "v2", horses: [h(1, 0.2, 0.4), h(2, 0.6, 0.6)] });
    store.saveResult("R2", [
      { umaban: 1, finishPosition: 6 },
      { umaban: 2, finishPosition: 2 },
    ]); // v2 prior: 0.2^2 + (0.6-1)^2 = 0.2 → 0.1 / 補正後: 0.4^2 + 0.4^2 = 0.32 → 0.16
    const byVersion = computeVerifyReportByPromptVersion(store);
    expect(byVersion.map((v) => v.promptVersion)).toEqual(["v1", "v2"]);
    const [v1, v2] = byVersion.map((v) => v.report.quality);
    expect(v1).toEqual({ evaluatedCount: 1, priorBrier: 0.25, adjustedBrier: 0.25 });
    expect(v2!.evaluatedCount).toBe(2);
    expect(v2!.priorBrier).toBeCloseTo(0.1, 12);
    expect(v2!.adjustedBrier).toBeCloseTo(0.16, 12);
    store.close();
  });

  it("版別の includedAnalysisCount は、同じ版の中の同じレースの重複分析を 1 と数える(画面の「レース数」に使う前提)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: "R1", analyzedAt: "2026-07-01T00:00:00Z", promptVersion: "v1", horses: [h(1, 0.5, 0.5)] });
    store.saveAnalysis({ raceId: "R1", analyzedAt: "2026-07-02T00:00:00Z", promptVersion: "v1", horses: [h(1, 0.5, 0.5)] });
    store.saveAnalysis({ raceId: "R2", analyzedAt: "2026-07-01T00:00:00Z", promptVersion: "v1", horses: [h(1, 0.5, 0.5)] });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    store.saveResult("R2", [{ umaban: 1, finishPosition: 1 }]);
    const [v1] = computeVerifyReportByPromptVersion(store);
    expect(v1!.report.includedAnalysisCount).toBe(2); // 3 分析・2 レース
    expect(v1!.report.quality.evaluatedCount).toBe(2);
    store.close();
  });
});
