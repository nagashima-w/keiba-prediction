/**
 * IPC チャネル名の集中定義。
 *
 * main(ipcMain.handle)と preload(ipcRenderer.invoke)の双方がこの定数を参照することで、
 * チャネル名の綴り間違いを防ぎ、今後チャネルを増やす際の一覧性を確保する。
 * 命名規約: `<領域>:<動作>`(コロン区切り)。
 */
export const IPC_CHANNELS = {
  /** アプリ情報(名称・バージョン・core要約)を取得する。 */
  getAppInfo: "app:get-info",
  /** 開催日(YYYYMMDD)のレース一覧を取得する。 */
  listRaces: "race:list",
  /** レースの分析を実行する(スクレイピング→スコアリング→LLM→EV→保存)。 */
  runAnalysis: "analysis:run",
  /** 分析の進捗イベント(main→renderer への一方向通知)。 */
  analysisProgress: "analysis:progress",
} as const;

/** IPC_CHANNELS の値(実際のチャネル名文字列)のユニオン型。 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
