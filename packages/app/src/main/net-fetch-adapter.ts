/**
 * Electron の `net.fetch`(Chromium ネットワークスタック)を core の fetch 抽象へ適合させるアダプタ。
 *
 * なぜ必要か:
 * - core の HttpClient / Discord 送信は既定で undici の fetch を使う。かつて core は undici ^8
 *   (engines Node>=22.19.0)へ直接依存しており、Electron 34 の内蔵 Node(20.18.x)と非互換で、
 *   Electron 内でのみ undici の fetch が実行時に失敗した(素の Node22 で回る CI/テストでは検出できない)。
 * - Electron の `net.fetch` は Chromium のネットワークスタックを使い、Node のバージョンに依存しない。
 *   システムプロキシ・OS の TLS 設定にも従うため、Windows 実機での取得に適する(これが注入の主目的)。
 *
 * このアダプタを HttpClient / sendDiscordNotification へ注入すると、undici のロード経路を
 * 通らなくなる(既定の defaultFetch/defaultDiscordFetch を使わない)。
 * なお多層防御として core の undici は cheerio 互換の ^7(Node>=20.18.1)へ整合済みで、万一
 * 注入を忘れた経路が生じても Electron 内で壊れないようにしてある。
 */

import { net } from "electron";

import type {
  DiscordFetchLike,
  DiscordFetchResponse,
  FetchLike,
  FetchResponse,
} from "@keiba/core";

/** Electron `net.fetch` の最小シグネチャ(テストで差し替え可能にするための抽象)。 */
export type NetFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * core 側 init(GET系: headers/signal、POST系: method/headers/body/signal)を統合した入力型。
 * FetchLike と DiscordFetchLike の init の上位集合。
 */
export interface CoreFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * core の init を Electron `net.fetch` の RequestInit へ変換する(純関数)。
 * 未指定フィールドは付与しない(net.fetch 側の既定に委ねる)。
 */
export function toNetRequestInit(init?: CoreFetchInit): RequestInit {
  const result: RequestInit = {};
  if (init === undefined) {
    return result;
  }
  if (init.method !== undefined) {
    result.method = init.method;
  }
  if (init.headers !== undefined) {
    result.headers = init.headers;
  }
  if (init.body !== undefined) {
    result.body = init.body;
  }
  if (init.signal !== undefined) {
    result.signal = init.signal;
  }
  return result;
}

/**
 * Electron の Web 標準 Response を core の FetchResponse / DiscordFetchResponse へ適合する(純関数)。
 * 使う分だけに絞り、かつ arrayBuffer/text/headers.get を元 Response に this 束縛して呼ぶ
 * (メソッド参照をそのまま渡すと this 束縛が外れるため、アロー関数で包む)。
 */
export function adaptNetResponse(
  response: Response,
): FetchResponse & DiscordFetchResponse {
  return {
    status: response.status,
    ok: response.ok,
    headers: {
      get: (name: string): string | null => response.headers.get(name),
    },
    arrayBuffer: (): Promise<ArrayBuffer> => response.arrayBuffer(),
    text: (): Promise<string> => response.text(),
  };
}

/**
 * 注入した net.fetch から、core の FetchLike かつ DiscordFetchLike として使えるアダプタを作る。
 * FetchLike(GET系)と DiscordFetchLike(POST系)双方の呼び出し形に適合する。
 */
export function createNetFetchAdapter(
  netFetch: NetFetch,
): FetchLike & DiscordFetchLike {
  const adapter = async (
    url: string,
    init?: CoreFetchInit,
  ): Promise<FetchResponse & DiscordFetchResponse> => {
    const response = await netFetch(url, toNetRequestInit(init));
    return adaptNetResponse(response);
  };
  return adapter as FetchLike & DiscordFetchLike;
}

/**
 * Electron の `net.fetch` を利用する既定アダプタ。
 * HttpClient / sendDiscordNotification への注入に用いる。
 * net.fetch は正しい this で呼ぶ必要があるためアロー関数で束縛する。
 */
export const netFetchAdapter: FetchLike & DiscordFetchLike =
  createNetFetchAdapter((url, init) => net.fetch(url, init));
