import { contextBridge, ipcRenderer } from "electron";

import type { KeibaApi } from "../shared/api.js";
import { IPC_CHANNELS } from "../shared/channels.js";

/**
 * レンダラーに公開する API。
 * contextIsolation 有効下で contextBridge を用い、ipcRenderer を直接晒さず
 * 必要なメソッドだけを `window.keibaApi` として公開する(最小権限)。
 */
const api: KeibaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
};

contextBridge.exposeInMainWorld("keibaApi", api);
