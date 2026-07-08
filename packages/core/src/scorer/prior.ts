/**
 * prior(複勝圏内確率の事前推定値)の合成。仕様「2. scorer」末尾:
 * 「基礎スコア+バイアス補正から各馬の複勝圏内確率の事前推定値(prior)を算出。
 *  各バイアスの重みはconfigで調整可能」。
 *
 * 合成式(設計判断):
 *   raw_i = 中立確率 + Σ(基礎スコア6項目の補正) + Σ(環境・状態バイアス7項目の補正)
 *   中立確率 = min(3, 頭数) / 頭数   (頭数Nのレースで概ね3頭が複勝圏に入る前提の起点)
 *   prior_i = clamp(raw_i, [minPrior, maxPrior])
 *
 * 健全性(仕様の意識点):
 * - 全馬が同一データなら全補正が同一 → 全馬同一 prior(決定論的に自明)。
 * - 頭数Nのレースで prior の合計は概ね「目標(min(3,N))」付近であるべき。各馬を独立に計算するため
 *   合計は目標からずれ得る。computeFieldPriors は raw の合計が目標から大きく逸脱(逸脱比率 >
 *   normalizeTolerance)した場合のみ、raw を目標に合わせて一律スケール(正規化)してからクランプする。
 *   一律スケールは「全馬同一 → 全馬同一」を保つ。
 *
 * 寄与度ログ: 基礎6項目 + 環境7項目(馬場・競馬場・季節・夏負け・枠順個別・輸送滞在・ローテ)の
 * 計13項目を contributions として返す(仕様「各バイアスの寄与度をログ出力し、verifyで重みを調整」)。
 */

import type { DerivedRaceFeature, FrameZone, Season } from "./derive-features.js";
import {
  classifyFrameZone,
  classifyRotationInterval,
  classifySeason,
  daysBetweenDates,
  deriveRaceFeatures,
} from "./derive-features.js";
import type {
  CourseType,
  HorseRaceResult,
  ShutubaHorse,
  StableLocation,
} from "../scraper/types.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";
import { computeBaseScore, type JockeyCourseStats } from "./base-score.js";
import { computeTrackConditionBias } from "./bias-track-condition.js";
import { computeVenueBias } from "./bias-venue.js";
import { computeSeasonBias, computeSummerFatigueBias } from "./bias-season.js";
import { computeFrameBias } from "./bias-frame.js";
import { computeTransportBias } from "./bias-transport.js";
import { computeRotationBias } from "./bias-rotation.js";

/**
 * prior合成で扱う寄与度ログの最小共通形。
 * 基礎スコア(BaseScoreContribution)・各バイアス(BiasContribution 等)はいずれもこの形に
 * 構造的に適合する(sampleCount/targetRate/overallRate は複勝率系のみ埋まる optional)。
 */
export interface ScoreContribution {
  /** 項目名(ログ識別用)。 */
  readonly biasName: string;
  /** 補正を適用したか。 */
  readonly applied: boolean;
  /** 適用/非適用の理由。 */
  readonly reason: string;
  /** 適用した重み係数。 */
  readonly weight: number;
  /** 最終的な補正値(非発動なら0)。 */
  readonly correction: number;
  /** 対象サンプル数(複勝率系項目のみ)。 */
  readonly sampleCount?: number;
  /** 対象条件の指標値(複勝率系項目のみ)。 */
  readonly targetRate?: number | null;
  /** 比較基準値(複勝率系項目のみ)。 */
  readonly overallRate?: number | null;
}

/** 今回レースの条件(基礎スコア・全バイアスが必要とする今回情報をまとめたもの)。 */
export interface TodayRaceConditions {
  /** 今回のコース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 今回の距離(m)。 */
  readonly distance: number;
  /** 今回の中央競馬場名。 */
  readonly venueName: string;
  /** 今回(または想定)馬場が稍重以下(道悪)なら true。 */
  readonly isWet: boolean;
  /** 今回の開催季節(夏/冬/春秋)。 */
  readonly season: Season;
  /** 今回の枠ゾーン(内/中/外)。 */
  readonly frameZone: FrameZone;
  /** 今回が休み明け何走目か(走目不明なら null)。 */
  readonly restRunNumber: number | null;
  /** 厩舎所在地(美浦/栗東)。 */
  readonly stableLocation: StableLocation;
  /** 今回の斤量(kg)。 */
  readonly kinryo: number;
  /** 今回の馬体重増減(kg、前走比)。未発表なら null。 */
  readonly bodyWeightDiff: number | null;
}

/** computePrior の入力(1頭分)。 */
export interface PriorInput {
  /** 過去走の派生特徴量。 */
  readonly features: readonly DerivedRaceFeature[];
  /** 今回レースの条件。 */
  readonly today: TodayRaceConditions;
  /** 今回の出走頭数(中立確率の起点に使う)。 */
  readonly fieldSize: number;
  /** 騎手の当該コース成績(なければ省略)。 */
  readonly jockeyCourseStats?: JockeyCourseStats;
  /** scorer 設定。省略時は既定値。 */
  readonly config?: ScorerConfig;
}

/** prior の算出結果(1頭分)。 */
export interface PriorResult {
  /** クランプ後の prior(事前複勝確率)。 */
  readonly prior: number;
  /** クランプ・正規化前の raw prior(中立確率 + 補正合計)。 */
  readonly rawPrior: number;
  /** 起点の中立確率(min(3,頭数)/頭数)。 */
  readonly neutralProb: number;
  /** 基礎6項目 + バイアス7項目の補正合計。 */
  readonly correctionSum: number;
  /** 全13項目の寄与度ログ。 */
  readonly contributions: ScoreContribution[];
}

/** 1頭分の全寄与度ログと補正合計を計算する(中立確率・クランプは含めない)。 */
function collectContributions(input: PriorInput): {
  contributions: ScoreContribution[];
  correctionSum: number;
} {
  const config = input.config ?? DEFAULT_SCORER_CONFIG;
  const { features, today } = input;

  // 基礎スコア6項目。
  const base = computeBaseScore(
    features,
    {
      courseType: today.courseType,
      distance: today.distance,
      venueName: today.venueName,
      frameZone: today.frameZone,
      kinryo: today.kinryo,
      bodyWeightDiff: today.bodyWeightDiff,
    },
    input.jockeyCourseStats,
    config,
  );

  // 環境・状態バイアス7項目。過剰補正防止(仕様L135)のため、prior合成時に biasCorrectionScale で
  // バイアス寄与を一律減衰する。個々のバイアス関数・単体テストには影響させず、ここでのみ各バイアス重みに
  // 係数を乗じた実効設定(biasConfig)を渡す。これにより寄与度ログの weight/correction は減衰後の実効値と
  // 一致し(correction = (target−overall)×実効weight)、Σcorrection == correctionSum の不変条件も保たれる。
  const scale = config.prior.biasCorrectionScale;
  const bw = config.weights;
  const biasConfig: ScorerConfig = {
    ...config,
    weights: {
      trackCondition: bw.trackCondition * scale,
      venue: bw.venue * scale,
      season: bw.season * scale,
      frame: bw.frame * scale,
      summerFatigue: bw.summerFatigue * scale,
      transport: bw.transport * scale,
      rotation: bw.rotation * scale,
    },
  };
  const biases: ScoreContribution[] = [
    computeTrackConditionBias(
      features,
      { courseType: today.courseType, isWet: today.isWet },
      biasConfig,
    ),
    computeVenueBias(features, { venueName: today.venueName }, biasConfig),
    computeSeasonBias(features, { season: today.season }, biasConfig),
    computeSummerFatigueBias(features, { season: today.season }, biasConfig),
    computeFrameBias(features, { frameZone: today.frameZone }, biasConfig),
    computeTransportBias(
      features,
      { stableLocation: today.stableLocation, venueName: today.venueName },
      biasConfig,
    ),
    computeRotationBias(
      features,
      { restRunNumber: today.restRunNumber },
      biasConfig,
    ),
  ];

  const contributions: ScoreContribution[] = [...base.contributions, ...biases];
  const correctionSum = contributions.reduce((s, c) => s + c.correction, 0);
  return { contributions, correctionSum };
}

/** 頭数から中立確率を求める。min(目標, 頭数)/頭数(頭数0以下は0)。 */
function neutralProbFor(fieldSize: number, config: ScorerConfig): number {
  if (fieldSize <= 0) {
    return 0;
  }
  return Math.min(config.prior.targetPlaceCount, fieldSize) / fieldSize;
}

/** min ≤ x ≤ max にクランプする。 */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * 1頭分の prior を算出する(頭数レベルの正規化は行わず、クランプのみ)。
 * 頭数間の合計を目標に寄せたい場合は computeFieldPriors を使う。
 */
export function computePrior(input: PriorInput): PriorResult {
  const config = input.config ?? DEFAULT_SCORER_CONFIG;
  const { contributions, correctionSum } = collectContributions(input);
  const neutralProb = neutralProbFor(input.fieldSize, config);
  const rawPrior = neutralProb + correctionSum;
  const prior = clamp(rawPrior, config.prior.minPrior, config.prior.maxPrior);
  return { prior, rawPrior, neutralProb, correctionSum, contributions };
}

/**
 * 頭数レベルで prior を算出する。各馬の raw prior を求め、合計が目標(min(3,頭数))から
 * 大きく逸脱した場合のみ一律スケールで正規化してからクランプする。
 *
 * - inputs はレース全頭を表す前提。各馬の fieldSize は inputs.length と一致していなければならない
 *   (中立確率の頭数と正規化目標の頭数を一致させる。提案3の参照源二重化の解消)。不一致は契約違反として throw。
 * - スケール計算には **クランプ後([minPrior, maxPrior])の値** を使う(要修正2)。飽和した1頭の巨大 raw を
 *   そのまま分母に入れると、補正ゼロの平均馬まで巻き添えで過度に引き下げられるため。
 * - 一律スケールなので「全馬同一データ → 全馬同一 prior」は保たれる。
 * - 正規化後になお maxPrior を超える馬は最終クランプで maxPrior に収める。
 * - クランプ後の合計は目標から多少ずれ得る(クランプの丸め)。「概ね目標付近」を担保する設計。
 */
export function computeFieldPriors(
  inputs: readonly PriorInput[],
): PriorResult[] {
  if (inputs.length === 0) {
    return [];
  }
  const config = inputs[0]!.config ?? DEFAULT_SCORER_CONFIG;
  const { minPrior, maxPrior, normalizeTolerance } = config.prior;
  const fieldSize = inputs.length;

  // 各馬の寄与度・raw を計算する(中立確率は頭数=inputs.length で統一)。
  const perHorse = inputs.map((input) => {
    if (input.fieldSize !== fieldSize) {
      throw new Error(
        `computeFieldPriors: 各馬の fieldSize(${input.fieldSize})は inputs.length(${fieldSize})と一致させてください`,
      );
    }
    const c = input.config ?? DEFAULT_SCORER_CONFIG;
    const { contributions, correctionSum } = collectContributions(input);
    const neutralProb = neutralProbFor(fieldSize, c);
    const rawPrior = neutralProb + correctionSum;
    return { contributions, correctionSum, neutralProb, rawPrior };
  });

  // 正規化の目標は頭数に対する min(3, 頭数)。
  const target = Math.min(config.prior.targetPlaceCount, fieldSize);

  // スケール計算は raw をクランプ([minPrior, maxPrior])した値で行う。
  // 飽和馬(raw≫maxPrior)を maxPrior 止まりにすることで、平均馬への巻き添え引き下げを防ぐ。
  const clamped = perHorse.map((h) => clamp(h.rawPrior, minPrior, maxPrior));
  const sumClamped = clamped.reduce((s, v) => s + v, 0);

  // 目標からの逸脱比率が許容を超えたら一律スケール。
  let scale = 1;
  if (
    sumClamped > 0 &&
    Math.abs(sumClamped - target) / target > normalizeTolerance
  ) {
    scale = target / sumClamped;
  }

  return perHorse.map((h, i) => {
    // クランプ後の値をスケールし、正規化後に上下限を超える場合は再度クランプする。
    const prior = clamp(clamped[i]! * scale, minPrior, maxPrior);
    return {
      prior,
      rawPrior: h.rawPrior,
      neutralProb: h.neutralProb,
      correctionSum: h.correctionSum,
      contributions: h.contributions,
    };
  });
}

// ---------------------------------------------------------------------------
// buildPriorInput: scraper 出力からの組み立てヘルパ(任意)
// ---------------------------------------------------------------------------

/** buildPriorInput の今回レース条件。 */
export interface BuildPriorRaceInfo {
  /** 今回のコース種別。 */
  readonly courseType: CourseType;
  /** 今回の距離(m)。 */
  readonly distance: number;
  /** 今回の中央競馬場名。 */
  readonly venueName: string;
  /** 今回(または想定)馬場が道悪なら true。 */
  readonly isWet: boolean;
  /** 今回のレース日(YYYY/MM/DD)。季節分類・休み明け走目の算出に使う。 */
  readonly date: string;
}

/** buildPriorInput の引数。 */
export interface BuildPriorInputArgs {
  /** 出馬表の1頭。 */
  readonly horse: ShutubaHorse;
  /** その馬の全戦績(新しい順)。 */
  readonly raceResults: HorseRaceResult[];
  /** 今回レースの条件。 */
  readonly race: BuildPriorRaceInfo;
  /** 今回の出走頭数。 */
  readonly fieldSize: number;
  /** 騎手の当該コース成績(なければ省略)。 */
  readonly jockeyCourseStats?: JockeyCourseStats;
  /** scorer 設定。省略時は既定値。 */
  readonly config?: ScorerConfig;
}

/**
 * 今回のレース日と直近走から「休み明け何走目か」を求める。
 * derive-features の走目ロジックと同じ規則:
 *   - 前走なし or 休み明け(中10週以上) → 1走目
 *   - 間隔不明(日付欠損) → null
 *   - それ以外 → 直近走の走目 + 1(直近走の走目が不明なら null)
 */
function todayRestRunNumber(
  features: readonly DerivedRaceFeature[],
  todayDate: string,
): number | null {
  const last = features[0];
  if (last === undefined) {
    return 1; // キャリア初戦。
  }
  const interval = classifyRotationInterval(
    daysBetweenDates(last.result.date, todayDate),
  );
  if (interval === "休み明け") {
    return 1;
  }
  if (interval === "不明") {
    return null;
  }
  return last.restRunNumber === null ? null : last.restRunNumber + 1;
}

/** 「YYYY/MM/DD」から月(1〜12)を取り出す。解釈不能なら null。 */
function monthOf(date: string): number | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(date.trim());
  return m ? Number(m[2]) : null;
}

/**
 * 出馬表馬 + 全戦績 + 今回レース条件から PriorInput を組み立てる(任意ヘルパ)。
 * 枠ゾーン・季節・休み明け走番・馬体重増減などの今回条件を scraper 出力から導出する。
 * 枠ゾーン・季節が確定できない異常入力(枠範囲外・日付不正)は呼び出し側の想定外とし、
 * それぞれ「中」枠・「春秋」に丸めてフォールバックする(prior自体は落とさない)。
 */
export function buildPriorInput(args: BuildPriorInputArgs): PriorInput {
  const { horse, raceResults, race } = args;
  const features = deriveRaceFeatures(raceResults);

  const frameZone: FrameZone = classifyFrameZone(horse.wakuban) ?? "中";
  const month = monthOf(race.date);
  const season: Season = (month === null ? null : classifySeason(month)) ?? "春秋";

  const stableLocation: StableLocation =
    horse.stableLocation === "美浦" || horse.stableLocation === "栗東"
      ? horse.stableLocation
      : "美浦";

  const today: TodayRaceConditions = {
    courseType: race.courseType,
    distance: race.distance,
    venueName: race.venueName,
    isWet: race.isWet,
    season,
    frameZone,
    restRunNumber: todayRestRunNumber(features, race.date),
    stableLocation,
    kinryo: horse.kinryo,
    bodyWeightDiff: horse.bodyWeight?.diff ?? null,
  };

  return {
    features,
    today,
    fieldSize: args.fieldSize,
    jockeyCourseStats: args.jockeyCourseStats,
    config: args.config,
  };
}
