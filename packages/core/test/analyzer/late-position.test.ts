/**
 * 終盤の位置の指標 `computeLatePosition`(Issue #363。想定隊列図の4コーナーの位置に使う)。
 * 新しい順に最大3走(通過順位の最後の要素=最終コーナー ÷ 出走頭数)を平均する。0〜1 で小さいほど前。判定不能は null。
 * 序盤の位置(`early-position.ts`)と同じ作りで、見る要素が「最初」から「最後」に変わる。
 * 通過点が 1 つしかない走は採らない(最後=最初になり、終盤の位置として意味が崩れるため)。
 */
import { describe, expect, it } from "vitest";
import { computeEarlyPosition } from "../../src/analyzer/early-position.js";
import { computeLatePosition, LATE_POSITION_RUNS } from "../../src/analyzer/late-position.js";

type Run = { readonly passing: number[]; readonly entryCount: number | null };
const run = (passing: number[], entryCount: number | null): Run => ({ passing, entryCount });

describe("computeLatePosition(最終コーナーの相対位置の平均)", () => {
  it("前提: 参照する走数は3", () => {
    expect(LATE_POSITION_RUNS).toBe(3);
  });

  const table: ReadonlyArray<{ readonly name: string; readonly runs: readonly Run[] | null; readonly expected: number | null }> = [
    { name: "戦績が null(取得失敗)は null", runs: null, expected: null },
    { name: "戦績が空(初出走)は null", runs: [], expected: null },
    { name: "通過順位なし(空配列)の走だけは null", runs: [run([], 16), run([], 14)], expected: null },
    { name: "通過点が 1 つだけの走は採らない(最後=最初になり意味が崩れる)", runs: [run([4], 16)], expected: null },
    { name: "頭数 null の走だけは null", runs: [run([3, 3], null)], expected: null },
    { name: "頭数 1 の走だけは null(相対位置が定まらない)", runs: [run([1, 1], 1)], expected: null },
    { name: "頭数 0 の走だけは null", runs: [run([1, 1], 0)], expected: null },
    { name: "位置が頭数を超える走(不正)は採らない", runs: [run([3, 17], 16)], expected: null },
    { name: "位置が 0 の走(不正)は採らない", runs: [run([3, 0], 16)], expected: null },
    { name: "位置が整数でない走(不正)は採らない", runs: [run([3, 1.5], 16)], expected: null },
    { name: "頭数が整数でない走(不正)は採らない", runs: [run([3, 3], 10.5)], expected: null },
    { name: "1走だけでも採用する(通過点 2 つ。最後の 4/16 = 0.25)", runs: [run([9, 4], 16)], expected: 0.25 },
    { name: "通過点 4 つなら最後(4 コーナー)を使う(4/16 = 0.25)", runs: [run([4, 4, 3, 4], 16)], expected: 0.25 },
    { name: "先頭は 1/頭数、最後尾は 1.0", runs: [run([1, 1], 10), run([10, 10], 10)], expected: 0.55 },
    { name: "2走の平均(2/10 と 6/10 → 0.4)", runs: [run([5, 2], 10), run([5, 6], 10)], expected: 0.4 },
    { name: "新しい順に3走だけ見る(4走目は無視: (0.1+0.2+0.3)/3 = 0.2)", runs: [run([5, 1], 10), run([5, 2], 10), run([5, 3], 10), run([5, 10], 10)], expected: 0.2 },
    {
      name: "採れない走は数に入れず飛ばす(通過順位なし・通過点 1 つ・頭数 null の後ろの3走を見る)",
      runs: [run([], 16), run([5], 16), run([5, 5], null), run([5, 1], 10), run([5, 2], 10), run([5, 3], 10), run([5, 10], 10)],
      expected: 0.2,
    },
    { name: "通過点が 1 つの走を飛ばして次の走を採る(その走が新しくても無視)", runs: [run([1], 10), run([5, 6], 10)], expected: 0.6 },
    { name: "小数3桁に丸める(1/3 → 0.333)", runs: [run([2, 1], 3)], expected: 0.333 },
    { name: "最終コーナーだけを使う(序盤で前にいても無関係。2/16 → 後退して 12/16 = 0.75)", runs: [run([2, 8, 12], 16)], expected: 0.75 },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(computeLatePosition(t.runs)).toBe(t.expected);
    });
  }

  it("序盤の位置とは別の値を返す(同じ戦績で、序盤は先頭の要素・終盤は末尾の要素)", () => {
    const runs = [run([1, 5, 9], 10)];
    expect(computeEarlyPosition(runs)).toBe(0.1);
    expect(computeLatePosition(runs)).toBe(0.9);
  });
});
