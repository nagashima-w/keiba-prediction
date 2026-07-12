import type { AppInfo } from "../main/app-info.js";
import type {
  AnalysisHistoryItem,
  BatchProgress,
  BatchRaceOutcome,
  ImportResultOutcome,
  RaceListItem,
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
   */
  listRaces(date: string): Promise<RaceListItem[]>;

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

  /** 検証レポート(累積回収率・キャリブレーション表)を取得する。 */
  getVerifyReport(): Promise<VerifyReportView>;

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
}
