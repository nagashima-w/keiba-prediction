/**
 * analyzer 本体 — プロンプト構築 → LLM呼び出し(1レース1リクエスト) → パース → 補正後確率。
 *
 * 仕様「3. analyzer」:
 *  - LLMクライアントは注入(LlmClient.complete)。テストはモックのみで実APIは呼ばない。
 *  - フェイルセーフ(仕様L107): JSONパース失敗時は1回だけ同一プロンプトでリトライし、再失敗時は
 *    prior をそのまま採用して fallback:true と理由を返す。LLM呼び出し自体の例外も同様に扱う。
 *  - 出力: 馬ごと {umaban, prior, adjustedProb, reason, clipped, usedPrior} + メタ(fallback有無・リトライ回数)。
 */

import { buildPrompt, type BuildPromptInput } from "./build-prompt.js";
import {
  AnalyzerResponseParseError,
  parseAnalyzerResponse,
  type ParsedHorseResult,
  type PriorRef,
} from "./parse-response.js";

/**
 * analyzer が使う LLM クライアントの最小インターフェース。
 * プロンプト文字列を渡すと、LLMの生出力テキストを返す。実装は anthropic-client.ts。
 */
export interface LlmClient {
  /** プロンプトを送り、LLMの生出力テキストを返す。 */
  complete(prompt: string): Promise<string>;
}

/** analyzeRace の依存(注入)。 */
export interface AnalyzeRaceDeps {
  /** LLMクライアント(注入必須)。 */
  readonly llm: LlmClient;
  /**
   * 補正の最大幅(prior からの絶対値)。省略時は parse-response 既定(MAX_ADJUST=0.10)。
   * 呼び出し側は AnalyzerConfig.maxAdjust をそのまま渡せる。
   */
  readonly maxAdjust?: number;
}

/** analyzeRace の結果(全馬 + メタ)。 */
export interface AnalyzeRaceResult {
  /** 全馬の補正後確率(入力馬番順)。 */
  readonly horses: ParsedHorseResult[];
  /** priorフォールバックに落ちた場合 true。 */
  readonly fallback: boolean;
  /** 実行したリトライ回数(0 or 1)。 */
  readonly retryCount: number;
  /** フォールバックの理由(通常時は null)。 */
  readonly fallbackReason: string | null;
}

/** 全馬を prior のまま採用する(フォールバック用)結果を組み立てる。 */
function priorFallbackHorses(priors: readonly PriorRef[]): ParsedHorseResult[] {
  return priors.map((p) => ({
    umaban: p.umaban,
    prior: p.prior,
    adjustedProb: p.prior,
    reason: null,
    clipped: false,
    usedPrior: true,
  }));
}

/**
 * 1レースを分析する。プロンプトを1回だけ組み立て、LLM呼び出し→パースを最大2回試行する
 * (初回 + パース/例外失敗時に1回リトライ)。2回とも失敗したら prior をそのまま採用して返す。
 * @param input プロンプト構築に必要なレース・全馬情報(prior を含む)
 * @param deps LLMクライアントの注入
 */
export async function analyzeRace(
  input: BuildPromptInput,
  deps: AnalyzeRaceDeps,
): Promise<AnalyzeRaceResult> {
  const priors: PriorRef[] = input.horses.map((h) => ({
    umaban: h.umaban,
    prior: h.prior,
  }));
  const prompt = buildPrompt(input);

  // 初回 + リトライ1回(同一プロンプト)。
  const maxAttempts = 2;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const text = await deps.llm.complete(prompt);
      const parsed = parseAnalyzerResponse(text, priors, {
        maxAdjust: deps.maxAdjust,
      });
      return {
        horses: parsed.horses,
        fallback: false,
        retryCount: attempt, // 成功時: 実施したリトライ回数 = attempt。
        fallbackReason: null,
      };
    } catch (e) {
      // パース失敗・LLM例外いずれも同様に扱い、残り試行があればリトライ。
      lastError = e;
    }
  }

  // 全試行失敗 → prior をそのまま採用(フェイルセーフ)。
  const reason =
    lastError instanceof AnalyzerResponseParseError
      ? `JSONパースに2回失敗したため prior を採用: ${lastError.message}`
      : `LLM呼び出しに2回失敗したため prior を採用: ${errorMessage(lastError)}`;

  return {
    horses: priorFallbackHorses(priors),
    fallback: true,
    retryCount: maxAttempts - 1,
    fallbackReason: reason,
  };
}

/** 未知の例外値から可能な範囲でメッセージを取り出す。 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
