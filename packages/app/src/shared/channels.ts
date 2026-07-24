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
  /**
   * 期間バッチ「先取得+件数算出」(phase1。タスクB2b-1)。指定期間・取得対象からレースIDを
   * 収集し件数を返すのみで、LLM分析(runBatchAnalysis/analyzeOne)は一切呼ばない。
   * 実行対象が確定した後の分析実行(phase2)は既存 runBatchAnalysis(runBatchAnalysisチャネル)を
   * そのまま再利用する(新規の実行チャネルは設けない)。
   */
  collectPeriodBatch: "analysis:period-batch-collect",
  /**
   * 実行中の期間バッチ先取得(phase1)に中断を要求する(次の日境界で停止)。
   * 一括分析の中断(cancelBatchAnalysis)とは別の独立フラグ・別チャネル(bulkImportCancelRequestedに倣う)。
   */
  cancelCollectPeriodBatch: "analysis:period-batch-collect-cancel",
  /**
   * 期間バッチ「先取得」(phase1)の全体進捗イベント(main→renderer への一方向通知。タスクC2)。
   * 一括分析の全体進捗(batchProgress)とは別チャネル(先取得は日単位、実行はレース単位で
   * 意味が異なるため)。ペイロードは {completedDays, totalDays} のみの単純な件数
   * (bulkImportProgressと同じ「レース内段階の無い単純な件数」の流儀)。
   */
  periodBatchCollectProgress: "analysis:period-batch-collect-progress",
  /**
   * 期間バッチ「実行」(phase2。タスクC1)。phase1(collectPeriodBatch)が確定した
   * targetRaces(raceId+その開催日の組)を受け取り、レースごとに自分の開催日で分析する。
   * オーケストレーション本体・進捗(batchProgress)・中断(cancelBatchAnalysis)は
   * 単日一括分析(runBatchAnalysis)とそのまま共有する(新規チャネルは実行の起点のみ)。
   */
  runPeriodBatchAnalysis: "analysis:run-period-batch",
  /** レース結果を取り込む(result.html取得→パース→実着順+複勝確定払戻を保存)。 */
  importResult: "result:import",
  /** 検証レポート(累積回収率・キャリブレーション表)を取得する。 */
  getVerifyReport: "verify:report",
  /** プロンプト版別の検証レポート一覧を取得する(Task#27)。 */
  getVerifyReportByPromptVersion: "verify:report-by-prompt-version",
  /**
   * プロンプト版不明(prompt_version が null)の分析をまとめて削除する(Task#33)。
   * 関連する analysis_horses(馬単位の子行)も併せて削除する。race_results は削除しない。
   */
  deleteUnknownPromptVersionAnalyses: "verify:delete-unknown-prompt-version-analyses",
  /**
   * レース単位の統合リスト(検証画面UI統合)を取得する。旧 getRaceBreakdown(結果取込済みのみ)と
   * 旧 listAnalyses(分析単位・重複あり)を置き換える。母集団は「分析済みの全レース」
   * (latest統合済み・結果取込の有無を問わない)を、開催日降順(null は最後)→レースID昇順で返す。
   */
  getRaceLedger: "verify:race-ledger",
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
  /**
   * 分析データのエクスポート(第一版、GitHub Issue#10)。指定レースの「保存済みの最新分析」
   * (同一レースに複数分析があれば最新〈id最大〉)を、schemaVersion=1のJSON+馬別CSVの2ファイルへ
   * 書き出す。保存先はJSON側をダイアログで選ばせ、CSVは同じ場所へ拡張子違いで自動保存する。
   */
  exportAnalysis: "analysis:export",
} as const;

/** IPC_CHANNELS の値(実際のチャネル名文字列)のユニオン型。 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
