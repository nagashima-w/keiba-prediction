import { describe, expect, it } from "vitest";
import { isDayQuiet, type DayQuietInput } from "../src/day-quiet";

/**
 * Issue #235: 「その日が静かになった」= 日報を作ってよい、の判定(純関数)。時刻・曜日を一切見ない: 計画と、発走前のタスクと、結果の取り込みの状態だけで決まる。
 * 全部が揃ったとき(基準)から 1 つずつ崩して、どの条件も判定を変えることを固定する。
 */

const QUIET: DayQuietInput = { planFinalized: true, plannedRows: 0, pendingTasks: 0, resultRows: 36, queuedResults: 0 };

describe("isDayQuiet", () => {
  it("基準: 計画が確定し、計画中の行も未了のタスクも結果の取り込み待ちも無く、結果の行がある → 静か", () => {
    expect(isDayQuiet(QUIET)).toBe(true);
  });

  it.each([
    ["計画が確定していない(会場の一覧の取得中など)", { planFinalized: false }],
    ["期限を待つ計画中のレースがある(20:50 発走の地方の重賞がまだ分析されていない)", { plannedRows: 1 }],
    ["発走前のタスク(取得・計算)が未了", { pendingTasks: 1 }],
    ["結果の取り込み待ちのレースがある", { queuedResults: 1 }],
    ["結果の行が 1 件も無い(結果の仕組みが無効・レースが無い日)", { resultRows: 0, queuedResults: 0 }],
  ] as const)("静かでない: %s", (_name, change) => {
    expect(isDayQuiet({ ...QUIET, ...change })).toBe(false);
  });

  it("空振り防止: 上の 5 つの崩し方は、どれも基準と 1 項目だけ違う(複数を同時に崩していない)", () => {
    const changes: Array<Partial<DayQuietInput>> = [{ planFinalized: false }, { plannedRows: 1 }, { pendingTasks: 1 }, { queuedResults: 1 }, { resultRows: 0 }];
    for (const change of changes) {
      const differing = (Object.keys(change) as Array<keyof DayQuietInput>).filter((k) => QUIET[k] !== change[k]);
      expect(differing).toHaveLength(1);
    }
  });

  it("結果の取り込みを諦めた行(gave_up)は待たない: 行があり、待ち(queued)が 0 なら静か", () => {
    expect(isDayQuiet({ ...QUIET, resultRows: 3, queuedResults: 0 })).toBe(true);
  });
});
