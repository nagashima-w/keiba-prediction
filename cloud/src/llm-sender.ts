/**
 * クラウド版の LLM の呼び出しの土台(Issue #193〈#179-a〉。#194〈#179-b〉で `RaceDay`〈`race-day-do.ts`〉が `createCloudLlm` を使う)。
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

/** テスト用の差し替え口(省略時は本番の値・Workers のグローバル fetch)。 */
export interface CloudLlmOptions {
  /** fetch の差し替え(実 API に出ずに検証する)。 */
  readonly fetch?: typeof fetch;
  /**
   * 1リクエストの上限時間(ミリ秒)の差し替え。省略時は本番の値(sender は {@link LLM_REQUEST_TIMEOUT_MS}、モデル一覧は {@link LLM_LIST_TIMEOUT_MS})。
   * 上限時間が SDK に実際に渡っていること(応答しない fetch が、この時間で打ち切られること)をテストで固定するための口(Issue #194)。
   */
  readonly timeoutMs?: number;
}

/** LLM の呼び出しの依存(`RaceDay` に渡す)。`lister` が無ければ、モデルの自動選択をせず、固定モデルで送る。 */
export interface CloudLlm {
  readonly sender: MessageSender;
  readonly lister?: ModelLister;
}

/**
 * メッセージ送信の関数を作る。キーは**前後の空白(改行を含む)を除いて**渡す: ダッシュボードにキーを貼ると末尾に改行が付くことがあり、そのまま x-api-key ヘッダに入れると、
 * 毎回「LLM 呼び出しに失敗」になる(原因が利用者から見えない)。
 */
export function createCloudLlmSender(apiKey: string, options: CloudLlmOptions = {}): MessageSender {
  return createSdkMessageSender({
    apiKey: apiKey.trim(),
    timeout: options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
    maxRetries: LLM_SDK_MAX_RETRIES,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** モデル一覧の取得関数を作る。キーは前後の空白を除いて渡す(理由は {@link createCloudLlmSender})。 */
export function createCloudModelLister(apiKey: string, options: CloudLlmOptions = {}): ModelLister {
  return createSdkModelLister({
    apiKey: apiKey.trim(),
    timeout: options.timeoutMs ?? LLM_LIST_TIMEOUT_MS,
    maxRetries: LLM_SDK_MAX_RETRIES,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/**
 * API キー(Worker の secret `ANTHROPIC_API_KEY`)から、LLM の依存を作る。**キーが無い・空白だけなら undefined**(= LLM を使わない。呼び出し側は、理由を固定文言で残して prior で保存する)。
 * キーはここで sender・lister に渡すだけで、保持も出力もしない。
 */
export function createCloudLlm(apiKey: string | undefined, options: CloudLlmOptions = {}): CloudLlm | undefined {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return undefined;
  }
  const key = apiKey.trim();
  return { sender: createCloudLlmSender(key, options), lister: createCloudModelLister(key, options) };
}
