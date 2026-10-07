/**
 * クラウド版の LLM の呼び出しの土台(Issue #193〈#179-a〉)。**挙動は変えない**: 本番の入口(`worker.ts`)・`RaceDay` からは、まだ呼ばれない(呼び出し元は #194〈#179-b〉)。
 * このモジュールがあるのは、(1) #194 が使う設定値(再試行 0・上限時間あり)を、1か所に決めておくため、
 * (2) cloud/src から SDK(`@anthropic-ai/sdk`)までの import の閉包を実際に辿れる状態にして、`test/import-guard.test.ts`・型検査(CI の配置)・
 * バンドルのガードが SDK の経路を本当に検査できるようにするため。
 *
 * ## 設定値の根拠(実測は workerd + 偽 fetch。Issue #179 の着手前調査)
 * - **再試行 0**: SDK の既定は再試行 2 回(= HTTP 最大 3 本)で、`analyzeRace` もすでに1回再送する。重ねると 1 レースの HTTP が最大 9 本になり、
 *   DO のアラームの中で待つ時間とサブリクエスト数が膨らむ。cloud は SDK の再試行をしない(`analyzeRace` の再送だけに任せる)。
 * - **上限時間 180 秒**(sender): 非ストリーミング・max_tokens 16000 の応答が 120 秒で足りない可能性があるため(ゲートの決定。**暫定値**で、実 API で測ってから調整する)。
 *   最悪(sender の呼び出し 3 回)でも 9 分で、DO のアラームの壁時計の上限(15 分)に収まる。
 * - **モデル一覧の上限 30 秒**: 失敗しても固定モデルに戻るだけなので、長く待たない。
 * 秘密: API キーは呼び出し側(#194 の `race-day-do.ts`)が env から読んで渡す。ここでは保持も出力もしない。
 */
import { createSdkMessageSender, createSdkModelLister, type MessageSender, type ModelLister } from "@keiba/core/llm";

/** sender の1リクエストの上限時間(ミリ秒)。暫定値(実 API で測ってから調整する)。 */
export const LLM_REQUEST_TIMEOUT_MS = 180_000;
/** モデル一覧(Models API)の取得の上限時間(ミリ秒)。 */
export const LLM_LIST_TIMEOUT_MS = 30_000;
/** SDK の内部再試行の回数(cloud はしない)。 */
export const LLM_SDK_MAX_RETRIES = 0;

/** メッセージ送信の関数を作る。`fetchImpl` はテスト用の差し替え(省略時は Workers のグローバル fetch)。 */
export function createCloudLlmSender(apiKey: string, fetchImpl?: typeof fetch): MessageSender {
  return createSdkMessageSender({
    apiKey,
    timeout: LLM_REQUEST_TIMEOUT_MS,
    maxRetries: LLM_SDK_MAX_RETRIES,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

/** モデル一覧の取得関数を作る。`fetchImpl` はテスト用の差し替え。 */
export function createCloudModelLister(apiKey: string, fetchImpl?: typeof fetch): ModelLister {
  return createSdkModelLister({
    apiKey,
    timeout: LLM_LIST_TIMEOUT_MS,
    maxRetries: LLM_SDK_MAX_RETRIES,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
