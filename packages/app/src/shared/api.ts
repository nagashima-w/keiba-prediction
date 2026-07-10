import type { AppInfo } from "../main/app-info.js";
import type {
  AnalysisHistoryItem,
  AnalysisProgress,
  AnalysisResult,
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
   * レースの分析を実行する。進捗は onAnalysisProgress で購読する。
   * @param raceId レースID(12桁)
   * @param date 選択済み開催日(YYYYMMDD)。季節分類・休み明け走目の起点に用いる。
   */
  runAnalysis(raceId: string, date: string): Promise<AnalysisResult>;

  /**
   * 分析の進捗イベントを購読する。
   * @param listener 進捗を受け取るコールバック
   * @returns 購読を解除する関数
   */
  onAnalysisProgress(listener: (progress: AnalysisProgress) => void): () => void;

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
   * 分析結果を Discord Webhook へ送信する。
   * Webhook URL は main 側が最新設定から読み、送信前に検証する。
   * 成功時は解決、失敗時(URL未設定・検証NG・送信エラー)はユーザー向けメッセージで reject する。
   * @param result 送信する分析結果
   */
  sendDiscord(result: AnalysisResult): Promise<void>;
}
