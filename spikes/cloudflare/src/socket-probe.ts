/**
 * Worker の TCP ソケット(`cloudflare:sockets` の `connect()`)で netkeiba を取得するための `ProbeFetch`
 * (Issue #160〈#21-B〉E3)。fetch の自動ヘッダ・fetch 実装の TLS の特徴を無くして、HTTP/1.1 の GET を
 * 自前で組み立てて送る。
 *
 * **`cloudflare:sockets` をここでは import しない**: `connect` を引数で受ける。`cloudflare:sockets` は Node の
 * vitest でもルートの tsc でも解決できないため、Worker のエントリ(`worker.ts`)だけが本物の `connect` を渡す。
 * これで、偽ソケット(Web Streams)で読み取りループ・EOF・サイズ上限・タイムアウト・後始末をテストできる
 * (`scripts/test/cloudflare-spike-socket-probe.test.ts`)。
 *
 * **返すのは `ProbeFetch`**: `probeNetkeiba(request, socketFetch)` に差し込むと、記録の形(`NetkeibaProbeRecord`)・
 * EUC-JP のデコード・既存パーサ・診断ヘッダの選択・`maxRetries: 0` がそのまま使える。ランナーの fetch との
 * 差は取得手段だけになる。
 *
 * 守り:
 *  - **再試行もリダイレクトの追従もしない**(1回の呼び出しで接続は1回。3xx は Response として返すだけ)
 *  - 読み取りには**サイズ上限**({@link SOCKET_MAX_BYTES})と**タイムアウト**({@link SOCKET_TIMEOUT_MS})を設け、
 *    超えたら読むのをやめて、受信済みのステータスを添えた例外にする(記録の `error` に残る)
 *  - 既定では圧縮を要求しない(Accept-Encoding を送らない)。`content-encoding` が identity 以外で返ったら未対応として例外にする
 *  - **#162 段階1: `acceptEncoding: "gzip"` で opt-in すると、`Accept-Encoding: gzip` を送り、gzip の本文を
 *    `DecompressionStream`(上限 {@link SOCKET_MAX_DECODED_BYTES})で展開する。** gzip・identity 以外(br など)は
 *    例外にする。展開した Response からは `content-encoding` と `content-length` を外す(undici の fetch の見え方に揃える)
 *  - **計測用のメタ情報**(`onMeta`。受信バイト数・圧縮後/展開後の本文バイト数・方式・本文のハッシュ・時間3点)を、
 *    成功した取得(拒否の応答を含む)についてだけ出す。失敗では出さない(部分的な数値を成功の記録に混ぜない)
 *  - ソケットは、成功・失敗・打ち切りのいずれでも必ず閉じる
 */

import {
  buildHttp1Request,
  gunzipLimited,
  parseHttp1Response,
  peekHttp1Status,
  type HeaderEntry,
  type ParsedHttp1Response,
  type SocketFetchMeta,
} from "../../../scripts/cloudflare-spike/http1.js";
import type { ProbeFetch } from "./netkeiba-probe.js";

/** 受信バイト数の上限(超えたら打ち切る)。 */
export const SOCKET_MAX_BYTES = 2 * 1024 * 1024;

/** 1回の取得(接続・送信・受信)全体のタイムアウト(ミリ秒)。 */
export const SOCKET_TIMEOUT_MS = 20_000;

/** gzip を展開した後のバイト数の上限(超えたら打ち切る。圧縮爆弾の防止)。 */
export const SOCKET_MAX_DECODED_BYTES = 4 * 1024 * 1024;

/** 打ち切りの記録に添えるステータスを読むために保持する先頭のバイト数。 */
const STATUS_PEEK_BYTES = 256;

/**
 * 応答のステータス行・ヘッダまでは読めたが、本文の扱い(未対応の content-encoding・gzip の展開失敗など)で失敗した例外。
 * **受信済みのステータスを持つ**: 記録(`NetkeibaProbeRecord.status`)に残し、圧縮された 403/429 も連続拒否の判定に数えるため
 * (status=null の通信エラー扱いにすると、拒否が数えられず netkeiba へ撃ち続ける)。メッセージは理由を表す。
 */
export class SocketResponseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SocketResponseError";
    this.status = status;
  }
}

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

// 計測用メタ情報の型は、Worker(ここ)とドライバ・集計(scripts/cloudflare-spike)で共有するため http1.ts に置く。
export type { SocketFetchMeta };

export interface SocketFetchOptions {
  /** 送るヘッダ(この順序)。`Host` と `Connection: close` は自前で付ける。 */
  readonly headers: readonly HeaderEntry[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** `Accept-Encoding: gzip` を送り、gzip の応答を展開する opt-in(#162)。省略時は送らない。 */
  readonly acceptEncoding?: "gzip";
  /** gzip を展開した後のバイト数の上限。省略時は {@link SOCKET_MAX_DECODED_BYTES}。 */
  readonly maxDecodedBytes?: number;
  /** 計測用の時計(ms)。省略時は `Date.now`。開始・opened・最初のバイト・終了の4点で1回ずつ呼ぶ。 */
  readonly now?: () => number;
  /** 成功した取得ごとに呼ばれる計測用のメタ情報。 */
  readonly onMeta?: (meta: SocketFetchMeta) => void;
}

const NO_BODY_STATUSES: readonly number[] = [204, 205, 304];

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * fetch の init のヘッダ(`HttpClient` が付ける User-Agent など)を足す。**同名(大文字小文字を区別しない)なら
 * `options.headers` の値を優先する**(ドライバが、ランナーの観測から導出して渡した集合(`accept-encoding`・`connection` は除く)が正で、init はそれに無い名前を
 * 末尾に足すだけ)。
 */
function mergeHeaders(base: readonly HeaderEntry[], extra: Record<string, string> | undefined): HeaderEntry[] {
  const out = base.map((h) => ({ ...h }));
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!out.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, value });
    }
  }
  return out;
}

async function sha256Prefix(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
  let hex = "";
  for (const byte of digest.subarray(0, 8)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** 解いた応答を Response にする。gzip は opt-in のときだけ展開し、gzip・identity 以外の content-encoding は例外にする。 */
async function toResponse(
  parsed: ParsedHttp1Response,
  decode: { readonly acceptGzip: boolean; readonly maxDecodedBytes: number },
): Promise<{ response: Response; decoded: Uint8Array; contentEncoding: string | null }> {
  if (parsed.status < 200 || parsed.status > 599) {
    throw new Error(`Response にできないステータスです(HTTP ${parsed.status})`);
  }
  const rawEncoding = parsed.headers.find((h) => h.name === "content-encoding")?.value.trim().toLowerCase();
  const contentEncoding = rawEncoding === undefined || rawEncoding === "" ? null : rawEncoding;
  let body = parsed.body;
  let handledGzip = false;
  if (contentEncoding !== null && contentEncoding !== "identity") {
    if (contentEncoding === "gzip" && decode.acceptGzip) {
      // 本文0バイト(拒否の応答など)は展開しない(空の gzip ではないので、展開すると壊れた gzip になる)。
      if (body.length > 0) {
        body = await gunzipLimited(body, decode.maxDecodedBytes);
      }
      handledGzip = true;
    } else {
      throw new Error(
        `未対応の content-encoding: ${contentEncoding}(${
          decode.acceptGzip ? "gzip と identity だけ対応している" : "Accept-Encoding を送っていないのに圧縮された。デコードしない"
        })`,
      );
    }
  }
  const headers = new Headers();
  for (const h of parsed.headers) {
    if (handledGzip && (h.name === "content-encoding" || h.name === "content-length")) {
      continue;
    }
    try {
      headers.append(h.name, h.value);
    } catch {
      // Headers が受け付けない名前・値は飛ばす(診断用の記録を、応答の一部の不備で失わない)。
    }
  }
  // 本文は新しい ArrayBuffer にコピーして渡す(元は受信バッファ全体の一部を指す view で、型も BodyInit に合わない)。
  const response = new Response(NO_BODY_STATUSES.includes(parsed.status) ? null : new Uint8Array(body), {
    status: parsed.status,
    headers,
  });
  return { response, decoded: body, contentEncoding };
}

/** ソケットで取得する `ProbeFetch` を作る。接続は1回の呼び出しにつき1回だけ(再試行・リダイレクト追従なし)。 */
export function createSocketFetch(connect: ConnectFn, options: SocketFetchOptions): ProbeFetch {
  const maxBytes = options.maxBytes ?? SOCKET_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;
  const maxDecodedBytes = options.maxDecodedBytes ?? SOCKET_MAX_DECODED_BYTES;
  const now = options.now ?? (() => Date.now());

  return async (url, init) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`URL として読めません: ${url.slice(0, 80)}`);
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.port !== "" || parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new Error("ソケットで取得できるのは、https・ポート指定なし(443)・ユーザー情報なしの URL だけです");
    }
    if (init.signal?.aborted === true) {
      throw new Error("リクエストが開始前に中止されました");
    }

    // 接続の前に組み立てる(禁止ヘッダ・不正な値はここで拒否され、接続しない)。
    const request = new TextEncoder().encode(
      buildHttp1Request({
        host: parsedUrl.hostname,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: mergeHeaders(options.headers, init.headers),
        ...(options.acceptEncoding !== undefined ? { acceptEncoding: options.acceptEncoding } : {}),
      }),
    );

    const received: Uint8Array[] = [];
    let total = 0;
    let startedAt = 0;
    let openedAt = 0;
    let firstByteAt: number | null = null;
    let endedAt = 0;
    let socket: SocketLike | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    /** 打ち切りの理由に添える、受信の状況(バイト数と、読めていればステータス)。 */
    const receivedContext = (): string => {
      const head: Uint8Array[] = [];
      let headBytes = 0;
      for (const chunk of received) {
        head.push(chunk);
        headBytes += chunk.length;
        if (headBytes >= STATUS_PEEK_BYTES) {
          break;
        }
      }
      const status = peekHttp1Status(concat(head, headBytes));
      return `受信 ${total} バイト${status === null ? "" : `、HTTP ${status} のヘッダを受信済み`}`;
    };

    let abortWith: (message: string) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortWith = (message) => reject(new Error(message));
    });
    const timer = setTimeout(() => abortWith(`タイムアウト(${timeoutMs} ms)で打ち切りました(${receivedContext()})`), timeoutMs);
    const onAbort = (): void => abortWith(`リクエストが中止されました(${receivedContext()})`);
    init.signal?.addEventListener("abort", onAbort, { once: true });

    const work = (async (): Promise<Uint8Array> => {
      startedAt = now();
      socket = connect({ hostname: parsedUrl.hostname, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
      await socket.opened;
      openedAt = now();
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
          if (firstByteAt === null) {
            firstByteAt = now();
          }
          received.push(value);
          total += value.length;
          if (total > maxBytes) {
            throw new Error(`サイズ上限(${maxBytes} バイト)を超えたため打ち切りました(${receivedContext()})`);
          }
        }
      }
      endedAt = now();
      return concat(received, total);
    })();
    // 打ち切りで aborted が先に決着したとき、work 側の遅れて起きる拒否が未処理の拒否にならないようにする。
    work.catch(() => {});

    try {
      const bytes = await Promise.race([work, aborted]);
      const parsed = parseHttp1Response(bytes);
      let built: Awaited<ReturnType<typeof toResponse>>;
      try {
        built = await toResponse(parsed, { acceptGzip: options.acceptEncoding === "gzip", maxDecodedBytes });
      } catch (error) {
        // ステータスは受信済み。理由(メッセージ)はそのままに、ステータスを添えて投げ直す。
        throw new SocketResponseError(error instanceof Error ? error.message : String(error), parsed.status);
      }
      const { response, decoded, contentEncoding } = built;
      if (options.onMeta !== undefined) {
        options.onMeta({
          status: parsed.status,
          framing: parsed.framing,
          contentEncoding,
          receivedBytes: bytes.length,
          wireBodyBytes: parsed.body.length,
          decodedBytes: decoded.length,
          bodySha256: await sha256Prefix(decoded),
          openedMs: openedAt - startedAt,
          firstByteMs: firstByteAt === null ? null : (firstByteAt as number) - startedAt,
          totalMs: endedAt - startedAt,
        });
      }
      return response;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
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
