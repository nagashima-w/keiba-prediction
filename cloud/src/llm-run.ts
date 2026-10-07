/**
 * クラウド版の発走前の分析で LLM を使うための部品(Issue #194〈#179-b〉)。**純ロジック**: `cloudflare:workers` も SQL も import しない(`RaceDayCore` と DO のラッパが配線する)。
 *
 *  - {@link clampAdditionalInstruction}: 追加指示を 2,000 UTF-16 単位に切る(サロゲートペアを割らない)。読む側(`coerceCloudSettings`)には上限が無いので、組み立て側で切る。
 *  - {@link createRecordingSender}: **成功した応答を記録し、再実行では再生する**(冪等。アラームは少なくとも1回実行され、保存の失敗は計算ステップごと再試行される。そのたびに LLM へ送り直さない)。
 *  - {@link withErrorLog}・{@link sanitizeLister}・{@link describeLlmErrorForLog}・{@link redactSecrets}: **エラーの本文・鍵をどこにも出さない**。
 *    SDK の例外のメッセージには、レスポンスの本文がそのまま入る(workerd での実測)。ログには status と種別だけを出し、`sk-ant-` で始まる文字列は伏せる。
 *  - {@link outcomeOf}: `analyzeRace` の結果から、LLM が効いたか・画面に出す理由(固定文言)を決める。API のエラーの本文・core の診断メッセージは通さない。
 *
 * 記録の保存先(DO の SQLite)は `llm-response-store.ts`、組み立て(analyze の束縛・モデルの自動選択)は `race-day-core.ts`。
 */
import {
  analyzeRace,
  AnthropicLlmClient,
  createModelSelector,
  DEFAULT_ANALYZER_CONFIG,
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_REFUSED,
  FALLBACK_REASON_TRUNCATED,
  type AnalyzeRaceResult,
  type AnthropicMessageResponse,
  type MessageSender,
  type ModelLister,
  type ModelSelector,
} from "@keiba/core/llm";
import type { BuildPromptInput } from "@keiba/core/pipeline";
import type { CloudLlm } from "./llm-sender";
import { ADDITIONAL_INSTRUCTION_MAX_LENGTH } from "./settings";

// ---- 追加指示の切り詰め ----

/**
 * 追加指示を `max` UTF-16 コード単位(既定 2,000。`String#length` と同じ単位)までに切る。上位サロゲートで終わってしまうとき(ペアの途中)は、そのペアごと落とす。
 * 先頭から切るだけで、途中は書き換えない。`clamped` は、実際に切ったか。
 */
export function clampAdditionalInstruction(text: string, max: number = ADDITIONAL_INSTRUCTION_MAX_LENGTH): { readonly text: string; readonly clamped: boolean } {
  if (text.length <= max) {
    return { text, clamped: false };
  }
  let end = max;
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1; // 上位サロゲートだけが残る(対の下位サロゲートを切った)ので、ペアごと落とす
  }
  return { text: text.slice(0, end), clamped: true };
}

// ---- 秘密 ----

/** `sk-ant-` で始まる文字列(API キーの形)を伏せる。ログに出す文字列は、すべてこれを通す。 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]*/g, "sk-ant-***");
}

/**
 * LLM 呼び出しの失敗を、ログに出せる短い説明にする: HTTP のエラーは `status=429`、それ以外は `種別=timeout|connection|other`。
 * **例外のメッセージ・本文は出さない**(SDK の例外のメッセージには、レスポンスの本文がそのまま入る)。種別の判定にだけメッセージを読む。
 */
export function describeLlmErrorForLog(error: unknown): string {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number" && Number.isFinite(status)) {
    return redactSecrets(`status=${status}`);
  }
  const message = error instanceof Error ? error.message : "";
  const kind = /time(d)?[ -]?out/i.test(message) ? "timeout" : /connection|network|fetch failed|ECONN/i.test(message) ? "connection" : "other";
  return `種別=${kind}`;
}

/** sender の失敗を、status と種別だけで警告に出し、**同じ例外のまま**投げ直す(上位の判定が `status` を見られるように)。 */
export function withErrorLog(inner: MessageSender, warn: (message: string) => void): MessageSender {
  return async (params) => {
    try {
      return await inner(params);
    } catch (error) {
      warn(`LLM の呼び出しに失敗しました(${describeLlmErrorForLog(error)})`);
      throw error;
    }
  };
}

/**
 * モデル一覧の取得の失敗を、メッセージを捨てた説明(status・種別だけ)の例外に置き換える。
 * core の `createModelSelector` は、失敗した例外のメッセージを警告に埋め込む(本文が入りうる)ので、その手前で落とす。
 */
export function sanitizeLister(inner: ModelLister): ModelLister {
  return async () => {
    try {
      return await inner();
    } catch (error) {
      throw new Error(describeLlmErrorForLog(error));
    }
  };
}

// ---- 応答の記録と再生 ----

/** 記録する応答(送信に必要な部分だけ: text ブロック・stop_reason・model。thinking などの他のブロックは持たない)。 */
export type StoredLlmResponse = AnthropicMessageResponse;

/** 記録の保存先。番号は「成功した応答の通し番号」(0 から。失敗は数えない)。 */
export interface LlmResponseStore {
  get(index: number): StoredLlmResponse | undefined;
  put(index: number, response: StoredLlmResponse): void;
}

function toStored(response: AnthropicMessageResponse): StoredLlmResponse {
  return {
    content: response.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => ({ type: "text", text: b.text as string })),
    ...(response.stop_reason === undefined ? {} : { stop_reason: response.stop_reason }),
    ...(response.model === undefined ? {} : { model: response.model }),
  };
}

/**
 * 成功した応答を記録し、再実行では再生する sender。呼び出しのたびに、**まだ使っていない記録があればそれを返し**(実送信しない)、無ければ実送信して、
 * **返す前に**記録する。失敗(例外)は記録せず、番号も進めない(失敗は課金されない前提。再実行は、失敗した呼び出しを飛ばして、記録済みの成功から始める)。
 *  - stop_reason が max_tokens・refusal の応答も、課金されているので記録する(再生で同じ判定になる)。
 *  - 記録の読み書きの失敗は、分析を止めない(読めなければ記録なしとして送る・書けなければ応答はそのまま使う。警告だけ出す。**保護が効かなくなるだけ**)。
 */
export function createRecordingSender(inner: MessageSender, store: LlmResponseStore, warn?: (message: string) => void): MessageSender {
  let next = 0;
  return async (params) => {
    let recorded: StoredLlmResponse | undefined;
    try {
      recorded = store.get(next);
    } catch {
      warn?.("LLM の応答の記録を読めませんでした(記録なしとして送ります)");
    }
    if (recorded !== undefined) {
      next += 1;
      return recorded;
    }
    const response = await inner(params);
    try {
      store.put(next, toStored(response));
    } catch {
      warn?.("LLM の応答の記録を書けませんでした(この応答は使いますが、再試行のときに送り直すことがあります)");
    }
    next += 1;
    return response;
  };
}

// ---- 結果の理由(固定文言) ----

/** キー未登録(LLM を呼ばなかった)のときの理由。 */
export const LLM_NOTE_NO_KEY = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";
/** 印の制約違反が続き、印は付けず、確率の補正だけ採用したときの理由(core の `marksDroppedReason` は例外のメッセージを含むので使わない)。 */
export const LLM_NOTE_MARKS_DROPPED = "印の制約違反のため、印は付けていません(3着内率の補正は反映しています)";
/** core の固定文言のどれでもない fallbackReason のときの理由(未知の文字列をそのまま出さない)。 */
export const LLM_NOTE_UNKNOWN_FALLBACK = "LLM を使えなかったため、3着内率をそのまま採用しました";

const KNOWN_FALLBACK_REASONS: readonly string[] = [FALLBACK_REASON_TRUNCATED, FALLBACK_REASON_PARSE_ERROR, FALLBACK_REASON_INVOCATION_ERROR, FALLBACK_REASON_REFUSED];

export interface LlmOutcome {
  /** LLM の補正が実際に採用されたか(モデル欄にモデル名を出してよいか)。 */
  readonly effective: boolean;
  /** 画面に出す理由(固定文言)。LLM が問題なく効いたときは null。 */
  readonly note: string | null;
}

/** `analyzeRace` の結果(LLM を呼ばなかったときは null)から、効いたか・理由を決める。出す文字列は、この module と core の固定文言だけ。 */
export function outcomeOf(result: AnalyzeRaceResult | null): LlmOutcome {
  if (result === null) {
    return { effective: false, note: LLM_NOTE_NO_KEY };
  }
  if (result.fallback) {
    const reason = result.fallbackReason;
    return { effective: false, note: reason !== null && KNOWN_FALLBACK_REASONS.includes(reason) ? reason : LLM_NOTE_UNKNOWN_FALLBACK };
  }
  if (result.marksDropped === true) {
    return { effective: true, note: LLM_NOTE_MARKS_DROPPED };
  }
  return { effective: true, note: null };
}

// ---- 組み立て ----

/** モデルの自動選択(最新の Sonnet。取得に失敗すれば固定モデル)を作る。`lister` が無ければ undefined(固定モデルで送る)。一覧の失敗のメッセージは、本文を含めない。 */
export function createCloudModelSelector(llm: CloudLlm, warn: (message: string) => void): ModelSelector | undefined {
  return llm.lister === undefined
    ? undefined
    : createModelSelector({ lister: sanitizeLister(llm.lister), fixedModel: DEFAULT_ANALYZER_CONFIG.model, onWarn: warn });
}

export interface CloudAnalyzeInput {
  readonly llm: CloudLlm;
  readonly selector: ModelSelector | undefined;
  readonly store: LlmResponseStore;
  /** 補正の最大幅(clipVariant を1回解決した値)。 */
  readonly maxAdjust: number;
  readonly warn: (message: string) => void;
}

/**
 * `runAnalysis` の `analyze` に渡す関数と、その結果の取り出し口を作る。
 * sender は、外側から「記録・再生」→「失敗のログ(status・種別だけ)」→ 実送信の順に包む(再生のときはログも実送信も無い)。
 * 結果(`AnalyzeRaceResult`)は `runAnalysis` が保存を呼ぶ**前**に取り出せる(保存のフックが、モデル欄・理由を決めるため)。
 */
export function createCloudAnalyze(input: CloudAnalyzeInput): {
  readonly analyze: (promptInput: BuildPromptInput) => Promise<AnalyzeRaceResult>;
  readonly lastResult: () => AnalyzeRaceResult | null;
} {
  let last: AnalyzeRaceResult | null = null;
  const sender = createRecordingSender(withErrorLog(input.llm.sender, input.warn), input.store, input.warn);
  const client = new AnthropicLlmClient({}, { sender, ...(input.selector === undefined ? {} : { modelSelector: input.selector }), onWarn: input.warn });
  return {
    analyze: async (promptInput) => {
      const result = await analyzeRace(promptInput, { llm: client, maxAdjust: input.maxAdjust });
      last = result;
      return result;
    },
    lastResult: () => last,
  };
}
