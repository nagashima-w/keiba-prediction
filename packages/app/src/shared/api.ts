import type { AppInfo } from "../main/app-info.js";
import type {
  AnalysisHistoryItem,
  BatchProgress,
  BatchRaceOutcome,
  BulkImportProgress,
  BulkImportRaceOutcome,
  ImportResultOutcome,
  PromptVersionVerifyReportView,
  RaceListItem,
  RaceVenueKind,
  VerifyReportView,
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
   */
  listRaces(date: string, venueKind?: RaceVenueKind): Promise<RaceListItem[]>;

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

  /** 検証レポート(累積回収率・キャリブレーション表)を取得する。 */
  getVerifyReport(): Promise<VerifyReportView>;

  /**
   * プロンプト版別の検証レポート一覧を取得する(Task#27)。
   * プロンプトを改善したときに版ごとの成績(回収率等)を比較するために使う。
   * 版不明(旧データ・LLM未使用の分析)は promptVersion=null の1グループとして含まれる。
   */
  getVerifyReportByPromptVersion(): Promise<readonly PromptVersionVerifyReportView[]>;

  /** 分析履歴一覧(検証画面用)を取得する。 */
  listAnalyses(): Promise<AnalysisHistoryItem[]>;

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
}
