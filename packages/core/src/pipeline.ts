/**
 * runAnalysis(`analysis/analysis-pipeline.ts`)が使う core の公開物だけを再 export する**狭い入口**
 * (`@keiba/core/pipeline`。Issue #176〈#164-a〉)。
 *
 * 目的: バレル(`index.ts`)は `cache.ts`・`analysis-store.ts`(better-sqlite3 に依存するネイティブモジュール)を値で巻き込む。
 * クラウド版(`cloud/`。Cloudflare Workers)は runAnalysis を相対 import でバンドルするため、バレルを経由すると
 * better-sqlite3 が解決できずバンドル・型検査が失敗する(実測)。この入口は、**better-sqlite3 に依存するモジュールを
 * 一切(値でも型でも)経由しない**。型は `ev/analysis-store-types.ts`(型だけ)から取る。
 * 検査: `test/ev/native-free-modules.test.ts`(閉包に better-sqlite3 が無いこと)。
 *
 * 追加の基準: runAnalysis の closure(`core/src/analysis/analysis-pipeline.ts`・`allocation-record.ts`・`analysis-export.ts`)が
 * `@keiba/core` から import する名前だけを置く(例外: `buildPromptPreview`。Issue #396 で設定画面のプロンプトのプレビューをサーバが組み立てるようにしたため、
 * `cloud/src/prompt-preview.ts` が使う。同じ `build-prompt.js` から既に `resolveClipVariant` を再 export しているので、閉包は増えない)。旧 exe の他の部分(pipeline-deps.ts 等。#287 で削除。3c1664e まで)は引き続きバレルを使っていた。
 */

export type {
  AnalyzeRaceResult,
} from "./analyzer/analyze-race.js";

export {
  summarizeBodyWeightTrend,
} from "./analyzer/body-weight-trend.js";

export {
  summarizeBestWeight,
} from "./analyzer/best-weight.js";

export {
  summarizeRestRecord,
} from "./analyzer/rest-record.js";

export {
  buildPromptPreview,
  computeReferenceEv,
  resolveClipVariant,
} from "./analyzer/build-prompt.js";

export type {
  BuildPromptInput,
  ClipVariantId,
} from "./analyzer/build-prompt.js";

export {
  computeConditionChangeTags,
} from "./analyzer/condition-change.js";

export type {
  ConditionChangeRun,
} from "./analyzer/condition-change.js";

export type {
  GradeWinnerConditions,
  GradeWinnerTrendSummary,
} from "./analyzer/grade-winner-trend.js";

export {
  summarizeJockeyChange,
} from "./analyzer/jockey-change.js";

export type {
  JockeyChangePrevRunInput,
} from "./analyzer/jockey-change.js";

export {
  summarizeMarginTrend,
} from "./analyzer/margin-trend.js";

export {
  summarizeMarketGap,
} from "./analyzer/market-gap.js";

export type {
  PredictionMark,
} from "./analyzer/parse-response.js";

export {
  collectSameDayTrend,
} from "./analyzer/same-day-trend.js";

export {
  assessTurfWear,
} from "./analyzer/turf-wear.js";

export type {
  AnalysisAllocationRecord,
  AnalysisRecord,
  RaceResultDetail,
  AnalysisAllocationMetaRecord,
  AnalysisBetRecord,
  AnalysisMissedBetRecord,
  RaceResultEntry,
  StoredAnalysis,
} from "./ev/analysis-store-types.js";

export {
  computeEstimatedRaceEv,
  computeRaceEv,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
} from "./ev/expected-value.js";

export type {
  EstimatedPlaceConfig,
  EvConfig,
  HorsePrior,
} from "./ev/expected-value.js";

export type {
  ScorerConfig,
} from "./scorer/config.js";

export {
  classifyRotationInterval,
  classifyTrackWetness,
  daysBetweenDates,
} from "./scorer/derive-features.js";

export {
  selectJockeyStats,
} from "./scorer/jockey-stats.js";

export {
  selectTrainerStats,
} from "./scorer/trainer-stats.js";

export {
  buildPriorInput,
  computeFieldPriors,
} from "./scorer/prior.js";

export type {
  PriorInput,
} from "./scorer/prior.js";

export {
  precedingRaceIdsSameDay,
  venueKindOfRaceId,
} from "./scraper/ids.js";

export type {
  KaisaiDate,
  RaceId,
} from "./scraper/ids.js";

export type {
  RaceData,
  ComboOddsScrapeOutcome,
} from "./scraper/scrape-race.js";

export type {
  HorseRaceResult,
} from "./scraper/types.js";
