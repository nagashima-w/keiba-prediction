/**
 * #258 第1段の前後比較に使う、頭数正規化の「旧」と「参考」の実装。
 *
 * - **採用した方式は `packages/core/src/scorer/prior.ts` の `normalizeFieldPriors`(ロジットシフト)**で、ここには
 *   置かない(二重管理を避けるため、比較スクリプトはそれを直接 import する)。
 * - `legacyMultiplicativeNormalize` は、**#258 より前の `computeFieldPriors` の正規化を凍結したコピー**
 *   (比較の「前」を再現するためだけにある。production からは呼ばれない)。凍結が正しいことは
 *   `scripts/test/prior-normalization-258.test.ts` が、旧テストの固定値で確かめている。
 * - `additiveShiftNormalize` は、ユーザーが検討して採用しなかった「確率の加算シフト」(参考)。
 *   Σ clamp(raw_i + c, minPrior, maxPrior) = 目標 となる c を、折れ点から厳密に解く。
 */

import type { PriorConfig } from "../../packages/core/src/scorer/config.js";

/** 旧の許容比率(#258 で `PriorConfig.normalizeTolerance` ごと撤去した値)。 */
export const LEGACY_NORMALIZE_TOLERANCE = 0.1;

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * 【凍結】#258 前の `computeFieldPriors` の正規化。
 * raw を [minPrior, maxPrior] にクランプ → その合計が目標から ±10% を超えたときだけ全馬に
 * `目標 / 合計` を掛ける → 再クランプ。
 */
export function legacyMultiplicativeNormalize(
  rawPriors: readonly number[],
  config: PriorConfig,
): number[] {
  if (rawPriors.length === 0) return [];
  const { minPrior, maxPrior, targetPlaceCount } = config;
  const target = Math.min(targetPlaceCount, rawPriors.length);
  const clamped = rawPriors.map((v) => clamp(v, minPrior, maxPrior));
  const sumClamped = clamped.reduce((s, v) => s + v, 0);
  let scale = 1;
  if (sumClamped > 0 && Math.abs(sumClamped - target) / target > LEGACY_NORMALIZE_TOLERANCE) {
    scale = target / sumClamped;
  }
  return clamped.map((v) => clamp(v * scale, minPrior, maxPrior));
}

/**
 * 【参考】確率の加算シフト: Σ clamp(raw_i + c) = 目標 となる共通項 c を求め、clamp(raw_i + c) を返す。
 * f(c) は連続・単調非減少の区分線形なので、折れ点(minPrior−raw_i、maxPrior−raw_i)を昇順に並べ、
 * 目標を挟む区間で線形補間すれば厳密に解ける(反復なし)。実現不能(目標 ≥ 頭数×maxPrior など)は飽和。
 */
export function additiveShiftNormalize(
  rawPriors: readonly number[],
  config: PriorConfig,
): number[] {
  const n = rawPriors.length;
  if (n === 0) return [];
  const { minPrior, maxPrior, targetPlaceCount } = config;
  const target = Math.min(targetPlaceCount, n);
  if (target >= n * maxPrior) return new Array<number>(n).fill(maxPrior);
  if (target <= n * minPrior) return new Array<number>(n).fill(minPrior);

  const f = (c: number): number =>
    rawPriors.reduce((s, v) => s + clamp(v + c, minPrior, maxPrior), 0);
  const breakpoints = rawPriors
    .flatMap((v) => [minPrior - v, maxPrior - v])
    .sort((a, b) => a - b);
  let lo = breakpoints[0]!;
  let hi = breakpoints[breakpoints.length - 1]!;
  for (let i = 0; i < breakpoints.length - 1; i++) {
    if (f(breakpoints[i + 1]!) >= target) {
      lo = breakpoints[i]!;
      hi = breakpoints[i + 1]!;
      break;
    }
  }
  const fLo = f(lo);
  const fHi = f(hi);
  const c = fHi === fLo ? lo : lo + ((target - fLo) * (hi - lo)) / (fHi - fLo);
  return rawPriors.map((v) => clamp(v + c, minPrior, maxPrior));
}
