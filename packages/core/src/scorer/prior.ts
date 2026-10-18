/**
 * prior(複勝圏内確率の事前推定値)の合成。仕様「2. scorer」末尾:
 * 「基礎スコア+バイアス補正から各馬の複勝圏内確率の事前推定値(prior)を算出。
 *  各バイアスの重みはconfigで調整可能」。
 *
 * 合成式(設計判断):
 *   raw_i = 中立確率 + Σ(基礎スコア6項目の補正) + Σ(環境・状態バイアス7項目の補正)
 *   (computeFieldPriors はこれに + w × タイム指数の特徴量〈レース内の中央値との差。Issue #353。`time-index.ts`〉
 *    + w × 調教師成績の特徴量〈縮小した前2年の3着内率 − レース内の平均。Issue #354。`trainer-stats.ts`〉を足す)
 *   中立確率 = min(3, 頭数) / 頭数   (頭数Nのレースで概ね3頭が複勝圏に入る前提の起点)
 *   prior_i = clamp(sigmoid(logit(clamp(raw_i)) + c), [minPrior, maxPrior])
 *             (c: レース内で全馬に共通。Σ prior_i = min(3, 頭数) となるように決める。下の「健全性」)
 *   単独の computePrior は頭数レベルの正規化をせず prior_i = clamp(raw_i, [minPrior, maxPrior]) のみ。
 *
 * 健全性(仕様の意識点):
 * - 全馬が同一データなら全補正が同一 → 全馬同一 prior(決定論的に自明)。
 * - 頭数Nのレースで prior の合計は「目標(min(3,N))」にちょうど一致させる。各馬を独立に計算するため
 *   raw の合計は目標からずれる(実測では全馬で平均 +0.08 ほど上にずれる)。computeFieldPriors は
 *   `normalizeFieldPriors` で、各馬の raw を [minPrior, maxPrior] に収めて logit に変え、**全馬に共通の
 *   c を足して** Σ clamp(sigmoid(logit_i + c)) = 目標 となる c を求める(ロジットシフト。Issue #258)。
 *   共通項を足すだけなので、クランプに当たらない馬どうしのロジット差(オッズ比)は保たれ、順序も保たれる。
 *   「全馬同一 → 全馬同一」も保たれる。
 *   旧版(〜#226)は、Σ が目標から ±10% を超えたときだけ全馬に同じ倍率を掛けていた。raw の偏りが
 *   正方向なので倍率は 1 より小さく、確率の広がり(sd)を raw の中央値で 0.77 倍に縮めていた(#258 の調査)。
 *   ロジットシフトでは、この比が 0.86 倍(33 レース・429 頭の中央値)まで戻る。完全には戻らない: c が負のとき、
 *   確率の差は p(1−p) 倍に縮むため(下位ほど縮む)。比較は `docs/investigations/prior-normalization-258/report.md`。
 *
 * 寄与度ログ: 基礎6項目 + 環境7項目(馬場・競馬場・季節・夏負け・枠順個別・輸送滞在・ローテ)の
 * 計13項目を contributions として返す(仕様「各バイアスの寄与度をログ出力し、verifyで重みを調整」)。
 * `computeFieldPriors` は、これに**タイム指数**(Issue #353〈#274-B〉。`time-index.ts`)を末尾の 14 番目として足す。
 * タイム指数は「馬の過去走の指数 − レース内の中央値」なので 1 頭では決まらず、レース全頭を見る `computeFieldPriors` が足す
 * (raw = 中立確率 + Σ13項目 + w × 特徴量 を、上のロジットシフトで正規化する)。末尾に置くのは、既存の 13 項目の位置を変えないため。
 * さらに末尾の 15 番目として**調教師成績**(Issue #354〈#348 の TR1〉。`trainer-stats.ts`)を足す。同じくレース内の平均との差なので `computeFieldPriors` が足す。
 */

import type { DerivedRaceFeature, FrameZone, Season } from "./derive-features.js";
import {
  classifyFrameZone,
  classifyRotationInterval,
  classifySeason,
  daysBetweenDates,
  deriveRaceFeatures,
} from "./derive-features.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import type {
  CourseType,
  HorseRaceResult,
  ShutubaHorse,
  StableLocation,
} from "../scraper/types.js";
import { DEFAULT_SCORER_CONFIG, type PriorConfig, type ScorerConfig } from "./config.js";
import { computeBaseScore, type JockeyCourseStats } from "./base-score.js";
import { computeTrackConditionBias } from "./bias-track-condition.js";
import { computeVenueBias } from "./bias-venue.js";
import { computeSeasonBias, computeSummerFatigueBias } from "./bias-season.js";
import { computeFrameBias } from "./bias-frame.js";
import { computeTransportBias } from "./bias-transport.js";
import { computeRotationBias } from "./bias-rotation.js";
import { computeFieldTimeIndexContributions } from "./time-index.js";
import { computeFieldTrainerContributions, type TrainerStats } from "./trainer-stats.js";

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
  /**
   * 今回レースの開催区分(中央/地方)。省略時は "central"(従来どおり)。
   * "nar"(地方競馬)では COURSE_TRAITS・COURSE_FRAME_BIAS_TABLE・美浦/栗東輸送負荷テーブルが
   * いずれも中央10場前提のため、competeVenueBias(競馬場適性)・computeCourseFrameBiasScore
   * (コース枠順バイアス)・computeTransportBias(輸送・滞在バイアス)の3項目を一律対象外にする
   * (寄与度ログには「NARのため対象外」等の理由を残す)。それ以外の基礎スコア・バイアス項目は
   * venueKind に関わらず従来どおり計算する。
   */
  readonly venueKind?: RaceIdVenueKind;
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
  /**
   * 調教師の前2年(Y−2, Y−1)の出走数と3着内の数(Issue #354。なければ省略 = 「データなし」)。
   * 1頭では使われず、`computeFieldPriors` がレース全頭の分を比べて足す(`trainer-stats.ts`)。
   */
  readonly trainerStats?: TrainerStats;
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
  /** 基礎6項目 + バイアス7項目の補正合計(`computeFieldPriors` の結果にはタイム指数・調教師成績の補正も含む)。 */
  readonly correctionSum: number;
  /**
   * 全項目の寄与度ログ。`computePrior`(1頭用)は基礎6 + バイアス7 の 13 項目。
   * `computeFieldPriors` は末尾にタイム指数(Issue #353)・調教師成績(Issue #354)を足した 15 項目(レース内の比較が要るので、レース全頭を見られる側でだけ足す)。
   */
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
      venueKind: today.venueKind,
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
    computeVenueBias(
      features,
      { venueName: today.venueName, venueKind: today.venueKind },
      biasConfig,
    ),
    computeSeasonBias(features, { season: today.season }, biasConfig),
    computeSummerFatigueBias(features, { season: today.season }, biasConfig),
    computeFrameBias(features, { frameZone: today.frameZone }, biasConfig),
    computeTransportBias(
      features,
      {
        stableLocation: today.stableLocation,
        venueName: today.venueName,
        venueKind: today.venueKind,
      },
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

/** ロジット。p は (0,1) の内側に収めてから渡すこと。 */
function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/** シグモイド。 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 共通項 c の二分法の反復回数。区間幅 120 を 2^100 で割るので c は倍精度の限界まで収束する(決定的)。 */
const SHIFT_BISECTION_ITERATIONS = 100;

/** 共通項 c の探索区間。c=±60 では全馬のシグモイドが床・天井のどちらかに完全に飽和する。 */
const SHIFT_SEARCH_BOUND = 60;

/** logit の前に raw を収める区間の余白(minPrior が 0 以下・maxPrior が 1 以上の設定でも logit が有限になるように)。 */
const LOGIT_EPSILON = 1e-12;

/**
 * 頭数レベルの正規化(Issue #258): 各馬の raw prior に**ロジットの共通項 c を足して**、合計を
 * `min(targetPlaceCount, 頭数)` にちょうど合わせる。
 *
 * ## 手順
 * 1. 各馬の raw を `[minPrior, maxPrior]` に収める(raw ≤ 0 や ≥ 1 もここで収まり、logit は常に有限。
 *    同じ値に収まった馬どうしは、以後も同じ出力になる)。
 * 2. 収めた値を logit に変える: `l_i = logit(clamp(raw_i))`。
 * 3. `g(c) = Σ clamp(sigmoid(l_i + c), minPrior, maxPrior)` が目標に等しくなる c を二分法で求める。
 *    `g` は c について連続・単調非減少なので、解は(実現可能なら)存在し、固定回数の二分法で決定的に求まる。
 * 4. 出力は `clamp(sigmoid(l_i + c), minPrior, maxPrior)`。
 *
 * ## 性質
 * - **ロジットの広がりが縮まない**: 床・天井に当たらない馬どうしでは `logit(出力_i) − logit(出力_j) = l_i − l_j`
 *   (旧版の乗算は、raw の偏りが正のとき倍率が 1 より小さく、広がりを縮めていた)。ただし**確率の差は保たれない**
 *   (c<0 のとき、確率の差は p(1−p) 倍に縮む。確率の sd は raw の 0.86 倍。確率の差を保つ「加算シフト」は、
 *   床に 25/429 頭が同値で張り付いたため採用しなかった)。
 * - **順序の保存**: 入力 a < b → 出力 a ≤ b。床・天井に当たらない限り厳密な不等号で、同値を新たに作らない。
 * - **水詰め**: 床・天井に当たった馬は固定され、残りの馬が同じ c で動いて合計を合わせる
 *   (再分配の反復は要らない。`g` を直接解くため)。飽和した 1 頭が他の馬を巻き添えにしない。
 * - **常に 0.02〜0.95**: 負や 1 超は出ない。
 * - **実現不能は throw しない**: 目標 ≥ 頭数 × maxPrior(頭数 3 以下など)なら全頭 maxPrior、
 *   目標 ≤ 頭数 × minPrior なら全頭 minPrior に飽和させる(合計は目標に届かない)。
 * - **NaN の raw は、その馬だけ NaN のまま**で、他の馬は有限の馬だけで合計を合わせる(全頭 NaN なら全頭 NaN。
 *   throw しない)。±Infinity は片側に収まる。
 * - 頭数 0 は空配列。入力は変更しない。
 *
 * @param rawPriors 全頭の raw prior(中立確率 + 補正合計。クランプ前)。
 * @param config prior 設定(minPrior・maxPrior・targetPlaceCount を使う)。
 */
export function normalizeFieldPriors(
  rawPriors: readonly number[],
  config: PriorConfig,
): number[] {
  const n = rawPriors.length;
  if (n === 0) {
    return [];
  }
  const { minPrior, maxPrior, targetPlaceCount } = config;
  const target = Math.min(targetPlaceCount, n);

  // NaN の馬は二分法から除き、出力も NaN のままにする(影響をその 1 頭に閉じ込める。旧版の乗算も、NaN の馬だけが
  // NaN になり他の馬は有限だった)。NaN を含めると total(c) が NaN になり、`NaN > target` が常に偽で探索が
  // 片側に倒れて、他の全頭が maxPrior に張り付く。有限の馬だけで Σ を目標に合わせる(目標は NaN の馬を含む
  // 頭数 n で決める。NaN の馬の取り分は不明なので、残りの馬にその分だけ多く配られる)。±Infinity は NaN ではなく、
  // [minPrior, maxPrior] への収め込みで片側に寄る。
  const out = new Array<number>(n).fill(Number.NaN);
  const finiteIndices: number[] = [];
  rawPriors.forEach((v, i) => {
    if (!Number.isNaN(v)) {
      finiteIndices.push(i);
    }
  });
  const m = finiteIndices.length;
  if (m === 0) {
    return out;
  }
  if (target >= m * maxPrior) {
    finiteIndices.forEach((i) => (out[i] = maxPrior));
    return out;
  }
  if (target <= m * minPrior) {
    finiteIndices.forEach((i) => (out[i] = minPrior));
    return out;
  }

  const logitLow = Math.max(minPrior, LOGIT_EPSILON);
  const logitHigh = Math.min(maxPrior, 1 - LOGIT_EPSILON);
  const logits = finiteIndices.map((i) => logit(clamp(rawPriors[i]!, logitLow, logitHigh)));
  const shifted = (l: number, c: number): number =>
    clamp(sigmoid(l + c), minPrior, maxPrior);
  const total = (c: number): number =>
    logits.reduce((s, l) => s + shifted(l, c), 0);

  // g(−bound) = m×minPrior < 目標 < m×maxPrior = g(+bound)(上の実現可能性の判定で保証)。
  let lo = -SHIFT_SEARCH_BOUND;
  let hi = SHIFT_SEARCH_BOUND;
  for (let i = 0; i < SHIFT_BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const c = (lo + hi) / 2;
  finiteIndices.forEach((idx, k) => {
    out[idx] = shifted(logits[k]!, c);
  });
  return out;
}

/**
 * 頭数レベルで prior を算出する。各馬の raw prior を求め、`normalizeFieldPriors` で
 * 合計を目標(min(3,頭数))にちょうど合わせる(ロジットシフト。Issue #258)。
 *
 * - inputs はレース全頭を表す前提。各馬の fieldSize は inputs.length と一致していなければならない
 *   (中立確率の頭数と正規化目標の頭数を一致させる。提案3の参照源二重化の解消)。不一致は契約違反として throw。
 * - 旧版の「合計が目標から許容(±10%)を超えたときだけ正規化」は撤去した。常に合計が目標に一致する。
 * - 一律の共通項なので「全馬同一データ → 全馬同一 prior」は保たれる。
 * - 飽和した 1 頭の巨大 raw は [minPrior, maxPrior] に収めてから扱うので、補正ゼロの平均馬を巻き添えにしない。
 */
export function computeFieldPriors(
  inputs: readonly PriorInput[],
): PriorResult[] {
  if (inputs.length === 0) {
    return [];
  }
  const config = inputs[0]!.config ?? DEFAULT_SCORER_CONFIG;
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
    return { contributions, correctionSum, neutralProb };
  });

  // タイム指数(Issue #353): レース内の中央値との差なので、全頭の戦績がそろってから 14 番目の寄与度として足す。
  // 今回のレースの条件(開催区分・コース種別)と重みはレースで共通(先頭の入力の値を使う。正規化の設定と同じ流儀)。
  const timeIndex = computeFieldTimeIndexContributions(
    inputs.map((input) => input.features.map((f) => f.result)),
    {
      venueKind: inputs[0]!.today.venueKind ?? "central",
      courseType: inputs[0]!.today.courseType,
      weight: config.baseScore.weights.timeIndex,
    },
  );
  // 調教師成績(Issue #354): 同じくレース内の平均との差なので、全頭がそろってから 15 番目の寄与度として足す(開催区分・コース種別・重みはタイム指数と同じ流儀)。
  const trainer = computeFieldTrainerContributions(
    inputs.map((input) => input.trainerStats),
    {
      venueKind: inputs[0]!.today.venueKind ?? "central",
      courseType: inputs[0]!.today.courseType,
      weight: config.baseScore.weights.trainer,
    },
  );
  const withFieldItems = perHorse.map((h, i) => {
    const contributions = [...h.contributions, timeIndex[i]!, trainer[i]!];
    const correctionSum = h.correctionSum + timeIndex[i]!.correction + trainer[i]!.correction;
    return {
      contributions,
      correctionSum,
      neutralProb: h.neutralProb,
      rawPrior: h.neutralProb + correctionSum,
    };
  });

  const priors = normalizeFieldPriors(
    withFieldItems.map((h) => h.rawPrior),
    config.prior,
  );

  return withFieldItems.map((h, i) => ({
    prior: priors[i]!,
    rawPrior: h.rawPrior,
    neutralProb: h.neutralProb,
    correctionSum: h.correctionSum,
    contributions: h.contributions,
  }));
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
  /**
   * 今回レースの開催区分(中央/地方)。呼び出し側(`analysis/analysis-pipeline.ts`)は
   * venueKindOfRaceId(raceId) 等で判定した値を必ず明示的に渡すこと(TodayRaceConditions.venueKind
   * と異なり省略不可)。NARでは競馬場適性・コース枠順バイアス・輸送滞在バイアスを対象外にする
   * (詳細は TodayRaceConditions.venueKind のコメント参照)。
   */
  readonly venueKind: RaceIdVenueKind;
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
  /** 調教師の前2年の出走数と3着内の数(なければ省略。Issue #354)。 */
  readonly trainerStats?: TrainerStats;
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
 * 枠ゾーン・季節・休み明け走番・斤量などの今回条件を scraper 出力から導出する。
 * 枠ゾーン・季節が確定できない異常入力(枠範囲外・日付不正)は呼び出し側の想定外とし、
 * それぞれ「中」枠・「春秋」に丸めてフォールバックする(prior自体は落とさない)。
 */
export function buildPriorInput(args: BuildPriorInputArgs): PriorInput {
  const { horse, raceResults, race } = args;
  const features = deriveRaceFeatures(raceResults);

  const frameZone: FrameZone = classifyFrameZone(horse.wakuban) ?? "中";
  const month = monthOf(race.date);
  const season: Season = (month === null ? null : classifySeason(month)) ?? "春秋";

  // 実装済み(Task #21): ShutubaHorse.stableLocation は string型に拡張済みで、NAR(地方競馬)の
  // 出馬表では「高知」「浦和」等の所属会場名がそのまま入り得る。その場合ここは「美浦/栗東の
  // いずれでもない」に該当し、便宜上「美浦」へフォールバックする。以前はこのフォールバックが
  // 輸送バイアスの誤補正につながる懸念があったが、collectContributions が
  // race.venueKind === "nar" を computeTransportBias に明示的に渡すことで、輸送・滞在バイアス
  // 自体がstableLocationの値を参照する前に対象外(correction=0)として短絡評価されるようになった
  // (bias-transport.ts の venueKind ガード参照)。そのためこのフォールバック値はNARレースの
  // prior計算結果に一切影響しない(値は保持されるがcomputeTransportBias内で未参照)。
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
    venueKind: race.venueKind,
  };

  return {
    features,
    today,
    fieldSize: args.fieldSize,
    jockeyCourseStats: args.jockeyCourseStats,
    ...(args.trainerStats !== undefined ? { trainerStats: args.trainerStats } : {}),
    config: args.config,
  };
}
