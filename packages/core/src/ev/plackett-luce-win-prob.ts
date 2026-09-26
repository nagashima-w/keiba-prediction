/**
 * plackett-luce-win-prob — θから1着確率を導出する純関数(Issue #77・#20-A)。
 *
 * Plackett-Luce では上位1集合(k=1)の周辺確率が F_i(θ) = θ_i / Σθ で閉じるため、
 * これがそのまま「1着確率」になる(#23 の着手前ゲートが要求した「1着確率と3着内率を
 * 同一のθから導出する」の直接的な実装)。
 *
 * ## 既知の制約(θに2個以上のInfinity=固定馬が含まれる場合)
 * `fitPlackettLuceStrengths` は placeCount>=2 の入力に対して、複数の馬を「上位k枠に厳密に固定
 * (θ=+Infinity)」として返すことがある(degenerateFixedCount>=2)。この固定は「上位k集合に
 * 含まれることが確実」という情報のみを表し、固定された馬同士の相対的な強さ(誰が1着に近いか)は
 * 縮約の過程で失われている。そのため、2個以上のInfinityを含むθをこの関数にそのまま渡すと、
 * 1着確率の相対配分を一意に決定できない(数学的に不定)。この関数はその場合に例外を投げる
 * (NaN等の「もっともらしいが誤った値」を黙って返さない)。この制約は#20-Aでは解消しない
 * (#20-Bで検討)。
 */

/**
 * θ(潜在強度)から1着確率を導出する。Σ winProb = 1、winProb_i ∝ θ_i。
 * @throws θに2個以上のInfinityが含まれる場合、またはθの合計が非有限・0以下の場合
 */
export function winProbabilitiesFromStrengths(theta: readonly number[]): number[] {
  const infinityIndices = theta
    .map((t, i) => ({ t, i }))
    .filter((e) => e.t === Number.POSITIVE_INFINITY);

  if (infinityIndices.length >= 2) {
    throw new Error(
      "winProbabilitiesFromStrengths: θに2個以上のInfinity(上位k枠固定)が含まれるため、" +
        "1着確率の相対配分が一意に定まりません(既知の制約。JSDoc参照。#20-Bで解消を検討)",
    );
  }
  if (infinityIndices.length === 1) {
    return theta.map((t) => (t === Number.POSITIVE_INFINITY ? 1 : 0));
  }

  const total = theta.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `winProbabilitiesFromStrengths: θの合計が不正です(合計=${total})。` +
        "全馬θ=0、または非有限値の混入が疑われます",
    );
  }
  return theta.map((t) => t / total);
}
