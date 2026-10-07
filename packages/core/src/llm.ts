/**
 * LLM(`@anthropic-ai/sdk`)の呼び出しに使う core の公開物だけを再 export する**狭い入口**
 * (`@keiba/core/llm`。Issue #193〈#179-a〉)。
 *
 * 目的: クラウド版(`cloud/`。Cloudflare Workers)の発走前の分析が、LLM を呼ぶために使う。
 * バレル(`index.ts`)は `cache.ts`・`analysis-store.ts`(better-sqlite3 に依存するネイティブモジュール)を値で巻き込むので、
 * クラウド版は経由できない(`pipeline.ts` と同じ理由)。この入口は、**better-sqlite3 に依存するモジュールを一切(値でも型でも)経由しない**。
 * 検査: `test/ev/native-free-modules.test.ts`(閉包に better-sqlite3 が無いこと)。
 *
 * `pipeline.ts` に足さない理由: `pipeline.ts` は runAnalysis の入口(型と純関数だけ)で、SDK を値で巻き込まない。
 * SDK を使う入口を別にして、SDK がバンドルに入る経路を「この入口を import したとき」だけに限る。
 * clipVariant の解決(`resolveClipVariant`)は `pipeline.ts` から取る(ここでは再 export しない)。
 *
 * 追加の基準: クラウド版が LLM の実行(sender・モデル選択・analyzeRace)で使う名前だけを置く。exe は引き続きバレルを使う。
 */

export {
  analyzeRace,
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_REFUSED,
  FALLBACK_REASON_TRUNCATED,
} from "./analyzer/analyze-race.js";

export type {
  AnalyzeRaceDeps,
  AnalyzeRaceResult,
  LlmClient,
  LlmCompletion,
} from "./analyzer/analyze-race.js";

export {
  AnthropicLlmClient,
  createSdkMessageSender,
  DEFAULT_ANALYZER_CONFIG,
} from "./analyzer/anthropic-client.js";

export type {
  AnalyzerConfig,
  AnthropicLlmClientDeps,
  AnthropicMessageResponse,
  AnthropicRequestParams,
  MessageSender,
  SdkMessageSenderOptions,
} from "./analyzer/anthropic-client.js";

export {
  createModelSelector,
  createSdkModelLister,
} from "./analyzer/model-selection.js";

export type {
  ModelInfoLite,
  ModelLister,
  ModelSelector,
  SdkModelListerOptions,
} from "./analyzer/model-selection.js";
