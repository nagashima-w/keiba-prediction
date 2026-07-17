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
  /** 複数レースを一括分析する(選択レースID配列+開催日。直列実行)。 */
  runBatchAnalysis: "analysis:run-batch",
  /** 実行中の一括分析に中断を要求する(次のレース境界で停止)。 */
  cancelBatchAnalysis: "analysis:cancel-batch",
  /** 一括分析の全体進捗イベント(main→renderer への一方向通知)。 */
  batchProgress: "analysis:batch-progress",
  /** レース結果を取り込む(result.html取得→パース→実着順+複勝確定払戻を保存)。 */
  importResult: "result:import",
  /** 検証レポート(累積回収率・キャリブレーション表)を取得する。 */
  getVerifyReport: "verify:report",
  /** プロンプト版別の検証レポート一覧を取得する(Task#27)。 */
  getVerifyReportByPromptVersion: "verify:report-by-prompt-version",
  /**
   * レース単位の予実ブレークダウン一覧を取得する(Task#34)。
   * verifyと同じ母集団(latest選択・推定EV除外・結果未保存除外)のレースを、開催日降順
   * (null は最後)→レースID昇順で返す。
   */
  getRaceBreakdown: "verify:race-breakdown",
  /** 分析履歴一覧(検証画面用)を取得する。 */
  listAnalyses: "analysis:list",
  /** 設定(マスク済み)を取得する。 */
  getSettings: "settings:get",
  /** 設定を保存する(マスク済みの更新後設定を返す)。 */
  saveSettings: "settings:save",
  /** 設定を既定へ初期化する(マスク済みの初期化後設定を返す)。 */
  resetSettings: "settings:reset",
  /** 一括分析の横断サマリを Discord Webhook へ1通で送信する。 */
  sendBatchDiscord: "notify:discord-batch",
  /**
   * 分析済みで結果未取込のレースを列挙し直列に一括取込する(Task#31)。
   * 未取込判定は NOT EXISTS(race_results に行が1件も無い)を用いる。
   */
  runBulkImport: "result:run-bulk-import",
  /** 実行中の一括取込に中断を要求する(次のレース境界で停止)。 */
  cancelBulkImport: "result:cancel-bulk-import",
  /** 一括取込の全体進捗イベント(main→renderer への一方向通知)。 */
  bulkImportProgress: "result:bulk-import-progress",
  /**
   * renderer側で発生したエラーをmain側のログファイルへ集約する(Task#35)。
   * renderer → main の一方向通知だが、他チャネルと同様に invoke/handle で統一する
   * (ipcMain.on を新たに使わずに済み、既存の結線テストのモック形状を変えなくて良いため)。
   */
  logRendererError: "log:renderer-error",
  /** ログ保存ディレクトリを OS のファイラーで開く(Task#36 受け入れ条件1)。 */
  openLogFolder: "log:open-folder",
  /** 現行ログ+ローテーション済みログを1ファイルに集約して保存する(Task#36 受け入れ条件2)。 */
  exportLogs: "log:export",
} as const;

/** IPC_CHANNELS の値(実際のチャネル名文字列)のユニオン型。 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
