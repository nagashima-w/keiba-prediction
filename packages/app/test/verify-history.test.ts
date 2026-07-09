import { describe, expect, it } from "vitest";
import type { StoredAnalysis } from "@keiba/core";
import { buildAnalysisHistory } from "../src/main/verify-history.js";

/** テスト用の保存済み分析を最小構成で組み立てる。 */
function analysis(
  id: number,
  raceId: string,
  positives: boolean[],
): StoredAnalysis {
  return {
    id,
    raceId,
    analyzedAt: `2026-07-0${id}T00:00:00.000Z`,
    horses: positives.map((isPositive, i) => ({
      umaban: i + 1,
      prior: 0.3,
      adjustedProb: 0.3,
      placeOddsMin: 2.0,
      ev: isPositive ? 1.2 : 0.8,
      isPositive,
      contributions: null,
    })),
  };
}

describe("buildAnalysisHistory(分析履歴一覧の組み立て)", () => {
  it("各分析の頭数・EVプラス数・結果取込済みか・払戻取込済みかを算出すること", () => {
    const analyses: StoredAnalysis[] = [
      analysis(1, "R1", [true, false, true]),
      analysis(2, "R2", [false, false]),
    ];
    const resultRaceIds = new Set(["R1"]);
    const payoutRaceIds = new Set(["R1"]);
    const history = buildAnalysisHistory(analyses, resultRaceIds, payoutRaceIds);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      analysisId: 1,
      raceId: "R1",
      analyzedAt: "2026-07-01T00:00:00.000Z",
      horseCount: 3,
      positiveCount: 2,
      hasResult: true,
      hasPayout: true,
    });
    expect(history[1]!.hasResult).toBe(false);
    expect(history[1]!.hasPayout).toBe(false);
    expect(history[1]!.positiveCount).toBe(0);
  });

  it("結果は取込済みだが払戻が未取込のレースは hasResult=true / hasPayout=false になること", () => {
    // 確定直前などで着順のみ保存され、複勝払戻がまだ無いケース。
    const history = buildAnalysisHistory(
      [analysis(1, "R1", [true])],
      new Set(["R1"]),
      new Set<string>(),
    );
    expect(history[0]!.hasResult).toBe(true);
    expect(history[0]!.hasPayout).toBe(false);
  });
});
