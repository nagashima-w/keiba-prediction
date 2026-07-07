/**
 * scorer(数値スコアリング)の調整可能な設定。
 *
 * 仕様「各バイアスの重みはconfigで調整可能にし、verifyの結果を見ながらチューニング」に対応する。
 * バイアス補正はすべて「複勝率の差分(対象条件の複勝率 − 全体複勝率)× 重み係数」を基本単位とする。
 * 差分は概ね ±0.0〜±0.3 の範囲(複勝率の差)になるため、重み1.0はその差分をそのまま事前確率へ
 * 反映する意味になる。バイアス項目が多く過剰補正のリスクがあるため(仕様「注意事項」)、
 * デフォルトは控えめに各1.0を基準とし、verifyの寄与度ログを見ながら下げる方向で調整する想定。
 *
 * 申し送り(レビュー指摘の記録):
 * - デフォルト重み1.0のまま5バイアス(道悪・競馬場・季節・枠順・夏負け)を単純加算すると、
 *   理論上は補正の合計が ±1.5 程度まで振れうる。prior(事前確率)への結合を実装する段では、
 *   合算後に [0,1] へのクランプまたは正規化を必須とすること。
 * - 各バイアスの基準複勝率(全体複勝率)は、比較対象の部分集合(道悪走・当該枠走など)自身を
 *   含むため、差分は保守的に縮む設計(部分集合が全体に寄与するぶん過小評価気味)。加えて季節と
 *   枠など相関しうる特徴を別項目として加算するため二重計上のリスクがある。これらは verify の
 *   寄与度ログで監視し、必要なら重みで調整する。
 */

/** 夏負けフラグの設定。 */
export interface SummerFatigueConfig {
  /**
   * 夏開催の平均馬体重変化がこの値以下(kg)なら夏負けと判定する。
   * 仕様「夏開催で平均-6kg以上減」→ 平均差分が -6 以下(-6ちょうどを含む)。
   */
  readonly avgWeightDiffThreshold: number;
  /**
   * 夏負けと判定したときのマイナス補正の大きさ(正の値)。実際の補正は -penalty × 重み。
   * 複勝率差分と同じスケール(控えめに 0.05 を既定)。
   */
  readonly penalty: number;
}

/** 競馬場適性(代替評価)の設定。 */
export interface VenueBiasConfig {
  /**
   * 代替評価で類似コースとみなす類似度の下限(0〜1)。これ未満の場は代替評価の母数に含めない。
   */
  readonly similarityThreshold: number;
  /**
   * 代替評価の減衰係数(0〜1)。当該場の直接実績より不確実なため、補正をこの係数で割り引く。
   */
  readonly similarityDecay: number;
}

/** 各バイアスの重み係数。差分ベース補正に乗算する。 */
export interface BiasWeights {
  /** 馬場状態適性(道悪)。 */
  readonly trackCondition: number;
  /** 競馬場適性。 */
  readonly venue: number;
  /** 季節適性。 */
  readonly season: number;
  /** 枠順適性(馬個別)。 */
  readonly frame: number;
  /** 夏負けフラグ。 */
  readonly summerFatigue: number;
}

/** scorer 全体の調整可能設定。 */
export interface ScorerConfig {
  /**
   * バイアス補正を適用する最小サンプル数(対象条件の集計対象走数)。
   * 仕様の必須境界「サンプル2走未満は補正なし」に対応し、既定は2。
   */
  readonly minSampleForBias: number;
  /** 各バイアスの重み係数。 */
  readonly weights: BiasWeights;
  /** 夏負けフラグの設定。 */
  readonly summerFatigue: SummerFatigueConfig;
  /** 競馬場適性(代替評価)の設定。 */
  readonly venue: VenueBiasConfig;
}

/**
 * 既定の scorer 設定。
 * 過剰補正を避けるため重みは控えめに各1.0を基準とし、代替評価は0.5に減衰する。
 * これらの値はすべてチューニング対象(verifyの寄与度ログを見て調整する)。
 */
export const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  minSampleForBias: 2,
  weights: {
    trackCondition: 1,
    venue: 1,
    season: 1,
    frame: 1,
    summerFatigue: 1,
  },
  summerFatigue: {
    avgWeightDiffThreshold: -6,
    penalty: 0.05,
  },
  venue: {
    similarityThreshold: 0.5,
    similarityDecay: 0.5,
  },
};
