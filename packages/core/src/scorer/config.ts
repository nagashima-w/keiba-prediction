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

import type { CourseType } from "../scraper/types.js";

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

/** 輸送・滞在バイアスの設定。 */
export interface TransportBiasConfig {
  /**
   * 滞在競馬(札幌・函館)で「輸送弱」フラグの馬に与えるプラス補正の大きさ(正の値)。
   * 実際の補正は +stayBonus × 重み。複勝率差分と同じスケール(控えめに 0.05 を既定)。
   * 仕様「輸送に弱い馬は滞在競馬でプラス補正」に対応する。
   */
  readonly stayBonus: number;
  /**
   * 「輸送弱」判定の馬体重減の閾値(kg、負値)。輸送を伴う過去走でこの値以下(=より大きい減)の
   * 馬体重減をカウントする。仕様「-10kg以上の馬体重減」→ diff ≤ -10(=-10ちょうどを含む)。
   */
  readonly weakWeightDropThreshold: number;
  /**
   * 「輸送弱」と判定するのに必要な大幅減の最小回数。仕様「複数回(2回以上)」→ 既定2。
   */
  readonly weakDropMinCount: number;
}

/** ローテーション適性の設定。 */
export interface RotationBiasConfig {
  /**
   * タイプ判定で「明確に低い」とみなす複勝率差の閾値。
   * 叩き良化型(1走目が2〜3走目より明確に低い)・使い込み下降型(4走目以降がピークより明確に低い)の
   * 判定に使う。設計判断: バケット母数が小さく(数走)ノイズが乗りやすいため、偶然の1走差を吸収できるよう
   * 既定0.1(複勝率差10ポイント)に設定。verifyの寄与度ログを見て調整する。
   */
  readonly clearlyLowerThreshold: number;
  /**
   * 休み明け実績が2走未満で型判定できない(不明)とき、今回が休み明けの場合に適用する
   * 弱いマイナス補正の大きさ(正の値)。実際の補正は -unknownRestPenalty × 重み。
   * 仕様「休み明け実績2走未満は不明として弱いマイナス補正のみ(休み明けは平均的に割引が妥当)」。
   * 控えめに 0.05 を既定とする(チューニング対象)。
   */
  readonly unknownRestPenalty: number;
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

/** 基礎スコア6項目の重み係数。各項目の補正値に乗算する。 */
export interface BaseScoreWeights {
  /** 近走着順(重み減衰付き)。 */
  readonly recentForm: number;
  /** 上がり3F水準(代替評価)。 */
  readonly last3f: number;
  /** コース・距離適性(同条件での複勝率)。 */
  readonly courseDistance: number;
  /** 騎手の当該コース複勝率。 */
  readonly jockey: number;
  /** 斤量変化・馬体重増減。 */
  readonly weightChange: number;
  /** コースレベル枠順バイアス(定数テーブル・仕様の枠2層のうち①)。 */
  readonly courseFrameBias: number;
}

/**
 * 基礎スコアの設定。
 *
 * 近走着順・コース距離適性・騎手複勝率などの「複勝率系」項目は、対象複勝率と中立基準
 * (neutralPlaceRate)の差分に重みを掛けて補正を作る(バイアス補正と同じ差分パターン)。
 * 中立基準はリーグ平均的な複勝率の目安であり、頭数正規化(prior.ts)で系統的な偏りは吸収するため
 * 概算で足りる。すべてチューニング対象(verifyの寄与度ログを見て調整する)。
 *
 * 既定重みの較正根拠(過剰補正・クランプ飽和の防止。仕様L135):
 * - recentForm・courseDistance・jockey はいずれも「馬の総合能力」を別スライスで測る相関の強い
 *   推定であり、中立0.33に対し重み1で単純加算すると同じ能力を多重計上して prior が容易に飽和する。
 *   そこでこれらの既定重みは 0.15〜0.2 と控えめにし、合算しても中立確率スケール(頭数16なら約0.19)
 *   に対して過大にならないようにする。強馬でも prior が天井(0.95)に張り付かず、中堅馬が床に
 *   張り付かない分布(analyzerの±10%補正が意味を持つ範囲)を狙う。
 */
export interface BaseScoreConfig {
  /** 各項目の重み係数。 */
  readonly weights: BaseScoreWeights;
  /**
   * 複勝率系項目(近走着順・コース距離・騎手)の中立基準となる複勝率。
   * 平均的な馬の複勝率の目安(既定0.33)。差分 = 対象複勝率 − この値。
   */
  readonly neutralPlaceRate: number;
  /**
   * 近走着順の幾何減衰率(0<r≤1)。直近走の重み1、1走ごとに r 倍に減衰する(既定0.8)。
   */
  readonly recentFormDecay: number;
  /** 近走着順の評価に使う直近走数の上限(既定6)。これより古い走は使わない。 */
  readonly recentFormMaxRuns: number;
  /**
   * 圏外着の着順スコアの線形減衰ステップ。複勝圏内(3着以内)は満点1.0、圏外は
   * 4着から1着悪化するごとに outOfPlaceStep だけ下げ、床は0(既定0.1 → 13着で0)。
   */
  readonly outOfPlaceStep: number;
  /**
   * 上がり3Fを「速い」とみなす閾値(秒)をコース種別ごとに持つ。各過去走のコース種別に応じた
   * 閾値で判定することで、ダート走を芝基準で不当に「遅い」と扱う系統オフセットを避ける。
   * 既定は芝34.9・ダ36.5・障38.0(概算・チューニング対象)。コース種別が取れない走は芝閾値で代替する。
   */
  readonly fastLast3fThresholdSec: Record<CourseType, number>;
  /**
   * 速い上がり率の中立基準(既定0.15)。差分 = 速い上がり率 − この値。
   * 上がりタイムはコース・距離・ペースに強く依存するため中立基準は低めに置く(重みも控えめ)。
   */
  readonly neutralFastLast3fRate: number;
  /** コース・距離適性で同距離帯とみなす許容差(m、片側)。既定200(±200m)。 */
  readonly distanceBandMeters: number;
  /** 斤量1kgあたりの補正スケール(増でマイナス方向)。既定0.01。 */
  readonly kinryoScale: number;
  /** 斤量変化の絶対値の上限(kg)。極端な値を抑える。既定3。 */
  readonly kinryoCapKg: number;
  /** 馬体重減1kgあたりの補正スケール(減でマイナス方向)。既定0.004。 */
  readonly bodyWeightDropScale: number;
  /** 馬体重減補正の下限(kg、負値)。これより大きい減は同じ扱いにする。既定-20。 */
  readonly bodyWeightDropCapKg: number;
}

/** prior(事前複勝確率)合成の設定。 */
export interface PriorConfig {
  /** prior の下限(既定0.02)。 */
  readonly minPrior: number;
  /** prior の上限(既定0.95)。 */
  readonly maxPrior: number;
  /**
   * 頭数レベル正規化の目標となる「1レースの複勝圏内数」(既定3)。
   * 実際の目標は min(この値, 頭数)。全馬のraw合計をこの目標に寄せる。
   */
  readonly targetPlaceCount: number;
  /**
   * 頭数正規化を発動する逸脱の許容比率(既定0.1)。
   * |raw合計 − 目標| / 目標 がこの値を超えたときだけ正規化する(仕様「大きく逸脱する場合は正規化」)。
   */
  readonly normalizeTolerance: number;
  /**
   * 環境・状態バイアス7項目(馬場・競馬場・季節・夏負け・枠順個別・輸送滞在・ローテ)の補正合計に
   * 掛ける減衰係数(既定0.3)。各バイアスは小さいバケットの複勝率差でノイズが乗りやすく、重み1のまま
   * 確率空間へ単純加算すると過剰補正になりやすい(例: 休み明けカーブから -0.2 超の補正)。仕様L135の
   * 過剰補正防止として、prior合成でバイアス寄与を一律に減衰する。個々のバイアス関数(および単体テスト)は
   * この係数の影響を受けず、prior.ts が合成時にのみ適用する(バイアス重みへ乗算する形)。チューニング対象。
   */
  readonly biasCorrectionScale: number;
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
  /** 輸送・滞在バイアス。 */
  readonly transport: number;
  /** ローテーション適性。 */
  readonly rotation: number;
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
  /** 基礎スコアの設定。 */
  readonly baseScore: BaseScoreConfig;
  /** prior(事前複勝確率)合成の設定。 */
  readonly prior: PriorConfig;
  /** 夏負けフラグの設定。 */
  readonly summerFatigue: SummerFatigueConfig;
  /** 競馬場適性(代替評価)の設定。 */
  readonly venue: VenueBiasConfig;
  /** 輸送・滞在バイアスの設定。 */
  readonly transport: TransportBiasConfig;
  /** ローテーション適性の設定。 */
  readonly rotation: RotationBiasConfig;
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
    transport: 1,
    rotation: 1,
  },
  baseScore: {
    weights: {
      // recentForm/courseDistance/jockey は相関の強い総合能力推定のため多重計上を避けて控えめに。
      recentForm: 0.2,
      // 上がり3Fはコース・距離・ペース依存が強い代替評価のため最も控えめに。
      last3f: 0.1,
      courseDistance: 0.15,
      jockey: 0.15,
      // 斤量・馬体重・コース枠順は補正値自体が小さい(±0.05以内)ため重み1でよい。
      weightChange: 1,
      courseFrameBias: 1,
    },
    neutralPlaceRate: 0.33,
    recentFormDecay: 0.8,
    recentFormMaxRuns: 6,
    outOfPlaceStep: 0.1,
    fastLast3fThresholdSec: { 芝: 34.9, ダ: 36.5, 障: 38.0 },
    neutralFastLast3fRate: 0.15,
    distanceBandMeters: 200,
    kinryoScale: 0.01,
    kinryoCapKg: 3,
    bodyWeightDropScale: 0.004,
    bodyWeightDropCapKg: -20,
  },
  prior: {
    minPrior: 0.02,
    maxPrior: 0.95,
    targetPlaceCount: 3,
    normalizeTolerance: 0.1,
    biasCorrectionScale: 0.3,
  },
  summerFatigue: {
    avgWeightDiffThreshold: -6,
    penalty: 0.05,
  },
  venue: {
    similarityThreshold: 0.5,
    similarityDecay: 0.5,
  },
  transport: {
    stayBonus: 0.05,
    weakWeightDropThreshold: -10,
    weakDropMinCount: 2,
  },
  rotation: {
    clearlyLowerThreshold: 0.1,
    unknownRestPenalty: 0.05,
  },
};
