import iconv from "iconv-lite";

/**
 * fetch(undici互換)が返すレスポンスのうち、本クライアントが利用する最小限のインターフェース。
 * これに絞ることで、テストでは実ネットワークを使わず疑似レスポンスを注入できる。
 */
export interface FetchResponse {
  /** HTTPステータスコード */
  readonly status: number;
  /** 2xx系かどうか(undici Response.ok 相当) */
  readonly ok: boolean;
  /** ヘッダ参照(存在しなければ null を返す) */
  readonly headers: { get(name: string): string | null };
  /** レスポンスボディを生バイト列として取得する */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * 注入可能な fetch 関数の型(undici の fetch 相当を最小限に抽象化したもの)。
 */
export type FetchLike = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

/** 本クライアントがサポートするデコード用エンコーディング。 */
export type SupportedEncoding = "euc-jp" | "utf-8";

/**
 * User-Agent を明示するためのデフォルト値。
 * netkeibaへのスクレイピングであることを隠さず、個人利用である旨を示す。
 */
export const DEFAULT_USER_AGENT =
  "keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)";

/** リクエスト間隔のデフォルト(ミリ秒)。仕様の「最低1.5秒」を満たす。 */
export const DEFAULT_MIN_INTERVAL_MS = 1500;

/** 一時的エラー時のリトライ回数のデフォルト。 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * リクエスト単位のタイムアウトのデフォルト(ミリ秒)。
 * undiciのfetchはボディ受信ハングに全体タイムアウトを持たないため、
 * 本クライアント側で打ち切ることで直列チェーン全体のブロックを防ぐ。
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/** HttpClient の構築オプション。 */
export interface HttpClientOptions {
  /** 注入する fetch 関数。省略時は undici の fetch を使う。 */
  fetch?: FetchLike;
  /** リクエストの最低間隔(ミリ秒)。デフォルト 1500。 */
  minIntervalMs?: number;
  /** 明示する User-Agent。デフォルトは DEFAULT_USER_AGENT。 */
  userAgent?: string;
  /** 一時的エラー(5xx / ネットワークエラー)のリトライ回数。デフォルト 2。 */
  maxRetries?: number;
  /**
   * リクエスト単位のタイムアウト(ミリ秒)。デフォルト 30000。
   * この時間内に応答が完了しない場合は一時的エラーとして打ち切り、リトライ対象とする。
   */
  timeoutMs?: number;
  /** デコード時のデフォルトエンコーディング。charset未指定時に使う。デフォルト utf-8。 */
  defaultEncoding?: SupportedEncoding;
}

/** fetchText の呼び出しオプション。 */
export interface FetchTextOptions {
  /** デコードに使うエンコーディングを明示指定する(Content-Typeより優先)。 */
  encoding?: SupportedEncoding;
}

/**
 * HTTP取得の失敗を表す例外。理由(ステータス・URL・原因)を保持する。
 */
export class HttpError extends Error {
  /** 失敗したリクエストのURL。 */
  readonly url: string;
  /** HTTPステータス(ネットワークエラー時は undefined)。 */
  readonly status?: number;

  constructor(
    message: string,
    options: { url: string; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.url = options.url;
    this.status = options.status;
  }
}

/**
 * undici本体のロードは1度だけ行い、以降は同じPromiseを再利用する遅延シングルトン。
 * テスト等で fetch を注入する場合はこの経路を通らないため、undiciのロードコストは発生しない。
 */
let undiciModulePromise: Promise<typeof import("undici")> | undefined;

/**
 * 環境変数(HTTPS_PROXY/NO_PROXY等)を参照するdispatcher。
 * プロセス内で1つだけ生成して全リクエストで使い回す(リクエストごとには生成しない)。
 */
let sharedDispatcher: import("undici").Dispatcher | undefined;

/** undici本体を遅延ロードする(初回のみ実import、以降はキャッシュ)。 */
function loadUndici(): Promise<typeof import("undici")> {
  if (undiciModulePromise === undefined) {
    undiciModulePromise = import("undici");
  }
  return undiciModulePromise;
}

/**
 * デフォルトの fetch 実装。
 *
 * undiciの素のfetchは HTTPS_PROXY / NO_PROXY 環境変数を自動では参照しないため、
 * プロキシ経由必須の環境では全リクエストが失敗する。これを避けるため、
 * EnvHttpProxyAgent を dispatcher として渡し、環境変数に従ってプロキシを利用させる。
 * EnvHttpProxyAgent は該当環境変数が無ければ通常のAgentと同等に振る舞うため、
 * プロキシ無し環境でも安全に動作する。
 * dispatcher はプロセス内で1つを再利用する(リクエストごとに生成しない)。
 */
async function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<FetchResponse> {
  const { fetch, EnvHttpProxyAgent } = await loadUndici();
  if (sharedDispatcher === undefined) {
    sharedDispatcher = new EnvHttpProxyAgent();
  }
  return fetch(url, {
    ...init,
    dispatcher: sharedDispatcher,
  }) as unknown as Promise<FetchResponse>;
}

/**
 * レート制限・User-Agent明示・リトライ・文字コードデコードを備えたHTTPクライアント。
 *
 * - すべてのリクエストは直列に「発火スロット」を取得し、発火間隔が minIntervalMs 以上になるよう保証する。
 *   並行に呼び出しても間隔は守られる。
 * - 5xx応答とネットワークエラー(fetchのreject)は一時的エラーとみなし maxRetries 回までリトライする。
 * - 4xx応答は即座に HttpError を投げる(リトライしない)。
 * - レスポンスは Buffer で受け、指定または Content-Type の charset に従ってデコードする。
 */
export class HttpClient {
  private readonly fetchFn: FetchLike;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly defaultEncoding: SupportedEncoding;

  /** 直近リクエストの発火時刻(未発火なら負の無限大)。 */
  private lastStart = Number.NEGATIVE_INFINITY;
  /** スロット取得を直列化するためのプロミスチェーン末尾。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: HttpClientOptions = {}) {
    this.fetchFn = options.fetch ?? defaultFetch;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultEncoding = options.defaultEncoding ?? "utf-8";
  }

  /**
   * URLを取得し、指定または応答のcharsetでデコードした文字列を返す。
   */
  async fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
    const { body, contentType } = await this.fetchBuffer(url);
    let encoding = options.encoding;
    if (!encoding) {
      const { raw, supported } = charsetFromContentType(contentType);
      if (supported) {
        encoding = supported;
      } else {
        // charsetが明示されているのにサポート外の場合は、黙ってフォールバックせず警告する。
        if (raw) {
          console.warn(
            `サポート外のcharset(${raw})を検出したため、${this.defaultEncoding}にフォールバックします: ${url}`,
          );
        }
        encoding = this.defaultEncoding;
      }
    }
    return iconv.decode(body, encoding);
  }

  /**
   * URLを取得し、生バイト列(Buffer)と Content-Type を返す低レベルAPI。
   * レート制限とリトライはここで適用される。
   */
  async fetchBuffer(
    url: string,
  ): Promise<{ body: Buffer; contentType: string | null; status: number }> {
    let lastError: unknown;
    // 初回 + maxRetries 回まで試行する。
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      // 発火スロットを取得(レート制限を直列に適用)。リトライも間隔対象とする。
      await this.acquireSlot();

      let response: FetchResponse;
      try {
        response = await this.fetchWithTimeout(url);
      } catch (error) {
        // タイムアウトは既に HttpError 化されているためそのまま、
        // それ以外のネットワークエラーは一時的エラーとして包む。いずれもリトライ対象。
        // 丸めたメッセージに根本原因(cause の message)を織り込む。これが無いと、
        // 例えば Electron 内蔵 Node と undici の非互換で fetch 実装が投げる実行時エラーが
        // 「ネットワークエラーにより…」に潰れ、UI から原因が読み取れなくなる。
        lastError =
          error instanceof HttpError
            ? error
            : new HttpError(
                `ネットワークエラーによりリクエストに失敗しました(原因: ${describeCause(error)}): ${url}`,
                { url, cause: error },
              );
        continue;
      }

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return {
          body: Buffer.from(arrayBuffer),
          contentType: response.headers.get("content-type"),
          status: response.status,
        };
      }

      // 5xx はサーバ側の一時的エラーとみなしリトライ。それ以外(4xx等)は即座に失敗。
      if (response.status >= 500 && response.status <= 599) {
        lastError = new HttpError(
          `サーバエラー(${response.status})が発生しました: ${url}`,
          { url, status: response.status },
        );
        continue;
      }

      throw new HttpError(
        `HTTPエラー(${response.status})が発生しました: ${url}`,
        { url, status: response.status },
      );
    }

    // リトライ上限に到達。最後に記録したエラーを投げる。
    if (lastError instanceof HttpError) {
      throw lastError;
    }
    // 通常ここへは到達しない(失敗時は必ず HttpError を lastError に積む)が、
    // 防御的フォールバックとしても根本原因を握りつぶさず「(原因: …)」を添えて投げる。
    throw new HttpError(
      `リクエストに失敗しました(原因: ${describeCause(lastError)}): ${url}`,
      { url, cause: lastError },
    );
  }

  /**
   * fetch を timeoutMs で打ち切れるようにラップする。
   * setTimeout + AbortController ベースにすることで vitest のフェイクタイマーでも制御できる。
   * タイムアウト時は AbortController を abort して実リクエストの解放を促しつつ、
   * 一時的エラーとして扱える HttpError を投げる。
   */
  private async fetchWithTimeout(url: string): Promise<FetchResponse> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(
          new HttpError(
            `リクエストがタイムアウトしました(${this.timeoutMs}ms): ${url}`,
            { url },
          ),
        );
      }, this.timeoutMs);
    });

    const fetchPromise = this.fetchFn(url, {
      headers: { "User-Agent": this.userAgent },
      signal: controller.signal,
    });
    // タイムアウトが先に解決した場合でも fetch 側の reject を握りつぶし、
    // 未処理のPromise拒否(unhandledRejection)を防ぐ。
    fetchPromise.catch(() => {});

    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * 直列に発火スロットを取得し、前回発火から minIntervalMs 以上空くまで待機する。
   * スロット取得(=lastStartの更新)は tail チェーンで直列化されるため、
   * 並行呼び出しでも間隔が保証される。
   */
  private acquireSlot(): Promise<void> {
    const run = this.tail.then(async () => {
      const waitMs = this.lastStart + this.minIntervalMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.lastStart = Date.now();
    });
    // 後続がこのスロット取得の完了を待てるよう、末尾を差し替える(失敗しても鎖は継続)。
    this.tail = run.catch(() => {});
    return run;
  }
}

/** setTimeout ベースの待機(vitestのフェイクタイマーで制御可能)。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 例外を人間可読な原因文字列へ変換する(エラーメッセージ埋め込み用)。
 * Error は message を、それ以外は String() を用いる。
 */
function describeCause(error: unknown): string {
  if (error === undefined || error === null) {
    return "不明";
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return String(error);
}

/**
 * Content-Type ヘッダから charset を取り出す。
 * - raw: ヘッダに書かれていた生の charset 名(未指定なら null)。警告表示用。
 * - supported: 本クライアントがデコードできるエンコーディング(サポート外/未指定なら null)。
 */
function charsetFromContentType(contentType: string | null): {
  raw: string | null;
  supported: SupportedEncoding | null;
} {
  if (!contentType) {
    return { raw: null, supported: null };
  }
  const match = /charset=([^;\s]+)/i.exec(contentType);
  if (!match) {
    return { raw: null, supported: null };
  }
  const raw = match[1]!.replace(/^["']|["']$/g, "");
  const charset = raw.toLowerCase();
  if (charset === "euc-jp" || charset === "eucjp" || charset === "x-euc-jp") {
    return { raw, supported: "euc-jp" };
  }
  if (charset === "utf-8" || charset === "utf8") {
    return { raw, supported: "utf-8" };
  }
  return { raw, supported: null };
}
