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
  horseUrl,
  newspaperUrl,
  oikiriUrl,
  raceListSubUrl,
} from "./scraper/urls.js";
// 注: フィクスチャ取得の純粋ロジック(parseFetchArgs / planFixtureTargets)は
// 取得スクリプト専用の内部ユーティリティであり、ライブラリの公開APIには含めない。
// scripts/fetch-fixtures.ts は ./scraper/fixture-plan.js を直接importする。
