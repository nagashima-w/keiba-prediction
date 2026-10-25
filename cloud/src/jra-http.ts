/**
 * JRA のページを Worker の素のグローバルの fetch で 1 本取る部品(Issue #478〈#477-B〉で `jra-check.ts` から切り出した。#488 の確認口と、馬場の取得〈`jra-baba-fetch.ts`〉が共有する)。
 *
 * 守ること(`jra-check.ts`・`jra-baba-fetch.ts` の冒頭に、使う側の約束が書いてある):
 *  - 1 本につき fetch は 1 回だけ。再試行しない。リダイレクトは追わない(`redirect: "manual"`。3xx は `redirect` の失敗)。
 *  - タイムアウトは {@link JRA_TIMEOUT_MS}(本文の読み出しも含む。1 本ごと)。本文は {@link JRA_MAX_BODY_BYTES} まで(超えたら打ち切って `too-large`)。
 *  - UA などのヘッダは付けない(#488 で、素の fetch で届くと確かめた)。
 *  - 例外のメッセージ・URL・本文は残さない(失敗は分類名だけ)。Shift_JIS は `iconv-lite` で読む(`TextDecoder("shift_jis")` が workerd で使えるかには頼らない)。
 * このファイルは **fetch 関数を呼ぶ部品**(`fetchOne`)を持つが、グローバルの `fetch` そのものは呼ばない(注入された関数を呼ぶだけ)。取得の起点は使う側が持つ。
 */
import iconv from "iconv-lite";

export const JRA_CUSHION_URL = "https://www.jra.go.jp/keiba/baba/_data_cushion.html";
export const JRA_MOIST_URL = "https://www.jra.go.jp/keiba/baba/_data_moist.html";
export const JRA_ACCESS_URL = "https://www.jra.go.jp/JRADB/accessJ.html";
export const JRA_ACCESS_BODY = "CNAME=pw01iwtS3/CD";

/** コースの情報のページの URL。1 は `index.html`、2 以降は `index2.html`・`index3.html`。 */
export const jraCourseUrl = (n: number): string => `https://www.jra.go.jp/keiba/baba/index${n <= 1 ? "" : String(n)}.html`;

/** 1 本ごとのタイムアウト(ミリ秒)。応答の待ちと本文の読み出しの合計。 */
export const JRA_TIMEOUT_MS = 10_000;
/** 本文の上限(バイト)。コースの情報のページ(約 75KB)が最大で、その 3 倍以上。 */
export const JRA_MAX_BODY_BYTES = 256 * 1024;
/** 本のあいだの待ち(ミリ秒)。JRA への取得は 1.5 秒以上あける(#477 の承認の範囲)。 */
export const JRA_GAP_MS = 1_500;

/** 要約の長さの上限(Content-Type)。 */
const MAX_CONTENT_TYPE_CHARS = 100;

/** 注入できる fetch(Worker のグローバル `fetch` のうち使う部分)。 */
export type JraFetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 取得の失敗の分類。 */
export type JraFailure = "timeout" | "network" | "redirect" | "too-large";

/** 取得 1 本に共通の要約。 */
export interface JraFetchSummary {
  /** HTTP の状態(数値)か、失敗の分類名。 */
  readonly status: number | JraFailure;
  /** HTTP の状態が分かっているときの数値(`redirect`・`too-large` でも分かる。`timeout` のうち応答が来る前・`network` は null)。 */
  readonly httpStatus: number | null;
  /** 読んだ本文のバイト数。読めなかった(`redirect`・`too-large`・`timeout`・`network`)は null。 */
  readonly bytes: number | null;
  readonly contentType: string | null;
  /** 期待した形が見えたか。 */
  readonly ok: boolean;
}

export interface JraFetched {
  readonly summary: JraFetchSummary;
  /** 本文のバイト列(読めたときだけ)。 */
  readonly body: Uint8Array | null;
}

/** fetch が投げた例外の分類。名前だけを見る(メッセージは読まない・残さない)。 */
export function classifyThrown(error: unknown): "timeout" | "network" {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

class ReadFailure extends Error {
  constructor(readonly failure: "timeout" | "network" | "too-large") {
    super(failure);
  }
}

/** 本文を上限まで読む(バイト列のまま)。上限を超えたら打ち切って `too-large` を投げる。読み出しの失敗は分類して投げ直す。 */
async function readBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (response.headers.get("content-length") !== null && Number.isFinite(declared) && declared > JRA_MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ReadFailure("too-large");
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > JRA_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ReadFailure("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ReadFailure) {
      throw error;
    }
    throw new ReadFailure(classifyThrown(error));
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

export function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function failed(status: JraFailure, httpStatus: number | null, contentType: string | null): JraFetched {
  return { summary: { status, httpStatus, bytes: null, contentType, ok: false }, body: null };
}

/** 1 本を取る。例外は投げない(失敗は分類名に落とす)。`ok` はここでは false で、呼び出し側が本文の形を見て決める。 */
export async function fetchOne(fetchFn: JraFetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<JraFetched> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, redirect: "manual", signal });
  } catch (error) {
    return failed(classifyThrown(error), null, null);
  }
  const httpStatus = response.status;
  const rawType = response.headers.get("content-type");
  const contentType = rawType === null ? null : cap(rawType, MAX_CONTENT_TYPE_CHARS);
  if (httpStatus >= 300 && httpStatus < 400) {
    void response.body?.cancel().catch(() => undefined);
    return failed("redirect", httpStatus, contentType);
  }
  try {
    const body = await readBytes(response);
    return { summary: { status: httpStatus, httpStatus, bytes: body.byteLength, contentType, ok: false }, body };
  } catch (error) {
    return failed(error instanceof ReadFailure ? error.failure : "network", httpStatus, contentType);
  }
}

export function decodeShiftJis(body: Uint8Array): string {
  return iconv.decode(Buffer.from(body.buffer, body.byteOffset, body.byteLength), "shift_jis");
}
