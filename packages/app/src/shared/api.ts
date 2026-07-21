import type { AppInfo } from "../main/app-info.js";
import type {
  BatchProgress,
  BatchRaceOutcome,
  BulkImportProgress,
  BulkImportRaceOutcome,
  DeleteUnknownPromptVersionAnalysesResult,
  ImportResultOutcome,
  LogExportOutcome,
  PeriodBatchCollectProgress,
  PeriodBatchCollectResult,
  PeriodBatchTargetRace,
  PromptVersionVerifyReportView,
  RaceLedgerView,
  RaceListItem,
  RaceListTarget,
  RaceVenueKind,
  VerifyReportView,
  VerifyVenueFilter,
} from "./analysis-types.js";
import type { MaskedSettings, SettingsUpdate } from "./settings.js";

/**
 * preload の contextBridge でレンダラーに公開する API の型。
 * レンダラーからは `window.keibaApi` として参照する(型は renderer/global.d.ts で宣言)。
 * ipcRenderer は直接公開せず、必要なメソッドだけをここに列挙して最小権限を保つ。
 */
export interface KeibaApi {
  /** アプリ情報(名称・バージョン・core要約)を取得する。 */
  getAppInfo(): Promise<AppInfo>;

  /**
   * 開催日(YYYYMMDD)のレース一覧を取得する。
   * @param date 開催日(YYYYMMDD形式)
   * @param venueKind 開催区分(中央/地方)。省略時は "central"(中央)。
   *   "nar"(地方)を指定すると main 側で listNarRaces を呼び分ける。
   * @param jpnOnly 交流重賞(Jpn1/2/3)のみに絞り込むか(タスクB1)。省略時は false(後方互換)。
   *   venueKind="nar" のときのみ有効(main 側で判定)。venueKind="central" のときは無視される。
   */
  listRaces(
    date: string,
    venueKind?: RaceVenueKind,
    jpnOnly?: boolean,
  ): Promise<RaceListItem[]>;

  /**
   * 複数レースを一括分析する(直列実行)。全体進捗は onBatchProgress で購読する。
   * 1レースの失敗で全体を止めず、per-race の成功/失敗/スキップを配列で返す。
   * @param raceIds 対象レースID(12桁)の配列。実行順は渡した順。
   * @param date 選択済み開催日(YYYYMMDD)。全レース共通の開催日として用いる。
   */
  runBatchAnalysis(
    raceIds: readonly string[],
    date: string,
  ): Promise<BatchRaceOutcome[]>;

  /**
   * 実行中の一括分析に中断を要求する。次のレース境界で停止する
   * (実行中のレースは完走させる)。実行していないときは無視される。
   */
  cancelBatchAnalysis(): Promise<void>;

  /**
   * 一括分析の全体進捗イベントを購読する。
   * @param listener 全体進捗(完了レース数・現在レース・レース内段階)を受け取るコールバック
   * @returns 購読を解除する関数
   */
  onBatchProgress(listener: (progress: BatchProgress) => void): () => void;

  /**
   * 期間バッチ「実行」(phase2。タスクC1)。phase1(collectPeriodBatch)が確定した
   * targetRaces(raceId+その開催日の組)を渡すと、main側でレースごとに自分の開催日で分析する
   * (単一の date を全レースへ使い回すと日跨ぎで開催日を取り違えるため、単日一括分析用の
   * runBatchAnalysis とはシグネチャを分ける)。全体進捗・中断は既存の onBatchProgress /
   * cancelBatchAnalysis をそのまま再利用する(同時に両方は走らない前提)。
   * @param targetRaces 実行対象(phase1の PeriodBatchCollectResult.targetRaces をそのまま渡す)
   */
  runPeriodBatchAnalysis(
    targetRaces: readonly PeriodBatchTargetRace[],
  ): Promise<BatchRaceOutcome[]>;

  /**
   * 期間バッチ「先取得+件数算出」(phase1。タスクB2b-1/C2)。指定期間・取得対象からレースIDを
   * 収集し件数を返すのみで、LLM分析(runPeriodBatchAnalysis/runBatchAnalysis)は一切呼ばない。
   * 全体進捗は onPeriodBatchCollectProgress で購読する。
   * @param from 開始日(YYYYMMDD)
   * @param to 終了日(YYYYMMDD)
   * @param target 取得対象(中央/地方(全て)/地方(Jpnのみ))
   */
  collectPeriodBatch(
    from: string,
    to: string,
    target: RaceListTarget,
  ): Promise<PeriodBatchCollectResult>;

  /**
   * 実行中の期間バッチ先取得(phase1)に中断を要求する。次の日境界で停止する
   * (一括分析の中断=cancelBatchAnalysisとは独立。実行していないときは無視される)。
   */
  cancelCollectPeriodBatch(): Promise<void>;

  /**
   * 期間バッチ先取得(phase1)の全体進捗イベントを購読する。
   * @param listener 全体進捗(完了日数・総日数)を受け取るコールバック
   * @returns 購読を解除する関数
   */
  onPeriodBatchCollectProgress(
    listener: (progress: PeriodBatchCollectProgress) => void,
  ): () => void;

  /**
   * レース結果を取り込む(result.html取得→パース→実着順+複勝確定払戻を保存)。
   * @param raceId レースID(12桁)
   */
  importResult(raceId: string): Promise<ImportResultOutcome>;

  /**
   * 分析済みで結果未取込のレースを列挙し、直列に一括取込する(Task#31)。
   * 全体進捗は onBulkImportProgress で購読する。1レースの失敗で全体を止めず、
   * per-race の取込/未確定スキップ/失敗/中断スキップを配列で返す。
   */
  runBulkImport(): Promise<readonly BulkImportRaceOutcome[]>;

  /**
   * 実行中の一括取込に中断を要求する。次のレース境界で停止する
   * (実行中のレースは完走させる)。実行していないときは無視される。
   */
  cancelBulkImport(): Promise<void>;

  /**
   * 一括取込の全体進捗イベントを購読する。
   * @param listener 全体進捗(完了レース数・総数・現在レースID)を受け取るコールバック
   * @returns 購読を解除する関数
   */
  onBulkImportProgress(listener: (progress: BulkImportProgress) => void): () => void;

  /**
   * 検証レポート(累積回収率・キャリブレーション表)を取得する。
   * @param venueKind 開催区分フィルタ(Task#32)。省略時は "all"(全体、従来どおり)。
   *   "central"/"nar" を指定すると raceId 由来の開催区分でレポート母集団を絞り込む
   *   (listRaces(date, venueKind) と同じ「同一チャネルに引数を追加する」流儀。
   *   プロンプト版別比較・レース一覧への適用はスコープ外のため channel/引数を増やさない)。
   */
  getVerifyReport(venueKind?: VerifyVenueFilter): Promise<VerifyReportView>;

  /**
   * プロンプト版別の検証レポート一覧を取得する(Task#27)。
   * プロンプトを改善したときに版ごとの成績(回収率等)を比較するために使う。
   * 版不明(旧データ・LLM未使用の分析)は promptVersion=null の1グループとして含まれる。
   */
  getVerifyReportByPromptVersion(): Promise<readonly PromptVersionVerifyReportView[]>;

  /**
   * プロンプト版不明(prompt_version が null)の分析をまとめて削除する(Task#33)。
   * 破壊的操作(取り消せない)であり、呼び出し側(renderer)が確認ダイアログを出したうえで
   * 呼ぶことを前提とする。関連する analysis_horses(馬単位の子行)も併せて削除するが、
   * race_results(結果データ)は版と無関係に再利用できるため削除しない。
   */
  deleteUnknownPromptVersionAnalyses(): Promise<DeleteUnknownPromptVersionAnalysesResult>;

  /**
   * レース単位の統合リスト(検証画面UI統合)を取得する。旧 getRaceBreakdown(結果取込済みのみ)と
   * 旧 listAnalyses(分析単位・重複あり)を置き換える。母集団は「分析済みの全レース」
   * (latest統合済み・結果取込の有無を問わない)を、開催日降順(null は最後)→レースID昇順で返す。
   */
  getRaceLedger(): Promise<readonly RaceLedgerView[]>;

  /** 設定(マスク済み。平文APIキーは含まない)を取得する。 */
  getSettings(): Promise<MaskedSettings>;

  /**
   * 設定を保存し、保存後のマスク済み設定を返す。
   * @param update 更新内容(apiKey は省略で現在値保持、文字列で差し替え)
   */
  saveSettings(update: SettingsUpdate): Promise<MaskedSettings>;

  /** 設定を既定へ初期化し、初期化後のマスク済み設定を返す。 */
  resetSettings(): Promise<MaskedSettings>;

  /**
   * 一括分析の横断サマリ(EVプラス馬一覧)を Discord Webhook へ1通で送信する。
   * Webhook URL は main 側が最新設定から読み、送信前に検証する。
   * @param outcomes 一括分析のレースごとのアウトカム
   */
  sendBatchDiscord(outcomes: readonly BatchRaceOutcome[]): Promise<void>;

  /**
   * renderer側で発生したエラーをmain側のログファイルへ集約する(Task#35 受け入れ条件6)。
   * ユーザーがログをそのままAIに渡して原因特定できるようにするため、renderer側の console.error の
   * 代わりに使う。呼び出し失敗(main側の一時的な不調等)はUI表示に影響させないため、
   * 呼び出し側で reject を無視してよい(ログ集約自体のベストエフォート性)。
   */
  logRendererError(payload: {
    /** どの操作で発生したか(例: "renderer:bulk-import")。 */
    operation: string;
    /** エラーメッセージ。 */
    message: string;
    /** スタックトレース(取得できれば)。 */
    stack?: string | null;
    /** 関連するレースID(あれば)。 */
    raceId?: string | null;
    /** 関連するURL(あれば)。 */
    url?: string | null;
  }): Promise<void>;

  /**
   * ログ保存ディレクトリを OS のファイラーで開く(Task#36 受け入れ条件1)。
   * ディレクトリが未作成でも安全に開けるよう、main 側で開く前に作成する。
   */
  openLogFolder(): Promise<void>;

  /**
   * 現行ログ(main.log)+ローテーション済みログ(main.old.log、存在すれば)を1ファイルに
   * 集約し、ユーザーが選んだ保存先へ書き出す(Task#36 受け入れ条件2)。
   * 保存先は main 側の dialog.showSaveDialog で選ばせる。キャンセル時は "canceled" を返し、
   * 何も書き込まない。
   */
  exportLogs(): Promise<LogExportOutcome>;
}
