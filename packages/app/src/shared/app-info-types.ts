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
