/**
 * 単日一括分析と期間バッチの相互排他予測子(純関数)のテスト(タスクC2)。
 *
 * 単日一括分析(batchAnalysisReducer)と期間バッチ(periodBatchReducer)は完全に独立した
 * reducerのため、同時に両方を起動できてしまうと analysis:batch-progress / cancelBatchAnalysis
 * (両者が共有するIPC)の進捗・中断が混線する。この予測子は reducer 自体を変更せず、
 * 「片方が実行中(または実行に向けて処理中)なら、もう片方の操作を無効化すべきか」だけを
 * 両reducerの状態から導出する(Appでdisabled propに渡すためのビュー層の純関数)。
 */

import { describe, expect, it } from "vitest";

import { deriveBatchAvailability } from "../src/renderer/batch-availability.js";
import type { PeriodBatchPhase } from "../src/renderer/batch-analysis-reducer.js";

describe("deriveBatchAvailability(単日/期間バッチの相互排他予測子)", () => {
  it.each<[boolean, PeriodBatchPhase, boolean, boolean]>([
    // [singleDayRunning, periodPhase, expected.singleDayDisabled, expected.periodDisabled]
    [false, "idle", false, false],
    [true, "idle", false, true],
    [false, "collecting", true, false],
    [false, "running", true, false],
    [true, "running", true, true],
  ])(
    "singleDayRunning=%s, periodPhase=%s → singleDayDisabled=%s, periodDisabled=%s",
    (singleDayRunning, periodPhase, expectedSingleDayDisabled, expectedPeriodDisabled) => {
      const result = deriveBatchAvailability(singleDayRunning, periodPhase);
      expect(result.singleDayDisabled).toBe(expectedSingleDayDisabled);
      expect(result.periodDisabled).toBe(expectedPeriodDisabled);
    },
  );

  it("両方アイドル(単日running=false・期間phase=idle)では両方とも有効(disabled=false)であること", () => {
    const result = deriveBatchAvailability(false, "idle");
    expect(result).toEqual({ singleDayDisabled: false, periodDisabled: false });
  });

  it("期間バッチが収集済み(collected、確定待ち)の間は単日一括分析を無効化しないこと(collected中はIOが走っていないため)", () => {
    const result = deriveBatchAvailability(false, "collected");
    expect(result.singleDayDisabled).toBe(false);
  });

  it("期間バッチが完了(done)の間は単日一括分析を無効化しないこと", () => {
    const result = deriveBatchAvailability(false, "done");
    expect(result.singleDayDisabled).toBe(false);
  });
});
