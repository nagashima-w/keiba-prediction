// バレル(@keiba/core)ではなく scorer 設定のサブパスだけを narrow import する。
// バレル経由だと ev/scraper 一式(better-sqlite3 等の native 依存)を巻き込み、
// main バンドルの起動時にネイティブ解決を要求してしまうため。
import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";

/** アプリの表示名称(固定)。 */
export const APP_NAME = "競馬期待値分析ツール";

/** 現在の開発フェーズ表示。 */
export const APP_PHASE = "Phase 4 開発中";

/**
 * core から取り込んだ設定の要約。
 * レンダラーが core を直接 import せず(better-sqlite3 等のネイティブ依存を避けるため)、
 * IPC 経由で core の値を受け取れることを確認するための最小データ。
 */
export interface CoreSummary {
  /** バイアス補正を適用する最小サンプル数。 */
  readonly minSampleForBias: number;
  /** prior の下限。 */
  readonly priorMin: number;
  /** prior の上限。 */
  readonly priorMax: number;
}

/** レンダラーへ返すアプリ情報。 */
export interface AppInfo {
  /** アプリ名称。 */
  readonly appName: string;
  /** アプリのバージョン(package.json 由来)。 */
  readonly appVersion: string;
  /** 開発フェーズ表示。 */
  readonly phase: string;
  /** core 設定の要約(core 読み込み確認用)。 */
  readonly core: CoreSummary;
}

/**
 * アプリ情報を組み立てる純関数。
 *
 * Electron の app.getVersion() から得たバージョン文字列を受け取り、
 * core の DEFAULT_SCORER_CONFIG の一部を要約して返す。
 * バージョンが空(または空白のみ)の場合は "unknown" にフォールバックする。
 */
export function buildAppInfo(version: string): AppInfo {
  const trimmed = version.trim();
  return {
    appName: APP_NAME,
    appVersion: trimmed === "" ? "unknown" : trimmed,
    phase: APP_PHASE,
    core: {
      minSampleForBias: DEFAULT_SCORER_CONFIG.minSampleForBias,
      priorMin: DEFAULT_SCORER_CONFIG.prior.minPrior,
      priorMax: DEFAULT_SCORER_CONFIG.prior.maxPrior,
    },
  };
}
