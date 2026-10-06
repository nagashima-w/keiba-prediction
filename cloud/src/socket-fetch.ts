/**
 * Worker の TCP ソケット(`cloudflare:sockets` の `connect()`)で netkeiba を取得する(Issue #162 段階2a)。
 * Workers の `fetch` は Cloudflare が付ける中継ヘッダのせいで netkeiba(CloudFront)から HTTP 400 になるため(#160)、
 * HTTP/1.1 の GET を自前で組み立てて送る。
 *
 * **`cloudflare:sockets` をここでは import しない**: `connect` を引数で受ける。`cloudflare:sockets` は Node の vitest では
 * 解決できないため、DO のラッパ(`netkeiba-gate-do.ts`)だけが本物の `connect` を渡す。これで、偽ソケット(Web Streams)で
 * 読み取りループ・EOF・サイズ上限・タイムアウト・後始末をテストできる。
 *
 * 送るヘッダは**この集合だけ**({@link NETKEIBA_REQUEST_HEADERS})。呼び出し側からヘッダを渡す口は無い。段階1(#162)の実測で、
 * この4つ + `Host` + `Connection: close`(`Accept-Encoding` なし)の形が、race・db・nar の9本すべて HTTP 200 だった。
 * **圧縮は要求しない**(gzip を要求しても圧縮されずに返ったため)。
 *
 * 守り:
 *  - **再試行もリダイレクトの追従もしない**(1回の呼び出しで接続は1回。3xx は応答として返すだけ)
 *  - 読み取りには**サイズ上限**({@link SOCKET_MAX_BYTES})と**全体のタイムアウト**({@link SOCKET_TIMEOUT_MS})を設ける
 *  - `content-encoding` が identity 以外で返ったら、**受信済みのステータスを持つ**例外にする(圧縮された 403/429 も、
 *    呼び出し側のサーキットブレーカーが数えられるように。status を落とすと、拒否されているのに撃ち続ける)
 *  - ソケットは、成功・失敗・打ち切りのいずれでも必ず閉じる
 *
 * 由来: 調査(#160・#162 段階1)の `spikes/cloudflare/src/socket-probe.ts` を土台に、本番用として作り直した(調査のコードは参照しない)。
 * gzip の展開・計測用のメタ情報・ProbeFetch への適合は持ち込まない。
 */

import { buildHttp1Request, Http1Error, parseHttp1Response, type HeaderEntry } from "./http1";

/**
 * User-Agent。core の `DEFAULT_USER_AGENT`(`packages/core/src/scraper/http-client.ts`)と同じ文字列。
 * core を取り込まずに済むよう文字列で持つ。両者の一致はテストが固定している(core 側が変わったらテストが落ちる)。
 */
export const NETKEIBA_USER_AGENT = "keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)";

/**
 * 送るヘッダ(この順序)。`Host` と `Connection: close` は組み立て側が付ける。
 * #160 E3 で通り、#162 段階1 の9本でも使った集合(Node の fetch の観測から導いたもの。`accept-encoding`・`connection` は送らない)。
 */
export const NETKEIBA_REQUEST_HEADERS: readonly HeaderEntry[] = [
  { name: "User-Agent", value: NETKEIBA_USER_AGENT },
  { name: "accept", value: "*/*" },
  { name: "accept-language", value: "*" },
  { name: "sec-fetch-mode", value: "cors" },
];

/** 受信バイト数の上限(超えたら打ち切る)。出馬表の実測は約 277 KB(#162 段階1)。 */
export const SOCKET_MAX_BYTES = 2 * 1024 * 1024;

/** 1回の取得(接続・送信・受信)全体のタイムアウト(ミリ秒)。 */
export const SOCKET_TIMEOUT_MS = 20_000;

/** `cloudflare:sockets` の `Socket` のうち、ここで使う部分(偽ソケットを作れる最小限)。 */
export interface SocketLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<unknown>;
  close(): Promise<void>;
}

/** `cloudflare:sockets` の `connect` のうち、ここで使う形(TLS で接続し、半開きにしない)。 */
export type ConnectFn = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on"; allowHalfOpen: false },
) => SocketLike;

/** 取得の失敗の種類。 */
export type SocketFetchErrorKind =
  /** 全体のタイムアウト。 */
  | "timeout"
  /** 接続・送信・受信の失敗(ネットワークの失敗)。 */
  | "network"
  /** サイズ上限を超えた。 */
  | "too-large"
  /** 応答を HTTP/1.1 として読めない(途中で切断・不正な形式)、または URL が許されない形。 */
  | "malformed"
  /** `content-encoding` が identity 以外(圧縮は要求していない)。 */
  | "unsupported-encoding";

/**
 * 取得の失敗。`status` は、応答のステータス行・ヘッダまで読めていたときだけ持つ(`unsupported-encoding`)。
 * **サーキットブレーカーは、この status を拒否の判定に使う。**
 */
export class SocketFetchError extends Error {
  readonly kind: SocketFetchErrorKind;
  readonly status: number | undefined;

  constructor(kind: SocketFetchErrorKind, message: string, status?: number) {
    super(message);
    this.name = "SocketFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export interface SocketResponse {
  readonly status: number;
  /** 応答の `content-type`(無ければ null)。文字コードのデコードは呼び出し側。 */
  readonly contentType: string | null;
  /** 本文(バイトのまま)。 */
  readonly body: Uint8Array;
}

/** URL を1本取得する。接続は1回だけ(再試行・リダイレクト追従なし)。 */
export type SocketFetcher = (url: string) => Promise<SocketResponse>;

export interface SocketFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ソケットで取得する関数を作る。 */
export function createSocketFetcher(connect: ConnectFn, options: SocketFetchOptions = {}): SocketFetcher {
  const maxBytes = options.maxBytes ?? SOCKET_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;

  return async (url) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new SocketFetchError("malformed", `URL として読めません: ${url.slice(0, 80)}`);
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.port !== "" || parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new SocketFetchError("malformed", "ソケットで取得できるのは、https・ポート指定なし(443)・ユーザー情報なしの URL だけです");
    }

    // 接続の前に組み立てる(不正な値はここで拒否され、接続しない)。
    let request: Uint8Array;
    try {
      request = new TextEncoder().encode(
        buildHttp1Request({
          host: parsedUrl.hostname,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          headers: NETKEIBA_REQUEST_HEADERS,
        }),
      );
    } catch (error) {
      throw new SocketFetchError("malformed", messageOf(error));
    }

    const received: Uint8Array[] = [];
    let total = 0;
    let socket: SocketLike | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    let abortWith: (error: SocketFetchError) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortWith = reject;
    });
    const timer = setTimeout(
      () => abortWith(new SocketFetchError("timeout", `タイムアウト(${timeoutMs} ms)で打ち切りました(受信 ${total} バイト)`)),
      timeoutMs,
    );

    const work = (async (): Promise<Uint8Array> => {
      try {
        socket = connect({ hostname: parsedUrl.hostname, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
        await socket.opened;
        const writer = socket.writable.getWriter();
        try {
          await writer.write(request);
        } finally {
          try {
            writer.releaseLock();
          } catch {
            // 書き込みが失敗したあとのロック解放の失敗は、元の例外を優先して無視する。
          }
        }
        reader = socket.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value !== undefined) {
            received.push(value);
            total += value.length;
            if (total > maxBytes) {
              throw new SocketFetchError("too-large", `サイズ上限(${maxBytes} バイト)を超えたため打ち切りました`);
            }
          }
        }
        return concat(received, total);
      } catch (error) {
        throw error instanceof SocketFetchError ? error : new SocketFetchError("network", messageOf(error));
      }
    })();
    // 打ち切りで aborted が先に決着したとき、work 側の遅れて起きる拒否が未処理の拒否にならないようにする。
    work.catch(() => {});

    try {
      const bytes = await Promise.race([work, aborted]);
      let parsed;
      try {
        parsed = parseHttp1Response(bytes);
      } catch (error) {
        throw new SocketFetchError("malformed", error instanceof Http1Error ? error.message : messageOf(error));
      }
      if (parsed.status > 599) {
        throw new SocketFetchError("malformed", `Response にできないステータスです(HTTP ${parsed.status})`);
      }
      const encoding = parsed.headers.find((h) => h.name === "content-encoding")?.value.trim().toLowerCase();
      if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
        throw new SocketFetchError(
          "unsupported-encoding",
          `未対応の content-encoding: ${encoding.slice(0, 40)}(Accept-Encoding を送っていないのに圧縮された。デコードしない)`,
          parsed.status,
        );
      }
      return {
        status: parsed.status,
        contentType: parsed.headers.find((h) => h.name === "content-type")?.value ?? null,
        body: parsed.body,
      };
    } finally {
      clearTimeout(timer);
      const r = reader as ReadableStreamDefaultReader<Uint8Array> | null;
      if (r !== null) {
        try {
          await r.cancel();
        } catch {
          // すでに閉じている。
        }
      }
      const s = socket as SocketLike | null;
      if (s !== null) {
        try {
          await s.close();
        } catch {
          // 閉じる操作の失敗で、取得の結果(成功・失敗)を隠さない。
        }
      }
    }
  };
}
