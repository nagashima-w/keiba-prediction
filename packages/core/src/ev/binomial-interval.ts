/**
 * binomial-interval — 件数から求める 2 項比率の信頼区間(Wilson スコア区間・95%)と、予測値との照合(Issue #254)。
 *
 * 検証画面の「予測と結果の対応表」(キャリブレーション)の各帯に、**実際の率の信頼区間**を付けるための純関数。
 * 「N 件中 k 件が複勝圏に来た」から 2 項比率の区間を求め、帯内の平均予測値がその区間に入るかを見る。
 * 区間の幅が、その帯の件数が十分かどうかを表す。
 *
 * **依存を持たない純モジュール**(ブラウザのクライアントも `@keiba/core/ev/binomial-interval` として直接 import する。
 * `node:`・`node_modules`・バレルを引き込まない。`packages/core/test/ev/native-free-modules.test.ts` が閉包を固定する)。
 *
 * ## なぜ Wilson か
 *  - 件数が少なくても、率が 0 や 1 に張り付いても、区間が [0,1] からはみ出さず、幅 0 に潰れない
 *    (Wald 区間は 0 件・全件で幅 0 になり、小さい n で [0,1] の外へ出る)。
 *  - 閉形式で、依存なし・テーブル駆動でテストしやすい(Clopper–Pearson は保守的で少し広く、ベータ分位点の反復計算が要る)。
 *
 * ## 限界(画面の説明文にも書く)
 *  - 2 項分布は各件が**独立**であることを仮定する。実際は、同じレースの馬の複勝は互いに独立でなく(3 着内は丁度 3 頭)、同じ馬が複数のレースに出ることもある。区間は目安。
 *  - 20 帯を同時に 95% で見るので、予測が正しくても 1 帯程度は偶然に区間を外れる。
 */

/** 95% 信頼区間の両側分位点(標準正規分布)。信頼水準は 95% 固定で、設定にしない。 */
export const CONFIDENCE_Z_95 = 1.959964;

/** 判定を出すのに要る最小の件数。これ未満は区間だけを出し、判定は「件数不足」とする(目安の定数)。 */
export const MIN_COUNT_FOR_JUDGMENT = 30;

/** 2 項比率の信頼区間(0〜1 の割合)。 */
export interface ProportionInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * Wilson スコア区間(95%)。`trials === 0` は区間なし(null)。
 * 引数は 0 以上の整数で、`successes <= trials`。満たさなければ例外(呼び出し側の取り違えを黙って通さない)。
 */
export function wilsonInterval(successes: number, trials: number): ProportionInterval | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials) || successes < 0 || trials < 0 || successes > trials) {
    throw new RangeError(`wilsonInterval: 不正な件数です(successes=${successes}, trials=${trials})`);
  }
  if (trials === 0) {
    return null;
  }
  const z2 = CONFIDENCE_Z_95 * CONFIDENCE_Z_95;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = (CONFIDENCE_Z_95 * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // 浮動小数の丸めで 0 未満・1 超になる(例: 全件で上限が 1.0000000000000002)のを抑える。
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/**
 * 予測値と区間の照合の判定。
 *  - `consistent`: 予測値が区間の中(境界を含む)。
 *  - `overpredicted`: 予測値が区間の上限より高い(実際より高く予測した=過信)。
 *  - `underpredicted`: 予測値が区間の下限より低い(過小評価)。
 *  - `insufficient`: 件数が {@link MIN_COUNT_FOR_JUDGMENT} 未満(区間は出すが判定しない)。
 */
export type CalibrationVerdict = "consistent" | "overpredicted" | "underpredicted" | "insufficient";

export interface CalibrationJudgment {
  /** 実際の率の信頼区間。件数 0 は null。 */
  readonly interval: ProportionInterval | null;
  /** 判定。件数 0・平均予測値なし(null)は null。 */
  readonly verdict: CalibrationVerdict | null;
}

/**
 * 1 帯の件数から区間を求め、帯内の平均予測値がその区間に入るかを判定する。
 * @param predicted 帯に入った予測件数
 * @param placed そのうち複勝圏に来た件数
 * @param meanPredictedProb 帯内の予測値の平均(件数 0 は null)
 */
export function judgeCalibration(input: {
  readonly predicted: number;
  readonly placed: number;
  readonly meanPredictedProb: number | null;
}): CalibrationJudgment {
  const interval = wilsonInterval(input.placed, input.predicted);
  if (interval === null) {
    return { interval: null, verdict: null };
  }
  if (input.predicted < MIN_COUNT_FOR_JUDGMENT) {
    return { interval, verdict: "insufficient" };
  }
  const predicted = input.meanPredictedProb;
  if (predicted === null) {
    return { interval, verdict: null };
  }
  if (predicted > interval.upper) {
    return { interval, verdict: "overpredicted" };
  }
  if (predicted < interval.lower) {
    return { interval, verdict: "underpredicted" };
  }
  return { interval, verdict: "consistent" };
}
