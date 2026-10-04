/**
 * Worker が netkeiba の1本を取得して「到達性の記録」を作る処理(Issue #159〈#21-A〉)。
 *
 * - core の `HttpClient`(fetch 注入口・iconv-lite のデコード)と既存パーサをそのまま使う
 *   (core を Worker にバンドルできるかの確認も兼ねる)。
 * - `HttpClient.fetchBuffer` は非 2xx で応答ヘッダと本文を捨てて例外にするため、注入する fetch を
 *   記録ラッパで包み、ステータス・選んだヘッダ・本文の先頭を控える(403 が netkeiba の拒否か
 *   Cloudflare のチャレンジかを切り分けるのに必要)。
 * - `redirect: "manual"`: リダイレクトに従わない(許可ホスト外への転送や本数の上限の素通りを防ぐ)。
 * - `maxRetries: 0` / `minIntervalMs: 0`: 5xx の再試行で netkeiba への本数が増えないようにする
 *   (本数と 2 秒間隔の管理はドライバ側の `RequestGuard` が担う)。
 *
 * fetch を注入できるので、保存済みフィクスチャを返す偽 fetch でテストできる
 * (`scripts/test/cloudflare-spike-netkeiba-probe.test.ts`)。
 */

import { HttpClient, type FetchLike } from "../../../packages/core/src/scraper/http-client.js";
import { parseHorseId } from "../../../packages/core/src/scraper/ids.js";
import { parseHorseProfile } from "../../../packages/core/src/scraper/parse-horse-profile.js";
import { parseHorseResults } from "../../../packages/core/src/scraper/parse-horse-results.js";
import { parseOdds } from "../../../packages/core/src/scraper/parse-odds.js";
import { parseShutuba } from "../../../packages/core/src/scraper/parse-shutuba.js";
import type { NetkeibaProbeRecord } from "../../../scripts/cloudflare-spike/reachability.js";
import type { TargetKind } from "../../../scripts/cloudflare-spike/targets.js";

/** 注入する fetch(グローバル fetch と同じ形。応答は `clone()` できる Response)。 */
export type ProbeFetch = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "manual" | "follow" | "error";
  },
) => Promise<Response>;

export interface ProbeRequest {
  readonly targetId: string;
  readonly url: string;
  readonly kind: TargetKind;
  readonly encoding: "utf-8" | "euc-jp";
}

/** 診断用に残す応答ヘッダ。 */
const PICKED_HEADERS = ["server", "cf-ray", "cf-mitigated", "content-type", "content-length", "content-encoding", "via", "x-cache", "location"];

/** 非 2xx のときに残す本文の先頭のバイト数。 */
const ERROR_BODY_HEAD_BYTES = 400;

/** 2xx でパースに失敗したときに残す本文の先頭の文字数。 */
const PARSE_FAILURE_HEAD_CHARS = 300;

interface Captured {
  status: number;
  headers: Record<string, string>;
  bytes: number;
  errorHead: string | null;
  contentType: string | null;
}

function parseCount(kind: TargetKind, url: string, text: string): number {
  switch (kind) {
    case "shutuba":
      return parseShutuba(text).horses.length;
    case "odds-json":
      return Object.keys(parseOdds(text).win).length;
    case "horse-results":
      return parseHorseResults(text).length;
    case "horse-page": {
      const match = /\/horse\/(\d+)\//.exec(url);
      const horseId = parseHorseId(match?.[1] ?? "");
      return parseHorseProfile(text, horseId).name !== "" ? 1 : 0;
    }
  }
}

function charsetOf(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  const match = /charset=([^;\s]+)/i.exec(contentType);
  return match ? match[1]!.replace(/^["']|["']$/g, "") : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 1本を取得し、到達性の記録を返す(例外は投げず、失敗も記録に載せる)。 */
export async function probeNetkeiba(
  request: ProbeRequest,
  fetchImpl: ProbeFetch = (url, init) => fetch(url, init),
): Promise<NetkeibaProbeRecord> {
  let captured: Captured | null = null;

  const recordingFetch: FetchLike = async (url, init) => {
    const response = await fetchImpl(url, {
      // リダイレクトには従わない: 許可ホスト外への転送や、1回の呼び出しで netkeiba へ出す本数(1本)の上限の
      // 素通りを防ぐ。3xx はステータスと location を記録するだけにする。
      redirect: "manual",
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    });
    // 本文は HttpClient が arrayBuffer() で読むため、記録用には clone() から読む。
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
      headers,
      bytes: buffer.byteLength,
      errorHead: response.ok
        ? null
        : new TextDecoder("utf-8").decode(buffer.slice(0, ERROR_BODY_HEAD_BYTES)).slice(0, ERROR_BODY_HEAD_BYTES),
      contentType: response.headers.get("content-type"),
    };
    return response;
  };

  const client = new HttpClient({
    fetch: recordingFetch,
    minIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 20_000,
    onWarn: () => {},
  });

  let text: string | null = null;
  let error: string | null = null;
  try {
    text = await client.fetchText(request.url, { encoding: request.encoding });
  } catch (e) {
    error = messageOf(e);
  }

  const cap = captured as Captured | null;
  let parsedCount: number | null = null;
  let parseError: string | null = null;
  let replacementChars: number | null = null;
  let bodyHead: string | null = cap?.errorHead ?? null;
  if (text !== null) {
    replacementChars = [...text].filter((c) => c === "�").length;
    try {
      parsedCount = parseCount(request.kind, request.url, text);
    } catch (e) {
      parseError = messageOf(e);
    }
    if (parsedCount === null || parsedCount === 0) {
      bodyHead = text.slice(0, PARSE_FAILURE_HEAD_CHARS);
    }
  }

  return {
    targetId: request.targetId,
    url: request.url,
    status: cap?.status ?? null,
    bodyLength: cap?.bytes ?? null,
    charset: charsetOf(cap?.contentType ?? null),
    parsedKind: request.kind,
    parsedCount,
    parseError,
    replacementChars,
    headers: cap?.headers ?? {},
    bodyHead,
    error,
  };
}
