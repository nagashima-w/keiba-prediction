// @keiba/core のエントリポイント。実装が進むにつれて公開APIをここから再エクスポートする。
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  HttpClient,
  HttpError,
  type FetchLike,
  type FetchResponse,
  type FetchTextOptions,
  type HttpClientOptions,
  type SupportedEncoding,
} from "./scraper/http-client.js";
export {
  CachedFetcher,
  ScrapeCache,
  type CacheEntry,
  type CachedFetcherOptions,
  type CachedFetchTextOptions,
  type NowFn,
  type ScrapeCacheGetOptions,
  type ScrapeCacheOptions,
  type TextFetcher,
} from "./scraper/cache.js";
export {
  centralVenueInfoFromRaceId,
  InvalidIdError,
  kaisaiDateFromNarRaceId,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  siblingRaceIdsSameDay,
  venueKindOfRaceId,
  type CentralVenueInfo,
  type HorseId,
  type KaisaiDate,
  type RaceId,
  type RaceIdVenueKind,
} from "./scraper/ids.js";
export {
  commentUrl,
  horseResultsApiUrl,
  horseUrl,
  narOddsPageUrl,
  narRaceListSubUrl,
  NarUnsupportedError,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  raceResultUrl,
  shutubaUrl,
} from "./scraper/urls.js";
export { parseRaceList } from "./scraper/parse-race-list.js";
export { filterJpnOnlyEntries, isJpnGrade } from "./scraper/jpn-grade.js";
export { enumerateDates } from "./scraper/enumerate-dates.js";
export {
  validatePeriodInput,
  type PeriodInputValidationResult,
} from "./scraper/validate-period-input.js";
export { parseShutuba, ShutubaParseError } from "./scraper/parse-shutuba.js";
export {
  HorseProfileParseError,
  parseHorseProfile,
} from "./scraper/parse-horse-profile.js";
export {
  HorseResultsParseError,
  parseHorseResults,
} from "./scraper/parse-horse-results.js";
export { OddsParseError, parseOdds } from "./scraper/parse-odds.js";
export { NarOddsParseError, parseNarOdds } from "./scraper/parse-nar-odds.js";
export {
  parseRaceResult,
  RaceResultNotConfirmedError,
  RaceResultParseError,
} from "./scraper/parse-race-result.js";
export { OikiriParseError, parseOikiri } from "./scraper/parse-oikiri.js";
export {
  DEFAULT_ODDS_TTL_MS,
  DEFAULT_OIKIRI_TTL_MS,
  DEFAULT_RACE_LIST_TTL_MS,
  DEFAULT_RESULTS_TTL_MS,
  DEFAULT_SHUTUBA_TTL_MS,
  listNarRaces,
  listRaces,
  scrapeRace,
  type RaceData,
  type RaceDataMeta,
  type RaceFetcher,
  type RaceHorseData,
  type ScrapeDeps,
  type ScrapeRaceOptions,
  type ScrapeTtlConfig,
  type ScrapeWarning,
  type ScrapeWarningKind,
} from "./scraper/scrape-race.js";
export {
  DEFAULT_CACHE_DB,
  parseCliArgs,
  type CliCommand,
  type DateDumpCommand,
  type RaceDumpCommand,
} from "./scraper/cli.js";
export {
  classifyFrameZone,
  classifyRotationInterval,
  classifySeason,
  classifyTrackWetness,
  daysBetweenDates,
  deriveRaceFeatures,
  isPlaced,
  REST_MIN_DAYS,
  SHORT_ROTATION_MAX_DAYS,
  type DerivedRaceFeature,
  type FrameZone,
  type PlacedResult,
  type RotationInterval,
  type Season,
  type TrackWetness,
} from "./scorer/derive-features.js";
export {
  aggregatePlaceRate,
  computeDifferenceCorrection,
  type BiasContribution,
  type DifferenceCorrectionParams,
  type PlaceRateAggregate,
} from "./scorer/aggregate.js";
export {
  DEFAULT_SCORER_CONFIG,
  type BaseScoreConfig,
  type BaseScoreWeights,
  type BiasWeights,
  type PriorConfig,
  type RotationBiasConfig,
  type ScorerConfig,
  type SummerFatigueConfig,
  type TransportBiasConfig,
  type VenueBiasConfig,
} from "./scorer/config.js";
export {
  COURSE_TRAITS,
  courseSimilarity,
  isCentralVenue,
  type CourseTraits,
  type TurfKind,
  type TurnDirection,
} from "./scorer/course-traits.js";
export {
  computeTrackConditionBias,
  type TrackConditionInput,
} from "./scorer/bias-track-condition.js";
export {
  computeVenueBias,
  type VenueBiasContribution,
  type VenueBiasKind,
  type VenueInput,
} from "./scorer/bias-venue.js";
export {
  computeSeasonBias,
  computeSummerFatigueBias,
  type SeasonInput,
  type SummerFatigueContribution,
} from "./scorer/bias-season.js";
export {
  computeFrameBias,
  type FrameInput,
} from "./scorer/bias-frame.js";
export {
  classifyTransportLoad,
  computeTransportBias,
  type TransportBiasContribution,
  type TransportInput,
  type TransportKind,
  type TransportLoad,
} from "./scorer/bias-transport.js";
export {
  buildRotationCurve,
  classifyRotationType,
  computeRotationBias,
  type RotationBiasContribution,
  type RotationCurve,
  type RotationInput,
  type RotationTypeFlags,
} from "./scorer/bias-rotation.js";
export {
  COURSE_FRAME_BIAS_TABLE,
  courseFrameBiasValue,
  type CourseFrameBiasRow,
} from "./scorer/frame-bias-table.js";
export {
  computeBaseScore,
  computeCourseDistanceScore,
  computeCourseFrameBiasScore,
  computeJockeyScore,
  computeLast3fScore,
  computeRecentFormScore,
  computeWeightChangeScore,
  type BaseScoreContribution,
  type BaseScoreInput,
  type BaseScoreResult,
  type CourseDistanceInput,
  type CourseFrameInput,
  type JockeyCourseStats,
  type WeightChangeInput,
} from "./scorer/base-score.js";
export {
  buildPriorInput,
  computeFieldPriors,
  computePrior,
  type BuildPriorInputArgs,
  type BuildPriorRaceInfo,
  type PriorInput,
  type PriorResult,
  type ScoreContribution,
  type TodayRaceConditions,
} from "./scorer/prior.js";
export {
  computeEstimatedRaceEv,
  computeRaceEv,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
  estimatePlaceOddsMinFromWin,
  type EstimatedHorseEv,
  type EstimatedPlaceConfig,
  type EvConfig,
  type HorseEv,
  type HorsePrior,
} from "./ev/expected-value.js";
export {
  computeRaceOpportunity,
  DEFAULT_RACE_OPPORTUNITY_CONFIG,
  type RaceOddsStatus,
  type RaceOpportunity,
  type RaceOpportunityBestPick,
  type RaceOpportunityConfig,
  type RaceOpportunityHorse,
  type RaceOpportunityMeta,
} from "./ev/race-opportunity.js";
export {
  AnalysisStore,
  type AnalysisFilter,
  type AnalysisHorseRecord,
  type AnalysisRecord,
  type AnalysisStoreOptions,
  type RaceResultDetail,
  type RaceResultDetailHorse,
  type RaceResultEntry,
  type StoredAnalysis,
  type StoredAnalysisHorse,
} from "./ev/analysis-store.js";
export {
  computeRaceLedger,
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  DEFAULT_VERIFY_CONFIG,
  type AdjustmentDirection,
  type CalibrationBiasBin,
  type CalibrationBin,
  type DirectionGroupStat,
  type MarkStat,
  type PromptVersionVerifyReport,
  type RaceBreakdown,
  type RaceBreakdownHorse,
  type RaceLedgerEntry,
  type VerifyBetSummary,
  type VerifyConfig,
  type VerifyReport,
  type VerifyTrendReport,
  type VerifyVenueFilter,
} from "./ev/verify.js";
export {
  analyzeHorseLegStyle,
  buildRaceDevelopment,
  classifyHorseLegStyle,
  classifyHorseLegStyleFull,
  classifyRunLegStyle,
  classifyRunLegStyleFull,
  computeFrontRunningScore,
  computeLegStyleStability,
  countFrontRunners,
  estimatePace,
  summarizePastPaceTendency,
  type ClassifyHorseOptions,
  type HorseLegStyleAnalysis,
  type HorseRunPassing,
  type LegStyle,
  type LegStyleStability,
  type PaceEstimate,
  type RaceDevelopment,
  type RaceDevelopmentHorseInput,
  type RunLegStyleDetail,
} from "./analyzer/leg-style.js";
export {
  computeConditionChangeTags,
  DISTANCE_CHANGE_LOOKBACK_RUNS,
  DISTANCE_CHANGE_THRESHOLD_METERS,
  type ConditionChangeInput,
  type ConditionChangeRun,
  type ConditionChangeTag,
  type ConditionChangeTagKind,
} from "./analyzer/condition-change.js";
export {
  collectSameDayTrend,
  summarizeSameDayTrend,
  type ClosingTrend,
  type InOutTrend,
  type PaceLeaningTrend,
  type SameDayTrendRace,
  type SameDayTrendRaceDetailHorseLike,
  type SameDayTrendRaceDetailLike,
  type SameDayTrendRaceHorse,
  type SameDayTrendSampleSize,
  type SameDayTrendSummary,
} from "./analyzer/same-day-trend.js";
export { assessTurfWear, type TurfWearHint } from "./analyzer/turf-wear.js";
export {
  summarizeBodyWeightTrend,
  type BodyWeightTrendLabel,
  type BodyWeightTrendSummary,
  type BodyWeightTrendToday,
  type SummarizeBodyWeightTrendOptions,
} from "./analyzer/body-weight-trend.js";
export {
  summarizeMarketGap,
  type MarketGapJudgement,
  type MarketGapPastRun,
  type MarketGapRun,
  type MarketGapSummary,
  type MarketGapTrendLabel,
  type SummarizeMarketGapOptions,
} from "./analyzer/market-gap.js";
export {
  summarizeJockeyChange,
  type JockeyChangeBasis,
  type JockeyChangeCategory,
  type JockeyChangePrevRunInput,
  type JockeyChangeSummary,
  type JockeyChangeTodayInput,
} from "./analyzer/jockey-change.js";
export {
  buildPrompt,
  buildPromptPreview,
  CLIP_VARIANTS,
  clipAbsoluteLabel,
  clipPercentLabel,
  computeReferenceEv,
  DEFAULT_CLIP_VARIANT_ID,
  PROMPT_VERSION,
  resolveClipVariant,
  type BuildPromptInput,
  type BuildPromptRaceInfo,
  type ClipVariant,
  type ClipVariantId,
  type PromptHorse,
  type PromptOikiri,
} from "./analyzer/build-prompt.js";
export {
  AnalyzerMarkViolationError,
  AnalyzerResponseParseError,
  AnalyzerTruncationError,
  extractJsonObject,
  MAX_ADJUST,
  parseAnalyzerResponse,
  PREDICTION_MARKS,
  type ParseAnalyzerOptions,
  type ParseAnalyzerResult,
  type ParsedHorseResult,
  type PredictionMark,
  type PriorRef,
} from "./analyzer/parse-response.js";
export {
  analyzeRace,
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_TRUNCATED,
  type AnalyzeRaceDeps,
  type AnalyzeRaceResult,
  type LlmClient,
} from "./analyzer/analyze-race.js";
export {
  AnthropicLlmClient,
  buildRequestParams,
  DEFAULT_ANALYZER_CONFIG,
  extractText,
  type AnalyzerConfig,
  type AnthropicLlmClientDeps,
  type AnthropicMessageResponse,
  type AnthropicRequestParams,
  type MessageSender,
} from "./analyzer/anthropic-client.js";
export {
  buildAnalysisEmbed,
  DEFAULT_DISCORD_TIMEOUT_MS,
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_TITLE_MAX,
  DiscordNotifyError,
  isDiscordWebhookUrl,
  parseRetryAfterMs,
  sendDiscordNotification,
  truncate,
  type DiscordEmbed,
  type DiscordFetchLike,
  type DiscordFetchResponse,
  type DiscordPayload,
  type EmbedHorse,
  type EmbedRaceInfo,
  type SendDiscordDeps,
} from "./notify/discord.js";
export type {
  BodyWeight,
  CourseType,
  FinishPosition,
  HorseProfile,
  HorseRaceResult,
  OddsSnapshot,
  OikiriEntry,
  OikiriResult,
  OikiriSkippedRow,
  PlaceOdds,
  RaceListEntry,
  RacePayoutEntry,
  RaceResult,
  RaceResultHorse,
  RaceVenue,
  Shutuba,
  ShutubaHorse,
  ShutubaRaceInfo,
  StableLocation,
  VenueKind,
  WinOdds,
} from "./scraper/types.js";
// 注: フィクスチャ取得の純粋ロジック(parseFetchArgs / planFixtureTargets)は
// 取得スクリプト専用の内部ユーティリティであり、ライブラリの公開APIには含めない。
// scripts/fetch-fixtures.ts は ./scraper/fixture-plan.js を直接importする。
