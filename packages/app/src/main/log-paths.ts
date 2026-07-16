/**
 * ログ保存先パスの計算(main プロセス、Task#35 ログ基盤)。
 *
 * electron に依存しない純関数として切り出す。理由:
 * - main/logger.ts(electron-log への実配線)から独立してテストできる。
 * - Task#36(ログフォルダを開く・エクスポート)がログディレクトリの場所を知る必要があるため、
 *   参照しやすい単純な関数として公開する(main/logger.ts の getLogDirectory() が本関数を使う)。
 */

import path from "node:path";

/**
 * userData配下の絶対パスから、ログ保存ディレクトリの絶対パスを導出する。
 * 既存の keiba.db・settings.json と同じく userData 配下に置く(Windowsでは %APPDATA%/<アプリ名>/logs/)。
 * @param userDataPath app.getPath("userData") の値
 */
export function logDirectoryFromUserData(userDataPath: string): string {
  return path.join(userDataPath, "logs");
}
