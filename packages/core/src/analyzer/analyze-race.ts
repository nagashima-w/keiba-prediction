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
 *
 * maxTokens引き上げ・切り詰め検出の可視化(2026-07-19改定・小倉記念18頭切り詰め事故の再発防止):
 * AnthropicLlmClient.complete() が stop_reason==="max_tokens" を検出すると
 * AnalyzerTruncationError(AnalyzerResponseParseError のサブクラス)を投げる。この分岐は
 * 汎用のJSON解析失敗より必ず先に判定し、専用の理由文言・truncated:true・生のstop_reasonを
 * 返す(汎用の「パース失敗」に埋もれて根本原因〈max_tokens不足〉の特定が遅れるのを防ぐ)。
 * fallbackReason(UI/DB向け)は秘密安全性のため常に固定分類文言(FALLBACK_REASON_*)のみとし、
 * 生の例外詳細は diagnosticMessage に別途保持してログ経路(main側onFallback)でのみ使う
 * (詳細は各定数・AnalyzeRaceResultのフィールドコメントを参照)。
 */

import { buildPrompt, type BuildPromptInput } from "./build-prompt.js";
import {
  AnalyzerMarkViolationError,
  AnalyzerResponseParseError,
  AnalyzerTruncationError,
  parseAnalyzerResponse,
  type ParsedHorseResult,
  type PriorRef,
} from "./parse-response.js";

/**
 * fallbackReason(UI/DB向け)に使う固定分類文言(2026-07-19改定: 秘密安全性のための再設計)。
 *
 * 背景: 従来は生の例外メッセージ(lastError.message等)をそのまま fallbackReason に埋め込んでいたが、
 * これは analyzeRace 内部専用のフィールドで、UI/DBには露出していなかった。今回 fallbackReason を
 * UI(BatchAnalysisView の「LLM補正:」行tooltip)へ新規露出させるにあたり、CLAUDE.mdに記録された
 * 過去の秘密漏洩事故の重さを踏まえ、生の例外内容(万一 apiKey・プロンプト本文の断片等を含んでいても)が
 * 構造的にUI/DBへ混入しないよう、fallbackReason は必ずこの3種の固定文字列のいずれかとする
 * (診断に必要な生の詳細は diagnosticMessage に別途保持し、ログ経路〈main/pipeline-deps.ts の
 * onFallback→main/logger.ts の logWarn〉でのみ、既存の秘密マスキング〈log-formatter.ts〉を通して使う。
 * UI/DB(AnalysisResult/AnalysisRecord)へは diagnosticMessage を一切渡さない)。
 */
export const FALLBACK_REASON_TRUNCATED =
  "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました";
/** 汎用のJSON解析失敗(horses配列なし・有効な補正0件を含む)時の固定分類文言。 */
export const FALLBACK_REASON_PARSE_ERROR =
  "LLM応答のJSON解析に失敗したため、3着内率をそのまま採用しました";
/** LLM呼び出し自体の例外(認証エラー・レート制限・ネットワーク断等)時の固定分類文言。 */
export const FALLBACK_REASON_INVOCATION_ERROR =
  "LLM呼び出しに失敗したため、3着内率をそのまま採用しました";

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
  /**
   * fallback:true の原因が応答の切り詰め(stop_reason==="max_tokens")だった場合 true
   * (2026-07-19改定: 小倉記念18頭切り詰め事故の再発防止・可視化)。切り詰め以外の失敗では
   * 明示的に false を返す。成功時・印救済時(AnalyzerMarkViolationError経由)はこのフィールド
   * 自体を省略する(値は undefined。既存呼び出し元との互換のため optional にしている)。
   */
  readonly truncated?: boolean;
  /**
   * 切り詰め検出時に AnthropicLlmClient が観測した生の stop_reason(現状は常に "max_tokens")。
   * truncated:true の場合のみ値が入る。診断ログ(main側のonFallback経由)向けの構造化情報であり、
   * 秘密を含まないため fallbackReason 同様 UI に出しても安全(ただし今回はログ配線のみで使う)。
   * 切り詰め以外の失敗では明示的に null、成功時・印救済時は省略(undefined)。
   */
  readonly stopReason?: string | null;
  /**
   * fallback:true 時の診断用の生詳細(例外メッセージ等)。UI(AnalysisResult)にもDB
   * (AnalysisRecord)にも絶対に伝播させないこと。main/analysis-pipeline.ts の onFallback
   * コールバック経由で main/logger.ts の logWarn に渡し、既存の秘密マスキング
   * (shared/log-formatter.ts)を通してのみ記録する(#35 ログ基盤: LLM呼び出し失敗の原因を
   * 完全不可視にしないための診断ログ保持)。truncated:true の場合は stopReason で診断可能なため
   * 生の例外メッセージではなく固定文言(FALLBACK_REASON_TRUNCATED)を入れる。fallback:true の
   * 失敗時は必ず値が入り、成功時・印救済時(fallback:false)は省略(undefined)。
   */
  readonly diagnosticMessage?: string | null;
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

  // 応答の切り詰め(stop_reason==="max_tokens")は、汎用のJSON解析失敗より必ず先に判定する
  // (2026-07-19改定: 小倉記念18頭切り詰め事故の再発防止)。汎用文言に埋もれると「パース失敗」と
  // 誤表示され、根本原因(max_tokens不足)の特定が遅れるため。stopReasonは構造化フィールドで
  // 拾えるため診断上生の例外メッセージを別途保持する必要は無い(diagnosticMessageは固定文言と同一)。
  if (lastError instanceof AnalyzerTruncationError) {
    return {
      horses: priorFallbackHorses(priors),
      fallback: true,
      retryCount: maxAttempts - 1,
      fallbackReason: FALLBACK_REASON_TRUNCATED,
      marksDropped: false,
      marksDroppedReason: null,
      truncated: true,
      stopReason: lastError.stopReason,
      diagnosticMessage: FALLBACK_REASON_TRUNCATED,
    };
  }

  // 印・切り詰めのいずれとも無関係な失敗 → prior をそのまま採用(フェイルセーフ)。
  // fallbackReason(UI/DB向け)は固定分類文言のみとし、生の例外メッセージ(万一秘密を含んでいても)が
  // 構造的に混入しないようにする。生の詳細は diagnosticMessage に保持し、ログ経路
  // (main/analysis-pipeline.ts の onFallback → main/logger.ts の logWarn)でのみ、
  // 既存の秘密マスキング(shared/log-formatter.ts)を通して使う(#35 診断ログ保持)。
  const isParseError = lastError instanceof AnalyzerResponseParseError;
  const reason = isParseError ? FALLBACK_REASON_PARSE_ERROR : FALLBACK_REASON_INVOCATION_ERROR;
  const diagnosticMessage = isParseError
    ? (lastError as AnalyzerResponseParseError).message
    : errorMessage(lastError);

  return {
    horses: priorFallbackHorses(priors),
    fallback: true,
    retryCount: maxAttempts - 1,
    fallbackReason: reason,
    marksDropped: false,
    marksDroppedReason: null,
    truncated: false,
    stopReason: null,
    diagnosticMessage,
  };
}

/** 未知の例外値から可能な範囲でメッセージを取り出す。 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
