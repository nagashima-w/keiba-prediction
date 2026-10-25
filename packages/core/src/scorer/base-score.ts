/**
 * 基礎スコア(数値スコアリングの決定論的部分)。仕様「2. scorer > 基礎スコア」。
 *
 * 仕様の基礎スコア6項目を、外部状態に依存しない純関数として計算する。各項目は
 * 環境・状態バイアス群(bias-*.ts)と同じ寄与度ログ形式(biasName/applied/reason/
 * weight/correction と、複勝率系項目では sampleCount/targetRate/overallRate)を返し、
 * prior合成(prior.ts)がそれらを単純加算する。重みはすべて config で調整可能
 * (仕様「各バイアスの重みはconfigで調整可能」)。
 *
 * 設計判断(仕様が設計者に委ねている点):
 * - (1)近走着順: 「複勝圏内か(isPlaced)」を基礎に、圏外は着順悪化で線形減衰する着順スコアを
 *   併用する(近い着順の惜敗も評価に残す)。直近ほど重い幾何減衰でスコアを加重平均し、
 *   中立基準(neutralPlaceRate)との差分×重みを補正とする。
 * - (2)上がり3F: 戦績には同一レース内の上がり順位がないため、自身の上がりタイムが「速い」水準
 *   (fastLast3fThresholdSec 以下)を使えた率で代替する。上がりはコース・距離・ペース依存が強く
 *   粗い代替のため既定重みは控えめ。将来、同一レースの上がり順位が取れれば相対順位評価に差し替える。
 * - (4)騎手の複勝率: 騎手の成績(前年+当年の全体。Issue #226)を optional 入力にする。
 *   与えられれば複勝率で補正し、なければ「データなし」を寄与度ログに残して補正なし。
 *   競馬場・距離ごとの成績は netkeiba のプレミアム限定のため、当該コースの複勝率ではない。
 */

import type { DerivedRaceFeature, FrameZone } from "./derive-features.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import type { CourseType } from "../scraper/types.js";
import { aggregatePlaceRate } from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";
import { courseFrameBiasValue } from "./frame-bias-table.js";

/** 複勝圏(3着以内)とみなす上限順位(derive-features と同じ定義)。 */
const PLACE_MAX_RANK = 3;

/**
 * 基礎スコア1項目分の寄与度(ログ用内訳付き)。
 *
 * 複勝率系項目(近走着順・上がり3F・コース距離・騎手)では sampleCount/targetRate/overallRate を
 * 埋め、targetRate と overallRate の差 × weight が correction になる。
 * 斤量・コース枠順バイアスは複勝率差分ではないため、これらの内訳は省略(undefined)する。
 */
export interface BaseScoreContribution {
  /** 項目名(ログ識別用)。 */
  readonly biasName: string;
  /** 補正を適用したか(データ不足・非発動なら false)。 */
  readonly applied: boolean;
  /** 適用/非適用の理由。 */
  readonly reason: string;
  /** 適用した重み係数。 */
  readonly weight: number;
  /** 最終的な補正値(非発動なら0)。 */
  readonly correction: number;
  /** 対象サンプル数(複勝率系項目のみ)。 */
  readonly sampleCount?: number;
  /** 対象条件の指標値(複勝率など。複勝率系項目のみ)。 */
  readonly targetRate?: number | null;
  /** 比較基準値(中立基準など。複勝率系項目のみ)。 */
  readonly overallRate?: number | null;
}

/** min ≤ x ≤ max にクランプする。 */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * 1走の着順スコア(0〜1)。複勝圏内(3着以内)は満点1.0、圏外は4着から着順悪化ごとに
 * outOfPlaceStep だけ線形に下げ、床は0。
 */
function finishScore(value: number, outOfPlaceStep: number): number {
  if (value <= PLACE_MAX_RANK) {
    return 1;
  }
  return Math.max(0, 1 - (value - PLACE_MAX_RANK) * outOfPlaceStep);
}

// ---------------------------------------------------------------------------
// (1) 近走着順(重み減衰付き)
// ---------------------------------------------------------------------------

const RECENT_FORM_NAME = "近走着順";

/**
 * 近走着順の補正を計算する。直近ほど重い幾何減衰で着順スコアを加重平均し、
 * 中立基準(neutralPlaceRate)との差分 × 重みを補正とする。
 * 対象外(中止・除外・非数値着順)の走はスキップし、直近 recentFormMaxRuns 走まで使う。
 */
export function computeRecentFormScore(
  features: readonly DerivedRaceFeature[],
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreContribution {
  const { recentFormDecay, recentFormMaxRuns, outOfPlaceStep, neutralPlaceRate } =
    config.baseScore;
  const weight = config.baseScore.weights.recentForm;

  // 新しい順に、対象外を除いた数値着順を最大 recentFormMaxRuns 走まで集める。
  const values: number[] = [];
  for (const f of features) {
    const fin = f.result.finishPosition;
    if (fin === null || fin.kind !== "順位") {
      continue; // 中止・除外・着順欠損はスキップ。
    }
    values.push(fin.value);
    if (values.length >= recentFormMaxRuns) {
      break;
    }
  }

  if (values.length === 0) {
    return {
      biasName: RECENT_FORM_NAME,
      applied: false,
      reason: "評価できる近走(数値着順)がないため補正なし",
      weight,
      correction: 0,
      sampleCount: 0,
      targetRate: null,
      overallRate: neutralPlaceRate,
    };
  }

  let sumWeight = 0;
  let sumWeighted = 0;
  for (let k = 0; k < values.length; k++) {
    const w = recentFormDecay ** k;
    sumWeight += w;
    sumWeighted += w * finishScore(values[k]!, outOfPlaceStep);
  }
  const weightedScore = sumWeighted / sumWeight;

  return {
    biasName: RECENT_FORM_NAME,
    applied: true,
    reason: `直近${values.length}走の重み付き着順スコアで補正`,
    weight,
    correction: (weightedScore - neutralPlaceRate) * weight,
    sampleCount: values.length,
    targetRate: weightedScore,
    overallRate: neutralPlaceRate,
  };
}

// ---------------------------------------------------------------------------
// (2) 上がり3F水準(代替評価)
// ---------------------------------------------------------------------------

const LAST3F_NAME = "上がり3F";

/**
 * 上がり3F水準の補正を計算する(代替評価)。速い上がり(そのコース種別の閾値以下)を使えた率と
 * 中立基準の差分 × 重み。上がりが取れた走が2走未満なら補正なし。閾値は各過去走のコース種別ごとに引く
 * (ダート走を芝基準で不当に遅いと扱う系統オフセットを避ける)。種別が取れない走は芝の閾値で代替する。
 */
export function computeLast3fScore(
  features: readonly DerivedRaceFeature[],
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreContribution {
  const { fastLast3fThresholdSec, neutralFastLast3fRate } = config.baseScore;
  const weight = config.baseScore.weights.last3f;

  // 上がり3Fが取れた走のみを母数とする。
  const runs = features.filter((f) => f.result.last3f !== null);
  const sampleCount = runs.length;

  if (sampleCount < config.minSampleForBias) {
    return {
      biasName: LAST3F_NAME,
      applied: false,
      reason: "上がり3F取得走が2走未満のため補正なし",
      weight,
      correction: 0,
      sampleCount,
      targetRate: null,
      overallRate: neutralFastLast3fRate,
    };
  }

  // コース種別ごとの閾値で「速い上がり」を判定する。種別が取れない走は芝の閾値で代替。
  const fast = runs.filter(
    (f) => f.result.last3f! <= fastLast3fThresholdSec[f.result.courseType ?? "芝"],
  ).length;
  const rate = fast / sampleCount;
  return {
    biasName: LAST3F_NAME,
    applied: true,
    reason: "コース種別ごとの速い上がりを使えた率で補正",
    weight,
    correction: (rate - neutralFastLast3fRate) * weight,
    sampleCount,
    targetRate: rate,
    overallRate: neutralFastLast3fRate,
  };
}

// ---------------------------------------------------------------------------
// (3) コース・距離適性
// ---------------------------------------------------------------------------

const COURSE_DISTANCE_NAME = "コース・距離適性";

/** コース・距離適性の今回条件。 */
export interface CourseDistanceInput {
  /** 今回のコース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 今回の距離(m)。 */
  readonly distance: number;
}

/**
 * コース・距離適性の補正を計算する。同コース種別かつ距離帯(±distanceBandMeters)内の
 * 過去走の複勝率と中立基準の差分 × 重み。同条件が2走未満なら補正なし。
 */
export function computeCourseDistanceScore(
  features: readonly DerivedRaceFeature[],
  today: CourseDistanceInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreContribution {
  const { distanceBandMeters, neutralPlaceRate } = config.baseScore;
  const weight = config.baseScore.weights.courseDistance;

  const inBand = features.filter(
    (f) =>
      f.result.courseType === today.courseType &&
      f.result.distance !== null &&
      Math.abs(f.result.distance - today.distance) <= distanceBandMeters,
  );
  const agg = aggregatePlaceRate(inBand.map((f) => f.placed));

  if (agg.sampleCount < config.minSampleForBias) {
    return {
      biasName: COURSE_DISTANCE_NAME,
      applied: false,
      reason: "同コース種別・距離帯の実績が2走未満のため補正なし",
      weight,
      correction: 0,
      sampleCount: agg.sampleCount,
      targetRate: agg.sampleCount === 0 ? null : agg.rate,
      overallRate: neutralPlaceRate,
    };
  }

  return {
    biasName: COURSE_DISTANCE_NAME,
    applied: true,
    reason: `${today.courseType}${today.distance}m±${distanceBandMeters}mの複勝率で補正`,
    weight,
    correction: (agg.rate - neutralPlaceRate) * weight,
    sampleCount: agg.sampleCount,
    targetRate: agg.rate,
    overallRate: neutralPlaceRate,
  };
}

// ---------------------------------------------------------------------------
// (4) 騎手の複勝率(前年+当年の全体の成績。optional入力。Issue #226)
// ---------------------------------------------------------------------------

const JOCKEY_NAME = "騎手成績";

/**
 * 騎手の成績。**全体**の成績(当該コースではない)で、集計の窓は分析日の前年+当年
 * (過去日の分析は前々年+前年。`jockey-stats.ts`)。型名の「Course」は歴史的な名前で、
 * 競馬場・距離ごとの内訳は netkeiba のプレミアム限定で取得できないため(`parse-jockey-results.ts`)、
 * 現在は渡していない(競馬場・距離ごとの成績は第2段階の Issue #256)。
 */
export interface JockeyCourseStats {
  /** 騎乗数(窓の年の合計)。 */
  readonly starts: number;
  /** うち複勝圏内(3着以内)の回数。 */
  readonly placed: number;
}

/**
 * 騎手の複勝率の補正を計算する。
 * - 入力がなければ「データなし」を寄与度ログに残して補正なし。
 * - 騎乗数が最小(`jockeyMinStarts`、既定100)未満なら補正なし(複勝率は参考値として残す)。
 * - それ以外は `(複勝率 − 中立) × 重み`。中立は開催区分で別(`jockeyNeutralPlaceRate`)。
 * @param venueKind 今回のレースの開催区分。省略時は "central"。
 */
export function computeJockeyScore(
  stats: JockeyCourseStats | undefined,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
  venueKind: RaceIdVenueKind = "central",
): BaseScoreContribution {
  const { jockeyMinStarts } = config.baseScore;
  const neutral = config.baseScore.jockeyNeutralPlaceRate[venueKind];
  const weight = config.baseScore.weights.jockey;

  if (stats === undefined) {
    return {
      biasName: JOCKEY_NAME,
      applied: false,
      reason: "騎手の成績データなし(取得していない・取得できなかった)のため補正なし",
      weight,
      correction: 0,
      sampleCount: 0,
      targetRate: null,
      overallRate: neutral,
    };
  }

  if (stats.starts < jockeyMinStarts) {
    return {
      biasName: JOCKEY_NAME,
      applied: false,
      reason: `騎手の騎乗数が${jockeyMinStarts}走未満のため補正なし`,
      weight,
      correction: 0,
      sampleCount: stats.starts,
      targetRate: stats.starts === 0 ? null : stats.placed / stats.starts,
      overallRate: neutral,
    };
  }

  const rate = stats.placed / stats.starts;
  return {
    biasName: JOCKEY_NAME,
    applied: true,
    reason: "騎手の複勝率(前年+当年)で補正",
    weight,
    correction: (rate - neutral) * weight,
    sampleCount: stats.starts,
    targetRate: rate,
    overallRate: neutral,
  };
}

// ---------------------------------------------------------------------------
// (5) 斤量変化
// ---------------------------------------------------------------------------

const WEIGHT_CHANGE_NAME = "斤量";

/** 斤量の今回条件。 */
export interface WeightChangeInput {
  /** 今回の斤量(kg)。 */
  readonly kinryo: number;
  /**
   * 今回レースの開催区分(中央/地方)。省略時は "central"(従来どおり)。
   * "nar"(地方競馬)では斤量の項を使わない(Issue #421 手順 2。下の computeWeightChangeScore の JSDoc)。
   */
  readonly venueKind?: RaceIdVenueKind;
}

/**
 * 斤量変化の小補正を計算する。
 * - 斤量: 前走(直近走)比の増減。増はマイナス方向、kinryoCapKg で絶対値をクリップ。
 * スケールは控えめ(仕様「小補正・控えめに設計」)。前走斤量が取れなければ補正なし。
 *
 * 馬体重の増減による減点は Issue #213(#210-B)で撤去した。休み明け・馬体重の増減は、LLM が
 * その馬自身の実績(休み明け実績・ベスト体重。Issue #212)と照らして判断する。scorer でも機械的に
 * 減点すると二重に数えることになり、馬体重の減少が「ベスト体重に戻した」結果でも減点してしまうため。
 * 重みのキー(weights.weightChange)は、保存済みの設定を壊さないため名前を据え置いている(今は斤量だけに効く)。
 *
 * **地方(venueKind="nar")では斤量の項を使わない**(Issue #421 手順 2。ユーザー決定・2026-10-23)。寄与度の行は残し、
 * applied=false・補正 0 にする(重みは設定の値のまま。他の対象外項目と同じ書き方)。根拠は #421 の測り直し:
 * 本番の書き出し(2026-10-23。形式 3)の地方 151 レースで、斤量の項を外すと prior の Brier の差が
 * −0.00072 [−0.00124, −0.00023](95%。レース単位のブートストラップ 1,000 回)で、補正の向きも結果と逆に見えた。
 * ただしこの測定は 13 項目のモデル(タイム指数・調教師の項を入れる前)で行った。現行の 15 項目のモデルでは測っていない。
 * 中央(792 レース)は −0.00008 [−0.00022, +0.00006] で差がなかったので、中央と開催区分の省略は従来どおり
 * (値が 1 ビットも変わらない)。地方の判定が前走の斤量の有無より先(地方では前走の斤量があっても無くても同じ理由)。
 */
export function computeWeightChangeScore(
  features: readonly DerivedRaceFeature[],
  today: WeightChangeInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreContribution {
  const { kinryoScale, kinryoCapKg } = config.baseScore;
  const weight = config.baseScore.weights.weightChange;

  // 地方(NAR)レースは斤量の項を使わない(Issue #421 手順 2)。補正は正の 0 のリテラルで返す(式を通すと -0 になりうる)。
  if (today.venueKind === "nar") {
    return {
      biasName: WEIGHT_CHANGE_NAME,
      applied: false,
      reason: "NARのため対象外(地方では斤量の補正を使わない。Issue #421)",
      weight,
      correction: 0,
    };
  }

  // 前走(直近走)の斤量。取得できなければ斤量項は評価しない。
  const prevKinryo = features[0]?.result.kinryo ?? null;

  let kinTerm = 0;
  let hasKin = false;
  if (prevKinryo !== null) {
    const diff = clamp(today.kinryo - prevKinryo, -kinryoCapKg, kinryoCapKg);
    kinTerm = -diff * kinryoScale; // 斤量増でマイナス。
    hasKin = true;
  }

  return {
    biasName: WEIGHT_CHANGE_NAME,
    applied: hasKin,
    reason: hasKin ? "斤量増減による小補正" : "前走斤量が取得できないため補正なし",
    weight,
    correction: kinTerm * weight,
  };
}

// ---------------------------------------------------------------------------
// (6) コースレベル枠順バイアス(定数テーブル)
// ---------------------------------------------------------------------------

const COURSE_FRAME_NAME = "コース枠順バイアス";

/** コースレベル枠順バイアスの今回条件。 */
export interface CourseFrameInput {
  /** 今回の中央競馬場名。 */
  readonly venueName: string;
  /** 今回のコース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 今回の枠ゾーン(内/中/外)。 */
  readonly frameZone: FrameZone;
  /**
   * 今回レースの開催区分(中央/地方)。省略時は "central"(従来どおり)。
   * "nar"(地方競馬)では COURSE_FRAME_BIAS_TABLE が中央10場前提のため、コースレベル
   * 枠順バイアスを一律対象外とする。
   */
  readonly venueKind?: RaceIdVenueKind;
}

/**
 * コースレベル枠順バイアスの補正を計算する(仕様の枠2層のうち①)。
 * frame-bias-table の値 × 重み。テーブル未登録・値0の条件は補正なし。
 * この重みは馬個別の枠別成績(bias-frame.ts)とは独立に config で調整できる(仕様の明示要件)。
 */
export function computeCourseFrameBiasScore(
  today: CourseFrameInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreContribution {
  const weight = config.baseScore.weights.courseFrameBias;

  // 地方(NAR)レースはテーブルが中央10場前提のため一律対象外とする。
  if (today.venueKind === "nar") {
    return {
      biasName: COURSE_FRAME_NAME,
      applied: false,
      reason: "NARのため対象外(コースレベル枠順バイアスの補正なし)",
      weight,
      correction: 0,
    };
  }

  const value = courseFrameBiasValue(
    today.venueName,
    today.courseType,
    today.frameZone,
  );
  const applied = value !== 0;
  return {
    biasName: COURSE_FRAME_NAME,
    applied,
    reason: applied
      ? `${today.venueName}${today.courseType}${today.frameZone}枠のコース傾向で補正`
      : "コース枠順バイアスのテーブル値が0のため補正なし",
    weight,
    correction: value * weight,
  };
}

// ---------------------------------------------------------------------------
// (7) 統合: computeBaseScore
// ---------------------------------------------------------------------------

/** 基礎スコアの今回条件(6項目分をまとめて渡す)。 */
export interface BaseScoreInput {
  /** 今回のコース種別。 */
  readonly courseType: CourseType;
  /** 今回の距離(m)。 */
  readonly distance: number;
  /** 今回の中央競馬場名。 */
  readonly venueName: string;
  /** 今回の枠ゾーン(内/中/外)。 */
  readonly frameZone: FrameZone;
  /** 今回の斤量(kg)。 */
  readonly kinryo: number;
  /**
   * 今回レースの開催区分(中央/地方)。省略時は "central"(従来どおり)。
   * computeCourseFrameBiasScore にそのまま渡す(NARではコースレベル枠順バイアスを対象外にする)。
   * computeJockeyScore(中立の切り替え)・computeWeightChangeScore(NARでは斤量の項を使わない。Issue #421)にも渡す。
   */
  readonly venueKind?: RaceIdVenueKind;
}

/** 基礎スコアの集計結果(全項目の寄与度ログと補正合計)。 */
export interface BaseScoreResult {
  /** 6項目の寄与度ログ(計算順)。 */
  readonly contributions: BaseScoreContribution[];
  /** 6項目の補正合計。 */
  readonly correctionSum: number;
}

/**
 * 基礎スコア6項目を計算し、寄与度ログと補正合計を返す。
 * @param features 過去走の派生特徴量。
 * @param today 今回の条件。
 * @param jockeyCourseStats 騎手の当該コース成績(なければ undefined)。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeBaseScore(
  features: readonly DerivedRaceFeature[],
  today: BaseScoreInput,
  jockeyCourseStats: JockeyCourseStats | undefined,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): BaseScoreResult {
  const contributions: BaseScoreContribution[] = [
    computeRecentFormScore(features, config),
    computeLast3fScore(features, config),
    computeCourseDistanceScore(
      features,
      { courseType: today.courseType, distance: today.distance },
      config,
    ),
    computeJockeyScore(jockeyCourseStats, config, today.venueKind),
    computeWeightChangeScore(
      features,
      { kinryo: today.kinryo, venueKind: today.venueKind },
      config,
    ),
    computeCourseFrameBiasScore(
      {
        venueName: today.venueName,
        courseType: today.courseType,
        frameZone: today.frameZone,
        venueKind: today.venueKind,
      },
      config,
    ),
  ];
  const correctionSum = contributions.reduce((s, c) => s + c.correction, 0);
  return { contributions, correctionSum };
}
