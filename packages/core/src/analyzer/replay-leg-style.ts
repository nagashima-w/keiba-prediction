/**
 * 馬ごとの脚質(Issue #314。レース再生の隊列を脚質で決めるための材料)。
 *
 * プロンプトの展開想定(`build-prompt.ts` の `analyzeHorseLegStyle(h.runs, { recentRuns })`)と**同じ分類**(全コーナー版)・
 * **同じ参照走数(既定 3)**を使う。画面の脚質とプロンプトの脚質を食い違わせないため。
 * 戦績 → `HorseRunPassing` の写し方も、プロンプトの材料を作る `analysis-pipeline.ts` の `runs` と同じ
 * (`passing` → `passing`、`entryCount` → `fieldSize`)。LLM のプロンプト・確率・配分には使わない(画面の演出だけ)。
 */
import { analyzeHorseLegStyle, type LegStyle } from "./leg-style.js";

/** 参照する走数。`build-prompt.ts` の `recentRunsForLegStyle` の既定(3)と同じ(pipeline は上書きしない)。 */
export const REPLAY_LEG_STYLE_RUNS = 3;

/** 脚質の計算に使う戦績の1走分(`HorseRaceResult` の部分。`computeEarlyPosition` の入力と同じ形)。 */
export interface ReplayLegStyleRun {
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。空は不明。 */
  readonly passing: readonly number[];
  /** 出走頭数。取得できなければ null。 */
  readonly entryCount: number | null;
}

/** 戦績(新しい順)から脚質を求める。戦績が null・通過順位が取れる走が無ければ null。 */
export function computeReplayLegStyle(results: readonly ReplayLegStyleRun[] | null): LegStyle | null {
  if (results === null) {
    return null;
  }
  return analyzeHorseLegStyle(
    results.map((r) => ({ passing: r.passing, fieldSize: r.entryCount })),
    { recentRuns: REPLAY_LEG_STYLE_RUNS },
  ).style;
}
