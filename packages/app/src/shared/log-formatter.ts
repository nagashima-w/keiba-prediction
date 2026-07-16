/**
 * ログ整形の純関数(Task#35 ログ基盤)。
 *
 * main/renderer どちらからでも import できる副作用フリーの純関数のみを置く
 * (electron・electron-log への実接続は main/logger.ts の薄い配線層に分離し、ここでは扱わない)。
 *
 * 出力形式の設計判断: 1行JSON を採用する。
 * - ユーザー要望は「ログをそのままAIに渡して原因特定〜改修まで丸投げしたい」であり、
 *   AI(LLM)がプログラムとして解釈しやすい・grep/jqで機械的に絞り込みやすい形式が望ましい。
 * - 1エントリ1行にすることで、複数行にまたがる可読テキスト形式より「行単位でのタイムスタンプ・
 *   レベル・raceId等での検索」がしやすく、ログローテーションや部分コピーの際にエントリの境界が壊れない。
 * - キー(timestamp/level/operation/message/context/error)を固定した一貫スキーマにすることで、
 *   AIが構造を推測する必要がなくなる。
 *
 * 秘密情報の非記録(最重要・受け入れ条件4):
 * - (a) 既知の秘密フィールド名(apiKey, discordWebhookUrl, webhookUrl)の値は、フィールド名が
 *   一致した時点で無条件にマスクする(値の中身を見ない。空文字でもマスクする単純な設計)。
 * - (b) メッセージ・スタック・コンテキストの値に実際の秘密値(設定から渡された apiKey や
 *   webhookUrl の実値)が文字列として混入していても、値スキャンでマスクする(二重防御。
 *   フィールド名では拾えない、URLを別名フィールドに積んだ場合等をカバーする)。
 */

/** ログレベル。electron-log のレベル("error"|"warn"|"info"等)のうち本ツールで使う3種のみ。 */
export type LogLevel = "info" | "warn" | "error";

/**
 * ログのコンテキスト情報。raceId・url はAIが原因特定する際に重要な手がかりのため専用フィールドとし、
 * それ以外の付随情報(date・venueKind等)は index signature で自由に追加できるようにする。
 */
export interface LogContext {
  readonly raceId?: string | null;
  readonly url?: string | null;
  readonly [key: string]: unknown;
}

/** formatLogEntry への入力。 */
export interface LogEntryInput {
  /** ログレベル。 */
  readonly level: LogLevel;
  /** 操作名(どのIPCチャネル・どの処理かを一意に識別する文字列。IPC_CHANNELS の値を流用する)。 */
  readonly operation: string;
  /** 人間可読なメッセージ。 */
  readonly message: string;
  /** raceId・url等の構造化コンテキスト(省略可)。 */
  readonly context?: LogContext;
  /** 例外(Error インスタンス、または {message, stack} 形状のオブジェクト等)。省略可。 */
  readonly error?: unknown;
  /** タイムスタンプ(省略時は呼び出し時刻)。テストで固定するために注入可能にする。 */
  readonly timestamp?: Date;
}

/** マスク後に出力される固定マーカー文字列。元の秘密値の断片は一切残さない。 */
export const MASK_MARKER = "***MASKED***";

/**
 * 再帰マスキング(maskSecretFields)の深さ上限。
 * 理由: 本ツールのcontext・error.extraは通常フラット〜2階層程度(raceId/url、
 * DiscordNotifyErrorのstatus/responseBody等)で十分収まる。6段あれば通常の用途を
 * 十分に吸収しつつ、意図しない深いネスト(バグ・悪意ある入力)による処理コスト増大や
 * スタックオーバーフローのリスクを安全側で打ち切れる妥当な値として採用する。
 */
const MAX_MASK_DEPTH = 6;

/** 再帰マスキングが深さ上限に到達した際、それ以上のネストの代わりに埋め込むプレースホルダ。 */
export const DEPTH_LIMIT_MARKER = "***DEPTH_LIMIT_EXCEEDED***";

/** 再帰マスキングが循環参照を検出した際、再訪問先の代わりに埋め込むプレースホルダ(無限再帰防止)。 */
export const CIRCULAR_REFERENCE_MARKER = "***CIRCULAR_REFERENCE***";

/**
 * 秘密値スキャン(maskSecretValues)の対象とする最小文字数。
 * 理由: 1〜3文字程度の極端に短い値を秘密値としてスキャンすると、通常のログ文中に
 * 現れる数字・短い単語(レース番号や"abc"等)に偶然一致してマスクされてしまう
 * 誤爆事故が起きうる。実運用のAPIキー・Webhook URLはいずれも十分長いため、
 * 4文字未満を除外しても実害はなく、誤爆防止の閾値として妥当な値として採用する。
 */
const MIN_SECRET_LENGTH_FOR_SCAN = 4;

/**
 * 既知の秘密フィールド名(camelCase・厳密一致)。
 * apiKey: 設定画面のAnthropic APIキー。discordWebhookUrl: 設定画面のDiscord Webhook URL。
 * webhookUrl: 汎用の別名(将来的な呼び出し側の命名揺れに備える)。
 */
export const SECRET_FIELD_NAMES: readonly string[] = [
  "apiKey",
  "discordWebhookUrl",
  "webhookUrl",
];

const SECRET_FIELD_NAME_SET = new Set(SECRET_FIELD_NAMES);

/**
 * テキストに混入した秘密値(b)をスキャンしてマスクする。
 * 空文字・空白のみ、および MIN_SECRET_LENGTH_FOR_SCAN 未満の極端に短い secrets は
 * 対象から除外する(誤って全文字列を消費したり、短い単語に誤爆したりしないため)。
 * 正規表現ではなく split/join によるリテラル置換(secrets 側に正規表現特殊文字が
 * 含まれていても安全に置換できる)。
 * @param text 元のテキスト
 * @param secrets 既知の秘密値一覧(設定から渡された実際の apiKey・webhookUrl 等)
 */
export function maskSecretValues(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) {
    if (secret.trim().length < MIN_SECRET_LENGTH_FOR_SCAN) {
      continue;
    }
    masked = masked.split(secret).join(MASK_MARKER);
  }
  return masked;
}

/**
 * context・error.extra 等の値を再帰的にマスキングする内部ヘルパー(要修正2)。
 * - オブジェクトのキーが既知の秘密フィールド名(SECRET_FIELD_NAMES)に一致すれば、
 *   値の型(文字列・オブジェクト・配列いずれでも)に関わらずまるごと MASK_MARKER に置き換える。
 * - 文字列の葉ノードは maskSecretValues で秘密値スキャンする(フィールド名が秘密名でなくても、
 *   値そのものが既知の秘密値と一致すればマスクする二重防御)。
 * - 配列・オブジェクトは深さ上限(MAX_MASK_DEPTH)まで再帰し、上限超過時は DEPTH_LIMIT_MARKER に置き換える。
 * - 循環参照は WeakSet で訪問済みオブジェクトを記録して検出し、無限再帰を避けて
 *   CIRCULAR_REFERENCE_MARKER に置き換える(安全側フォールバック)。
 * @param value 対象の値
 * @param secrets 秘密値スキャン対象
 * @param depth 現在の再帰深さ(トップレベル=マスク対象オブジェクト自身が0)
 * @param seen 訪問済みオブジェクト・配列の集合(循環参照検出用)
 */
function maskDeep(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return maskSecretValues(value, secrets);
  }
  if (value === null || typeof value !== "object") {
    // number/boolean/undefined/bigint/function等はスキャン・マスクの対象外(文字列化しない)。
    return value;
  }
  if (depth >= MAX_MASK_DEPTH) {
    return DEPTH_LIMIT_MARKER;
  }
  if (seen.has(value)) {
    return CIRCULAR_REFERENCE_MARKER;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, secrets, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_FIELD_NAME_SET.has(key)
      ? MASK_MARKER
      : maskDeep(v, secrets, depth + 1, seen);
  }
  return out;
}

/**
 * コンテキスト(または error.extra 等の任意のレコード)の秘密フィールド名(a)をマスクし、
 * あわせて残りの文字列値を secrets でスキャンマスク(b)する(要修正2: 再帰的に適用)。
 * ネストしたオブジェクト・配列にも対応し、深さ上限・循環参照ガードで安全側に倒す。
 * @param context 元のコンテキスト(undefined ならそのまま undefined を返す)
 * @param secrets 既知の秘密値一覧(省略時は空配列。値スキャンを行わずフィールド名マスクのみ適用する)
 */
// オーバーロード: 呼び出し側が具体的な形状(LogContext等)を渡した場合は戻り値も同じ形で
// 返ることを型で保証する(テストや呼び出し元で毎回 `!` や undefined チェックを書かなくて済むため)。
export function maskSecretFields<T extends Record<string, unknown>>(
  context: T,
  secrets?: readonly string[],
): T;
export function maskSecretFields(
  context: undefined,
  secrets?: readonly string[],
): undefined;
export function maskSecretFields(
  context: Record<string, unknown> | undefined,
  secrets: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (context === undefined) {
    return undefined;
  }
  return maskDeep(context, secrets, 0, new WeakSet()) as Record<string, unknown>;
}

/** extractErrorInfo の戻り値。 */
export interface ErrorInfo {
  readonly name: string | null;
  readonly message: string;
  readonly stack: string | null;
  /**
   * name/message/stack 以外の列挙可能な own property(提案採用2)。
   * DiscordNotifyError の status/responseBody のような、例外が独自に持つ診断情報を
   * 安全な範囲でログへ含めるためのフィールド。該当プロパティが無い場合は省略する
   * (既存の extractErrorInfo テストの完全一致比較を壊さないため)。
   */
  readonly extra?: Record<string, unknown>;
}

/** name/message/stack を除いた own enumerable property を抽出する(無ければ undefined)。 */
function extractExtraProperties(source: object): Record<string, unknown> | undefined {
  const entries = Object.entries(source).filter(
    ([key]) => key !== "name" && key !== "message" && key !== "stack",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * 例外値からログ出力用の情報を抽出する純関数。
 * - Error インスタンス: name/message/stack をそのまま使い、それ以外の列挙可能な own property
 *   (DiscordNotifyError の status/responseBody 等)があれば extra に含める。
 * - {message, stack} 形状のプレーンオブジェクト(IPC越しに構造化クローンされたエラーや、
 *   renderer側で手動シリアライズしたエラー情報)からも抽出する(同様に extra を含める)。
 * - 文字列・数値等: message として扱い、name/stack は null。
 * - undefined/null: エラー情報なしとして null を返す。
 */
export function extractErrorInfo(error: unknown): ErrorInfo | null {
  if (error === undefined || error === null) {
    return null;
  }
  if (error instanceof Error) {
    const extra = extractExtraProperties(error);
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  if (typeof error === "object" && "message" in error) {
    const e = error as { message?: unknown; stack?: unknown; name?: unknown };
    const extra = extractExtraProperties(error);
    return {
      name: typeof e.name === "string" ? e.name : null,
      message: typeof e.message === "string" ? e.message : String(e.message),
      stack: typeof e.stack === "string" ? e.stack : null,
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  return { name: null, message: String(error), stack: null };
}

/**
 * JSON.stringify(record) が失敗した場合の最終フォールバック(要修正1)。
 * record の中身(マスキング済みとはいえ構造は信用しない)は使わず、input(呼び出し時に渡された
 * 生の値)から最低限の情報(timestamp・level・operation・message・失敗した旨)だけを、
 * String() 変換とテンプレートリテラルの手組みだけで安全に1行JSON文字列として組み立てる
 * (JSON.stringify を二度と使わないため、ここでの文字列化自体は失敗しない)。
 * secrets によるメッセージのマスクはここでも適用する(フォールバック経由でも秘密情報を漏らさないため)。
 */
function buildFallbackLogLine(
  input: LogEntryInput,
  timestamp: string,
  secrets: readonly string[],
): string {
  const message = maskSecretValues(safeToString(input.message), secrets);
  const operation = safeToString(input.operation);
  return (
    "{" +
    `"timestamp":"${escapeForFallbackJson(timestamp)}",` +
    `"level":"${escapeForFallbackJson(input.level)}",` +
    `"operation":"${escapeForFallbackJson(operation)}",` +
    `"message":"${escapeForFallbackJson(message)}",` +
    `"note":"ログの構造化シリアライズに失敗したため、最小限の情報のみを出力しています"` +
    "}"
  );
}

/** String() 変換自体が失敗する(toString()が例外を投げる)ケースに備えた安全な文字列化。 */
function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(文字列化に失敗しました)";
  }
}

/** フォールバック用の手組みJSON文字列に埋め込むため、最低限の特殊文字をエスケープする。 */
function escapeForFallbackJson(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * ログ1エントリを一貫した1行JSON文字列に整形する。
 *
 * 秘密情報のマスキングは常に適用される(呼び出し側が意識しなくても安全側に倒れる):
 * 1. context はフィールド名マスク(a)と値スキャンマスク(b)の両方を再帰的に適用する(要修正2)。
 * 2. message・error.message・error.stack・error.extra は secrets でスキャンマスク(b)する
 *    (error.extra はさらにフィールド名マスク(a)も再帰的に適用する)。
 *
 * 二重防御(要修正1): 上記のマスキング(要修正2の深さ上限・循環参照ガード)を経てもなお
 * JSON.stringify が失敗しうる値(BigInt等)が混入した場合に備え、最終防御線として
 * try/catch で包み、失敗時は buildFallbackLogLine で最小限の安全な1行を返す
 * (例外を外へ投げない。呼び出し元 main/logger.ts の write() は async 関数のため、
 * ここで例外を投げると reject した Promise になり、fire-and-forget 呼び出し元では
 * unhandledRejection としてログ自体が消えてしまう)。
 *
 * @param input ログエントリの内容
 * @param secrets 既知の秘密値一覧(省略時は空配列。呼び出し側=main/logger.ts が現在の設定から都度渡す)
 */
export function formatLogEntry(input: LogEntryInput, secrets: readonly string[] = []): string {
  const timestamp = (input.timestamp ?? new Date()).toISOString();
  try {
    const record: Record<string, unknown> = {
      timestamp,
      level: input.level,
      operation: input.operation,
      message: maskSecretValues(input.message, secrets),
    };

    if (input.context !== undefined) {
      record.context = maskSecretFields(input.context, secrets);
    }

    const errorInfo = extractErrorInfo(input.error);
    if (errorInfo !== null) {
      const maskedExtra =
        errorInfo.extra !== undefined ? maskSecretFields(errorInfo.extra, secrets) : undefined;
      record.error = {
        name: errorInfo.name,
        message: maskSecretValues(errorInfo.message, secrets),
        stack: errorInfo.stack !== null ? maskSecretValues(errorInfo.stack, secrets) : null,
        ...(maskedExtra !== undefined ? { extra: maskedExtra } : {}),
      };
    }

    return JSON.stringify(record);
  } catch {
    return buildFallbackLogLine(input, timestamp, secrets);
  }
}
