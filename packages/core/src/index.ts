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
  InvalidIdError,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  type HorseId,
  type KaisaiDate,
  type RaceId,
} from "./scraper/ids.js";
export {
  commentUrl,
  horseResultsApiUrl,
  horseUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  shutubaUrl,
} from "./scraper/urls.js";
export { parseRaceList } from "./scraper/parse-race-list.js";
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
export { OikiriParseError, parseOikiri } from "./scraper/parse-oikiri.js";
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
