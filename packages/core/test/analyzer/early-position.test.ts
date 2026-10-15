/**
 * スタート直後の位置の指標 `computeEarlyPosition`(Issue #311。レース再生の演出用)。
 * 新しい順に最大3走(第1コーナーの通過順位 ÷ 出走頭数)を平均する。0〜1 で小さいほど前。判定不能は null。
 */
import { describe, expect, it } from "vitest";
import { computeEarlyPosition, EARLY_POSITION_RUNS, summarizeEarlyPosition } from "../../src/analyzer/early-position.js";

type Run = { readonly passing: number[]; readonly entryCount: number | null };
const run = (passing: number[], entryCount: number | null): Run => ({ passing, entryCount });

describe("computeEarlyPosition(第1コーナーの相対位置の平均)", () => {
  it("前提: 参照する走数は3", () => {
    expect(EARLY_POSITION_RUNS).toBe(3);
  });

  const table: ReadonlyArray<{ readonly name: string; readonly runs: readonly Run[] | null; readonly expected: number | null }> = [
    { name: "戦績が null(取得失敗)は null", runs: null, expected: null },
    { name: "戦績が空(初出走)は null", runs: [], expected: null },
    { name: "通過順位なし(空配列)の走だけは null", runs: [run([], 16), run([], 14)], expected: null },
    { name: "頭数 null の走だけは null", runs: [run([3, 3], null)], expected: null },
    { name: "頭数 1 の走だけは null(相対位置が定まらない)", runs: [run([1], 1)], expected: null },
    { name: "頭数 0 の走だけは null", runs: [run([1], 0)], expected: null },
    { name: "位置が頭数を超える走(不正)は採らない", runs: [run([17], 16)], expected: null },
    { name: "位置が 0 の走(不正)は採らない", runs: [run([0], 16)], expected: null },
    { name: "位置が整数でない走(不正)は採らない", runs: [run([1.5], 16)], expected: null },
    { name: "1走だけでも採用する(4/16 = 0.25)", runs: [run([4, 4, 3, 3], 16)], expected: 0.25 },
    { name: "先頭は 1/頭数、最後尾は 1.0", runs: [run([1], 10), run([10], 10)], expected: 0.55 },
    { name: "2走の平均(2/10 と 6/10 → 0.4)", runs: [run([2], 10), run([6], 10)], expected: 0.4 },
    { name: "新しい順に3走だけ見る(4走目は無視: (0.1+0.2+0.3)/3 = 0.2)", runs: [run([1], 10), run([2], 10), run([3], 10), run([10], 10)], expected: 0.2 },
    {
      name: "採れない走は数に入れず飛ばす(通過順位なし・頭数 null の後ろの3走を見る)",
      runs: [run([], 16), run([5], null), run([1], 10), run([2], 10), run([3], 10), run([10], 10)],
      expected: 0.2,
    },
    { name: "小数3桁に丸める(1/3 → 0.333)", runs: [run([1], 3)], expected: 0.333 },
    { name: "第1コーナー(passing[0])だけを使う(道中で後退しても無関係)", runs: [run([2, 8, 12], 16)], expected: 0.125 },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(computeEarlyPosition(t.runs)).toBe(t.expected);
    });
  }
});

describe("summarizeEarlyPosition(位置と、平均に使った走数。Issue #315 のプロンプトの『テンの位置』用)", () => {
  it("前提: 既定の走数は computeEarlyPosition と同じ(EARLY_POSITION_RUNS)", () => {
    const runs = [run([1], 10), run([2], 10), run([3], 10), run([10], 10)];
    expect(summarizeEarlyPosition(runs)).toEqual({ position: 0.2, runs: 3 });
    expect(summarizeEarlyPosition(runs)!.position).toBe(computeEarlyPosition(runs));
  });

  const table: ReadonlyArray<{ readonly name: string; readonly runs: readonly Run[] | null; readonly maxRuns?: number; readonly expected: { position: number; runs: number } | null }> = [
    { name: "戦績 null は null", runs: null, expected: null },
    { name: "採れる走が無ければ null", runs: [run([], 16), run([3], null)], expected: null },
    { name: "1走だけなら runs=1", runs: [run([4, 4], 16)], expected: { position: 0.25, runs: 1 } },
    { name: "採れない走は数に入れない(runs は採用した走数)", runs: [run([], 16), run([2], 10), run([6], 10)], expected: { position: 0.4, runs: 2 } },
    { name: "maxRuns=2 なら新しい順に 2 走だけ((0.1+0.2)/2 = 0.15)", runs: [run([1], 10), run([2], 10), run([9], 10)], maxRuns: 2, expected: { position: 0.15, runs: 2 } },
    { name: "maxRuns=1 なら直近 1 走だけ", runs: [run([1], 10), run([9], 10)], maxRuns: 1, expected: { position: 0.1, runs: 1 } },
    { name: "maxRuns が 0 以下・非整数なら既定の 3 走(防御)", runs: [run([1], 10), run([2], 10), run([3], 10), run([10], 10)], maxRuns: 0, expected: { position: 0.2, runs: 3 } },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(summarizeEarlyPosition(t.runs, t.maxRuns)).toEqual(t.expected);
    });
  }
});
