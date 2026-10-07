/**
 * Anthropic 実装 — LlmClient を @anthropic-ai/sdk で実装する。
 *
 * 設計方針(タスク指示):
 *  - SDK 呼び出しはこのファイルに閉じ込める。単体テストは「SDKへ渡すパラメータの組み立て」
 *    (buildRequestParams)と「レスポンスからのテキスト抽出」(extractText)を検証できるよう、
 *    純関数として切り出し、実際の送信は注入可能な MessageSender 経由にする。
 *  - モデルは config で指定可能。既定(固定)モデルは claude-sonnet-5-5(Issue #157)。
 *    modelSelector を注入すると、Models API から選んだ最新 Sonnet を使い、400/403/404 のときだけ
 *    固定モデルで1回やり直す(model-selection.ts)。
 *  - max_tokens・effort も config で調整可能。temperature は送らない(Sonnet 5.5 は既定値以外を拒否する)。
 *  - APIキー未設定でもインスタンス化はエラーにしない。SDK クライアントは complete() 呼び出し時に
 *    遅延生成するため、キーの解決失敗は「呼び出し時」に初めて発生する。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmCompletion } from "./analyze-race.js";
import type { ModelSelector } from "./model-selection.js";
import { AnalyzerRefusalError, AnalyzerTruncationError } from "./parse-response.js";

/**
 * 推論の深さ(output_config.effort)。SDK 0.70.1 の型には無いため、型の外(キャスト)で送る。
 * Claude Sonnet 5.5 が受け付ける値。
 */
export type AnalyzerEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** analyzer(Anthropic呼び出し)の設定。 */
export interface AnalyzerConfig {
  /** 使用するモデルID。自動選択を使わない場合の送信先、自動選択を使う場合の固定モデル(既定: claude-sonnet-5-5)。 */
  readonly model: string;
  /** 応答の最大トークン数(thinking を含む)。 */
  readonly maxTokens: number;
  /**
   * 推論の深さ(output_config.effort。既定 "low")。設定から変えられるようにする(Issue #158)ための口。
   * temperature は削除した(Claude Sonnet 5.5 は既定値以外の temperature を 400 で拒否する)。
   */
  readonly effort: AnalyzerEffort;
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
 * 既定の analyzer 設定(Issue #157 で claude-sonnet-4-6 → claude-sonnet-5-5 へ移行)。
 *
 * model: 動作確認済みの固定モデル。自動選択(model-selection.ts)の失敗時・降格時の送信先でもある。
 *
 * maxTokens=16000: thinking(既定の adaptive)を含む出力の上限。旧値8192は、予想印+馬ごとの和文根拠を
 * 加えた現行スキーマで18頭分の応答が2048トークン付近に達した小倉記念の切り詰め事故(2026-07-19)を
 * 踏まえた値だったが、Sonnet 5.5 では thinking の出力トークンも max_tokens に数えられるため
 * 16000 に引き上げた。非ストリーミング(`messages.create`)のまま使うので、SDK 0.70.1 が
 * 非ストリーミングで例外を投げる 21333 を超えない値に留める
 * (`node_modules/@anthropic-ai/sdk/client.js` の _calculateNonstreamingTimeout が、
 * 想定所要時間 3600×max_tokens/128000 秒が 600 秒以上になる max_tokens で投げる。
 * 600×128000/3600 = 21333.3…)。ストリーミング化は本改定のスコープ外。
 *
 * effort="low": ユーザー判断(2026-10-03)。thinking を含む出力トークンの実測は実 API が要るため、
 * 実装後にユーザー承認を得て行う。
 */
export const DEFAULT_ANALYZER_CONFIG: AnalyzerConfig = {
  model: "claude-sonnet-5-5",
  maxTokens: 16000,
  effort: "low",
  maxAdjust: 0.1,
};

/** SDK の messages.create へ渡す(このモジュールが組み立てる)パラメータ。 */
export interface AnthropicRequestParams {
  /** モデルID。 */
  readonly model: string;
  /** 最大トークン数。 */
  readonly max_tokens: number;
  /** 推論の深さ。SDK の型に無いため型の外で送る。temperature・thinking は送らない。 */
  readonly output_config: { readonly effort: AnalyzerEffort };
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
  /**
   * 実際に応答したモデルID(SDK のレスポンスが持つ値。Issue #157)。使ったモデルの記録に使う。
   * 未提供(旧テストのモック等)の場合はリクエストしたモデルIDで代用する。
   */
  readonly model?: string;
  /**
   * 使用量(SDK のレスポンスが持つ値。Issue #197・段2)。入力・出力トークン数だけを型に持つ(SDK の usage にはほかに cache 系などがある)。
   * **`output_tokens` は thinking を含む**(max_tokens=16000 の中に数えられるので、見える出力だけの量は分からない)。
   * 未提供(旧テストのモック等)の場合もあるため optional。呼び出しの記録(cloud の `llm-run.ts`)が読む。
   */
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

/** パラメータを受け取り Anthropic へ送信してレスポンスを返す関数(注入・モック可能)。 */
export type MessageSender = (
  params: AnthropicRequestParams,
) => Promise<AnthropicMessageResponse>;

/** AnthropicLlmClient の依存(注入)。 */
export interface AnthropicLlmClientDeps {
  /** 実送信関数。省略時は @anthropic-ai/sdk を遅延生成して使う。 */
  readonly sender?: MessageSender;
  /**
   * モデルの自動選択(Issue #157)。省略時は config.model をそのまま使う(従来どおり)。
   * 1レースごとに new されるクライアントをまたいで状態(取得結果・降格)を共有するため、
   * 呼び出し側(createPipelineDeps)が1つ作って渡す。
   */
  readonly modelSelector?: ModelSelector;
  /** 固定モデルへの切り替えを記録する先(省略時は何も記録しない)。 */
  readonly onWarn?: (message: string) => void;
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
    output_config: { effort: merged.effort },
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

/** 自動選択モデルから固定モデルへ切り替える HTTP ステータス(拒否・権限・存在しない)。 */
const SWITCH_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

/**
 * エラーが「自動選択モデルの拒否」を意味するか(HTTP 400 / 403 / 404)。
 * 401(認証)・429(レート制限)・5xx・ネットワーク(status なし)は、モデルを変えても直らない
 * (または一時的な障害)ため切り替えない。
 */
function isModelRejection(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && SWITCH_STATUSES.has(status);
}

/**
 * LlmClient の Anthropic 実装。SDK 呼び出しはこのクラスに閉じ込める。
 * sender を注入すると SDK に触れずにテストできる(パラメータ組み立ての検証用)。
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly config: AnalyzerConfig;
  private readonly sender: MessageSender;
  private readonly modelSelector: ModelSelector | undefined;
  private readonly onWarn: ((message: string) => void) | undefined;

  constructor(config: Partial<AnalyzerConfig> = {}, deps: AnthropicLlmClientDeps = {}) {
    this.config = { ...DEFAULT_ANALYZER_CONFIG, ...config };
    // sender 未注入なら、SDK クライアントを遅延生成する既定 sender を組み立てる
    // (ここでは生成しない = APIキー未設定でもインスタンス化はエラーにしない)。
    this.sender = deps.sender ?? createSdkMessageSender({ apiKey: this.config.apiKey });
    this.modelSelector = deps.modelSelector;
    this.onWarn = deps.onWarn;
  }

  /** プロンプトを送り、LLM の生出力テキストを返す(completeDetailed の text のみ)。 */
  async complete(prompt: string): Promise<string> {
    return (await this.completeDetailed(prompt)).text;
  }

  /**
   * プロンプトを送り、LLM の生出力テキストと実際に使ったモデルを返す(Issue #157)。
   *
   * モデル: modelSelector があれば自動選択(最新 Sonnet)を使う。自動選択モデルが HTTP 400/403/404 を
   * 返したときだけ、selector を降格して固定モデルで1回やり直す(固定モデルと同じなら、やり直さない)。
   * 401・429・5xx・ネットワーク・refusal・max_tokens では切り替えない。
   * 返す model はレスポンスの model を優先し、無ければリクエストしたモデルID。
   *
   * stop_reason==="max_tokens"(応答が長さ上限で切り詰められた)場合は、本文JSONが不完全で
   * 信頼できないため text を返さず AnalyzerTruncationError を投げる(2026-07-19改定)。
   * stop_reason==="refusal"(安全分類器による拒否)は AnalyzerRefusalError を投げる(Issue #157)。
   * analyze-race側はどちらも AnalyzerResponseParseError のサブクラスとして受け取り、通常の
   * リトライ/フォールバック判定に乗せつつ、専用の理由文言・stop_reasonを伝播する。
   */
  async completeDetailed(prompt: string): Promise<LlmCompletion> {
    const selector = this.modelSelector;
    if (selector === undefined) {
      return this.sendOnce(prompt, this.config.model);
    }
    const model = await selector.resolve();
    try {
      return await this.sendOnce(prompt, model);
    } catch (e) {
      if (model !== selector.fixedModel && isModelRejection(e)) {
        selector.demote();
        const status = (e as { status: number }).status;
        this.onWarn?.(
          `自動選択したモデル(${model})が HTTP ${status} で拒否されたため、固定モデル(${selector.fixedModel})に切り替えます`,
        );
        return this.sendOnce(prompt, selector.fixedModel);
      }
      throw e;
    }
  }

  /** 指定モデルで1回送信し、停止理由を検査してテキストと使用モデルを返す。 */
  private async sendOnce(prompt: string, model: string): Promise<LlmCompletion> {
    const params = buildRequestParams(prompt, { ...this.config, model });
    const res = await this.sender(params);
    if (res.stop_reason === "max_tokens") {
      throw new AnalyzerTruncationError(
        "LLM応答が長さ上限(max_tokens)で切り詰められました",
        res.stop_reason,
        res.model ?? model,
      );
    }
    if (res.stop_reason === "refusal") {
      throw new AnalyzerRefusalError(
        "LLMが応答を拒否しました(stop_reason: refusal)",
        res.stop_reason,
        res.model ?? model,
      );
    }
    return { text: extractText(res), model: res.model ?? model };
  }
}

/** createSdkMessageSender の引数。 */
export interface SdkMessageSenderOptions {
  /** APIキー(省略時は環境変数 ANTHROPIC_API_KEY)。 */
  readonly apiKey?: string;
  /** fetch の差し替え(テスト用。実 API を呼ばずにリクエスト本文を検証する)。 */
  readonly fetch?: typeof fetch;
  /**
   * 1リクエストの上限時間(ミリ秒。Issue #193)。省略時は SDK の既定(10 分)のまま(exe はこれを渡さない)。
   * クラウド版(DO のアラーム)が、応答を際限なく待たないために渡す。
   */
  readonly timeout?: number;
  /**
   * SDK が内部で行う再試行の回数(Issue #193)。省略時は SDK の既定(2 回。つまり HTTP は最大3本)のまま
   * (exe はこれを渡さない)。0 は再試行しない。`analyzeRace` がすでに1回再送するので、
   * クラウド版は 0 を渡して HTTP の本数を抑える。
   */
  readonly maxRetries?: number;
}

/**
 * 既定 sender: 初回呼び出し時に @anthropic-ai/sdk のクライアントを生成する。
 * APIキー未解決の場合、SDK のエラーは「呼び出し時」に発生する(インスタンス化時ではない)。
 *
 * output_config(effort)は SDK 0.70.1 の型に無いが、SDK はリクエスト本文をそのまま送る
 * (テストで fetch を差し替えて本文に載ることを確認している)。SDK の更新は別途判断(#157)なので、
 * ここでは型の外(キャスト)で渡す。temperature・thinking は送らない。
 */
export function createSdkMessageSender(options: SdkMessageSenderOptions = {}): MessageSender {
  let client: Anthropic | null = null;
  return async (params) => {
    if (client === null) {
      client = new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      });
    }
    const body = {
      model: params.model,
      max_tokens: params.max_tokens,
      output_config: params.output_config,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    const res = await client.messages.create(
      body as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );
    return res;
  };
}
