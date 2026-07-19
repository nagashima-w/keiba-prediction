/**
 * analyzer 本体 — プロンプト構築 → LLM呼び出し(1レース1リクエスト) → パース → 補正後確率。
 *
 * 仕様「3. analyzer」:
 *  - LLMクライアントは注入(LlmClient.complete)。テストはモックのみで実APIは呼ばない。
 *  - フェイルセーフ(仕様L107): JSONパース失敗時は1回だけ同一プロンプトでリトライし、再失敗時は
 *    prior をそのまま採用して fallback:true と理由を返す。LLM呼び出し自体の例外も同様に扱う。
 *  - 出力: 馬ごと {umaban, prior, adjustedProb, reason, clipped, usedPrior} + メタ(fallback有無・リトライ回数)。
 *
 * A(フォールバック分離・2026-07-19合意): 印関連の違反(頭数制約・優先順位・未知の印文字の3種)は、
 * リトライ(同一プロンプトで最大2回試行)してもなお印関連違反(AnalyzerMarkViolationError)なら、
 * その最終試行の確率補正(adjustedProb/clipped/reason)を採用したまま全馬 mark=null で返し、
 * fallback:false・marksDropped:true とする(prior には戻さない)。
 * fallback は「通常時は false」という既存の不変条件(fallbackReason はfallback:trueの時のみ非null)を
 * 崩さないため、印救済でも fallbackReason は null のままにし、印救済の理由は専用の
 * marksDroppedReason フィールドに入れる。
 * 印と無関係な失敗(JSON破損・horses配列なし・有効な補正0件など)は従来どおり
 * priorFallbackHorses で全馬 prior を採用し、fallback:true・marksDropped:false のまま返す。
 */

import { buildPrompt, type BuildPromptInput } from "./build-prompt.js";
import {
  AnalyzerMarkViolationError,
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
  /**
   * フォールバックの理由(通常時は null)。不変条件: fallback:false の場合は必ず null。
   * 印関連違反によるA救済(marksDropped:true)は fallback:false のため、ここは null のままになる
   * (理由は marksDroppedReason に入る)。
   */
  readonly fallbackReason: string | null;
  /**
   * 印関連の違反(頭数・優先順位・未知の印文字)によりリトライ後も印を採用できず、
   * 確率補正のみ採用して全馬 mark=null にした場合 true(A: フォールバック分離・2026-07-19合意)。
   * 下流(pipeline/store/UI)が無改変で動作する既存契約を壊さないため optional にしている
   * (analyzeRace 自身は必ず true/false のいずれかを明示的に返す)。
   */
  readonly marksDropped?: boolean;
  /** marksDropped:true の場合の理由説明(通常時・非印失敗時は null)。 */
  readonly marksDroppedReason?: string | null;
}

/**
 * 全馬を prior のまま採用する(印と無関係な失敗時のフォールバック専用)結果を組み立てる。
 * 予想印(mark)はLLM判断が本質のため機械生成の代替はせず、全馬 null とする(Task#22: ユーザー決定事項)。
 * 印関連違反(頭数・優先順位・未知の印文字)のみの失敗は、この関数を使わず
 * AnalyzerMarkViolationError が運ぶ確率補正済みの horses(既に mark=null)をそのまま採用する
 * (A: フォールバック分離・2026-07-19合意。prior には戻さない)。
 */
function priorFallbackHorses(priors: readonly PriorRef[]): ParsedHorseResult[] {
  return priors.map((p) => ({
    umaban: p.umaban,
    prior: p.prior,
    adjustedProb: p.prior,
    reason: null,
    clipped: false,
    usedPrior: true,
    mark: null,
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
        marksDropped: false,
        marksDroppedReason: null,
      };
    } catch (e) {
      // パース失敗・LLM例外いずれも同様に扱い、残り試行があればリトライ。
      lastError = e;
    }
  }

  // 全試行失敗。最終試行(2回目)の失敗が印関連違反(AnalyzerMarkViolationError)なら、
  // 確率補正(adjustedProb/clipped/reason)は捨てずに全馬 mark=null で採用する(A: フォールバック分離)。
  // fallback:false の不変条件(fallbackReason は null)を保つため、理由は marksDroppedReason に入れる。
  if (lastError instanceof AnalyzerMarkViolationError) {
    return {
      horses: lastError.horses,
      fallback: false,
      retryCount: maxAttempts - 1,
      fallbackReason: null,
      marksDropped: true,
      marksDroppedReason: `印関連の制約違反のため2回目応答でも印を採用できず、確率補正のみ採用して印は全馬nullにしました: ${lastError.message}`,
    };
  }

  // 印と無関係な失敗 → prior をそのまま採用(フェイルセーフ)。
  const reason =
    lastError instanceof AnalyzerResponseParseError
      ? `JSONパースに2回失敗したため prior を採用: ${lastError.message}`
      : `LLM呼び出しに2回失敗したため prior を採用: ${errorMessage(lastError)}`;

  return {
    horses: priorFallbackHorses(priors),
    fallback: true,
    retryCount: maxAttempts - 1,
    fallbackReason: reason,
    marksDropped: false,
    marksDroppedReason: null,
  };
}

/** 未知の例外値から可能な範囲でメッセージを取り出す。 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
