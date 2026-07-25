/**
 * 期間バッチのフォーム(from/to/取得対象)ロック判定(純関数)のテスト(タスクC2重大修正)。
 *
 * code-reviewer指摘: 「確定実行される内容は、常に画面に表示中のfrom/to/target(=収集済み
 * スナップショット)と一致していなければならない」という不変条件を守るため、収集(phase1)が
 * 開始された時点(collecting)以降はフォームをロックし、表示中の入力と collectResult が
 * ズレる余地を無くす(idleに戻る=リセットを経ないと再編集できない)。
 */

import { describe, expect, it } from "vitest";

import { isPeriodFormLocked } from "../src/renderer/period-batch-form-lock.js";
import type { PeriodBatchPhase } from "../src/renderer/batch-analysis-reducer.js";

describe("isPeriodFormLocked(期間バッチのフォームロック判定)", () => {
  it.each<[PeriodBatchPhase, boolean]>([
    ["idle", false],
    ["collecting", true],
    ["collected", true],
    ["running", true],
    ["done", true],
  ])("phase=%s → locked=%s", (phase, expected) => {
    expect(isPeriodFormLocked(phase)).toBe(expected);
  });
});
