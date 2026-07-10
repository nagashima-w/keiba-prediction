import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { KeibaApi } from "../shared/api.js";
import type { AnalysisProgress } from "../shared/analysis-types.js";
import { IPC_CHANNELS } from "../shared/channels.js";

/**
 * レンダラーに公開する API。
 * contextIsolation 有効下で contextBridge を用い、ipcRenderer を直接晒さず
 * 必要なメソッドだけを `window.keibaApi` として公開する(最小権限)。
 *
 * 進捗イベント(analysis:progress)は main→renderer の一方向 send で届くため、
 * onAnalysisProgress で ipcRenderer.on を包み、購読解除関数を返す(リスナー漏れ防止)。
 */
const api: KeibaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  listRaces: (date) => ipcRenderer.invoke(IPC_CHANNELS.listRaces, date),
  runAnalysis: (raceId, date) =>
    ipcRenderer.invoke(IPC_CHANNELS.runAnalysis, raceId, date),
  importResult: (raceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.importResult, raceId),
  getVerifyReport: () => ipcRenderer.invoke(IPC_CHANNELS.getVerifyReport),
  listAnalyses: () => ipcRenderer.invoke(IPC_CHANNELS.listAnalyses),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (update) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, update),
  resetSettings: () => ipcRenderer.invoke(IPC_CHANNELS.resetSettings),
  sendDiscord: (result) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendDiscord, result),
  onAnalysisProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, progress: AnalysisProgress): void => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNELS.analysisProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.analysisProgress, handler);
    };
  },
};

contextBridge.exposeInMainWorld("keibaApi", api);
