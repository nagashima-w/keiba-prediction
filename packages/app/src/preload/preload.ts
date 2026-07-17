import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { KeibaApi } from "../shared/api.js";
import type { BatchProgress, BulkImportProgress } from "../shared/analysis-types.js";
import { IPC_CHANNELS } from "../shared/channels.js";

/**
 * レンダラーに公開する API。
 * contextIsolation 有効下で contextBridge を用い、ipcRenderer を直接晒さず
 * 必要なメソッドだけを `window.keibaApi` として公開する(最小権限)。
 *
 * 一括分析の全体進捗(analysis:batch-progress)は main→renderer の一方向 send で届くため、
 * onBatchProgress で ipcRenderer.on を包み、購読解除関数を返す(リスナー漏れ防止)。
 */
const api: KeibaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  listRaces: (date, venueKind) =>
    ipcRenderer.invoke(IPC_CHANNELS.listRaces, date, venueKind),
  importResult: (raceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.importResult, raceId),
  getVerifyReport: () => ipcRenderer.invoke(IPC_CHANNELS.getVerifyReport),
  getVerifyReportByPromptVersion: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getVerifyReportByPromptVersion),
  getRaceBreakdown: () => ipcRenderer.invoke(IPC_CHANNELS.getRaceBreakdown),
  listAnalyses: () => ipcRenderer.invoke(IPC_CHANNELS.listAnalyses),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (update) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, update),
  resetSettings: () => ipcRenderer.invoke(IPC_CHANNELS.resetSettings),
  sendBatchDiscord: (outcomes) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendBatchDiscord, outcomes),
  runBatchAnalysis: (raceIds, date) =>
    ipcRenderer.invoke(IPC_CHANNELS.runBatchAnalysis, raceIds, date),
  cancelBatchAnalysis: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelBatchAnalysis),
  onBatchProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, progress: BatchProgress): void => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNELS.batchProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.batchProgress, handler);
    };
  },
  logRendererError: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.logRendererError, payload),
  openLogFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openLogFolder),
  exportLogs: () => ipcRenderer.invoke(IPC_CHANNELS.exportLogs),
  runBulkImport: () => ipcRenderer.invoke(IPC_CHANNELS.runBulkImport),
  cancelBulkImport: () => ipcRenderer.invoke(IPC_CHANNELS.cancelBulkImport),
  onBulkImportProgress: (listener) => {
    const handler = (
      _event: IpcRendererEvent,
      progress: BulkImportProgress,
    ): void => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNELS.bulkImportProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.bulkImportProgress, handler);
    };
  },
};

contextBridge.exposeInMainWorld("keibaApi", api);
