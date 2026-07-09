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
