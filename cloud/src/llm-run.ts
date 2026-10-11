/**
 * クラウド版の発走前の分析で LLM を使うための部品(Issue #194〈#179-b〉)。**純ロジック**: `cloudflare:workers` も SQL も import しない(`RaceDayCore` と DO のラッパが配線する)。
 *
 *  - {@link clampAdditionalInstruction}: 追加指示を 2,000 UTF-16 単位に切る(サロゲートペアを割らない)。読む側(`coerceCloudSettings`)には上限が無いので、組み立て側で切る。
 *  - {@link createMeteredSender}・{@link createCallLog}: **LLM を呼ぶたびに、所要時間・usage〈入力・出力トークン〉・stop_reason・失敗の説明を1件記録する**(Issue #197 段2。保存は `analyses.llm_calls_json`)。
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
  type ModelFamily,
  type ModelInfoLite,
  type ModelLister,
  type ModelSelector,
} from "@keiba/core/llm";
import type { BuildPromptInput } from "@keiba/core/pipeline";
import type { LlmCallRecord } from "./llm-calls";
import type { CloudLlm } from "./llm-sender";
import { analysisModelFamily, type AnalysisModelFamily, type AnalysisModelId } from "./settings";

// ---- 追加指示の切り詰め ----

// 定義は `settings.ts`(依存を持たない純モジュール)に移した(Issue #201: 設定画面のプレビューが、送信と同じ切り方をするためにクライアントから import する。
// このファイルは SDK を巻き込むのでクライアントのバンドルに入れられない)。既存の import(`race-day-core.ts`・テスト)のため、ここから再 export する。
export { clampAdditionalInstruction } from "./settings";

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

/**
 * 記録する応答(送信に必要な部分: text ブロック・stop_reason・model。thinking などの他のブロックは持たない)に、
 * **呼び出しの測定値**(usage の入力・出力トークンと、`meter.ms`=所要時間)を足したもの(Issue #197 段2)。
 * 測定値は、再生のときに**元の呼び出しのときの値**を呼び出しの記録に載せるために持つ(再生の呼び出しは実際には送っていないので、測り直せない)。
 * この変更の前に記録された応答は、測定値を持たない(optional)。
 */
export interface StoredLlmResponse extends AnthropicMessageResponse {
  /** 実送信のときの所要時間(ミリ秒)。{@link createMeteredSender} が応答に付ける。 */
  readonly meter?: { readonly ms: number };
}

/** 記録の保存先。番号は「成功した応答の通し番号」(0 から。失敗は数えない)。 */
export interface LlmResponseStore {
  get(index: number): StoredLlmResponse | undefined;
  put(index: number, response: StoredLlmResponse): void;
}

/** 有限で 0 以上の数だけ(トークン数・所要時間)。それ以外は null。 */
function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toStored(response: StoredLlmResponse): StoredLlmResponse {
  const input = nonNegative(response.usage?.input_tokens);
  const output = nonNegative(response.usage?.output_tokens);
  const ms = nonNegative(response.meter?.ms);
  return {
    content: response.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => ({ type: "text", text: b.text as string })),
    ...(response.stop_reason === undefined ? {} : { stop_reason: response.stop_reason }),
    ...(response.model === undefined ? {} : { model: response.model }),
    // usage は入力・出力トークンだけ(cache 系などの他の項目は持たない)。どちらかが読めなければ持たない。
    ...(input === null || output === null ? {} : { usage: { input_tokens: input, output_tokens: output } }),
    ...(ms === null ? {} : { meter: { ms } }),
  };
}

// ---- 呼び出しの記録(所要時間・usage。Issue #197 段2) ----

/** 1回の分析の間の、LLM の呼び出しの記録の入れ物(呼び出しの順)。 */
export interface LlmCallLog {
  push(record: LlmCallRecord): void;
  calls(): readonly LlmCallRecord[];
}

export function createCallLog(): LlmCallLog {
  const records: LlmCallRecord[] = [];
  return {
    push: (record) => void records.push(record),
    calls: () => [...records],
  };
}

/** 応答から呼び出しの記録(成功)を作る。`ms` は測れていなければ null(旧い記録の再生)。 */
function successRecord(response: AnthropicMessageResponse, ms: number | null, replayed: boolean): LlmCallRecord {
  return {
    ok: true,
    ms,
    inputTokens: nonNegative(response.usage?.input_tokens),
    outputTokens: nonNegative(response.usage?.output_tokens),
    stopReason: typeof response.stop_reason === "string" ? response.stop_reason : null,
    model: typeof response.model === "string" ? response.model : null,
    replayed,
    error: null,
  };
}

/**
 * 実送信を包んで、**呼び出しごとに1件**を記録する sender(Issue #197 段2)。実送信(SDK への1リクエスト)の層で測るので、
 * 応答の切り詰め(`stop_reason=max_tokens`)・拒否(`refusal`)も、core が例外にする前に usage つきで取れる。
 *  - 成功: 所要時間(`now` の差。ミリ秒に丸め、負にはしない)・入力/出力トークン(`usage`。**出力は thinking を含む**)・stop_reason・モデル。
 *    応答には測定値(`meter.ms`)を付けて返す(記録・再生が、再生のときにも元の所要時間を使えるように。呼び出し元の解析は `meter` を見ない)。
 *  - 失敗: 同じ例外のまま投げ直し、所要時間と**固定の説明**(`describeLlmErrorForLog`: `status=429`・`種別=timeout`)だけを記録する(メッセージ・本文・鍵は入れない)。
 */
export function createMeteredSender(inner: MessageSender, log: LlmCallLog, now: () => number): MessageSender {
  return async (params) => {
    const start = now();
    const elapsed = (): number => Math.max(0, Math.round(now() - start));
    let response: AnthropicMessageResponse;
    try {
      response = await inner(params);
    } catch (error) {
      log.push({ ok: false, ms: elapsed(), inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: describeLlmErrorForLog(error) });
      throw error;
    }
    const ms = elapsed();
    log.push(successRecord(response, ms, false));
    const metered: StoredLlmResponse = { ...response, meter: { ms } };
    return metered;
  };
}

/**
 * 成功した応答を記録し、再実行では再生する sender。呼び出しのたびに、**まだ使っていない記録があればそれを返し**(実送信しない)、無ければ実送信して、
 * **返す前に**記録する。失敗(例外)は記録せず、番号も進めない(失敗は課金されない前提。再実行は、失敗した呼び出しを飛ばして、記録済みの成功から始める)。
 *  - stop_reason が max_tokens・refusal の応答も、課金されているので記録する(再生で同じ判定になる)。
 *  - 記録の読み書きの失敗は、分析を止めない(読めなければ記録なしとして送る・書けなければ応答はそのまま使う。警告だけ出す。**保護が効かなくなるだけ**)。
 *  - `log` を渡すと、**再生した呼び出しを `replayed:true` で呼び出しの記録に載せる**(Issue #197 段2。所要時間・トークンは、記録に残した元の呼び出しの値。
 *    課金・時間は元の1回きりなので、再実行の側では数え直さない。実送信の分は、内側の {@link createMeteredSender} が載せる)。
 *    記録に測定値が無い(この変更の前の記録)ときは、所要時間・トークンは null。
 */
export function createRecordingSender(inner: MessageSender, store: LlmResponseStore, warn?: (message: string) => void, log?: LlmCallLog): MessageSender {
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
      log?.push(successRecord(recorded, nonNegative(recorded.meter?.ms), true));
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

// 設定の系統(`settings.ts`。依存を持たない純モジュール)と core の `ModelFamily` が同じ3つであることを、型で固定する(片方に系統を足すと、ここが型エラーになる)。
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const FAMILIES_MATCH: Same<AnalysisModelFamily, ModelFamily> = true;
void FAMILIES_MATCH;

/** モデル一覧の取得を、最初の1回の結果(失敗も)で使い回す関数にする。系統ごとの selector が、同じ一覧を共有する(系統を切り替えるたびに Models API を叩かない)。 */
export function memoizeLister(inner: ModelLister): ModelLister {
  let memo: Promise<ReadonlyArray<ModelInfoLite>> | null = null;
  return () => (memo ??= inner());
}

/** 分析モデルの選択(`analysisModel`)から、その分析で使うモデルの selector を返す関数。`lister` が無ければ undefined(= selector を作れない。固定モデルで送る)。 */
export type ModelSelectorFor = (choice: AnalysisModelId) => ModelSelector;

/**
 * 系統ごとのモデルの自動選択(Issue #158。`auto` = 最新の Sonnet。取得に失敗すれば固定モデル)を作る。`lister` が無ければ undefined(固定モデルで送る)。
 * 一覧の失敗のメッセージは、本文を含めない。selector は系統ごとに1つ(遅延生成)で、降格はその系統だけが覚える
 * (Opus が拒否されても Sonnet・Haiku は影響を受けない)。一覧の取得は系統をまたいで1回(DO の寿命の間)。固定モデル(切り替え先)は系統によらず同じ。
 */
export function createCloudModelSelectors(llm: CloudLlm, warn: (message: string) => void): ModelSelectorFor | undefined {
  if (llm.lister === undefined) {
    return undefined;
  }
  const lister = memoizeLister(sanitizeLister(llm.lister));
  const selectors = new Map<ModelFamily, ModelSelector>();
  return (choice) => {
    const family: ModelFamily = analysisModelFamily(choice);
    let selector = selectors.get(family);
    if (selector === undefined) {
      selector = createModelSelector({ lister, fixedModel: DEFAULT_ANALYZER_CONFIG.model, family, onWarn: warn });
      selectors.set(family, selector);
    }
    return selector;
  };
}

export interface CloudAnalyzeInput {
  readonly llm: CloudLlm;
  readonly selector: ModelSelector | undefined;
  readonly store: LlmResponseStore;
  /** 補正の最大幅(clipVariant を1回解決した値)。 */
  readonly maxAdjust: number;
  readonly warn: (message: string) => void;
  /** 時計(ミリ秒。LLM の呼び出しの所要時間を測る。Issue #197 段2。DO の `now` を渡す)。 */
  readonly now: () => number;
}

/**
 * `runAnalysis` の `analyze` に渡す関数と、その結果の取り出し口を作る。
 * sender は、外側から「記録・再生」→「測定(呼び出しの記録)」→「失敗のログ(status・種別だけ)」→ 実送信の順に包む(再生のときは測定もログも実送信も無い。再生は記録・再生の層が呼び出しの記録に載せる)。
 * 結果(`AnalyzeRaceResult`)は `runAnalysis` が保存を呼ぶ**前**に取り出せる(保存のフックが、モデル欄・理由を決めるため)。
 */
export function createCloudAnalyze(input: CloudAnalyzeInput): {
  readonly analyze: (promptInput: BuildPromptInput) => Promise<AnalyzeRaceResult>;
  readonly lastResult: () => AnalyzeRaceResult | null;
  /** この分析の LLM の呼び出しの記録(呼び出しの順。再生した分は `replayed:true`。Issue #197 段2)。 */
  readonly calls: () => readonly LlmCallRecord[];
} {
  let last: AnalyzeRaceResult | null = null;
  const log = createCallLog();
  const sender = createRecordingSender(createMeteredSender(withErrorLog(input.llm.sender, input.warn), log, input.now), input.store, input.warn, log);
  const client = new AnthropicLlmClient({}, { sender, ...(input.selector === undefined ? {} : { modelSelector: input.selector }), onWarn: input.warn });
  return {
    analyze: async (promptInput) => {
      const result = await analyzeRace(promptInput, { llm: client, maxAdjust: input.maxAdjust });
      last = result;
      return result;
    },
    lastResult: () => last,
    calls: () => log.calls(),
  };
}
