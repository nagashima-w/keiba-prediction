/**
 * analyzer 本体 — プロンプト構築 → LLM呼び出し(1レース1リクエスト) → パース → 補正後確率。
 *
 * 仕様「3. analyzer」:
 *  - LLMクライアントは注入(LlmClient.complete)。テストはモックのみで実APIは呼ばない。
 *  - フェイルセーフ(仕様L107): JSONパース失敗時は1回だけ同一プロンプトでリトライし(Issue #317: 印の違反の後の聞き直しだけは、前回の違反の種類から作った固定の追記文を末尾に添える)、再失敗時は
 *    prior をそのまま採用して fallback:true と理由を返す。LLM呼び出し自体の例外も同様に扱う。
 *  - 出力: 馬ごと {umaban, prior, adjustedProb, reason, clipped, usedPrior} + メタ(fallback有無・リトライ回数)。
 *
 * A(フォールバック分離・2026-07-19合意): 印関連の違反(頭数制約・優先順位・未知の印文字の3種)は、確率補正
 * (adjustedProb/clipped/reason)を捨てず、prior には戻さない(fallback:false。fallbackReason は null のまま)。
 * Issue #317: 印は全消しにせず、`repairMarks` で規則に合わせて直して採用する(「全レースに印を付けたい」というユーザー要望。
 * Task#22 の「印は LLM 判断が本質のため機械生成の代替はしない」から、確率補正が有効な応答に限って変更した)。
 *  - 1回目が印の違反なら、今までどおり聞き直す(最大2試行)
 *  - 最後の試行が印の違反 → その応答を補修して採用する
 *  - 1回目が印の違反で、2回目が**別の失敗**(解析不能・切り詰め・拒否・LLM 例外) → 1回目の応答を補修して採用する
 *    (確率の補正・根拠・生応答・使ったモデルも1回目のもの)。全馬 prior に戻すより「全レースに印」の趣旨に合う
 *  - 両方が印の違反なら最後(2回目)の応答を採用する
 *  - 印と無関係な失敗のみ(JSON破損・horses配列なし・有効な補正0件など)は従来どおり priorFallbackHorses
 *    で全馬 prior・全馬 mark=null(fallback:true)。LLM 自体が失敗したレースには印を付けない
 * 補修の有無・違反の種類・変更した馬は `markRepair` に載る(D1 の `analyses.mark_repair_json` に保存して、どの規則でよく外れるかを数える)。
 * 以前あった「印を全消しにして確率補正だけ採用する」経路(`marksDropped`)は #317 で無くなり、#329 で型からも削除した。
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
  AnalyzerRefusalError,
  AnalyzerResponseParseError,
  AnalyzerTruncationError,
  parseAnalyzerResponse,
  type MarkViolationKind,
  type ParsedHorseResult,
  type PriorRef,
} from "./parse-response.js";
import { buildMarkRetryNotice } from "./mark-retry-notice.js";
import { repairMarks, type MarkRepairChange } from "./repair-marks.js";

/**
 * fallbackReason(UI/DB向け)に使う固定分類文言(2026-07-19改定: 秘密安全性のための再設計)。
 *
 * 背景: 従来は生の例外メッセージ(lastError.message等)をそのまま fallbackReason に埋め込んでいたが、
 * これは analyzeRace 内部専用のフィールドで、UI/DBには露出していなかった。今回 fallbackReason を
 * UI(exe の BatchAnalysisView(#287 で削除。3c1664e まで) の「LLM補正:」行tooltip)へ新規露出させるにあたり、CLAUDE.mdに記録された
 * 過去の秘密漏洩事故の重さを踏まえ、生の例外内容(万一 apiKey・プロンプト本文の断片等を含んでいても)が
 * 構造的にUI/DBへ混入しないよう、fallbackReason は必ずこの3種の固定文字列のいずれかとする
 * (診断に必要な生の詳細は diagnosticMessage に別途保持し、ログ経路〈旧 exe の main/pipeline-deps.ts(#287 で削除。3c1664e まで)の
 * onFallback→exe の main/logger.ts の logWarn〉でのみ、既存の秘密マスキング〈exe の log-formatter.ts〉を通して使った。
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
 * 拒否(stop_reason==="refusal")時の固定分類文言(Issue #157)。
 * 切り詰め・汎用パース失敗とは別の原因なので、別の文言で区別する(汎用の「JSON解析失敗」に埋もれると
 * 拒否されたことが分からなくなる)。
 */
export const FALLBACK_REASON_REFUSED =
  "LLMが応答を拒否(refusal)したため、3着内率をそのまま採用しました";

/** completeDetailed の戻り値: 生出力テキストと実際に使ったモデルID。 */
export interface LlmCompletion {
  /** LLMの生出力テキスト。 */
  readonly text: string;
  /** 実際に使ったモデルID(レスポンスの model を優先し、無ければリクエストしたID)。 */
  readonly model: string;
}

/**
 * analyzer が使う LLM クライアントの最小インターフェース。
 * プロンプト文字列を渡すと、LLMの生出力テキストを返す。実装は anthropic-client.ts。
 */
export interface LlmClient {
  /** プロンプトを送り、LLMの生出力テキストを返す。 */
  complete(prompt: string): Promise<string>;
  /**
   * プロンプトを送り、生出力テキストと実際に使ったモデルを返す(Issue #157。後方互換の追加で、
   * 実装しない LlmClient〈既存のモック等〉は complete だけで動く)。あれば analyzeRace はこちらを使い、
   * AnalyzeRaceResult.modelUsed に載せる。
   */
  completeDetailed?(prompt: string): Promise<LlmCompletion>;
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

/**
 * 印の補修の記録(Issue #317)。固定の語彙だけで、LLM の生の文字列は含まない。
 */
export interface MarkRepairReport {
  /** 採用した応答の印を、実際に補修したか。聞き直して解消した(違反が初回だけだった)ときは false。 */
  readonly repaired: boolean;
  /** 採用した応答の試行番号(1 = 初回、2 = 聞き直し)。 */
  readonly adoptedAttempt: 1 | 2;
  /** 印の違反があった試行ごとの違反の種類(試行の順)。どの規則でよく外れるかを数えるための記録。 */
  readonly attempts: ReadonlyArray<{ readonly n: 1 | 2; readonly kinds: readonly MarkViolationKind[] }>;
  /** 補修で印が変わった馬(元の印→今の印)。repaired:false のときは空。 */
  readonly changes: readonly MarkRepairChange[];
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
   * 印関連違反は補修して採用する(Issue #317。`markRepair` に記録する)ので fallback:false で、ここは null のままになる
   * (旧仕様の「印を全消しにする A 救済〈marksDropped:true〉」は、#317 で無くなった)。
   */
  readonly fallbackReason: string | null;
  /**
   * 印の補修の記録(Issue #317)。採用した応答、または聞き直す前の応答に印の違反が1度もなければ null
   * (印と無関係な失敗で prior に戻ったときも null)。省略可なのは、既存の結果リテラルを使うテストを壊さないため。
   */
  readonly markRepair?: MarkRepairReport | null;
  /**
   * fallback:true の原因が応答の切り詰め(stop_reason==="max_tokens")だった場合 true
   * (2026-07-19改定: 小倉記念18頭切り詰め事故の再発防止・可視化)。切り詰め以外の失敗では
   * 明示的に false を返す。成功時・印の補修時(AnalyzerMarkViolationError経由)はこのフィールド
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
   * (AnalysisRecord)にも絶対に伝播させないこと。analysis/analysis-pipeline.ts の onFallback
   * コールバック経由で(旧 exe では)main/logger.ts の logWarn に渡し、既存の秘密マスキング
   * (exe の shared/log-formatter.ts。#287 で削除。3c1664e まで)を通してのみ記録した(#35 ログ基盤: LLM呼び出し失敗の原因を
   * 完全不可視にしないための診断ログ保持)。truncated:true の場合は stopReason で診断可能なため
   * 生の例外メッセージではなく固定文言(FALLBACK_REASON_TRUNCATED)を入れる。fallback:true の
   * 失敗時は必ず値が入り、成功時・印救済時(fallback:false)は省略(undefined)。
   */
  readonly diagnosticMessage?: string | null;
  /**
   * LLMの生応答テキスト(Issue#10 分析データのエクスポート)。
   * 成功時(fallback:false。印の補修〈Issue #317〉を含む)は、実際に採用した試行の
   * 応答テキストをそのまま載せる。text自体を取得できなかった失敗時(パース失敗・LLM呼び出し例外・
   * 切り詰め検出によりprior採用へフォールバックした場合)は null にする(欠損は明示nullで表す。
   * 秘密安全性: これはLLMが返したモデル出力テキストのみで、プロンプト本文・apiKey等は含まない)。
   * optional なのは既存の AnalyzeRaceResult リテラルを使うテストを無改変で通すため
   * (analyzeRace 自身は必ずこのフィールドを明示的に設定して返す)。
   */
  readonly rawResponse?: string | null;
  /**
   * 実際に応答したモデルID(Issue #157)。LlmClient.completeDetailed を持つ実装のときだけ載り、
   * 応答を得られた最後の試行のモデルが入る(リトライで切り替わった場合は採用した試行のもの)。
   * 拒否(refusal)・切り詰め(max_tokens)は応答自体は得ているため、例外が運ぶ model で埋める。
   * 応答を得られなかった(HTTPエラー・ネットワーク断等の)呼び出しが毎回の場合・
   * completeDetailed を持たない LlmClient では
   * キー自体を持たない(呼び出し側は静的なモデル名で代用する)。
   */
  readonly modelUsed?: string;
}

/**
 * 全馬を prior のまま採用する(印と無関係な失敗時のフォールバック専用)結果を組み立てる。
 * 予想印(mark)はLLM判断が本質のため機械生成の代替はせず、全馬 null とする(Task#22: ユーザー決定事項)。
 * 印関連違反(頭数・優先順位・未知の印文字)のみの失敗は、この関数を使わず
 * AnalyzerMarkViolationError が運ぶ印つきの horses(`markedHorses`)を `repairMarks` で規則に合わせて直して採用する
 * (Issue #317。A: フォールバック分離・2026-07-19合意の「prior には戻さない」は維持。旧仕様はそれを全馬 mark=null で採用していた)。
 */
function priorFallbackHorses(priors: readonly PriorRef[]): ParsedHorseResult[] {
  return priors.map((p) => ({
    umaban: p.umaban,
    prior: p.prior,
    adjustedProb: p.prior,
    reason: null,
    highlights: [],
    concerns: [],
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

  // 初回 + リトライ1回(同一プロンプト。ただし印の違反の後の聞き直しだけ、固定の追記文つき。Issue #317)。
  const maxAttempts = 2;
  let lastError: unknown = null;
  // 印関連違反(AnalyzerMarkViolationError)を起こした最後の試行(Issue #317)。応答テキスト(Issue#10)・そのときのモデル・
  // 試行番号を覚え、最後まで全試行が失敗したとき、この応答を補修して採用する。
  // LLM呼び出しとパースを別tryに分け、パース例外(印違反含む)のcatch節でも呼び出し済みの
  // テキストを参照できるようにする(tryブロック内のconstはcatch節から見えないため)。
  let lastMarkViolation: {
    readonly error: AnalyzerMarkViolationError;
    readonly text: string;
    readonly model: string | undefined;
    readonly attempt: 1 | 2;
  } | null = null;
  // 印の違反があった試行ごとの違反の種類(試行の順。補修の記録に載せる)。
  const violationAttempts: Array<{ n: 1 | 2; kinds: readonly MarkViolationKind[] }> = [];
  // 直前の試行が印の違反だったときの、違反の種類(Issue #317)。次の試行(聞き直し)のプロンプトの末尾に、固定の追記文として添える。
  // 印と無関係な失敗の後は null(従来どおり同一のプロンプトで聞き直す)。1回目のプロンプトは常に追記なし。
  let previousViolationKinds: readonly MarkViolationKind[] | null = null;
  // 応答を得られた最後の試行のモデル(Issue #157)。completeDetailed を持たない LlmClient や、
  // 毎回例外で応答が無い場合は undefined のまま(結果にキー自体を載せない)。
  let modelUsed: string | undefined;
  const withModel = (): { modelUsed?: string } =>
    modelUsed === undefined ? {} : { modelUsed };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let text: string;
    const attemptPrompt = previousViolationKinds === null ? prompt : prompt + buildMarkRetryNotice(previousViolationKinds);
    previousViolationKinds = null;
    try {
      if (deps.llm.completeDetailed !== undefined) {
        const completion = await deps.llm.completeDetailed(attemptPrompt);
        text = completion.text;
        modelUsed = completion.model;
      } else {
        text = await deps.llm.complete(attemptPrompt);
      }
    } catch (e) {
      // LLM呼び出し自体の例外(認証エラー・レート制限・ネットワーク断等)。テキスト自体を
      // 取得できていないため、rawResponse は次の試行に持ち越さず null のままにする。
      lastError = e;
      // 拒否・切り詰めは応答したモデルを例外に載せて返す(応答は得ているため、使ったモデルとして残す。
      // 残さないと、呼び出し側が静的な固定モデル名で代用して実際と違う値を記録してしまう)。
      if (
        (e instanceof AnalyzerRefusalError || e instanceof AnalyzerTruncationError) &&
        e.model !== undefined
      ) {
        modelUsed = e.model;
      }
      continue;
    }
    try {
      const parsed = parseAnalyzerResponse(text, priors, {
        maxAdjust: deps.maxAdjust,
      });
      return {
        horses: parsed.horses,
        fallback: false,
        retryCount: attempt, // 成功時: 実施したリトライ回数 = attempt。
        fallbackReason: null,
        // 初回が印の違反で、聞き直しで解消したときだけ、初回の違反の種類を残す(repaired:false)。
        markRepair:
          violationAttempts.length === 0
            ? null
            : { repaired: false, adoptedAttempt: (attempt + 1) as 1 | 2, attempts: violationAttempts, changes: [] },
        rawResponse: text,
        ...withModel(),
      };
    } catch (e) {
      // パース失敗(印関連違反を含む)。残り試行があればリトライ。
      lastError = e;
      if (e instanceof AnalyzerMarkViolationError) {
        const n = (attempt + 1) as 1 | 2;
        lastMarkViolation = { error: e, text, model: modelUsed, attempt: n };
        violationAttempts.push({ n, kinds: e.kinds });
        previousViolationKinds = e.kinds;
      }
    }
  }

  // 全試行失敗。どれかの試行が印関連違反(AnalyzerMarkViolationError)だったなら、その応答(最後の違反)を補修して採用する
  // (Issue #317。全消しにしない)。違反の後の試行が別の失敗(解析不能・切り詰め・拒否・LLM 例外)で終わっていても、
  // 確率補正が有効な違反の応答があるので、全馬 prior に戻さずそちらを採用する。確率補正(adjustedProb/clipped/reason)は
  // 違反した応答のもの。fallback:false の不変条件(fallbackReason は null)を保つ。rawResponse・モデルも採用した試行のもの。
  if (lastMarkViolation !== null) {
    const repaired = repairMarks(lastMarkViolation.error.markedHorses, lastMarkViolation.error.unknownUmabans);
    return {
      horses: repaired.horses,
      fallback: false,
      retryCount: maxAttempts - 1,
      fallbackReason: null,
      markRepair: {
        repaired: true,
        adoptedAttempt: lastMarkViolation.attempt,
        attempts: violationAttempts,
        changes: repaired.changes,
      },
      rawResponse: lastMarkViolation.text,
      ...(lastMarkViolation.model === undefined ? withModel() : { modelUsed: lastMarkViolation.model }),
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
      truncated: true,
      stopReason: lastError.stopReason,
      diagnosticMessage: FALLBACK_REASON_TRUNCATED,
      // 切り詰め検出はLLM呼び出し自体の例外(text未取得)のため rawResponse は null(Issue#10)。
      rawResponse: null,
      ...withModel(),
    };
  }

  // 拒否(stop_reason==="refusal"。Issue #157)。切り詰めと同じく、汎用のJSON解析失敗より先に判定し、
  // 専用の固定文言・stopReason を返す(content が空のため汎用文言では原因が分からなくなる)。
  // truncated は「切り詰めが原因か」なので、拒否では false。
  if (lastError instanceof AnalyzerRefusalError) {
    return {
      horses: priorFallbackHorses(priors),
      fallback: true,
      retryCount: maxAttempts - 1,
      fallbackReason: FALLBACK_REASON_REFUSED,
      truncated: false,
      stopReason: lastError.stopReason,
      diagnosticMessage: FALLBACK_REASON_REFUSED,
      rawResponse: null,
      ...withModel(),
    };
  }

  // 印・切り詰めのいずれとも無関係な失敗 → prior をそのまま採用(フェイルセーフ)。
  // fallbackReason(UI/DB向け)は固定分類文言のみとし、生の例外メッセージ(万一秘密を含んでいても)が
  // 構造的に混入しないようにする。生の詳細は diagnosticMessage に保持し、ログ経路
  // (analysis/analysis-pipeline.ts の onFallback → 旧 exe の main/logger.ts の logWarn。#287 で削除。3c1664e まで)でのみ、
  // 既存の秘密マスキング(exe の shared/log-formatter.ts)を通して使った(#35 診断ログ保持)。
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
    truncated: false,
    stopReason: null,
    diagnosticMessage,
    // 印と無関係な失敗(パース失敗・LLM呼び出し例外)はprior採用のフォールバックのため、
    // テキストを取得できていても(パース失敗の場合)UI/DB向けrawResponseには載せない
    // (欠損は明示null。Issue#10「text未取得の失敗時はnull」と同じ扱いに統一する)。
    rawResponse: null,
    ...withModel(),
  };
}

/** 未知の例外値から可能な範囲でメッセージを取り出す。 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
