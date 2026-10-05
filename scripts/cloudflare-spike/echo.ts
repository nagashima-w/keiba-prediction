/**
 * E1(ヘッダの観測。Issue #160〈#21-B〉)の純ロジック。
 *
 * Worker とランナーの fetch から、受信したヘッダをそのまま返すエコーサービスを叩き、届いたヘッダの差を取る。
 * そのうえで、E2(ランナーに Workers 風のヘッダを付けて netkeiba を取る)と E3(ソケット)で使うヘッダ集合を導出し、
 * 公開される記録(コミットされる JSON・ジョブログ)に載せる値をマスクする。
 *
 * **生の値の扱い**: エコーの応答には、送信元の IP(ランナー・Cloudflare)や、CF-Worker のように workers.dev の
 * サブドメインを含みうる値が入る。生の値は E2・E3 の送信にだけ使い(メモリ上のみ)、記録に載せる値は
 * {@link maskHeaderValue} を通したものだけにする。
 *
 * **何がどこへ送られるか**(第三者と netkeiba に出るもの):
 *  - E1: Worker とランナーの fetch が、第三者のエコー(tls.peet.ws・httpbin.org)へ、`HttpClient` の User-Agent と、
 *    fetch の実装が付けるヘッダを送る(共有秘密などは送らない)。**Worker の subrequest には Cloudflare が
 *    `CF-Worker`(Worker を所有するゾーン名。workers.dev のサブドメインを含みうる)などを付けるので、それがエコーを
 *    運営する第三者に届く**。ランナー側は、ランナーの IP が届く(エコーは送信元として必ず見る)。
 *  - E2: Worker にだけ現れたヘッダ(`CF-Worker`・`CF-Connecting-IP` など。Worker が付けた生の値)を、**ランナーから
 *    netkeiba へ送る**。これは Worker が netkeiba に送るものと同じ内容で、実験として意図したもの。
 *  - E3: ランナーの観測から導出したヘッダ(生の値)を、Worker のソケットから netkeiba へ送る。
 */

import { DEFAULT_USER_AGENT } from "../../packages/core/src/scraper/http-client.js";
import type { EchoService } from "./echo-targets.js";
import { isForbiddenRequestHeader, isValidHeaderName, isValidHeaderValue, type HeaderEntry } from "./http1.js";

/** エコーへの1回の取得の結果(Worker の `/echo` もランナーの fetch も、この形にそろえる)。 */
export interface EchoFetchResult {
  /** HTTP ステータス。fetch が例外のときは null。 */
  readonly status: number | null;
  readonly bodyText: string | null;
  /** 診断用に選んだ応答ヘッダ(server / cf-ray / via)。名前は小文字。 */
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly error: string | null;
}

/** エコー応答から取り出した観測(値は生のまま。記録に載せる前に必ずマスクする)。 */
export interface EchoObservation {
  readonly service: EchoService;
  readonly ok: boolean;
  readonly status: number | null;
  /** エコーが見た HTTP バージョン(peet のみ。`h2` / `HTTP/1.1`)。観測できなければ null。 */
  readonly httpVersion: string | null;
  /** TLS の JA3 のハッシュ(peet のみ)。 */
  readonly tlsJa3Hash: string | null;
  /** TLS の JA4(peet のみ)。 */
  readonly tlsJa4: string | null;
  /** HTTP/2 の Akamai 指紋のハッシュ(peet で HTTP/2 のときのみ)。 */
  readonly h2Fingerprint: string | null;
  /** 受信ヘッダ(順序・名前の大文字小文字は観測のまま。疑似ヘッダは含まない)。 */
  readonly headers: readonly HeaderEntry[];
  /** エコーが Cloudflare 上にある疑い(応答に cf-ray、または server: cloudflare)。あれば警告する。 */
  readonly cloudflareHosted: boolean;
  readonly error: string | null;
}

function failed(service: EchoService, f: EchoFetchResult, error: string): EchoObservation {
  return {
    service,
    ok: false,
    status: f.status,
    httpVersion: null,
    tlsJa3Hash: null,
    tlsJa4: null,
    h2Fingerprint: null,
    headers: [],
    cloudflareHosted: isCloudflareHosted(f.responseHeaders),
    error,
  };
}

function isCloudflareHosted(responseHeaders: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(responseHeaders)) {
    const lower = name.toLowerCase();
    if (lower === "cf-ray") {
      return true;
    }
    if (lower === "server" && /cloudflare/i.test(value)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Name: value` の行を分ける。疑似ヘッダ(`:method: GET`)は null。 */
function splitHeaderLine(line: string): HeaderEntry | null {
  if (line.startsWith(":")) {
    return null;
  }
  const idx = line.indexOf(": ");
  if (idx <= 0) {
    return null;
  }
  return { name: line.slice(0, idx), value: line.slice(idx + 2) };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function peetHeaders(json: Record<string, unknown>): HeaderEntry[] | null {
  const http1 = json["http1"];
  if (isRecord(http1) && Array.isArray(http1["headers"])) {
    return (http1["headers"] as unknown[])
      .filter((l): l is string => typeof l === "string")
      .map(splitHeaderLine)
      .filter((h): h is HeaderEntry => h !== null);
  }
  const http2 = json["http2"];
  if (isRecord(http2) && Array.isArray(http2["sent_frames"])) {
    for (const frame of http2["sent_frames"] as unknown[]) {
      if (isRecord(frame) && frame["frame_type"] === "HEADERS" && Array.isArray(frame["headers"])) {
        return (frame["headers"] as unknown[])
          .filter((l): l is string => typeof l === "string")
          .map(splitHeaderLine)
          .filter((h): h is HeaderEntry => h !== null);
      }
    }
  }
  return null;
}

/** エコーの応答を観測に変える。失敗は例外にせず、`ok: false` と理由で返す。 */
export function parseEchoObservation(service: EchoService, f: EchoFetchResult): EchoObservation {
  if (f.status === null || f.bodyText === null) {
    return failed(service, f, `エコーの取得に失敗しました(${f.error ?? "原因不明"})`);
  }
  if (f.status !== 200) {
    return failed(service, f, `エコーが HTTP ${f.status} を返しました`);
  }
  let json: unknown;
  try {
    json = JSON.parse(f.bodyText);
  } catch {
    return failed(service, f, "エコーの応答が JSON として読めません");
  }
  if (!isRecord(json)) {
    return failed(service, f, "エコーの応答が JSON のオブジェクトではありません");
  }

  if (service === "peet") {
    const headers = peetHeaders(json);
    if (headers === null) {
      return failed(service, f, "エコー応答に受信ヘッダが見つかりません");
    }
    const tls = isRecord(json["tls"]) ? json["tls"] : {};
    const http2 = isRecord(json["http2"]) ? json["http2"] : {};
    return {
      service,
      ok: true,
      status: f.status,
      httpVersion: stringOrNull(json["http_version"]),
      tlsJa3Hash: stringOrNull(tls["ja3_hash"]),
      tlsJa4: stringOrNull(tls["ja4"]),
      h2Fingerprint: stringOrNull(http2["akamai_fingerprint_hash"]),
      headers,
      cloudflareHosted: isCloudflareHosted(f.responseHeaders),
      error: null,
    };
  }

  const map = json["headers"];
  if (!isRecord(map) || Object.values(map).some((v) => typeof v !== "string")) {
    return failed(service, f, "エコー応答に受信ヘッダが見つかりません(headers が文字列の対応表ではない)");
  }
  return {
    service,
    ok: true,
    status: f.status,
    httpVersion: null,
    tlsJa3Hash: null,
    tlsJa4: null,
    h2Fingerprint: null,
    headers: Object.entries(map).map(([name, value]) => ({ name, value: value as string })),
    cloudflareHosted: isCloudflareHosted(f.responseHeaders),
    error: null,
  };
}

/**
 * 送信側の差にも、E3 のヘッダ集合にも数えないヘッダ(小文字)。**エコー側の中継・サーバが足すもの**で、
 * Worker もランナーも送っていない。`host` は HTTP/2 では `:authority` になるため両側で比べられず、
 * `x-amzn-trace-id` は httpbin(AWS の ALB)が受信のたびに足す揮発の値。
 */
export const ECHO_INFRA_HEADERS: ReadonlySet<string> = new Set(["host", "x-amzn-trace-id"]);

export interface HeaderValueDiff {
  readonly name: string;
  readonly workerValue: string;
  readonly runnerValue: string;
}

export interface HeaderDiff {
  /** Worker にだけ現れた名前(値は生のまま。E2 の送信元になる)。 */
  readonly workerOnly: readonly HeaderEntry[];
  /** ランナーにだけ現れた名前(小文字)。 */
  readonly runnerOnly: readonly string[];
  /** 名前は同じで値が違うもの(値は生のまま)。 */
  readonly valueDiffers: readonly HeaderValueDiff[];
}

function groupByName(headers: readonly HeaderEntry[]): Map<string, { first: HeaderEntry; value: string }> {
  const out = new Map<string, { first: HeaderEntry; value: string }>();
  for (const h of headers) {
    const key = h.name.toLowerCase();
    if (ECHO_INFRA_HEADERS.has(key)) {
      continue;
    }
    const existing = out.get(key);
    if (existing === undefined) {
      out.set(key, { first: h, value: h.value });
    } else {
      existing.value = `${existing.value}, ${h.value}`;
    }
  }
  return out;
}

/** Worker とランナーの受信ヘッダを、名前(大文字小文字を区別しない)で突き合わせる。 */
export function computeHeaderDiff(worker: readonly HeaderEntry[], runner: readonly HeaderEntry[]): HeaderDiff {
  const w = groupByName(worker);
  const r = groupByName(runner);
  const workerOnly: HeaderEntry[] = [];
  const valueDiffers: HeaderValueDiff[] = [];
  for (const [key, entry] of w) {
    const other = r.get(key);
    if (other === undefined) {
      workerOnly.push({ name: entry.first.name, value: entry.value });
    } else if (other.value !== entry.value) {
      valueDiffers.push({ name: key, workerValue: entry.value, runnerValue: other.value });
    }
  }
  const runnerOnly = [...r.keys()].filter((key) => !w.has(key));
  return { workerOnly, runnerOnly, valueDiffers };
}

/** E2 で付けるヘッダの値の長さの上限。 */
export const E2_MAX_VALUE_LENGTH = 200;

/** E2 で付けるヘッダの個数の上限。 */
export const E2_MAX_HEADERS = 20;

export interface SkippedHeader {
  readonly name: string;
  readonly reason: string;
}

export interface E2HeaderSelection {
  /** 付けるヘッダ(Worker が実際に付けた値。メモリ上でだけ使い、記録には載せない)。 */
  readonly send: readonly HeaderEntry[];
  /** 付けなかったヘッダと、その理由。 */
  readonly skipped: readonly SkippedHeader[];
}

/**
 * Worker にだけ現れたヘッダから、E2 でランナーの fetch に付けるものを選ぶ。
 *  - 宛先に転送されない種類・fetch の実装が付け替えるもの(host / connection / transfer-encoding /
 *    content-length / accept-encoding など)は付けず、理由つきで残す
 *  - IP を値に持つヘッダ(cf-connecting-ip / x-real-ip)も付ける(CloudFront がこれを理由に弾く仮説を直接試す)
 *  - エコーは第三者の応答なので、名前・値の形を検査し、個数にも上限を設ける
 */
export function selectE2Headers(workerOnly: readonly HeaderEntry[]): E2HeaderSelection {
  const send: HeaderEntry[] = [];
  const skipped: SkippedHeader[] = [];
  for (const h of workerOnly) {
    const shown = h.name.slice(0, 60);
    if (!isValidHeaderName(h.name)) {
      skipped.push({ name: shown, reason: "名前が不正(疑似ヘッダ・空白・制御文字など)" });
    } else if (isForbiddenRequestHeader(h.name)) {
      skipped.push({ name: shown, reason: "宛先に転送されない種類、または fetch の実装が付け替えるヘッダ" });
    } else if (!isValidHeaderValue(h.value) || h.value.length > E2_MAX_VALUE_LENGTH) {
      skipped.push({ name: shown, reason: `値が不正(制御文字・非 ASCII・${E2_MAX_VALUE_LENGTH} 文字超)` });
    } else if (send.length >= E2_MAX_HEADERS) {
      skipped.push({ name: shown, reason: `個数の上限(${E2_MAX_HEADERS})を超えた` });
    } else {
      send.push({ name: h.name, value: h.value });
    }
  }
  return { send, skipped };
}

/**
 * E1 のランナー側の観測が取れなかったときの E3 のヘッダ集合。**Node 22.22.2 の fetch(undici)が実測で出した
 * ヘッダ**(host・connection・accept-encoding を除く。User-Agent は core の `HttpClient` の既定)。
 * 「ランナーと同じ」を優先する。
 *
 * 再現: ローカルで `http.createServer((q) => console.log(q.rawHeaders))` を立て、同じ Node から
 * `fetch(url, { headers: { "User-Agent": "ua" } })` を1回出すと、`host`・`connection: keep-alive`・`User-Agent`・
 * `accept`・`accept-language: *`・`sec-fetch-mode: cors`・`accept-encoding: gzip, deflate` がこの順で届く
 * (netkeiba へは出ない)。
 */
export const STATIC_SOCKET_HEADERS: readonly HeaderEntry[] = [
  { name: "User-Agent", value: DEFAULT_USER_AGENT },
  { name: "accept", value: "*/*" },
  { name: "accept-language", value: "*" },
  { name: "sec-fetch-mode", value: "cors" },
];

export interface SocketHeaderSet {
  readonly headers: readonly HeaderEntry[];
  /** どちらを使ったか(結果に記録する)。 */
  readonly source: "runner-echo" | "static-fallback";
}

/**
 * E3 のソケットで送るヘッダを、ランナーの観測から導出する(取れなければ静的フォールバック)。
 * エコー側の中継が足したヘッダ({@link ECHO_INFRA_HEADERS})は、ランナーが送ったものではないので入れない。
 */
export function deriveSocketHeaders(runner: EchoObservation | null): SocketHeaderSet {
  if (runner !== null && runner.ok) {
    const headers = runner.headers.filter(
      (h) =>
        isValidHeaderName(h.name) &&
        !ECHO_INFRA_HEADERS.has(h.name.toLowerCase()) &&
        !isForbiddenRequestHeader(h.name) &&
        isValidHeaderValue(h.value),
    );
    if (headers.some((h) => h.name.toLowerCase() === "user-agent")) {
      return { headers, source: "runner-echo" };
    }
  }
  return { headers: STATIC_SOCKET_HEADERS, source: "static-fallback" };
}

/** マスクに使う、この実行に固有の識別子。 */
export interface MaskContext {
  readonly subdomain?: string;
  readonly workerName?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 公開される記録に載せる文字列から、IP(IPv4・IPv6)・workers.dev のサブドメイン・Worker 名を隠す。
 * ctx に無い別のサブドメインや別の実行の Worker 名も、パターンで隠す。
 * 偽陽性は許容する(例: `Chrome/120.0.0.0` のような4つ組の数字も IP として隠れる)。漏らすよりよい。
 */
export function maskText(text: string, ctx: MaskContext): string {
  let out = text;
  if (ctx.workerName !== undefined && ctx.workerName !== "") {
    out = out.replace(new RegExp(escapeRegExp(ctx.workerName), "gi"), "<worker>");
  }
  out = out.replace(/keiba-cf-spike-\d+-\d+/gi, "<worker>");
  if (ctx.subdomain !== undefined && ctx.subdomain !== "") {
    out = out.replace(new RegExp(escapeRegExp(ctx.subdomain), "gi"), "<subdomain>");
  }
  out = out.replace(/(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+\.workers\.dev\b/gi, "<subdomain>.workers.dev");
  out = out.replace(/::ffff:(?:\d{1,3}\.){3}\d{1,3}/gi, "<ip>");
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
  out = out.replace(/(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g, "<ip>");
  return out;
}

/** ヘッダの値をマスクする。cf-ray は一意の部分を隠し、データセンターの接尾辞だけ残す。 */
export function maskHeaderValue(name: string, value: string, ctx: MaskContext): string {
  if (name.toLowerCase() === "cf-ray") {
    const m = /^[0-9a-f]+-([A-Za-z]{2,4})$/i.exec(value);
    return m ? `<ray>-${m[1]}` : "<ray>";
  }
  return maskText(value, ctx);
}
