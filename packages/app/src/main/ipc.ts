import { app, ipcMain } from "electron";

import { IPC_CHANNELS } from "../shared/channels.js";
import { buildAppInfo } from "./app-info.js";

/**
 * main プロセスの IPC ハンドラをまとめて登録する。
 *
 * 各ハンドラの実処理(値の組み立て)は純関数(app-info.ts 等)に委ね、
 * ここでは Electron の ipcMain とチャネル定義を結線するだけに留める。
 * こうすることでロジックを Electron 非依存で単体テストできる。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, () => buildAppInfo(app.getVersion()));
}
