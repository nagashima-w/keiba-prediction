/**
 * calibration-bins — 確率帯(キャリブレーション帯)の定義を1箇所に集約する(#41「#35-1b」)。
 *
 * 検証画面のキャリブレーション表(`verify.ts`)と、確率の質の Murphy 分解
 * (`probability-quality-metrics.ts`)は、**帯の切り方**(`binIndexFor`・`calibrationBinBounds`)を
 * 共有する。同じ帯数を渡せば同じ帯になる(この不変条件は `brier-decomposition.test.ts` の突合が固定する)。
 * もともと `verify.ts` の private 関数だった `binIndexFor` を、`verify.ts`(依存が重い大きな
 * ファイル)を import せずに共有できるよう、依存ゼロの小さな純関数モジュールへ切り出した(#41)。
 *
 * **既定の帯数は用途ごとに分かれている**(#37)。2つの既定は別の定数で、連動しない:
 * - 検証画面: `DEFAULT_VERIFY_BIN_COUNT`(20 = 5% 刻み。表示の解像度)
 * - 確率の質の測定: `DEFAULT_QUALITY_BIN_COUNT`(10 = 10% 刻み)
 */

/**
 * 検証画面のキャリブレーション表の既定の帯数(`DEFAULT_VERIFY_CONFIG.calibrationBins`)。
 * 20 = 5% 刻み(0-5% … 95-100%)。Issue #37 で 10 から変更した(表示の解像度を上げる)。
 */
export const DEFAULT_VERIFY_BIN_COUNT = 20;

/**
 * 確率の質の測定(Murphy 分解・並べ替えによる resolution の参照値)の既定の帯数。
 * 10 = 10% 刻み。コミット済みの #41・#156 の測定記録(`docs/investigations/`)を、帯数を渡さない
 * 既定の呼び出しで再現できるよう **10 のまま据え置く**(検証画面が 20 になっても連動させない)。
 * 検証画面と同じ帯で集計したいときは、呼び出し側が帯数を明示して渡す。
 */
export const DEFAULT_QUALITY_BIN_COUNT = 10;

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
