/**
 * calibration-bins — 確率帯(キャリブレーション帯)の定義を1箇所に集約する(#41「#35-1b」)。
 *
 * 検証画面のキャリブレーション表(`verify.ts`)と、確率の質の Murphy 分解
 * (`probability-quality-metrics.ts`)は**同じ帯**で集計する必要がある。もともと `verify.ts` の
 * private 関数だった `binIndexFor` を、`verify.ts`(依存が重い大きなファイル)を import せずに
 * 共有できるよう、依存ゼロの小さな純関数モジュールへ切り出した。**挙動は不変**
 * (`verify.ts` は本ファイルから import するだけ。既存の verify テストが無改変で緑であること、
 * および `calibration-bins.test.ts` の境界テーブルがその保証)。
 */

/** 既定の帯数。検証画面の既定(`DEFAULT_VERIFY_CONFIG.calibrationBins`)と同じ。 */
export const DEFAULT_CALIBRATION_BIN_COUNT = 10;

/**
 * 推定確率を確率帯インデックスに写す。帯は下限を含み上限を含まない。
 * 確率1.0(および>1のはみ出し)は最終帯に丸める。負値は先頭帯に丸める。
 */
export function binIndexFor(prob: number, binCount: number): number {
  const raw = Math.floor(prob * binCount);
  return Math.min(Math.max(raw, 0), binCount - 1);
}

/** 帯の境界(下限を含み、上限を含まない。最終帯のみ上限1.0を含む)。 */
export function calibrationBinBounds(
  index: number,
  binCount: number,
): { readonly lowerBound: number; readonly upperBound: number } {
  return { lowerBound: index / binCount, upperBound: (index + 1) / binCount };
}
