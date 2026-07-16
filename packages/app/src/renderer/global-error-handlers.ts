/**
 * renderer側のグローバル例外集約(Task#35 code-reviewer指摘: 要修正3-b)。
 *
 * これまでIPC呼び出しのcatch節でしかmain側のログへ集約できておらず、IPCに紐付かない
 * renderer側の予期しない例外(白画面クラッシュ系)が一切ログに残らない問題があった。
 * window.onerror / window.onunhandledrejection から拾える情報を受け取り、
 * logRendererError相当のペイロードを組み立てて logFn を呼ぶロジックを純粋寄りの関数として
 * ここに集約する。main.tsx(vitest対象外の.tsx)からは本ファイルの関数を呼ぶだけの
 * 薄い配線にとどめ、ロジック本体はここでテストする。
 */

import { buildRendererErrorPayload, type RendererErrorPayload } from "./renderer-error-payload.js";

/** window.onerror が渡す情報のうち、本ハンドラが利用する最小限の形。 */
export interface WindowErrorEventInfo {
  readonly message: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly error?: unknown;
}

/** logRendererError(実体はwindow.keibaApi.logRendererError)相当の関数の型。 */
export type LogRendererErrorFn = (payload: RendererErrorPayload) => Promise<void>;

/**
 * window.onerror 相当のイベント情報からログペイロードを組み立て、logFn に渡す。
 * - filename があれば「ファイル名:行:列」をメッセージに付記する(発生箇所の手がかり)。
 * - error が Error インスタンスであればそのスタックを使う(無ければ null)。
 * - logFn が失敗しても例外を外へ漏らさない(ログ起因でさらに画面を壊さないため)。
 */
export function handleWindowError(event: WindowErrorEventInfo, logFn: LogRendererErrorFn): void {
  const location =
    event.filename !== undefined && event.filename !== ""
      ? ` (${event.filename}:${event.lineno ?? "?"}:${event.colno ?? "?"})`
      : "";
  const message = `${event.message}${location}`;
  const stack = event.error instanceof Error ? (event.error.stack ?? null) : null;
  logFn({ operation: "renderer:window-error", message, stack }).catch(() => {});
}

/**
 * window.onunhandledrejection 相当の reason からログペイロードを組み立て、logFn に渡す。
 * reason は catch(e: unknown) と同じ形(Error または任意の値)なので、
 * buildRendererErrorPayload をそのまま再利用する。
 * logFn が失敗しても例外を外へ漏らさない。
 */
export function handleUnhandledRejection(reason: unknown, logFn: LogRendererErrorFn): void {
  logFn(buildRendererErrorPayload("renderer:unhandled-rejection", reason)).catch(() => {});
}
