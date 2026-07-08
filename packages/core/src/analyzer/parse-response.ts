/**
 * レスポンス処理 — LLM出力テキストから JSON を抽出・パースし、バリデーション/±10%クリップ/
 * 馬番欠け補完を行う純関数群。
 *
 * 仕様「3. analyzer」:
 *  - コードフェンス付き・前後に説明文があるなどの揺れに耐えて JSON を取り出す。
 *  - 全馬番が揃っているか、place_prob が [0,1] か、prior から ±10%(絶対値0.10)以内か検証し、
 *    逸脱した馬は prior±0.10(かつ [0,1])にクリップして clipped を記録する。
 *  - 欠けた馬番(および place_prob が不正な馬)は prior をそのまま採用し記録する。
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

/** parse に渡す prior 参照(馬番 → prior)。 */
export interface PriorRef {
  /** 馬番。 */
  readonly umaban: number;
  /** その馬の prior(scorer 出力)。 */
  readonly prior: number;
}

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
  }

  let clippedCount = 0;
  let missingCount = 0;

  const horses: ParsedHorseResult[] = priors.map((p) => {
    const value = byNumber.get(p.umaban);

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
    };
  });

  // 有効な補正が1件も無い(全馬 prior のまま)場合は、スキーマ妥当でも実質失敗とみなす。
  // 例: {"horses":[]} や余分な馬番のみ。analyzer 本体でリトライ→フォールバックに回すため例外にする。
  if (priors.length > 0 && horses.every((h) => h.usedPrior)) {
    throw new AnalyzerResponseParseError(
      "有効な補正が0件(全馬 prior のまま)でした",
    );
  }

  return { horses, clippedCount, missingCount };
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
