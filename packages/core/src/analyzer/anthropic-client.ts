/**
 * Anthropic 実装 — LlmClient を @anthropic-ai/sdk で実装する。
 *
 * 設計方針(タスク指示):
 *  - SDK 呼び出しはこのファイルに閉じ込める。単体テストは「SDKへ渡すパラメータの組み立て」
 *    (buildRequestParams)と「レスポンスからのテキスト抽出」(extractText)を検証できるよう、
 *    純関数として切り出し、実際の送信は注入可能な MessageSender 経由にする。
 *  - モデルは config で指定可能。デフォルトは仕様どおり claude-sonnet-4-6。
 *  - max_tokens・temperature も config で調整可能。
 *  - APIキー未設定でもインスタンス化はエラーにしない。SDK クライアントは complete() 呼び出し時に
 *    遅延生成するため、キーの解決失敗は「呼び出し時」に初めて発生する。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./analyze-race.js";
import { AnalyzerTruncationError } from "./parse-response.js";

/** analyzer(Anthropic呼び出し)の設定。 */
export interface AnalyzerConfig {
  /** 使用するモデルID(既定: claude-sonnet-4-6)。 */
  readonly model: string;
  /** 応答の最大トークン数。 */
  readonly maxTokens: number;
  /** サンプリング温度(claude-sonnet-4-6 は指定可)。 */
  readonly temperature: number;
  /**
   * 補正の最大幅(prior からの絶対値)。既定0.10(仕様「±10%以内」を絶対値0.10と解釈)。
   *
   * 注意(タスクD-2で判明した設計上の記録): この値は AnthropicLlmClient.complete() 内では
   * 一切参照されない(実際のクリップは parseAnalyzerResponse が受け取る
   * AnalyzeRaceDeps.maxAdjust〈analyze-race.ts〉で行われ、そちらは呼び出し側〈pipeline-deps.ts〉が
   * clip-variants.ts の CLIP_VARIANTS から別途解決して渡す設計にした)。このフィールドは
   * 後方互換のために残すが、実際のクリップ幅制御には使われない(デッド。将来削除を検討)。
   */
  readonly maxAdjust: number;
  /** APIキー(省略時は環境変数 ANTHROPIC_API_KEY)。 */
  readonly apiKey?: string;
}

/**
 * 既定の analyzer 設定。モデルは仕様指定の claude-sonnet-4-6。
 * temperature=0 は補正の再現性を高めるための既定(チューニング対象)。
 *
 * maxTokens=8192(2026-07-19改定): 旧値2048は誤りだった。予想印(mark)+馬ごとの和文根拠(reason)を
 * 追加した現行スキーマでは、18頭分の応答が実測で2048トークン付近に達し、実際に小倉記念18頭で
 * 応答がmax_tokensで切り詰められ→JSON破損→パース失敗が2回続いて全馬prior採用になる事故が発生した
 * (fallbackReason/stop_reasonが可視化されていなかったため原因特定が遅れた。可視化は
 * analyze-race.ts/analysis-pipeline.ts側で別途対応)。8192は実測(概算1500〜2700トークン)の
 * 3〜6倍の余裕を持つ値として採用する。16384ではなく8192を選んだ理由: このクライアントは
 * ストリーミングを行わない `messages.create` を使っている。claude-api skill(Anthropic API
 * リファレンス)の記載では、非ストリーミング呼び出しで max_tokens が概ね16000を超えると
 * SDKのHTTPタイムアウトが起きうる目安とされており(この数値自体を本実装で実測検証したもの
 * ではない・出典: 上記skillの案内)、その目安を大きく下回る8192を保守的な安全側の上限とした
 * (ストリーミング化は本改定のスコープ外。将来 reason をさらに長くする等で8192超が必要になった
 * 場合は、ストリーミング化とあわせて要検証)。
 */
export const DEFAULT_ANALYZER_CONFIG: AnalyzerConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  temperature: 0,
  maxAdjust: 0.1,
};

/** SDK の messages.create へ渡す(このモジュールが組み立てる)パラメータ。 */
export interface AnthropicRequestParams {
  /** モデルID。 */
  readonly model: string;
  /** 最大トークン数。 */
  readonly max_tokens: number;
  /** サンプリング温度。 */
  readonly temperature: number;
  /** メッセージ列(analyzer は user 1メッセージのみ)。 */
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
}

/** SDK レスポンスの最小共通形(text抽出に必要な部分のみ)。 */
export interface AnthropicMessageResponse {
  /** コンテンツブロック列(text ブロックのみ使う)。 */
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  /**
   * 応答が停止した理由(SDKの生レスポンスが持つ値をそのまま透過する)。
   * "max_tokens" のときは max_tokens 上限により応答が途中で切り詰められたことを意味し、
   * 本文(content)のJSONが不完全で信頼できない(2026-07-19改定・小倉記念18頭切り詰め事故対応)。
   * 未提供(旧テストのモック等)の場合もあるため optional・null許容にする。
   */
  readonly stop_reason?: string | null;
}

/** パラメータを受け取り Anthropic へ送信してレスポンスを返す関数(注入・モック可能)。 */
export type MessageSender = (
  params: AnthropicRequestParams,
) => Promise<AnthropicMessageResponse>;

/** AnthropicLlmClient の依存(注入)。 */
export interface AnthropicLlmClientDeps {
  /** 実送信関数。省略時は @anthropic-ai/sdk を遅延生成して使う。 */
  readonly sender?: MessageSender;
}

/**
 * プロンプトと設定から SDK 呼び出しパラメータを組み立てる純関数。
 * @param prompt LLMへ渡すプロンプト全文
 * @param config 部分設定(省略項目は DEFAULT_ANALYZER_CONFIG で補完)
 */
export function buildRequestParams(
  prompt: string,
  config: Partial<AnalyzerConfig> = {},
): AnthropicRequestParams {
  const merged = { ...DEFAULT_ANALYZER_CONFIG, ...config };
  return {
    model: merged.model,
    max_tokens: merged.maxTokens,
    temperature: merged.temperature,
    messages: [{ role: "user", content: prompt }],
  };
}

/** レスポンスの text ブロックを連結して1本のテキストにする(text以外は無視)。 */
export function extractText(res: AnthropicMessageResponse): string {
  return res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * LlmClient の Anthropic 実装。SDK 呼び出しはこのクラスに閉じ込める。
 * sender を注入すると SDK に触れずにテストできる(パラメータ組み立ての検証用)。
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly config: AnalyzerConfig;
  private readonly sender: MessageSender;

  constructor(config: Partial<AnalyzerConfig> = {}, deps: AnthropicLlmClientDeps = {}) {
    this.config = { ...DEFAULT_ANALYZER_CONFIG, ...config };
    // sender 未注入なら、SDK クライアントを遅延生成する既定 sender を組み立てる
    // (ここでは生成しない = APIキー未設定でもインスタンス化はエラーにしない)。
    this.sender = deps.sender ?? this.createDefaultSender();
  }

  /**
   * プロンプトを送り、LLM の生出力テキストを返す。
   * stop_reason==="max_tokens"(応答が長さ上限で切り詰められた)場合は、本文JSONが不完全で
   * 信頼できないため text を返さず AnalyzerTruncationError を投げる(2026-07-19改定)。
   * analyze-race側はこれを AnalyzerResponseParseError のサブクラスとして受け取り、
   * 通常のリトライ/フォールバック判定に乗せつつ、専用の理由文言・stop_reasonを伝播する。
   */
  async complete(prompt: string): Promise<string> {
    const params = buildRequestParams(prompt, this.config);
    const res = await this.sender(params);
    if (res.stop_reason === "max_tokens") {
      throw new AnalyzerTruncationError(
        "LLM応答が長さ上限(max_tokens)で切り詰められました",
        res.stop_reason,
      );
    }
    return extractText(res);
  }

  /**
   * 既定 sender: 初回呼び出し時に @anthropic-ai/sdk のクライアントを生成する。
   * APIキー未解決の場合、SDK のエラーは「呼び出し時」に発生する(インスタンス化時ではない)。
   */
  private createDefaultSender(): MessageSender {
    let client: Anthropic | null = null;
    const apiKey = this.config.apiKey;
    return async (params) => {
      if (client === null) {
        client = new Anthropic(apiKey === undefined ? {} : { apiKey });
      }
      const res = await client.messages.create({
        model: params.model,
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return res;
    };
  }
}
