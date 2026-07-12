/**
 * 一括分析オーケストレータ(runBatchAnalysis)のテスト。
 *
 * 実IO(runAnalysis 本体)は analyzeOne として注入し、直列実行・部分失敗の継続・
 * 中断境界での残りスキップ・全体進捗の通知を、スタブだけで固定する(electron 非依存)。
 */

import { describe, expect, it, vi } from "vitest";

import { runBatchAnalysis } from "../src/main/analysis-batch.js";
import type {
  AnalysisProgress,
  AnalysisResult,
  BatchProgress,
} from "../src/shared/analysis-types.js";

/** レース名だけ差し替えた最小の AnalysisResult を作る。 */
const fakeResult = (raceId: string): AnalysisResult => ({
  raceId,
  venueName: "東京",
  raceName: `${raceId}のレース`,
  courseType: "芝",
  distance: 1600,
  date: "2026/07/12",
  dateApproximate: false,
  llmUsed: false,
  llmSkippedReason: null,
  fallback: false,
  oddsStatus: "result",
  rows: [],
  warnings: [],
  analyzedAt: "2026-07-12T00:00:00.000Z",
});

describe("runBatchAnalysis(一括分析オーケストレータ)", () => {
  it("選択レースを入力順どおり直列に分析し、成功アウトカムを返す", async () => {
    const order: string[] = [];
    let active = 0;
    const analyzeOne = vi.fn(async (raceId: string) => {
      // 直列であることの検証: 同時にアクティブなのは常に1件のみ。
      active += 1;
      expect(active).toBe(1);
      order.push(raceId);
      await Promise.resolve();
      active -= 1;
      return fakeResult(raceId);
    });

    const outcomes = await runBatchAnalysis(["A", "B", "C"], {
      analyzeOne,
      shouldCancel: () => false,
    });

    expect(order).toEqual(["A", "B", "C"]);
    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(outcomes.map((o) => o.raceId)).toEqual(["A", "B", "C"]);
    // 成功アウトカムのレース名は result.raceName を採用する。
    expect(outcomes[0]!.raceName).toBe("Aのレース");
  });

  it("1レースの失敗で全体を止めず、失敗を記録して次へ進む(部分失敗)", async () => {
    const analyzeOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        throw new Error("Bの取得に失敗");
      }
      return fakeResult(raceId);
    });

    const outcomes = await runBatchAnalysis(["A", "B", "C"], {
      analyzeOne,
      shouldCancel: () => false,
    });

    expect(analyzeOne).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "failure",
      "success",
    ]);
    const failed = outcomes[1]!;
    expect(failed.error).toBe("Bの取得に失敗");
    expect(failed.result).toBeNull();
  });

  it("中断要求後は次のレース境界で停止し、残りをスキップする(実行中レースは完走)", async () => {
    let canceled = false;
    const analyzeOne = vi.fn(async (raceId: string) => {
      // 最初のレース(A)完了時点で中断が要求されたとする。
      if (raceId === "A") {
        canceled = true;
      }
      return fakeResult(raceId);
    });

    const outcomes = await runBatchAnalysis(["A", "B", "C"], {
      analyzeOne,
      shouldCancel: () => canceled,
    });

    // A は完走、B・C は境界でスキップ。analyzeOne は A の1回だけ。
    expect(analyzeOne).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "skipped",
      "skipped",
    ]);
    expect(outcomes[1]!.raceId).toBe("B");
    expect(outcomes[2]!.raceId).toBe("C");
  });

  it("最初から中断済みなら全レースをスキップし、一度も分析しない", async () => {
    const analyzeOne = vi.fn(async (raceId: string) => fakeResult(raceId));
    const outcomes = await runBatchAnalysis(["A", "B"], {
      analyzeOne,
      shouldCancel: () => true,
    });
    expect(analyzeOne).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "skipped"]);
  });

  it("全体進捗を通知する(完了レース数・総数・現在レース・レース内段階の転送)", async () => {
    const progresses: BatchProgress[] = [];
    const stage: AnalysisProgress = {
      stage: "スコアリング",
      current: 1,
      total: 5,
      message: "採点中",
    };
    const analyzeOne = vi.fn(
      async (raceId: string, onStage: (s: AnalysisProgress) => void) => {
        onStage(stage);
        return fakeResult(raceId);
      },
    );

    await runBatchAnalysis(["A", "B"], {
      analyzeOne,
      shouldCancel: () => false,
      raceNameOf: (id) => `会場${id}`,
      onProgress: (p) => progresses.push(p),
    });

    // レース内段階が全体進捗に転送され、現在レース・完了数が付与される。
    const stageEvent = progresses.find((p) => p.stage !== null);
    expect(stageEvent).toBeDefined();
    expect(stageEvent!.stage).toEqual(stage);
    expect(stageEvent!.totalRaces).toBe(2);
    expect(stageEvent!.currentRaceId).toBe("A");
    expect(stageEvent!.currentRaceName).toBe("会場A");

    // 最終進捗は完了2/2・現在レースなし。
    const last = progresses[progresses.length - 1]!;
    expect(last.completedRaces).toBe(2);
    expect(last.totalRaces).toBe(2);
    expect(last.currentRaceId).toBeNull();
  });
});
