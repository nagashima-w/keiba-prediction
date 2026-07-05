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
