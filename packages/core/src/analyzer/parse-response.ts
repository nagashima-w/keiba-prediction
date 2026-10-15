/**
 * レスポンス処理 — LLM出力テキストから JSON を抽出・パースし、バリデーション/±10%クリップ/
 * 馬番欠け補完を行う純関数群。
 *
 * 仕様「3. analyzer」:
 *  - コードフェンス付き・前後に説明文があるなどの揺れに耐えて JSON を取り出す。
 *  - 全馬番が揃っているか、place_prob が [0,1] か、prior から ±10%(絶対値0.10)以内か検証し、
 *    逸脱した馬は prior±0.10(かつ [0,1])にクリップして clipped を記録する。
 *  - 欠けた馬番(および place_prob が不正な馬)は prior をそのまま採用し記録する。
 *
 * Task#22(予想印: ユーザー要望による同一LLM呼び出しでの印決定):
 *  - 各馬の mark(◎〇▲△☆注のいずれか、または印なしの null)を検証する。
 *  - 頭数制約(2026-07-19合意のB-1で緩和後): ◎はちょうど1頭のみ必須。〇・▲は0〜1頭、
 *    △は0〜3頭、☆・注は0〜1頭。加えて本線印(◎〇▲△)は gapless な優先順位を持ち、
 *    ▲を付けるなら〇が1頭以上必要、△を付けるなら▲が1頭以上必要(詳細はファイル末尾の
 *    「予想印の制約緩和(B-1)とフォールバック分離(A)」を参照)。
 *  - 未知の印文字列、または頭数制約・優先順位の違反は、専用の AnalyzerMarkViolationError
 *    (AnalyzerResponseParseError のサブクラス)で送出する。このエラーは印以外の確率補正
 *    (adjustedProb/clipped/reason)を保持したまま全馬 mark=null にした horses を運び、
 *    analyze-race 側がリトライしてもなお印関連違反なら、運んできた印つきの horses(`markedHorses`)を
 *    `repairMarks` で規則に合わせて直して fallback:false で採用する(prior には戻さない。A: フォールバック分離。
 *    Issue #317 より前は、この全馬 mark=null の horses を marksDropped:true として採用していた)。
 *  - mark がJSON上に完全に欠けている(旧形式の応答)場合、全馬 mark=null となり◎が0頭のため
 *    自動的に制約違反としてエラーになる(意図した挙動)。
 *  - priors に無い余分な馬番の mark は place_prob と同様に無視する(制約カウントに含めない)。
 *  - 馬番が重複した場合は最初の出現のみを採用する(place_prob と同じ挙動を流用)。
 *
 * Task#23(予想印: 堅牢性向上・bossの非ブロッキング観察へのPM採用対応):
 *  - LLMが「〇」(U+3007 IDEOGRAPHIC NUMBER ZERO)の代わりに見た目の似た同形異字
 *    (○ U+25CB WHITE CIRCLE・◯ U+25EF LARGE CIRCLE)を出力した場合、既知の印として正規化して受理する。
 *    正規化後も PREDICTION_MARKS のいずれとも一致しなければ、従来どおり未知の印としてエラーにする。
 *
 * Issue #315(想定ペースを LLM が展開予想して決める):
 *  - 応答の最上位の `development`(展開予想の短文)と `pace`(スロー・平均・ハイ)を取り出す。**欠落・不正でも例外にせず null**
 *    (馬の確率・印の解析と独立。分析の失敗・再試行にしない)。保存済みの生応答からは `extractDevelopment` で取り出す。
 *
 * 予想印の制約緩和(B-1)とフォールバック分離(A)(2026-07-19合意):
 *  - 頭数制約緩和: ◎はちょうど1頭のまま。〇・▲は0〜1頭、△は0〜3頭に緩和(☆・注は0〜1頭で不変)。
 *  - 本線印(◎〇▲△)は gapless な優先順位を持つ: ▲を付けるなら〇が1頭以上必要、
 *    △を付けるなら▲が1頭以上必要(結果として △≥1 ⇒ 〇≥1)。合法集合は
 *    {◎}/{◎〇}/{◎〇▲}/{◎〇▲+△(1〜3)}のいずれか。☆・注は本線と独立(◎〇▲△の有無に
 *    関わらず各0〜1頭)で、☆注間の順序依存もない。
 *  - A(フォールバック分離): 印関連の違反(頭数・優先順位・未知の印文字の3種)は、確率補正
 *    (adjustedProb/clipped/reason)自体は計算できているため捨てない。専用の
 *    AnalyzerMarkViolationError で「確率補正は保持した horses」(`markedHorses` は印つき、
 *    `horses` は全馬 mark=null)を運び、analyze-race 側がリトライしてもなお印関連違反なら、
 *    `repairMarks` で直した horses を fallback:false で採用できるようにする(Issue #317。
 *    旧仕様は全馬 mark=null の horses を marksDropped:true で採用していた)。印と無関係な失敗は
 *    従来どおり汎用の AnalyzerResponseParseError のみを投げ、全馬 prior フォールバックに回る。
 *  - 判定順序: 「有効な補正0件(全馬 usedPrior)」チェックは印関連チェックより必ず先に行う。
 *    そのため、全馬の place_prob が不正な応答は、mark が違反していても印の補修の対象にはならず、
 *    従来どおり汎用のフォールバックに回る。
 *  - 未知の印文字は、その馬1頭の判定を諦める(mark=null 扱い)だけで他馬の確率補正計算は継続し、
 *    horses 配列全体を最後まで構築してから違反として例外を投げる(1頭の不正のために他馬の
 *    確率補正まで失うことを防ぐ)。
 */

/**
 * 補正の最大幅の既定値(prior からの絶対値)。
 *
 * 仕様「±10%以内」の解釈: 確率(0〜1)に対するパーセントポイントの自然な読みとして
 * **絶対値0.10** を正式採用する(prior=0.40 なら [0.30, 0.50])。将来 prior 相対の解釈や
 * 幅調整に切り替えられるよう、値は parseAnalyzerResponse の options.maxAdjust /
 * AnalyzerConfig.maxAdjust で上書きできる。この公開定数は後方互換のため既定値として残す。
 */
export const MAX_ADJUST = 0.1;

/** parseAnalyzerResponse の任意設定。 */
export interface ParseAnalyzerOptions {
  /** 補正の最大幅(prior からの絶対値)。既定は MAX_ADJUST(0.10)。 */
  readonly maxAdjust?: number;
}

/** 浮動小数の丸め誤差で境界(±0.10ちょうど)を誤クリップしないための許容。 */
const EPS = 1e-9;

/** JSON抽出・パースに失敗したことを表すエラー(analyzer本体のリトライ判定に使う)。 */
export class AnalyzerResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyzerResponseParseError";
  }
}

/**
 * LLM応答がAPI側のトークン上限(max_tokens)で切り詰められたことを表すエラー
 * (小倉記念18頭切り詰め事故の再発防止・2026-07-19合意)。
 * AnthropicLlmClient.complete()(anthropic-client.ts)が SDK レスポンスの
 * stop_reason==="max_tokens" を検出した際に投げる。切り詰められた本文は
 * JSON として不完全で信頼できないため、テキストをそのまま返さずこの例外を投げて
 * analyze-race側のリトライ/フォールバック判定に委ねる。
 * AnalyzerResponseParseError のサブクラスなので、既存の
 * `instanceof AnalyzerResponseParseError` 判定・リトライ意味論(1回だけ同一プロンプトで
 * リトライ)を壊さない。
 */
export class AnalyzerTruncationError extends AnalyzerResponseParseError {
  /** 検出した生の stop_reason(現状は常に "max_tokens")。診断用に保持する。 */
  readonly stopReason: string;
  /**
   * 応答したモデルID(Issue #157。AnthropicLlmClient が渡す。レスポンスの model 優先、無ければ
   * リクエストしたID)。例外で終わっても「実際に使ったモデル」の記録を失わないために運ぶ。
   * 旧形式で作られたエラーでは undefined。
   */
  readonly model: string | undefined;

  constructor(message: string, stopReason: string, model?: string) {
    super(message);
    this.name = "AnalyzerTruncationError";
    this.stopReason = stopReason;
    this.model = model;
  }
}

/**
 * LLM応答が安全分類器により拒否されたこと(stop_reason==="refusal")を表すエラー(Issue #157。
 * Claude Sonnet 5.5 以降は HTTP 200 のまま content が空で返ることがあり、そのままでは
 * 「JSON解析失敗」に埋もれて原因が分からなくなる)。
 * AnthropicLlmClient.complete()(anthropic-client.ts)が検出した際に投げる。
 * AnalyzerTruncationError と同型で、AnalyzerResponseParseError のサブクラスなので
 * 既存の `instanceof AnalyzerResponseParseError` 判定・リトライ意味論(1回だけ同一プロンプトで
 * リトライ)を壊さない。analyze-race 側は専用の固定文言(FALLBACK_REASON_REFUSED)と
 * stopReason を返す。
 */
export class AnalyzerRefusalError extends AnalyzerResponseParseError {
  /** 検出した生の stop_reason(現状は常に "refusal")。診断用に保持する。 */
  readonly stopReason: string;
  /**
   * 応答したモデルID(Issue #157。AnthropicLlmClient が渡す。レスポンスの model 優先、無ければ
   * リクエストしたID)。例外で終わっても「実際に使ったモデル」の記録を失わないために運ぶ。
   * 旧形式で作られたエラーでは undefined。
   */
  readonly model: string | undefined;

  constructor(message: string, stopReason: string, model?: string) {
    super(message);
    this.name = "AnalyzerRefusalError";
    this.stopReason = stopReason;
    this.model = model;
  }
}

/**
 * 予想印の違反の種類(Issue #317。固定の語彙)。どの規則でよく外れるかを後から数えるために保存する(D1 の `analyses.mark_repair_json`)。
 *  - `unknown-char`: 既知の6種(◎〇▲△☆注)でない印の文字が1頭以上あった
 *  - `missing-◎` / `over-◎`: ◎が0頭 / 2頭以上
 *  - `over-〇`・`over-▲`・`over-△`・`over-☆`・`over-注`: 上限(〇▲☆注は1頭、△は3頭)を超えた
 *  - `gap-〇`: ▲があるのに〇が無い / `gap-▲`: △があるのに▲が無い(本線が途切れている)
 */
export const MARK_VIOLATION_KINDS = [
  "unknown-char",
  "missing-◎",
  "over-◎",
  "over-〇",
  "over-▲",
  "over-△",
  "over-☆",
  "over-注",
  "gap-〇",
  "gap-▲",
] as const;

/** 予想印の違反の種類({@link MARK_VIOLATION_KINDS} のいずれか)。 */
export type MarkViolationKind = (typeof MARK_VIOLATION_KINDS)[number];

/**
 * 予想印関連の違反(頭数制約・優先順位・未知の印文字の3種)を表すエラー(A: フォールバック分離)。
 * AnalyzerResponseParseError のサブクラスなので既存の `toThrow(AnalyzerResponseParseError)` は
 * 引き続き成立する。印以外は正常に計算できた確率補正(adjustedProb/clipped/reason/usedPrior)を
 * 失わないよう、horses をペイロードとして運ぶ。
 *
 * Issue #317: analyze-race 側は、リトライしてもなお(または、聞き直しが別の失敗で終わったとき)このエラーなら、
 * `markedHorses`(LLM の元の印を保った horses)を `repairMarks` で規則に合わせて直して採用する(全消しにしない)。
 * `horses`(全馬 mark=null)は従来との互換のために残す。
 */
export class AnalyzerMarkViolationError extends AnalyzerResponseParseError {
  /**
   * 印以外の確率補正を保持したまま全馬 mark=null にした horses(prior順)。
   * ParseAnalyzerResult.horses と型を揃え(ParsedHorseResult[])、呼び出し側でキャスト不要にする。
   */
  readonly horses: ParsedHorseResult[];
  /**
   * `horses` と同じ(確率補正を保持した prior順)だが、**LLM の元の印を保った**もの(Issue #317。補修の入力)。
   * 未知の印文字の馬だけは mark=null(その馬番は {@link unknownUmabans} に載る)。
   */
  readonly markedHorses: ParsedHorseResult[];
  /** 未知の印文字だった馬の馬番(Issue #317)。 */
  readonly unknownUmabans: number[];
  /** 違反の種類(Issue #317。固定の語彙。重複なし・{@link MARK_VIOLATION_KINDS} の順)。 */
  readonly kinds: MarkViolationKind[];

  constructor(
    message: string,
    horses: ParsedHorseResult[],
    detail: {
      readonly markedHorses: ParsedHorseResult[];
      readonly unknownUmabans: number[];
      readonly kinds: MarkViolationKind[];
    },
  ) {
    super(message);
    this.name = "AnalyzerMarkViolationError";
    this.horses = horses;
    this.markedHorses = detail.markedHorses;
    this.unknownUmabans = detail.unknownUmabans;
    this.kinds = detail.kinds;
  }
}

/** parse に渡す prior 参照(馬番 → prior)。 */
export interface PriorRef {
  /** 馬番。 */
  readonly umaban: number;
  /** その馬の prior(scorer 出力)。 */
  readonly prior: number;
}

/**
 * 予想印(Task#22: ユーザー要望)。
 * ◎本命/〇対抗/▲単穴/△連下/☆星/注注意。定義・頭数制約は build-prompt.ts のプロンプト指示を参照。
 */
export const PREDICTION_MARKS = ["◎", "〇", "▲", "△", "☆", "注"] as const;

/** 予想印の型(PREDICTION_MARKS のいずれか)。 */
export type PredictionMark = (typeof PREDICTION_MARKS)[number];

/** 1頭分のパース結果。 */
export interface ParsedHorseResult {
  /** 馬番。 */
  readonly umaban: number;
  /** 入力の prior。 */
  readonly prior: number;
  /** 補正後の複勝圏内確率(クリップ・prior採用を反映済み)。 */
  readonly adjustedProb: number;
  /** LLMが付けた根拠(prior採用・欠けなどで無い場合は null)。 */
  readonly reason: string | null;
  /**
   * 強調材料(Issue #197・#196-a。各最大 {@link MAX_ITEMS_PER_LIST} 項目の短い句)。
   * 欠落・形違い・prior採用の馬(usedPrior)は `[]`。必須だが、空配列が「無い」を表す。
   */
  readonly highlights: readonly string[];
  /** 懸念事項(Issue #197・#196-a。仕様は {@link ParsedHorseResult.highlights} と同じ)。 */
  readonly concerns: readonly string[];
  /** ±10%(または[0,1])逸脱でクリップした場合 true。 */
  readonly clipped: boolean;
  /** LLM値が使えず(馬番欠け or 不正値)prior をそのまま採用した場合 true。 */
  readonly usedPrior: boolean;
  /** 予想印(LLMが判定。印なし・フォールバック時は null)。 */
  readonly mark: PredictionMark | null;
}

/** parseAnalyzerResponse の結果(全馬 + メタ)。 */
export interface ParseAnalyzerResult {
  /** 全馬の結果(priors の順序で返す)。 */
  readonly horses: ParsedHorseResult[];
  /** クリップした馬の数。 */
  readonly clippedCount: number;
  /** prior をそのまま採用した(欠け/不正)馬の数。 */
  readonly missingCount: number;
  /** LLM の展開予想(短文。Issue #315)。欠落・不正・空は null。分析の成否には影響しない。 */
  readonly development: string | null;
  /** LLM の想定ペース(Issue #315)。「スロー」「平均」「ハイ」以外・欠落は null。分析の成否には影響しない。 */
  readonly pace: LlmPace | null;
}

/** LLM が出力する想定ペース(Issue #315)。leg-style.ts の `PaceEstimate` から「不明」を除いた 3 値。 */
export type LlmPace = "スロー" | "平均" | "ハイ";

/** 強調材料・懸念事項の1馬あたりの最大項目数(Issue #197。プロンプトの指示と同じ値)。 */
export const MAX_ITEMS_PER_LIST = 3;

/**
 * `reason` の最大文字数(コードポイント単位。Issue #303)。
 * 根拠: プロンプト(build-prompt.ts)は reason に文字数を指示していない(「総合の根拠の一文」)。実際の応答は、
 * `docs/investigations/probability-quality-41-llm/responses/` の LLM 応答 36 ファイル(n=449 頭)で、
 * 中央値 92・p99 141・最大 197 コードポイントだった(各ファイルの最初の `{` から最後の `}` を JSON.parse し、
 * `horses[].reason` を `Array.from(...).length` で数えた値)。最大の約 2 倍にして、通常の応答を切らず、
 * 暴走した応答(保存・表示・日報の入力の肥大化)だけを切る。
 */
export const PARSE_REASON_MAX_CODEPOINTS = 400;

/**
 * 強調材料・懸念事項の 1 項目の最大文字数(コードポイント単位。Issue #303)。
 * 根拠: プロンプトの指示が「1項目は全角30字以内の短い句」(build-prompt.ts)。指示を多少守れない応答は
 * 通すため、指示の約 3.3 倍にした。highlights・concerns の実データ(production の D1)は参照できておらず、
 * この値は指示からの導出である(#197 より前の応答群には両キーが無く、実測できない)。
 */
export const PARSE_ITEM_MAX_CODEPOINTS = 100;

/**
 * 未知の予想印の説明文に入れる、生値(`JSON.stringify` した結果)の最大文字数(コードポイント単位。Issue #303)。
 * 正当な印は 1 字なので、何が来たかの診断に足りる長さだけ残す。
 */
export const PARSE_MARK_VALUE_MAX_CODEPOINTS = 40;

/**
 * 展開予想(`development`)の最大文字数(コードポイント単位。Issue #315)。
 * 根拠: プロンプト(build-prompt.ts)の指示が「全角200字以内の日本語1段落」。指示を多少守れない応答は通し、暴走した応答
 * (画面・保存の肥大化)だけを切るため、指示の 2.5 倍にした(reason の上限 400 が実測最大 197 の約 2 倍、項目の上限 100 が
 * 指示 30 字の約 3.3 倍だったのと同じ考え方)。**実際の応答での実測は無い**(この項目を持つ応答が、まだ存在しない)。指示からの導出。
 */
export const PARSE_DEVELOPMENT_MAX_CODEPOINTS = 500;

/**
 * 想定ペースの生の値を 3 値に整える(例外を投げない。Issue #315)。文字列でなければ null。trim し、末尾の「ペース」を
 * 除いたうえで、「スロー」「平均」「ハイ」の完全一致だけ受ける(「ハイペース」→「ハイ」)。「ミドル」は「平均」と同じ意味の
 * よくある表記なので「平均」に写す。それ以外(「不明」・複数の語・部分一致・例の文言のコピー)は null。
 */
function coercePace(raw: unknown): LlmPace | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/ペース$/, "");
  if (t === "スロー" || t === "ハイ" || t === "平均") return t;
  if (t === "ミドル") return "平均";
  return null;
}

/** 展開予想の生の値を整える(例外を投げない。Issue #315)。文字列でなければ null。trim して空なら null。長すぎるときは切る。 */
function coerceDevelopment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "") return null;
  return truncateByCodePoints(t, PARSE_DEVELOPMENT_MAX_CODEPOINTS);
}

/** パース済みの JSON から展開予想と想定ペースを取り出す(例外を投げない)。オブジェクトでなければ両方 null。 */
function developmentFieldsOf(obj: unknown): { development: string | null; pace: LlmPace | null } {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { development: null, pace: null };
  }
  const rec = obj as Record<string, unknown>;
  return { development: coerceDevelopment(rec["development"]), pace: coercePace(rec["pace"]) };
}

/**
 * 保存済みの生応答のテキストから、展開予想と想定ペースだけを取り出す(Issue #315。cloud の分析の画面が使う入口)。
 * **例外を投げない**: 読めない応答(空・JSON でない・壊れている・型の外の値)は両方 null。馬の解析(確率・印)とは独立なので、
 * 印の制約違反で `parseAnalyzerResponse` が失敗する応答や、horses が無い応答でも取り出せる。整形の規則は
 * `parseAnalyzerResponse` の返す値と同じ(同じ関数を共有)。
 */
export function extractDevelopment(text: string): { development: string | null; pace: LlmPace | null } {
  if (typeof text !== "string") {
    return { development: null, pace: null };
  }
  try {
    return developmentFieldsOf(extractJsonObject(text));
  } catch {
    return { development: null, pace: null };
  }
}

/**
 * 文字列をコードポイント数 `max` 以下に切る(例外にしない。Issue #303)。
 * `max` 以下ならそのまま返す。超えるときは先頭 `max-1` コードポイント + `…` を返す(合計ちょうど `max`。
 * 日報の digest の `cut()`〈cloud/src/daily-report-digest.ts〉と同じ形。違いは、あちらが UTF-16 の長さで数えて
 * サロゲートの片割れを落とすのに対し、こちらはコードポイントで数えるのでペアを割らない点)。
 * UTF-16 長が `max` 以下なら必ずコードポイント数も `max` 以下なので、通常の(短い)値では配列化しない。
 */
export function truncateByCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join("")}…`;
}

/**
 * 強調材料・懸念事項の生の値を `string[]` に整える(例外を投げない。Issue #197)。
 * 配列でなければ `[]`。文字列でない要素は捨て、各要素は trim して空なら捨て、**空を除いたあとに**先頭
 * {@link MAX_ITEMS_PER_LIST} 個に切る。1項目の長さは、trim したあとに {@link PARSE_ITEM_MAX_CODEPOINTS}
 * コードポイントを超えるときだけ切る(末尾「…」。Issue #303。全角30字の指示は、これより厳しくプロンプト側で出す)。
 */
function coerceItemList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const items: string[] = [];
  for (const el of raw) {
    if (typeof el !== "string") continue;
    const t = el.trim();
    if (t === "") continue;
    items.push(truncateByCodePoints(t, PARSE_ITEM_MAX_CODEPOINTS));
    if (items.length >= MAX_ITEMS_PER_LIST) break;
  }
  return items;
}

/**
 * LLM出力テキストから JSON オブジェクトを取り出してパースする。
 * コードフェンス(```json / ```)や前後の説明文に耐えるため、最初の `{` から
 * 対応する `}` までを走査して切り出す。失敗時は AnalyzerResponseParseError。
 */
export function extractJsonObject(text: string): unknown {
  const slice = sliceJsonObject(text);
  if (slice === null) {
    throw new AnalyzerResponseParseError(
      "LLM出力からJSONオブジェクトを検出できませんでした",
    );
  }
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new AnalyzerResponseParseError(
      `JSONのパースに失敗しました: ${(e as Error).message}`,
    );
  }
}

/**
 * テキストから最初の JSON オブジェクト(バランスした {...})を切り出す。
 * 文字列リテラル内の波括弧・エスケープを考慮する。見つからなければ null。
 */
function sliceJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null; // 閉じ括弧が見つからない(壊れたJSON)。
}

/** min ≤ x ≤ max にクランプする。 */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * LLM出力テキストをパースし、全馬の補正後確率を返す。
 * @param text LLMの生出力
 * @param priors 全馬の馬番と prior(この順序・この馬番集合を正とする)
 */
export function parseAnalyzerResponse(
  text: string,
  priors: readonly PriorRef[],
  options: ParseAnalyzerOptions = {},
): ParseAnalyzerResult {
  const maxAdjust = options.maxAdjust ?? MAX_ADJUST;
  const obj = extractJsonObject(text);
  const rawHorses = extractHorseArray(obj);

  // 馬番 → LLMの place_prob(最初の出現を採用、重複は無視)。
  const byNumber = new Map<number, number>();
  const reasonByNumber = new Map<number, string | null>();
  const rawMarkByNumber = new Map<number, unknown>();
  const highlightsByNumber = new Map<number, string[]>();
  const concernsByNumber = new Map<number, string[]>();
  for (const entry of rawHorses) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const num = rec["number"];
    if (typeof num !== "number" || !Number.isFinite(num)) continue;
    if (byNumber.has(num)) continue; // 重複は最初を優先。
    const prob = rec["place_prob"];
    byNumber.set(num, typeof prob === "number" ? prob : NaN);
    const reason = rec["reason"];
    reasonByNumber.set(
      num,
      typeof reason === "string" ? truncateByCodePoints(reason, PARSE_REASON_MAX_CODEPOINTS) : null,
    );
    // 強調材料・懸念事項(Issue #197)。欠落・形違いは `[]`(分析は止めない)。
    highlightsByNumber.set(num, coerceItemList(rec["highlights"]));
    concernsByNumber.set(num, coerceItemList(rec["concerns"]));
    // mark キー自体が無い場合(旧形式)は undefined のまま登録され、classifyMark で null 扱いになる。
    rawMarkByNumber.set(num, rec["mark"]);
  }

  let clippedCount = 0;
  let missingCount = 0;
  // 未知の印文字が見つかった馬の説明文(A: 他馬の確率補正計算は止めず、最後にまとめて例外にする)。
  const unknownMarkMessages: string[] = [];
  // 未知の印文字だった馬の馬番(Issue #317。補修が「元の印は不明」と記録するため)。
  const unknownUmabans: number[] = [];

  const horses: ParsedHorseResult[] = priors.map((p) => {
    const value = byNumber.get(p.umaban);
    // mark は priors に無い馬番のものを無視するため、ここ(priorsループ内)で初めて解決する。
    // 未知の印文字列は例外にせず mark=null 扱いにして、他馬の確率補正計算を継続する(A)。
    const { mark, isUnknown } = classifyMark(rawMarkByNumber.get(p.umaban));
    if (isUnknown) {
      unknownUmabans.push(p.umaban);
      unknownMarkMessages.push(
        `未知の予想印です(馬番${p.umaban}): ${truncateByCodePoints(
          JSON.stringify(rawMarkByNumber.get(p.umaban)),
          PARSE_MARK_VALUE_MAX_CODEPOINTS,
        )}`,
      );
    }

    // 馬番欠け or 不正な place_prob → prior をそのまま採用。
    if (value === undefined || !Number.isFinite(value)) {
      missingCount++;
      return {
        umaban: p.umaban,
        prior: p.prior,
        adjustedProb: p.prior,
        reason: null,
        highlights: [],
        concerns: [],
        clipped: false,
        usedPrior: true,
        mark,
      };
    }

    // ±maxAdjust(かつ [0,1])の範囲を求めてクリップ。
    const lower = Math.max(0, p.prior - maxAdjust);
    const upper = Math.min(1, p.prior + maxAdjust);
    let adjusted = value;
    let clipped = false;
    if (value > upper + EPS) {
      adjusted = upper;
      clipped = true;
    } else if (value < lower - EPS) {
      adjusted = lower;
      clipped = true;
    } else {
      // 範囲内。丸め誤差でごく僅かに外れている場合のみ境界へ寄せる(非クリップ扱い)。
      adjusted = clamp(value, lower, upper);
    }
    if (clipped) clippedCount++;

    return {
      umaban: p.umaban,
      prior: p.prior,
      adjustedProb: adjusted,
      reason: reasonByNumber.get(p.umaban) ?? null,
      highlights: highlightsByNumber.get(p.umaban) ?? [],
      concerns: concernsByNumber.get(p.umaban) ?? [],
      clipped,
      usedPrior: false,
      mark,
    };
  });

  // 有効な補正が1件も無い(全馬 prior のまま)場合は、スキーマ妥当でも実質失敗とみなす。
  // 例: {"horses":[]} や余分な馬番のみ。analyzer 本体でリトライ→フォールバックに回すため例外にする。
  // (L2: この判定は印関連の判定より必ず先に行う。全馬 prior のまま=確率補正を救済する意味が
  //  無いため、mark 違反があっても AnalyzerMarkViolationError にはせず汎用エラーのみ投げる。)
  if (priors.length > 0 && horses.every((h) => h.usedPrior)) {
    throw new AnalyzerResponseParseError(
      "有効な補正が0件(全馬 prior のまま)でした",
    );
  }

  // 予想印の頭数制約・優先順位・未知の印文字を検証する(B-1+A)。
  // horses が空(priorsが空)の場合は印を割り当てる馬がいないため検証しない(従来どおり)。
  // 3種いずれかの違反があれば、印以外の確率補正(adjustedProb/clipped/reason)は保持したまま
  // AnalyzerMarkViolationError で運ぶ(捨てずに補修して採用する。Issue #317)。運ぶのは、全馬 mark=null の horses と、
  // 補修の入力にする印つきの horses(`markedHorses`)。
  if (horses.length > 0) {
    const counts = countMarks(horses);
    const violations = [
      ...unknownMarkMessages,
      ...collectMarkCountViolations(counts),
      ...collectMarkPriorityViolations(counts),
    ];
    if (violations.length > 0) {
      const rescuedHorses = horses.map((h) => ({ ...h, mark: null }));
      throw new AnalyzerMarkViolationError(violations.join("; "), rescuedHorses, {
        markedHorses: horses,
        unknownUmabans,
        kinds: findMarkViolationKinds(horses, unknownUmabans.length),
      });
    }
  }

  // 展開予想・想定ペース(Issue #315): 欠落・不正でも例外にしない(馬の解析・印の検証とは独立)。
  return { horses, clippedCount, missingCount, ...developmentFieldsOf(obj) };
}

/**
 * 印の同形異字(Unicode類似字形)→正規表記への正規化マップ(Task#23)。
 * 「〇」(U+3007)と見た目が近い字形をキーに、正式な印文字を値として持つ。
 */
const MARK_CHAR_ALIASES: ReadonlyMap<string, string> = new Map([
  ["○", "〇"], // U+25CB WHITE CIRCLE
  ["◯", "〇"], // U+25EF LARGE CIRCLE
]);

/** 印の同形異字を正規表記へ正規化する(該当しない文字列はそのまま返す)。 */
function normalizeMarkChar(raw: string): string {
  return MARK_CHAR_ALIASES.get(raw) ?? raw;
}

/**
 * 生の mark 値を PredictionMark | null に分類する(例外を投げない: A)。
 * null/undefined(キー欠落含む)は「印なし」として isUnknown:false, mark:null。
 * 文字列は同形異字の正規化(Task#23)を経てから既知の6種と照合し、一致すれば mark にセット。
 * それ以外(既知6種と一致しない文字列・文字列以外の値)は isUnknown:true, mark:null とし、
 * 呼び出し側(priors.map)で違反として集約させる(その馬1頭のためにmap全体を止めない)。
 */
function classifyMark(raw: unknown): { mark: PredictionMark | null; isUnknown: boolean } {
  if (raw === null || raw === undefined) {
    return { mark: null, isUnknown: false };
  }
  if (typeof raw === "string") {
    const normalized = normalizeMarkChar(raw);
    if ((PREDICTION_MARKS as readonly string[]).includes(normalized)) {
      return { mark: normalized as PredictionMark, isUnknown: false };
    }
  }
  return { mark: null, isUnknown: true };
}

/** 予想印ごとの頭数(下限・上限とも含む)。頭数制約緩和(B-1): ◎のみちょうど1頭が必須。 */
const MARK_COUNT_RANGES: ReadonlyArray<{
  readonly mark: PredictionMark;
  readonly min: number;
  readonly max: number;
}> = [
  { mark: "◎", min: 1, max: 1 },
  { mark: "〇", min: 0, max: 1 },
  { mark: "▲", min: 0, max: 1 },
  { mark: "△", min: 0, max: 3 },
  { mark: "☆", min: 0, max: 1 },
  { mark: "注", min: 0, max: 1 },
];

/** horses から予想印ごとの頭数を集計する。 */
function countMarks(horses: readonly { readonly mark: PredictionMark | null }[]): Record<PredictionMark, number> {
  const counts: Record<PredictionMark, number> = {
    "◎": 0,
    "〇": 0,
    "▲": 0,
    "△": 0,
    "☆": 0,
    注: 0,
  };
  for (const h of horses) {
    if (h.mark !== null) {
      counts[h.mark]++;
    }
  }
  return counts;
}

/**
 * 予想印の頭数制約(B-1で緩和後)を検証し、違反があれば理由文の配列を返す(例外は投げない)。
 * horses が空の場合は印を割り当てる馬がいないため検証しない。
 */
function collectMarkCountViolations(counts: Record<PredictionMark, number>): string[] {
  const violations: string[] = [];
  for (const { mark, min, max } of MARK_COUNT_RANGES) {
    const count = counts[mark];
    if (count < min || count > max) {
      const expected = min === max ? `ちょうど${min}頭` : `${min}〜${max}頭`;
      violations.push(
        `予想印${mark}は${expected}である必要がありますが${count}頭でした`,
      );
    }
  }
  return violations;
}

/**
 * 本線印(◎〇▲△)の gapless な優先順位を検証する。
 * ▲を付けるなら〇が1頭以上必要、△を付けるなら▲が1頭以上必要(結果として △≥1 ⇒ 〇≥1)。
 * ☆・注は本線と独立のため対象外。違反があれば理由文の配列を返す(例外は投げない)。
 */
function collectMarkPriorityViolations(counts: Record<PredictionMark, number>): string[] {
  const violations: string[] = [];
  if (counts["▲"] >= 1 && counts["〇"] < 1) {
    violations.push(
      "予想印▲を付けるには〇が1頭以上必要です(〇が0頭でした)",
    );
  }
  if (counts["△"] >= 1 && counts["▲"] < 1) {
    violations.push(
      "予想印△を付けるには▲が1頭以上必要です(▲が0頭でした)",
    );
  }
  return violations;
}

/**
 * 予想印の違反の種類を返す(Issue #317。例外は投げない)。規則は {@link collectMarkCountViolations}・{@link collectMarkPriorityViolations} と同じ。
 * @param horses 印を持つ馬(未知の印文字の馬は mark=null で渡す)
 * @param unknownCount 未知の印文字だった馬の数(1以上なら `unknown-char`)
 * @returns {@link MARK_VIOLATION_KINDS} の順で重複なし。違反が無ければ空配列
 */
export function findMarkViolationKinds(
  horses: readonly { readonly mark: PredictionMark | null }[],
  unknownCount: number,
): MarkViolationKind[] {
  const counts = countMarks(horses);
  const found = new Set<MarkViolationKind>();
  if (unknownCount > 0) found.add("unknown-char");
  // 頭数の上限・下限は MARK_COUNT_RANGES から導く(規則の定義を1箇所に保つ)。◎だけが下限(1)を持つ。
  for (const { mark, min, max } of MARK_COUNT_RANGES) {
    if (counts[mark] > max) found.add(`over-${mark}` as MarkViolationKind);
    if (counts[mark] < min) found.add(`missing-${mark}` as MarkViolationKind);
  }
  if (counts["▲"] >= 1 && counts["〇"] < 1) found.add("gap-〇");
  if (counts["△"] >= 1 && counts["▲"] < 1) found.add("gap-▲");
  return MARK_VIOLATION_KINDS.filter((k) => found.has(k));
}

/** パース済みオブジェクトから horses 配列を取り出す(形不正は空配列扱い)。 */
function extractHorseArray(obj: unknown): unknown[] {
  if (typeof obj !== "object" || obj === null) {
    throw new AnalyzerResponseParseError("JSONがオブジェクトではありません");
  }
  const horses = (obj as Record<string, unknown>)["horses"];
  if (!Array.isArray(horses)) {
    throw new AnalyzerResponseParseError(
      "JSONに horses 配列が含まれていません",
    );
  }
  return horses;
}
