/**
 * 検証画面の表示整形(純関数)。
 *
 * 回収率・複勝率のパーセント表示、金額の桁区切り、キャリブレーション帯グラフの幅、
 * 実配当/近似の内訳注記を JSX から切り離してここに集約し、単体テストで固定する。
 */

import type {
  AnalysisHistoryItem,
  CalibrationBinView,
  VerifyBetView,
} from "../shared/analysis-types.js";

/** 0〜1の割合を小数第1位までのパーセント文字列にする。null は "-"。 */
export function formatRate(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

/** 金額を3桁区切りの円表記にする(例: 1060 → "1,060円")。 */
export function formatYen(amount: number): string {
  return `${amount.toLocaleString("en-US")}円`;
}

/**
 * キャリブレーション帯グラフの幅(%)。複勝率(0〜1)を 0〜100 に写す。
 * 予測0件(actualPlaceRate=null)は幅0。
 */
export function calibrationBarWidthPercent(rate: number | null): number {
  return rate === null ? 0 : rate * 100;
}

/** 確率帯ラベル(例: 下限0.4/上限0.5 → "40〜50%")。 */
export function formatBinRange(bin: CalibrationBinView): string {
  const lower = Math.round(bin.lowerBound * 100);
  const upper = Math.round(bin.upperBound * 100);
  return `${lower}〜${upper}%`;
}

/** 実配当/近似の内訳注記(例: "実配当 3件 / 近似 1件")。 */
export function formatPayoutBreakdown(bet: VerifyBetView): string {
  return `実配当 ${bet.actualPayoutCount}件 / 近似 ${bet.approximatePayoutCount}件`;
}

/**
 * 取込ボタンを出す(再取込が必要)か。
 * 結果が未取込、または着順は取れているが複勝払戻が未取込(確定直前など)なら true。
 * 後者は実配当への更新導線を残すため、取込済み表示でもボタンを出し続ける。
 */
export function needsImport(item: AnalysisHistoryItem): boolean {
  return !item.hasResult || !item.hasPayout;
}

/**
 * 取込ボタンの文言。未取込は「結果を取り込む」、着順のみ取込(払戻待ち)は「再取込(払戻待ち)」。
 */
export function importButtonLabel(item: AnalysisHistoryItem): string {
  return item.hasResult ? "再取込(払戻待ち)" : "結果を取り込む";
}
