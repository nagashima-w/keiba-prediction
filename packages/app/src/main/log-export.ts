/**
 * ログのエクスポート(main プロセス、Task#36 ログ取り出し導線)。
 *
 * electron に依存しない純関数(集約・既定ファイル名・パス解決)と、実ファイル読み込みの薄いIO層を
 * 分離する。集約ロジック(aggregateLogContents)は文字列のみを扱う純関数としてTDDする
 * (仕様「ファイル集約ロジックはテスト可能な純関数/関数注入(fsをモック)で書く」)。
 * IO層(readLogFileIfExists)は settings-store.ts と同じ流儀(実FSへの薄い同期アクセス。
 * テストは実テンポラリディレクトリで検証する)に揃える。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** electron-log 標準の命名規則(logger.ts のローテーション設定)。main.log → main.old.log。 */
const CURRENT_LOG_FILE_NAME = "main.log";
const OLD_LOG_FILE_NAME = "main.old.log";

/**
 * 現行ログ(main.log)とローテーション済みログ(main.old.log、存在すれば)を1本のテキストへ集約する。
 * 古い→新しいの順(old が先)で並べる(受け入れ条件2「集約順序は古い→新しい」)。
 * 空文字は「無かった」ものとして扱い、連結時に余分な区切りを作らない。
 * どちらも無ければ空文字を返す(まだログが1件も書かれていない=初回起動直後等)。
 */
export function aggregateLogContents(
  oldContent: string | null,
  currentContent: string | null,
): string {
  const parts = [oldContent, currentContent].filter(
    (content): content is string => content !== null && content !== "",
  );
  return parts.join("\n");
}

/** ログディレクトリ配下の main.log・main.old.log の絶対パスを求める。 */
export function resolveLogExportPaths(logDir: string): {
  readonly oldLogPath: string;
  readonly currentLogPath: string;
} {
  return {
    oldLogPath: path.join(logDir, OLD_LOG_FILE_NAME),
    currentLogPath: path.join(logDir, CURRENT_LOG_FILE_NAME),
  };
}

/**
 * ファイルを読み込み、存在しない・読み込めない場合は例外を投げず null を返す薄いIO層。
 * ローテーション前(main.old.log が無い)・初回起動前(main.log が無い)は正常な状態なので、
 * 「ファイルが無い」ことをエラーではなく null で表す。
 */
export function readLogFileIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * ログディレクトリから現行ログ+ローテーション済みログを読み込み、集約済みテキストを返す
 * (「最新ログをエクスポート」の実体)。
 */
export function collectLogExportContent(logDir: string): string {
  const { oldLogPath, currentLogPath } = resolveLogExportPaths(logDir);
  return aggregateLogContents(
    readLogFileIfExists(oldLogPath),
    readLogFileIfExists(currentLogPath),
  );
}

/**
 * エクスポートの既定ファイル名(YYYYMMDD付き。例: keiba-ev-tool-logs-20260716.txt)。
 * ローカル日時基準(App.tsx の todayYyyymmdd・analysis-pipeline.ts 等、既存コードと同じ流儀)。
 */
export function buildDefaultLogExportFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `keiba-ev-tool-logs-${y}${m}${d}.txt`;
}
