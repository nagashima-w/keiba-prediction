/**
 * IPCハンドラ境界の薄いエラーログ付きラッパー(Task#35 ログ基盤)。
 *
 * ipc.ts の各ハンドラは、実IO(DB・HTTP・LLM)の失敗をそのまま renderer へ reject して返す
 * (挙動は変えない)。ただしこれまで main 側には何も記録が残らず、ユーザーが「ログを見て対処/
 * AIに渡す」ことができなかった。本ラッパーは fn() の例外を捕捉し、操作名・コンテキスト(raceId/url等)
 * 付きで logError してから、同じ例外をそのまま再送出する(renderer側の挙動・エラーメッセージは不変)。
 */

import { logError } from "./logger.js";
import type { LogContext } from "../shared/log-formatter.js";

/**
 * fn() を実行し、例外発生時のみ操作名・コンテキスト付きでログしてから再送出する。
 * @param operation 操作名(IPC_CHANNELS の値を流用することを推奨)
 * @param context raceId・url等(省略可)
 * @param fn 実行対象(同期関数・Promiseを返す関数のいずれも可)
 */
export async function withErrorLogging<T>(
  operation: string,
  context: LogContext | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logError(operation, error, context);
    throw error;
  }
}
