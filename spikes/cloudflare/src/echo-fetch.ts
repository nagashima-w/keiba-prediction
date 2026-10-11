/**
 * E1(ヘッダの観測。Issue #160〈#21-B〉)のエコー取得。**Worker の `/echo` もランナー(ドライバ)も、この関数を使う。**
 *
 * netkeiba の取得(`probeNetkeiba`)と同じ経路(core の `HttpClient` に fetch を注入)で、同じ init
 * (`forwardInit`)を通す。これで、エコーに届くヘッダ(`HttpClient` が付ける User-Agent と、fetch の実装が付ける
 * ヘッダ)が、netkeiba へ出すものと同じになることを構造で保証する。共有秘密などの余計なヘッダは付けない。
 *
 * `HttpClient.fetchText` は非 2xx で本文を捨てて例外にするため、fetch を記録ラッパで包み、ステータス・
 * 選んだ応答ヘッダ・本文(上限つき)を控える(`probeNetkeiba` と同じ作り)。
 */

import { HttpClient, type FetchLike } from "../../../packages/core/src/scraper/http-client.js";
import type { EchoFetchResult } from "../../../scripts/cloudflare-spike/echo.js";
import { ECHO_URLS, type EchoService } from "../../../scripts/cloudflare-spike/echo-targets.js";
import { forwardInit, type ProbeFetch } from "./netkeiba-probe.js";

/** 本文として残す最大のバイト数(巨大な応答を結果に載せない)。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 診断用に残す応答ヘッダ(エコーが Cloudflare 上にないかの確認に使う)。 */
const PICKED_HEADERS = ["server", "cf-ray", "via"];

export async function fetchEcho(
  service: EchoService,
  fetchImpl: ProbeFetch = (url, init) => fetch(url, init),
): Promise<EchoFetchResult> {
  let captured: { status: number; bodyText: string; headers: Record<string, string> } | null = null;

  const recordingFetch: FetchLike = async (url, init) => {
    const response = await fetchImpl(url, forwardInit(init));
    const buffer = await response.clone().arrayBuffer();
    const headers: Record<string, string> = {};
    for (const name of PICKED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        headers[name] = value;
      }
    }
    captured = {
      status: response.status,
      bodyText: new TextDecoder("utf-8").decode(buffer.slice(0, MAX_BODY_BYTES)),
      headers,
    };
    return response;
  };

  const client = new HttpClient({ fetch: recordingFetch, minIntervalMs: 0, maxRetries: 0, timeoutMs: 20_000, onWarn: () => {} });
  let error: string | null = null;
  try {
    await client.fetchText(ECHO_URLS[service]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const cap = captured as { status: number; bodyText: string; headers: Record<string, string> } | null;
  return {
    status: cap?.status ?? null,
    bodyText: cap?.bodyText ?? null,
    responseHeaders: cap?.headers ?? {},
    // 非 2xx は HttpClient が例外にするが、ステータスと本文は控えてある。ステータスが取れているときは、
    // 例外の文面ではなくステータスで判定できるので error は残さない。
    error: cap === null ? error : null,
  };
}
