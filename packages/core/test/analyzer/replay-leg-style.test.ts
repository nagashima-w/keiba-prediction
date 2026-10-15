/**
 * 馬ごとの脚質 `computeReplayLegStyle`(Issue #314。レース再生の隊列を脚質で決めるための材料)。
 * プロンプトの展開想定(`build-prompt.ts` → `analyzeHorseLegStyle`)と同じ分類・同じ参照走数(3)を使う。
 * 入力は戦績(`passing`・`entryCount`)で、プロンプトの経路(`analysis-pipeline.ts` の `runs`)と同じ写し方
 * (`passing` → `passing`、`entryCount` → `fieldSize`)で `analyzeHorseLegStyle` に渡す。
 */
import { describe, expect, it } from "vitest";
import { analyzeHorseLegStyle } from "../../src/analyzer/leg-style.js";
import { computeReplayLegStyle, REPLAY_LEG_STYLE_RUNS } from "../../src/analyzer/replay-leg-style.js";

type Run = { readonly passing: number[]; readonly entryCount: number | null };
const run = (passing: number[], entryCount: number | null): Run => ({ passing, entryCount });

describe("computeReplayLegStyle(脚質。全コーナー版の分類)", () => {
  it("前提: 参照する走数は3(プロンプトの既定 recentRunsForLegStyle と同じ)", () => {
    expect(REPLAY_LEG_STYLE_RUNS).toBe(3);
  });

  const table: ReadonlyArray<{ readonly name: string; readonly runs: readonly Run[] | null; readonly expected: string | null }> = [
    { name: "戦績が null(取得失敗)は null", runs: null, expected: null },
    { name: "戦績が空(初出走)は null", runs: [], expected: null },
    { name: "通過順位なし(空配列)の走だけは null", runs: [run([], 16), run([], 14)], expected: null },
    { name: "第1コーナー先頭で道中も先頭集団 → 逃げ", runs: [run([1, 1, 1, 1], 16), run([1, 2, 1, 1], 14)], expected: "逃げ" },
    { name: "道中の平均が前の3分の1以内 → 先行", runs: [run([3, 3, 2, 2], 16), run([4, 3, 3, 3], 15)], expected: "先行" },
    { name: "道中の平均が中団 → 差し", runs: [run([8, 8, 7, 6], 16), run([7, 7, 7, 6], 15)], expected: "差し" },
    { name: "道中の平均が後ろの3分の1 → 追込", runs: [run([14, 13, 12, 10], 16), run([13, 12, 11, 10], 15)], expected: "追込" },
    { name: "第1コーナーで先頭でも道中に失速した馬は逃げにしない(全コーナー版。道中平均 7.5/16=0.47 → 差し。基本版なら逃げ)", runs: [run([1, 6, 10, 13], 16)], expected: "差し" },
    { name: "頭数が不明な走は絶対位置でフォールバックして分類する(平均 2.5 → 先行)", runs: [run([3, 3, 2, 2], null)], expected: "先行" },
    { name: "新しい順に最大3走だけ見る(4走目の逃げは無視。最頻が追込)", runs: [run([14, 13, 12, 10], 16), run([14, 13, 12, 10], 16), run([8, 8, 7, 6], 16), run([1, 1, 1, 1], 16), run([1, 1, 1, 1], 16)], expected: "追込" },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(computeReplayLegStyle(t.runs)).toBe(t.expected);
    });
  }

  it("プロンプトの分類と一致する: pipeline の写し方(passing・entryCount → fieldSize)で analyzeHorseLegStyle を呼んだ結果と、すべての表の入力で同じ", () => {
    const inputs: (readonly Run[])[] = table.flatMap((t) => (t.runs === null ? [] : [t.runs]));
    expect(inputs.length).toBeGreaterThan(5); // 前提(空振り防止)
    for (const runs of inputs) {
      const viaPrompt = analyzeHorseLegStyle(
        runs.map((r) => ({ passing: r.passing, fieldSize: r.entryCount })),
        { recentRuns: 3 },
      ).style;
      expect(computeReplayLegStyle(runs)).toBe(viaPrompt);
    }
  });
});
