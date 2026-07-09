import type { AppInfo } from "../main/app-info.js";
import type {
  AnalysisProgress,
  AnalysisResult,
  RaceListItem,
} from "./analysis-types.js";

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
}
