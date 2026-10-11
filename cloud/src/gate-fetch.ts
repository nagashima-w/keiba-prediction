/**
 * ゲート(NetkeibaGate の `fetchRaw`。RPC)を、core の `HttpClient` の fetch 注入口(`FetchLike`)へ繋ぐアダプタ(Issue #162 段階2a)。
 *
 * これで、core の取得処理(`HttpClient.fetchText`・後続の `scrapeRace`)を、**Worker の fetch ではなく**ゲート経由(DO の中のソケット)で
 * 動かせる。**Worker の `fetch` で netkeiba を取る経路は、本番に持ち込まない**(#160。CloudFront から HTTP 400 になる)。
 *
 * 守り:
 *  - GET でゲートへ渡すのは **URL だけ**。呼び出し側のヘッダ(`HttpClient` が付ける User-Agent を含む)・シグナルは捨てる
 *    (ヘッダはソケット取得クライアントの固定の集合だけ。送信元を1か所に閉じ込める)
 *  - **POST は許可リストに合うものだけ**(Issue #181。重賞の過去10年傾向の API)通す: ヘッダは `Content-Type`・`X-Requested-With`(値は固定)・`Referer`・`Origin`
 *    の4つだけ(`User-Agent` は GET と同じく捨てる。そのほかのヘッダは拒否)で、宛先・本文・Referer・Origin の形は `checkAllowedPost`(`gate-core.ts`)で検査する。
 *    ゲートへ渡すのは宛先・Referer・Origin・本文だけ(`postRaw`)。合わないものと、GET・POST 以外のメソッドは、ゲートを呼ばずに拒否する
 *  - ゲートの拒否(ブレーカー・待ち行列・許可リスト・通信失敗など)は {@link GateRefusedError} として投げる(`HttpClient` が
 *    `HttpError` に包む。理由はメッセージに残る)
 *  - `createGateHttpClient` は `HttpClient` を **間隔 0・再試行 0** で作る。間隔制御はゲートだけが行い(二重に待たない)、
 *    再試行は netkeiba への本数を増やす(拒否されているときに撃ち続ける)ので行わない
 */

import { HttpClient, type FetchLike, type FetchResponse, type HttpClientOptions } from "../../packages/core/src/scraper/http-client.js";
import { checkAllowedPost, type GatePostRequest, type GateResult } from "./gate-core";
import { NETKEIBA_POST_CONTENT_TYPE, NETKEIBA_POST_REQUESTED_WITH } from "./socket-fetch";

/**
 * ゲートの、ここで使う部分(DO のスタブ・偽のゲートのどちらも当てはまる)。
 * `postRaw` は任意(Issue #181): GET だけの偽ゲートを使う既存のテストを変えずに済ませるため。無いゲートへの POST は、未対応として拒否する(GET の口へは流さない)。
 */
export interface GateLike {
  fetchRaw(url: string): Promise<GateResult>;
  postRaw?(request: GatePostRequest): Promise<GateResult>;
}

/** ゲートが取得を拒否した(応答は得ていない)。 */
export class GateRefusedError extends Error {
  readonly reason: string;
  readonly blockedUntil: number | undefined;

  constructor(reason: string, message: string, blockedUntil?: number) {
    super(`ゲートが取得を拒否しました(${reason}): ${message}`);
    this.name = "GateRefusedError";
    this.reason = reason;
    this.blockedUntil = blockedUntil;
  }
}

/** POST で許すヘッダ(小文字)。`user-agent` は `HttpClient` が付けるが、GET と同じく捨てる(ゲートが固定の値を付ける)。 */
const POST_ALLOWED_HEADERS: ReadonlySet<string> = new Set(["user-agent", "content-type", "x-requested-with", "referer", "origin"]);

/** `HttpClient` の POST を、ゲートへ渡す指定にする。許可リストに合わなければ(ゲートを呼ばずに)投げる。 */
function toPostRequest(url: string, init: { headers?: Record<string, string>; body?: string }): GatePostRequest {
  const byName = new Map<string, string>();
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!POST_ALLOWED_HEADERS.has(lower)) {
      throw new Error(`ゲートが POST できないヘッダです: ${name.slice(0, 40)}(許可: Content-Type・X-Requested-With・Referer・Origin)`);
    }
    if (byName.has(lower)) {
      throw new Error(`ゲートが POST できません: ヘッダ ${name.slice(0, 40)} が重複しています`);
    }
    byName.set(lower, value);
  }
  if (byName.get("content-type") !== NETKEIBA_POST_CONTENT_TYPE) {
    throw new Error("ゲートが POST できません: Content-Type が許可している値ではありません");
  }
  if (byName.get("x-requested-with") !== NETKEIBA_POST_REQUESTED_WITH) {
    throw new Error("ゲートが POST できません: X-Requested-With が許可している値ではありません");
  }
  const referer = byName.get("referer");
  const origin = byName.get("origin");
  if (referer === undefined) {
    throw new Error("ゲートが POST できません: Referer がありません");
  }
  if (origin === undefined) {
    throw new Error("ゲートが POST できません: Origin がありません");
  }
  if (init.body === undefined) {
    throw new Error("ゲートが POST できません: 本文がありません");
  }
  const request: GatePostRequest = { url, referer, origin, body: init.body };
  const checked = checkAllowedPost(request);
  if (!checked.ok) {
    throw new Error(`ゲートが POST できません: ${checked.message}`);
  }
  return request;
}

/** ゲートの fetch。 */
export function createGateFetch(gate: GateLike): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    let result: GateResult;
    if (method === "GET") {
      if (init?.body !== undefined) {
        throw new Error("ゲートの GET に本文は付けられません");
      }
      result = await gate.fetchRaw(url);
    } else if (method === "POST") {
      const request = toPostRequest(url, init ?? {});
      if (gate.postRaw === undefined) {
        throw new Error("このゲートは POST に対応していません");
      }
      result = await gate.postRaw(request);
    } else {
      throw new Error(`ゲートが取得できるメソッドは GET と POST だけです(${String(method).slice(0, 16)})`);
    }
    if (result.kind === "refused") {
      throw new GateRefusedError(result.reason, result.message, result.blockedUntil);
    }
    const response: FetchResponse = {
      status: result.status,
      ok: result.status >= 200 && result.status <= 299,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? result.contentType : null),
      },
      arrayBuffer: async () => result.body,
    };
    return response;
  };
}

/**
 * `HttpClient` が、取得の1回の呼び出しを諦めるまでの時間(ミリ秒)。ゲートの待ち行列と 2 秒間隔の待ちを含むので、既定の
 * 30 秒より長くする。超えたら呼び出し側だけが諦める(ゲートの中の取得は最後まで走り、状態を更新する)。
 */
export const GATE_FETCH_TIMEOUT_MS = 60_000;

/** ゲート経由で取得する `HttpClient`(間隔 0・再試行 0)。 */
export function createGateHttpClient(gate: GateLike, options: Pick<HttpClientOptions, "onWarn"> = {}): HttpClient {
  return new HttpClient({
    fetch: createGateFetch(gate),
    minIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: GATE_FETCH_TIMEOUT_MS,
    onWarn: options.onWarn ?? ((message) => console.warn(message)),
  });
}
