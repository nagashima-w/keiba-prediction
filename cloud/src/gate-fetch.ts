/**
 * ゲート(NetkeibaGate の `fetchRaw`。RPC)を、core の `HttpClient` の fetch 注入口(`FetchLike`)へ繋ぐアダプタ(Issue #162 段階2a)。
 *
 * これで、core の取得処理(`HttpClient.fetchText`・後続の `scrapeRace`)を、**Worker の fetch ではなく**ゲート経由(DO の中のソケット)で
 * 動かせる。**Worker の `fetch` で netkeiba を取る経路は、本番に持ち込まない**(#160。CloudFront から HTTP 400 になる)。
 *
 * 守り:
 *  - ゲートへ渡すのは **URL だけ**。呼び出し側のヘッダ(`HttpClient` が付ける User-Agent を含む)・シグナルは捨てる
 *    (ヘッダはソケット取得クライアントの固定の集合だけ。送信元を1か所に閉じ込める)。GET 以外は、ゲートを呼ばずに拒否する
 *  - ゲートの拒否(ブレーカー・待ち行列・許可リスト・通信失敗など)は {@link GateRefusedError} として投げる(`HttpClient` が
 *    `HttpError` に包む。理由はメッセージに残る)
 *  - `createGateHttpClient` は `HttpClient` を **間隔 0・再試行 0** で作る。間隔制御はゲートだけが行い(二重に待たない)、
 *    再試行は netkeiba への本数を増やす(拒否されているときに撃ち続ける)ので行わない
 */

import { HttpClient, type FetchLike, type FetchResponse, type HttpClientOptions } from "../../packages/core/src/scraper/http-client.js";
import type { GateResult } from "./gate-core";

/** ゲートの、ここで使う部分(DO のスタブ・偽のゲートのどちらも当てはまる)。 */
export interface GateLike {
  fetchRaw(url: string): Promise<GateResult>;
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

/** ゲートの fetch。 */
export function createGateFetch(gate: GateLike): FetchLike {
  return async (url, init) => {
    if ((init?.method !== undefined && init.method !== "GET") || init?.body !== undefined) {
      throw new Error("ゲートが取得できるのは GET だけです(POST・本文つきは未対応)");
    }
    const result = await gate.fetchRaw(url);
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
