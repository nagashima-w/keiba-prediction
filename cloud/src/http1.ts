/**
 * ソケット(`cloudflare:sockets` の `connect()`)で HTTP/1.1 を自前で話すための純ロジック(Issue #162 段階2a)。
 * リクエストの組み立て・応答の解釈・chunked の解除だけを持ち、ネットワークにも Workers のランタイムにも依存しない。
 *
 * 範囲を絞っている: GET と POST(Issue #181。本文つき)だけ、`Connection: close` で EOF まで読む前提、**圧縮は要求しない**(`Accept-Encoding` を送らない。
 * 呼び出し側が指定することも禁止する)、1xx の暫定応答・Upgrade・パイプラインは扱わない(不正な入力は例外にする)。
 *
 * 由来: 調査(#160・#162 段階1)の `scripts/cloudflare-spike/http1.ts` を土台に、本番用として作り直した。
 * 調査のコードは参照(import)しない。gzip の展開・計測用のメタ情報は本番には持ち込まない。
 */

export class Http1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Http1Error";
  }
}

export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

/** ヘッダ値の最大長(ヘッダ注入・肥大化の防止)。 */
const MAX_HEADER_VALUE_LENGTH = 1024;

/** リクエストのヘッダ名として許す形(英数字とハイフンだけ。`:` で始まる疑似ヘッダ・空白・制御文字は不可)。 */
function isValidHeaderName(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name);
}

/** リクエストのヘッダ値として許す形(印字可能な ASCII と空白だけ。CR/LF・NUL・非 ASCII は不可)。 */
function isValidHeaderValue(value: string): boolean {
  return value.length <= MAX_HEADER_VALUE_LENGTH && /^[\x20-\x7e]*$/.test(value);
}

/**
 * 呼び出し側が指定してはならないヘッダ(小文字)。`Host` と `Connection` は組み立て側が付け、残りは本文の長さ・転送方式・
 * 圧縮・接続の扱いを変えてしまう(このクライアントが前提としている形が崩れる)。
 */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

function isForbiddenRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-");
}

export interface BuildRequestInput {
  /** メソッド。省略は GET(これまでの呼び出しは変わらない)。 */
  readonly method?: "GET" | "POST";
  /** Host ヘッダに入れるホスト名(ポートなし)。 */
  readonly host: string;
  /** リクエスト対象(`/path?query`)。 */
  readonly path: string;
  /** 付けるヘッダ(この順序で送る)。 */
  readonly headers: readonly HeaderEntry[];
  /** 本文(POST では必須、GET では指定できない)。印字可能な ASCII と空白だけ(`Content-Length` は組み立て側がバイト長から付ける)。 */
  readonly body?: string;
}

/**
 * リクエストを組み立てる(ASCII の文字列)。順序は、リクエスト行 → `Host` → 指定ヘッダ(指定順)→ `Connection: close` →
 * (POST のときだけ)`Content-Length` → 空行 → (POST のときだけ)本文。GET の出力は、本文・`Content-Length` が付かず、POST の導入前と同じ。
 * `Content-Length` が `Connection: close` の後ろなのは、実測(Issue #181。HTTP 200)で通った順に合わせたため。
 * 禁止ヘッダ・CR/LF などの不正な入力は例外にする。
 */
export function buildHttp1Request(input: BuildRequestInput): string {
  const method = input.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    throw new Http1Error(`メソッドが不正です: ${JSON.stringify(method)}`);
  }
  if (method === "GET" && input.body !== undefined) {
    throw new Http1Error("GET に本文は付けられません");
  }
  if (method === "POST" && (input.body === undefined || !/^[\x20-\x7e]*$/.test(input.body))) {
    throw new Http1Error("POST の本文が必要です(印字可能な ASCII と空白だけ。改行・非 ASCII は不可)");
  }
  if (!/^[A-Za-z0-9.-]+$/.test(input.host)) {
    throw new Http1Error(`ホスト名が不正です: ${JSON.stringify(input.host)}`);
  }
  if (!/^\/[\x21-\x7e]*$/.test(input.path)) {
    throw new Http1Error(`リクエストのパスが不正です: ${JSON.stringify(input.path)}`);
  }
  const lines = [`${method} ${input.path} HTTP/1.1`, `Host: ${input.host}`];
  for (const { name, value } of input.headers) {
    if (!isValidHeaderName(name)) {
      throw new Http1Error(`ヘッダ名が不正です: ${JSON.stringify(name)}`);
    }
    if (isForbiddenRequestHeader(name)) {
      throw new Http1Error(`指定できないヘッダです: ${name}`);
    }
    if (!isValidHeaderValue(value)) {
      throw new Http1Error(`ヘッダ ${name} の値が不正です(制御文字・非 ASCII・長すぎる値)`);
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push("Connection: close");
  if (method === "POST") {
    const body = input.body!;
    lines.push(`Content-Length: ${new TextEncoder().encode(body).byteLength}`);
    return `${lines.join("\r\n")}\r\n\r\n${body}`;
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** chunk サイズの桁数の上限(16進8桁 = 約4GB。これを超えるサイズ行は不正とみなす)。 */
const MAX_CHUNK_SIZE_DIGITS = 8;

function indexOfCrlf(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      return i;
    }
  }
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

/** `Transfer-Encoding: chunked` の本文を解く。不完全(途中で切断)・不正な入力は例外にする。 */
export function decodeChunked(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let pos = 0;
  for (;;) {
    const lineEnd = indexOfCrlf(bytes, pos);
    if (lineEnd < 0) {
      throw new Http1Error("chunked の途中で切断されました(chunk のサイズ行が終わっていません)");
    }
    const sizeText = latin1(bytes, pos, lineEnd).split(";")[0]!.trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText) || sizeText.length > MAX_CHUNK_SIZE_DIGITS) {
      throw new Http1Error(`chunked のサイズ行が不正です: ${JSON.stringify(sizeText.slice(0, 40))}`);
    }
    const size = parseInt(sizeText, 16);
    pos = lineEnd + 2;
    if (size === 0) {
      // トレーラ(空行まで)を読み飛ばす。空行が無ければ途中で切断されている。
      for (;;) {
        const end = indexOfCrlf(bytes, pos);
        if (end < 0) {
          throw new Http1Error("chunked の途中で切断されました(終端の空行がありません)");
        }
        const empty = end === pos;
        pos = end + 2;
        if (empty) {
          break;
        }
      }
      break;
    }
    if (pos + size > bytes.length) {
      throw new Http1Error(`chunked の途中で切断されました(chunk が ${size} バイト中 ${bytes.length - pos} バイトで終わっています)`);
    }
    parts.push(bytes.subarray(pos, pos + size));
    total += size;
    pos += size;
    if (bytes[pos] !== 0x0d || bytes[pos + 1] !== 0x0a) {
      throw new Http1Error("chunked の chunk データの後ろに CRLF がありません(途中で切断、または不正)");
    }
    pos += 2;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface ParsedHttp1Response {
  readonly status: number;
  readonly reason: string;
  /** 名前は小文字。同名は出現順にすべて残す。 */
  readonly headers: readonly HeaderEntry[];
  readonly body: Uint8Array;
  /** 本文をどう切り出したか。 */
  readonly framing: "chunked" | "content-length" | "until-close" | "none";
}

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/;
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

/**
 * EOF まで読み終えた応答のバイト列を解く。ステータス行・ヘッダは Latin-1 として読み、本文はバイトのまま返す
 * (文字コードのデコードは呼び出し側)。不完全(ヘッダの終端なし・本文が足りない・chunked が途中)・不正な入力は例外にする。
 */
export function parseHttp1Response(bytes: Uint8Array): ParsedHttp1Response {
  const headEnd = indexOfHeaderEnd(bytes);
  if (headEnd < 0) {
    throw new Http1Error(`応答のヘッダが終わる前に切断されました(受信 ${bytes.length} バイト)`);
  }
  const lines = latin1(bytes, 0, headEnd).split("\r\n");
  const statusMatch = STATUS_LINE.exec(lines[0] ?? "");
  if (statusMatch === null) {
    throw new Http1Error(`HTTP/1.x のステータス行として読めません: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
  }
  const status = Number(statusMatch[1]);
  const reason = statusMatch[2] ?? "";
  if (status < 200) {
    throw new Http1Error(`1xx の暫定応答には対応していません(HTTP ${status})`);
  }

  const headers: { name: string; value: string }[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const last = headers[headers.length - 1];
      if (last === undefined) {
        throw new Http1Error("ヘッダの先頭に折り返しの継続行があります");
      }
      last.value = `${last.value} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon);
    if (colon < 0 || !HEADER_NAME_TOKEN.test(name)) {
      throw new Http1Error(`ヘッダ行として読めません: ${JSON.stringify(line.slice(0, 80))}`);
    }
    headers.push({ name: name.toLowerCase(), value: line.slice(colon + 1).trim() });
  }

  const rest = bytes.subarray(headEnd + 4);
  if (status === 204 || status === 304) {
    return { status, reason, headers, body: new Uint8Array(0), framing: "none" };
  }

  const transferEncoding = headers.filter((h) => h.name === "transfer-encoding").map((h) => h.value).join(",");
  const lastCoding = transferEncoding.split(",").pop()?.trim().toLowerCase();
  if (lastCoding === "chunked") {
    return { status, reason, headers, body: decodeChunked(rest), framing: "chunked" };
  }

  const lengthValues = headers
    .filter((h) => h.name === "content-length")
    .flatMap((h) => h.value.split(","))
    .map((v) => v.trim());
  if (lengthValues.length > 0) {
    if (lengthValues.some((v) => !/^\d+$/.test(v)) || new Set(lengthValues).size > 1) {
      throw new Http1Error(`Content-Length が不正です: ${JSON.stringify(lengthValues.join(", ").slice(0, 80))}`);
    }
    const length = Number(lengthValues[0]);
    if (!Number.isSafeInteger(length)) {
      throw new Http1Error("Content-Length が大きすぎます");
    }
    if (rest.length < length) {
      throw new Http1Error(`本文が途中で切断されました(Content-Length ${length} に対して ${rest.length} バイト)`);
    }
    return { status, reason, headers, body: rest.subarray(0, length), framing: "content-length" };
  }

  return { status, reason, headers, body: rest, framing: "until-close" };
}

/**
 * 途中までのバイト列から、ステータス行が(CRLF まで)揃っていて 2xx〜5xx のステータスならそのコードを返す(読めなければ undefined)。
 * 本文の扱いで失敗した取得に、**受信済みのステータス**を持たせるために使う(サーバが応答したことは分かっているので、
 * サーキットブレーカーが 400/403/429 を数えられるように)。1xx(暫定応答)と範囲外の値は、応答として扱わない。
 */
export function peekHttp1Status(bytes: Uint8Array): number | undefined {
  const lineEnd = indexOfCrlf(bytes, 0);
  if (lineEnd < 0) {
    return undefined;
  }
  const match = STATUS_LINE.exec(latin1(bytes, 0, lineEnd));
  if (match === null) {
    return undefined;
  }
  const status = Number(match[1]);
  return status >= 200 && status <= 599 ? status : undefined;
}
