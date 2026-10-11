/**
 * Worker の `POST /subrequest-probe` の処理(Issue #162 段階1)。Worker から Durable Object を繰り返し呼び、
 * 呼び出し側の subrequest 数(Free は 50/呼び出し)に DO の呼び出しが数えられるかを見る。
 * **netkeiba にも第三者にも出ない**(DO の軽い `/do/noop` を呼ぶだけ)。
 *
 * DO の呼び出しは注入できる(`callOnce`)ので、Node の vitest で、実際の DO なしに検証できる。
 * 共有秘密の検査は前面の `worker.ts` が行う。
 */

import { classifySubrequestError, type SubrequestProbeResult } from "../../../scripts/cloudflare-spike/socket-matrix-run.js";
import { json } from "./json.js";

/** 既定の回数(Free の上限 50 を超える 51 回以上が要る。スクリプト側の `SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT` と同じ)。 */
export const DEFAULT_PROBE_COUNT = 60;

/** 回数の上限(暴走の防止)。 */
export const MAX_PROBE_COUNT = 100;

/** `?n=` を回数にする。省略は既定の 60。1〜100 の整数(10進の数字だけ)以外は null。 */
export function parseProbeCount(value: string | null): number | null {
  if (value === null) {
    return DEFAULT_PROBE_COUNT;
  }
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n >= 1 && n <= MAX_PROBE_COUNT ? n : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `callOnce` を `count` 回、直列に呼ぶ。最初の失敗(例外・非 2xx)で止め、通番・種類・メッセージを残す。
 * 非 2xx は subrequest の上限とは決めつけず、`other` として HTTP ステータスを添える。
 */
export async function runSubrequestProbe(callOnce: () => Promise<Response>, count: number): Promise<SubrequestProbeResult> {
  let succeeded = 0;
  for (let i = 1; i <= count; i += 1) {
    try {
      const response = await callOnce();
      if (!response.ok) {
        return {
          ran: true,
          requested: count,
          attempted: i,
          succeeded,
          firstFailureAt: i,
          errorKind: "other",
          error: `DO が HTTP ${response.status} を返した`,
          httpStatus: response.status,
        };
      }
      succeeded += 1;
    } catch (error) {
      const message = messageOf(error);
      return {
        ran: true,
        requested: count,
        attempted: i,
        succeeded,
        firstFailureAt: i,
        errorKind: classifySubrequestError(message),
        error: message,
        httpStatus: null,
      };
    }
  }
  return { ran: true, requested: count, attempted: count, succeeded, firstFailureAt: null, errorKind: null, error: null, httpStatus: null };
}

/** `POST /subrequest-probe?n=60`。結果は `{ok: true, result}`(試験の中の失敗も 200 で運ぶ)。不正な n は 400。 */
export async function handleSubrequestProbe(request: Request, callOnce: () => Promise<Response>): Promise<Response> {
  const count = parseProbeCount(new URL(request.url).searchParams.get("n"));
  if (count === null) {
    return json({ ok: false, error: `n は 1〜${MAX_PROBE_COUNT} の整数です` }, 400);
  }
  return json({ ok: true, result: await runSubrequestProbe(callOnce, count) });
}
