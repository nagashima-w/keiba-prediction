/**
 * 設定画面「クラウドへの移行」の状態遷移と表示文(Issue #215・#167-A AC4)。
 *
 * 画面(CloudMigrationSection.tsx)は dispatch の橋渡しに徹し、遷移と文面はこの純関数に置いて単体テストする
 * (このリポジトリは @testing-library 未導入のためレンダリングテストは行わない)。
 */

import type { CloudMigrationExportOutcome } from "../shared/analysis-types.js";

/** 保存に成功した結果(件数・大きさ・保存先)。 */
export type CloudMigrationSaved = Extract<CloudMigrationExportOutcome, { status: "saved" }>;

/** 書き出し操作の状態。 */
export type CloudMigrationStatus = "idle" | "exporting" | "saved" | "canceled" | "error";

/** 節の状態。 */
export interface CloudMigrationState {
  readonly status: CloudMigrationStatus;
  /** status が "saved" のときだけ非 null。 */
  readonly saved: CloudMigrationSaved | null;
  /** status が "error" のときだけ非 null。 */
  readonly message: string | null;
}

/** 状態を変える操作。 */
export type CloudMigrationAction =
  | { readonly type: "書き出し開始" }
  | { readonly type: "書き出し成功"; readonly outcome: CloudMigrationExportOutcome }
  | { readonly type: "書き出しキャンセル" }
  | { readonly type: "書き出し失敗"; readonly message: string };

/** 初期状態(待機中)。 */
export function createInitialCloudMigrationState(): CloudMigrationState {
  return { status: "idle", saved: null, message: null };
}

/** 状態遷移。開始のたびに前回の結果・エラーは消す。 */
export function cloudMigrationReducer(
  _state: CloudMigrationState,
  action: CloudMigrationAction,
): CloudMigrationState {
  switch (action.type) {
    case "書き出し開始":
      return { status: "exporting", saved: null, message: null };
    case "書き出し成功":
      // canceled の結果を渡された場合(型の取り違え)に保存済みと表示しないよう、saved のときだけ成功にする。
      return action.outcome.status === "saved"
        ? { status: "saved", saved: action.outcome, message: null }
        : { status: "canceled", saved: null, message: null };
    case "書き出しキャンセル":
      return { status: "canceled", saved: null, message: null };
    case "書き出し失敗":
      return { status: "error", saved: null, message: action.message };
  }
}

/** 書き出し中か(ボタンを無効化する)。 */
export function isCloudMigrationBusy(state: CloudMigrationState): boolean {
  return state.status === "exporting";
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** ファイルの大きさの表示(1024 区切り。B は整数、それ以外は小数 1 桁)。 */
export function formatFileSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 丸めると 1024.0 になる境界(例: 1048575 バイト)は次の単位に繰り上げる。
  if (unit > 0 && unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** 完了時の表示文(件数・ファイルの大きさ・保存先)。 */
export function buildCloudMigrationSummaryText(saved: CloudMigrationSaved): string {
  return (
    `分析 ${saved.analysisCount.toLocaleString("en-US")} 件・` +
    `結果 ${saved.resultRaceCount.toLocaleString("en-US")} レース・` +
    `${formatFileSize(saved.fileBytes)}\n保存先: ${saved.filePath}`
  );
}
