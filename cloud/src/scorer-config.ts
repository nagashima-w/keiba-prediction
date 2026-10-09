import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "../../packages/core/src/scorer/config";
import { SCORING_WEIGHT_FIELDS, type CloudSettings } from "./settings";

/**
 * 設定から core の `ScorerConfig` を組み立てる(Issue #218)。exe の `buildScorerConfig`(`packages/app/src/main/settings-store.ts`)と同じ出力
 * (`DEFAULT_SCORER_CONFIG` へのディープマージ。重み2グループ〈バイアス7・基礎6〉だけ上書きし、prior・minSampleForBias などの他の既定項目は保つ)。
 * 重みの設定のキー(平坦な接頭辞つき)と core の `weights`・`baseScore.weights` の対応は {@link SCORING_WEIGHT_FIELDS} の表による。
 * 同値は `test/scorer-config.test.ts` が exe の `buildScorerConfig` と比べて固定する。
 */
export function buildCloudScorerConfig(settings: CloudSettings): ScorerConfig {
  const bias: Record<string, number> = {};
  const base: Record<string, number> = {};
  for (const { field, group, exeKey } of SCORING_WEIGHT_FIELDS) {
    (group === "bias" ? bias : base)[exeKey] = settings[field];
  }
  return {
    ...DEFAULT_SCORER_CONFIG,
    weights: bias as unknown as ScorerConfig["weights"],
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      weights: base as unknown as ScorerConfig["baseScore"]["weights"],
    },
  };
}
