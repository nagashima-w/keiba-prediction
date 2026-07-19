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
 *    analyze-race 側がリトライしてもなお印関連違反ならその horses を採用して
 *    fallback:false・marksDropped:true として救済する(prior には戻さない。A: フォールバック分離)。
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
 * 予想印の制約緩和(B-1)とフォールバック分離(A)(2026-07-19合意):
 *  - 頭数制約緩和: ◎はちょうど1頭のまま。〇・▲は0〜1頭、△は0〜3頭に緩和(☆・注は0〜1頭で不変)。
 *  - 本線印(◎〇▲△)は gapless な優先順位を持つ: ▲を付けるなら〇が1頭以上必要、
 *    △を付けるなら▲が1頭以上必要(結果として △≥1 ⇒ 〇≥1)。合法集合は
 *    {◎}/{◎〇}/{◎〇▲}/{◎〇▲+△(1〜3)}のいずれか。☆・注は本線と独立(◎〇▲△の有無に
 *    関わらず各0〜1頭)で、☆注間の順序依存もない。
 *  - A(フォールバック分離): 印関連の違反(頭数・優先順位・未知の印文字の3種)は、確率補正
 *    (adjustedProb/clipped/reason)自体は計算できているため捨てない。専用の
 *    AnalyzerMarkViolationError で「確率補正は保持したまま全馬 mark=null にした horses」を運び、
 *    analyze-race 側がリトライしてもなお印関連違反なら、その horses を fallback:false・
 *    marksDropped:true として採用できるようにする(印と無関係な失敗は従来どおり汎用の
 *    AnalyzerResponseParseError のみを投げ、全馬 prior フォールバックに回る)。
 *  - 判定順序: 「有効な補正0件(全馬 usedPrior)」チェックは印関連チェックより必ず先に行う。
 *    そのため、全馬の place_prob が不正な応答は、mark が違反していても印救済の対象にはならず、
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
 * 予想印関連の違反(頭数制約・優先順位・未知の印文字の3種)を表すエラー(A: フォールバック分離)。
 * AnalyzerResponseParseError のサブクラスなので既存の `toThrow(AnalyzerResponseParseError)` は
 * 引き続き成立する。印以外は正常に計算できた確率補正(adjustedProb/clipped/reason/usedPrior)を
 * 失わないよう、全馬 mark=null にした horses をペイロードとして運ぶ。
 * analyze-race 側は、リトライしてもなおこのエラーなら horses をそのまま採用し、
 * fallback:false・marksDropped:true として返す(prior に戻さない)。
 */
export class AnalyzerMarkViolationError extends AnalyzerResponseParseError {
  /**
   * 印以外の確率補正を保持したまま全馬 mark=null にした horses(prior順)。
   * ParseAnalyzerResult.horses と型を揃え(ParsedHorseResult[])、呼び出し側でキャスト不要にする。
   */
  readonly horses: ParsedHorseResult[];

  constructor(message: string, horses: ParsedHorseResult[]) {
    super(message);
    this.name = "AnalyzerMarkViolationError";
    this.horses = horses;
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
  for (const entry of rawHorses) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const num = rec["number"];
    if (typeof num !== "number" || !Number.isFinite(num)) continue;
    if (byNumber.has(num)) continue; // 重複は最初を優先。
    const prob = rec["place_prob"];
    byNumber.set(num, typeof prob === "number" ? prob : NaN);
    const reason = rec["reason"];
    reasonByNumber.set(num, typeof reason === "string" ? reason : null);
    // mark キー自体が無い場合(旧形式)は undefined のまま登録され、classifyMark で null 扱いになる。
    rawMarkByNumber.set(num, rec["mark"]);
  }

  let clippedCount = 0;
  let missingCount = 0;
  // 未知の印文字が見つかった馬の説明文(A: 他馬の確率補正計算は止めず、最後にまとめて例外にする)。
  const unknownMarkMessages: string[] = [];

  const horses: ParsedHorseResult[] = priors.map((p) => {
    const value = byNumber.get(p.umaban);
    // mark は priors に無い馬番のものを無視するため、ここ(priorsループ内)で初めて解決する。
    // 未知の印文字列は例外にせず mark=null 扱いにして、他馬の確率補正計算を継続する(A)。
    const { mark, isUnknown } = classifyMark(rawMarkByNumber.get(p.umaban));
    if (isUnknown) {
      unknownMarkMessages.push(
        `未知の予想印です(馬番${p.umaban}): ${JSON.stringify(rawMarkByNumber.get(p.umaban))}`,
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
  // 全馬 mark=null にした horses を AnalyzerMarkViolationError で運ぶ(捨てずにレスキューする)。
  if (horses.length > 0) {
    const counts = countMarks(horses);
    const violations = [
      ...unknownMarkMessages,
      ...collectMarkCountViolations(counts),
      ...collectMarkPriorityViolations(counts),
    ];
    if (violations.length > 0) {
      const rescuedHorses = horses.map((h) => ({ ...h, mark: null }));
      throw new AnalyzerMarkViolationError(violations.join("; "), rescuedHorses);
    }
  }

  return { horses, clippedCount, missingCount };
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
function countMarks(horses: readonly ParsedHorseResult[]): Record<PredictionMark, number> {
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
