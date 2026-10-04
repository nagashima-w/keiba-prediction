/**
 * Worker の公開エンドポイント `/echo`・`/netkeiba-socket` の入力検査(Issue #160〈#21-B〉)。純ロジック。
 *
 * 共有秘密を持っていても通さないもの: 固定表以外の宛先(`/echo`)、許可ホスト以外・http・ポート指定・ユーザー情報
 * つきの URL(`/netkeiba-socket`)、禁止ヘッダ、CR/LF などの制御文字(ヘッダ・リクエスト行の注入)、ヘッダの
 * 個数の超過。公開 URL が任意の宛先へのプロキシや、リクエストの注入口にならないようにする。
 */

import { ECHO_URLS, isEchoService, type EchoService } from "./echo-targets.js";
import { isForbiddenRequestHeader, isValidHeaderName, isValidHeaderValue, type HeaderEntry } from "./http1.js";
import { isAllowedUrl, TARGET_KINDS, type TargetKind } from "./targets.js";

export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** `/netkeiba-socket` で受け付けるヘッダの個数の上限。 */
export const SOCKET_MAX_HEADERS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `/echo` の入力: `{service}` だけ。URL は固定表(`ECHO_URLS`)から決め、リクエストからは受け取らない。 */
export function validateEchoRequest(body: unknown): ValidationResult<{ service: EchoService; url: string }> {
  if (!isRecord(body)) {
    return { ok: false, error: "本文が JSON のオブジェクトではありません" };
  }
  const extra = Object.keys(body).filter((k) => k !== "service");
  if (extra.length > 0) {
    return { ok: false, error: `service 以外のフィールドは受け付けません: ${extra.join(", ").slice(0, 80)}` };
  }
  const service = body["service"];
  if (!isEchoService(service)) {
    return { ok: false, error: "service が固定表にありません(peet / httpbin)" };
  }
  return { ok: true, value: { service, url: ECHO_URLS[service] } };
}

export interface SocketRequest {
  readonly targetId: string;
  readonly url: string;
  readonly kind: TargetKind;
  readonly encoding: "utf-8" | "euc-jp";
  readonly headers: readonly HeaderEntry[];
}

/** `/netkeiba-socket` の入力: `{targetId, url, kind, encoding, headers}`。 */
export function validateSocketRequest(body: unknown): ValidationResult<SocketRequest> {
  if (!isRecord(body)) {
    return { ok: false, error: "本文が JSON のオブジェクトではありません" };
  }
  const { targetId, url, kind, encoding, headers } = body;
  if (typeof targetId !== "string" || typeof url !== "string") {
    return { ok: false, error: "targetId と url は文字列である必要があります" };
  }
  if (!isAllowedUrl(url)) {
    return { ok: false, error: "許可されていない URL です(https の race / db / nar の netkeiba.com だけ)" };
  }
  if (typeof kind !== "string" || !(TARGET_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "kind が不正です" };
  }
  if (encoding !== "utf-8" && encoding !== "euc-jp") {
    return { ok: false, error: "encoding が不正です(utf-8 / euc-jp)" };
  }
  if (!Array.isArray(headers)) {
    return { ok: false, error: "headers は配列である必要があります" };
  }
  if (headers.length > SOCKET_MAX_HEADERS) {
    return { ok: false, error: `headers は ${SOCKET_MAX_HEADERS} 個までです(${headers.length} 個)` };
  }
  const entries: HeaderEntry[] = [];
  for (const h of headers as unknown[]) {
    if (!isRecord(h) || typeof h["name"] !== "string" || typeof h["value"] !== "string") {
      return { ok: false, error: "headers の要素は {name, value}(どちらも文字列)である必要があります" };
    }
    const name = h["name"];
    const value = h["value"];
    if (!isValidHeaderName(name)) {
      return { ok: false, error: `ヘッダ名が不正です: ${JSON.stringify(name.slice(0, 40))}` };
    }
    if (isForbiddenRequestHeader(name)) {
      return { ok: false, error: `指定できないヘッダです: ${name}` };
    }
    if (!isValidHeaderValue(value)) {
      return { ok: false, error: `ヘッダ ${name} の値が不正です(制御文字・非 ASCII・長すぎる値)` };
    }
    entries.push({ name, value });
  }
  return { ok: true, value: { targetId, url, kind: kind as TargetKind, encoding, headers: entries } };
}
