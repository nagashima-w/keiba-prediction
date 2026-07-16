/**
 * electron-log への薄い配線層(main プロセス、Task#35 ログ基盤)。
 *
 * 整形(shared/log-formatter.ts の formatLogEntry)とマスキングは純関数側に委ね、
 * ここでは「electron-log への実際の書き込み」と「ファイル保存先・ローテーション設定」だけを担う
 * (仕様: 「electron-logへの接続(transport設定)は薄い配線層に分離してテスト対象外にして良い」)。
 *
 * electron-log/main の読み込みは遅延化する(http-client.ts の loadUndici() と同じ流儀)。
 * 理由: ipc.ts はこのモジュールを import するため、モジュール読み込み時点で electron-log の
 * 初期化コードが走ってしまうと、electron を最小限だけモックしている既存の ipc 系テスト
 * (ipc.test.ts 等、electron-log を意識していない)を巻き込んで壊しかねない。
 * 実際に electron-log を読み込むのは logError 等を「呼んだ」ときだけにすることで、
 * 成功パスしか検証しない既存テストには一切影響しない(失敗パスを検証する一部のテストでは
 * main/logger.js 自体をモックして実接続を避ける方針にしている)。
 */

import path from "node:path";

import { app } from "electron";

import {
  extractErrorInfo,
  formatLogEntry,
  type LogContext,
  type LogLevel,
} from "../shared/log-formatter.js";
import { logDirectoryFromUserData } from "./log-paths.js";

/** electron-log/main の型(必要なメソッドのみ最小限に定義。動的importの戻り値を絞り込むため)。 */
interface ElectronLogMain {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  transports: {
    file: {
      resolvePathFn?: (...args: unknown[]) => string;
      maxSize?: number;
      format?: unknown;
    };
    console: {
      format?: unknown;
    };
  };
}

/** ファイルローテーションのサイズ上限(5MB)。超過分は electron-log 標準機能で .old.log へ退避される。 */
const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024;

let electronLogPromise: Promise<ElectronLogMain> | undefined;

/**
 * electron-log/main を遅延ロードし、ファイル保存先・ローテーション・出力フォーマットを設定する。
 * 初回のみ実 import + 設定を行い、以降は同じ Promise を再利用する。
 *
 * format を "{text}" にする理由: electron-log 標準のプレフィックス([日時][レベル])を付けさせず、
 * formatLogEntry が組み立てた1行JSONをそのまま書き出す(二重フォーマットで構造化JSONが壊れるのを防ぐ)。
 */
function loadElectronLog(): Promise<ElectronLogMain> {
  if (electronLogPromise === undefined) {
    electronLogPromise = import("electron-log/main").then((mod) => {
      const log = (mod as { default: ElectronLogMain }).default;
      log.transports.file.resolvePathFn = () => path.join(getLogDirectory(), "main.log");
      log.transports.file.maxSize = MAX_LOG_FILE_SIZE_BYTES;
      log.transports.file.format = "{text}";
      log.transports.console.format = "{text}";
      return log;
    });
  }
  return electronLogPromise;
}

/**
 * ログ保存ディレクトリの絶対パス(userData配下)。Task#36(ログフォルダを開く等)から参照する。
 */
export function getLogDirectory(): string {
  return logDirectoryFromUserData(app.getPath("userData"));
}

/** 既知の秘密値を提供する関数(呼び出しの都度、最新の設定値を返す)。既定は「秘密なし」。 */
let secretsProvider: () => readonly string[] = () => [];

/**
 * ログのマスキングに使う「既知の秘密値」の取得元を登録する。
 * ipc.ts の registerIpcHandlers() が、設定ストアから apiKey・discordWebhookUrl・環境変数の
 * ANTHROPIC_API_KEY を返す関数を登録する(設定変更の都度読み直すため、値ではなく関数で受け取る)。
 */
export function setSecretsProvider(provider: () => readonly string[]): void {
  secretsProvider = provider;
}

/**
 * ログを1行書き出す共通処理。electron-log 自体が失敗しても(ディスク書き込み失敗等)、
 * 呼び出し元(IPCハンドラ・バッチ処理)の本来の処理を壊してはならないため、例外を外へ漏らさない。
 *
 * 二重防御(code-reviewer指摘: 要修正1): formatLogEntry の呼び出し自体も try の内側に含める。
 * formatLogEntry 側(shared/log-formatter.ts)は JSON.stringify 失敗時に例外を投げず安全な
 * フォールバック文字列を返すよう既に防御しているが、万一その防御をすり抜けて例外が漏れても、
 * write() は async 関数のため try の外で投げると reject した Promise になり、
 * logError/logWarn/logInfo が `void write(...)` で fire-and-forget 呼び出ししている以上、
 * unhandledRejection としてログ自体が消える(場合によってはプロセスを不安定にする)。
 * それを防ぐため、formatLogEntry 呼び出しを含む一連の処理全体を try で包む。
 */
async function write(
  level: LogLevel,
  operation: string,
  message: string,
  options?: { readonly context?: LogContext; readonly error?: unknown },
): Promise<void> {
  let line: string | undefined;
  try {
    line = formatLogEntry(
      {
        level,
        operation,
        message,
        context: options?.context,
        error: options?.error,
      },
      secretsProvider(),
    );
    const log = await loadElectronLog();
    log[level](line);
  } catch {
    // ロガー自体の失敗(electron-log書き込み失敗、または万一 formatLogEntry 側の
    // 二重防御をすり抜けた失敗)は握りつぶす(最終防御線)。line が組み立てられていれば
    // それを、組み立てられていなければ(formatLogEntry自体の失敗)最低限の生の情報
    // (line に依存しない level/operation/message)を出力する。
    // ここで console を使うのは「ロガーが機能していない」ときの最終フォールバックとして
    // のみ許容する例外的な使用。
    // eslint-disable-next-line no-console
    console.error(line ?? `[${level}] ${operation}: ${message}`);
  }
}

/**
 * エラーログを記録する(受け入れ条件3: 操作名・raceId・URL・例外スタックを構造化付与)。
 * @param operation 操作名(IPC_CHANNELS の値を流用することを推奨。grepで追いやすくする)
 * @param error 例外(Error または {message, stack} 形状)
 * @param context raceId・url等(省略可)
 */
export function logError(operation: string, error: unknown, context?: LogContext): void {
  const message = extractErrorInfo(error)?.message ?? String(error);
  void write("error", operation, message, { context, error });
}

/** 警告ログを記録する。 */
export function logWarn(operation: string, message: string, context?: LogContext): void {
  void write("warn", operation, message, { context });
}

/** 情報ログを記録する。 */
export function logInfo(operation: string, message: string, context?: LogContext): void {
  void write("info", operation, message, { context });
}
