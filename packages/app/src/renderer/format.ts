/**
 * 結果テーブルの表示整形(純関数)。
 *
 * 確率のパーセント表示・オッズ/EVの桁揃え・欠損のダッシュ化・EVプラス行の判定を
 * 見た目(JSX)から切り離して純関数化する。表示規則をここに集約し、単体テストで固定する。
 */

import type { AnalysisRow } from "../shared/analysis-types.js";

/** 0〜1の確率を小数第1位までのパーセント文字列にする(例: 0.423 → "42.3%")。 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 複勝オッズ下限を小数第1位まで表示する。欠損(null)は "-"。 */
export function formatOdds(oddsMin: number | null): string {
  return oddsMin === null ? "-" : oddsMin.toFixed(1);
}

/** 期待値を小数第2位まで表示する。欠損(null)は "-"。 */
export function formatEv(ev: number | null): string {
  return ev === null ? "-" : ev.toFixed(2);
}

/** LLM根拠を表示する。無い(null)場合は "-"。 */
export function formatReason(reason: string | null): string {
  return reason === null ? "-" : reason;
}

/** EVプラス行(ハイライト対象)かどうか。 */
export function isHighlightRow(row: AnalysisRow): boolean {
  return row.isPositive;
}
