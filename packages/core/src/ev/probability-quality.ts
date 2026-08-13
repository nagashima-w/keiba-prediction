/**
 * probability-quality — 確率の質を測る計測基盤(#40「#35-1a: 確率の質を測る計測基盤の健全化と
 * 指標の実装」)。
 *
 * ## このモジュールがやらないこと(スコープ外)
 * **測るだけ**で、確率の出し方には一切手を入れない。`prior.ts`・`place-joint-model.ts`・
 * `combo-bet-allocation.ts`・`expected-value.ts` の挙動は一切変更しない(本ファイルはこれらを
 * 値として import して再利用するのみ)。較正(calibration)方式の実装・検討は #42、サンプル拡大・
 * LLM実行は別Issue。
 *
 * ## AC9: 値インポート境界
 * `scraper/types.ts` の型(`OddsStatus`等)は本ファイルが直接依存する重い実行時コードを持たない
 * 純粋な型定義の葉であり `import type` のみで取り込む。`scraper/scrape-race.ts` からの
 * 値インポートは0件(本ファイルは`RaceData`型を直接扱わない設計。呼び出し側が
 * `ProbabilityQualityReportInput`という本ファイル自身の最小構造体に詰め替えてから渡す)。
 * `./place-joint-model.js`・`./combo-bet-allocation.js`(いずれも実測でrendererバンドル
 * 済み・node:*非依存と確認済み)からは値として `CONDITIONAL_BERNOULLI_MODEL`・
 * `resolveComboOdds` を再利用する(受け入れ条件7。二重定義しない)。
 *
 * ## 4つの指標(boss設計・着手前ゲート)
 * 1. `computeTrioAllPointEvOverPayoutRate` — 全点等額購入時の平均EV÷払戻率(三連複専用)。
 * 2. `spearmanRankCorrelation` — prior(または補正後確率)と市場含意複勝確率の順位相関。
 * 3. `computeVarianceRatioMetrics` — sd比・max/min比(平坦さ)。
 * 4. `normalizedTrioJointKlDivergence` — 三連複同時分布の正規化KL(モデル側・市場側の両方を
 *    同一関数で算出して並記する。#35の「一様分布からの乖離」をスケール不変にしたもの)。
 *
 * ## 計測条件は必ず添付する(受け入れ条件5・5')
 * `buildProbabilityQualityReport` が唯一の想定エントリポイントであり、常に `conditions` を
 * 結果に同梱する。`conditions` の各項目は可能な限り入力から自動導出し、呼び出し側の申告
 * (=このモジュールが検証できない外部の事実)に頼るのは **`priorSource` の1項目だけ**にする:
 * - `priorSource`: `runAnalysis` の外側の事実(LLMを実行したかどうか)であり、確率の値だけを
 *   見ても本モジュールからは判別できない。**唯一、呼び出し側の申告に依存する項目。**
 * - `oddsStatus` / `fieldSize`: 入力データ(`OddsSnapshot.oddsStatus`・出走頭数)からそのまま
 *   転記するだけで、呼び出し側の解釈・判断を挟まない(自動導出)。
 * - `leakFilterApplied` / `cutoffDate` / `removedResultCount`: 呼び出し側が
 *   `filterRaceDataBefore` を実行した**実際の戻り値**(`SnapshotFilterDiagnostics`)を渡した
 *   場合のみ非nullになる。「適用した」という自己申告のbooleanを受け取るのではなく、実際の
 *   診断値オブジェクトの有無・中身から導出する(申告と実測を取り違えない設計)。
 * - `placeOddsKind` / `trioComboOddsKind`: 固定値(下記AC6'参照)。
 *
 * ## 複勝オッズは「幅」である(受け入れ条件6')
 * `PlaceOdds { oddsMin, oddsMax, ninki }` は下限・上限を持つ券種であり、`oddsMin` は
 * 「単一の真値」ではない。市場含意確率を `1/oddsMin` から求めると、複勝の控除分だけでなく
 * 「幅の分だけ」確率を過大に見積もる(実測: 中央フィクスチャで `Σ(1/oddsMin) = 4.2448`。
 * 理想値 `3/払戻率 ≒ 3.75` より明確に大きい)。Σ=3正規化は**レース共通のスケールバイアス**を
 * 消すが、**人気薄ほど幅が広いという馬ごとの差分バイアスは残る**(正規化しても消えない)。
 * このため `conditions.placeOddsKind` を `"placeOddsMinLowerBound"` という明示的な名前にし、
 * 呼び出し側が「単一の真値」と誤解しないようにする(`oddsMax`版・中点版との感度比較は
 * 本タスクのスコープ外)。
 *
 * ## ワイドへの誤用を防ぐ(受け入れ条件6)
 * `computeTrioAllPointEvOverPayoutRate` は**三連複の組合せオッズ専用**の関数で、汎用の
 * `comboType` 引数を持たない(構造的に「ワイドを渡す」という呼び出し自体ができない)。
 * 三連複は1レース1組的中のため `Σ(1/odds) = 1/払戻率` が厳密に成立するが、ワイドは1レース3組が
 * 同時的中するため成立しない(実測・誤用の危険性は `probability-quality.test.ts`
 * 「ワイドへの誤用防止」参照)。
 */

import type { OddsStatus } from "../scraper/types.js";
import type { SnapshotFilterDiagnostics } from "../scorer/snapshot-filter.js";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
} from "./place-joint-model.js";
import { resolveComboOdds } from "./combo-bet-allocation.js";

// ---------------------------------------------------------------------------
// 共通の型
// ---------------------------------------------------------------------------

/** null許容の指標値。null のときは必ず reason が入る(条件抜きのnullを返さない)。 */
export interface NullableMetric {
  readonly value: number | null;
  readonly reason: string | null;
}

function metric(value: number | null, reason: string | null): NullableMetric {
  return { value, reason };
}

// ---------------------------------------------------------------------------
// 基礎統計ヘルパ(内部利用)
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** 母集団標準偏差(出走全頭という「母集団」を扱うため、n-1補正はしない)。 */
function populationStdDev(values: readonly number[]): number {
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function maxMinRatio(values: readonly number[]): NullableMetric {
  if (values.length === 0) {
    return metric(null, "対象馬が0頭");
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(min > 0)) {
    return metric(null, "最小値が0以下(ゼロ除算、または非正の値を含む)");
  }
  return metric(max / min, null);
}

// ---------------------------------------------------------------------------
// (2) 市場含意複勝確率
// ---------------------------------------------------------------------------

/** computeMarketImpliedPlaceProbabilities の1頭分の入力。 */
export interface PlaceOddsInputHorse {
  readonly umaban: number;
  /** 複勝オッズ下限(未確定・非数値・yosoで複勝オッズ自体が無い場合は null)。 */
  readonly placeOddsMin: number | null;
}

/** 市場含意複勝確率の算出結果。 */
export interface MarketImpliedPlaceProbabilities {
  /** 馬番→Σ=min(3,頭数)に正規化した市場含意確率。算出不能なら null。 */
  readonly values: ReadonlyMap<number, number> | null;
  /** values が null のときの理由。 */
  readonly reason: string | null;
}

/**
 * `1/placeOddsMin` から市場含意複勝確率を求め、Σ=min(3,頭数)に正規化する。
 *
 * `placeOddsMin` が欠損(null)・非有限・0以下の馬が**1頭でもいる**レースは、Σ=一定への
 * 正規化そのものが崩れるため、レース全体の市場系指標を算出不能(`values: null`)として扱う
 * (一部の馬だけ除外して正規化すると、残りの馬の値も歪むため)。
 *
 * `oddsStatus === "yoso"`(発売前)は `OddsSnapshot.place` が常に空オブジェクトになる
 * (複勝オッズ自体が未発売)。呼び出し側が生の `OddsSnapshot.place` から `placeOddsMin` を
 * 引く限り、この関数は必ずこの経路(全馬 `placeOddsMin: null` → 算出不能)に入る。
 *
 * **注意**: `AnalysisRow.placeOddsMin`(`packages/app` の分析結果行)は `yoso` のとき
 * 単勝オッズからの推定値に置き換わっており、生の市場データではない
 * (`computeEstimatedRaceEv`。`expected-value.ts` のJSDoc「本関数は odds.place を一切参照
 * しない」参照)。本関数には必ず `OddsSnapshot.place[umaban].oddsMin` 由来の値(生データ)を
 * 渡すこと。
 */
export function computeMarketImpliedPlaceProbabilities(
  horses: readonly PlaceOddsInputHorse[],
): MarketImpliedPlaceProbabilities {
  if (horses.length === 0) {
    return { values: null, reason: "出走馬が0頭" };
  }
  const inverses: { umaban: number; inv: number }[] = [];
  for (const h of horses) {
    const odds = h.placeOddsMin;
    if (odds === null || !Number.isFinite(odds) || odds <= 0) {
      return {
        values: null,
        reason: `馬番${h.umaban}の複勝オッズ下限が欠損または不正な値のため、レース全体のΣ=一定への正規化が崩れる(oddsStatus="yoso"では常にこの経路に入る)`,
      };
    }
    inverses.push({ umaban: h.umaban, inv: 1 / odds });
  }
  const sumInv = inverses.reduce((s, r) => s + r.inv, 0);
  if (!(sumInv > 0) || !Number.isFinite(sumInv)) {
    return { values: null, reason: "複勝オッズ下限の逆数合計が0以下または非有限" };
  }
  // 複勝は原則3着以内。頭数が3未満のレースはΣの目標を頭数に合わせる
  // (prior.ts の neutralProbFor と同じ min(3,頭数)の考え方に揃える)。
  const target = Math.min(3, horses.length);
  const values = new Map<number, number>();
  for (const r of inverses) {
    values.set(r.umaban, (r.inv / sumInv) * target);
  }
  return { values, reason: null };
}

// ---------------------------------------------------------------------------
// (2) Spearman順位相関
// ---------------------------------------------------------------------------

/** 平均順位法でタイを処理した順位配列を返す(1始まり)。 */
function rankWithTies(values: readonly number[]): number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[order[k]!] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman順位相関係数(平均順位法によるタイ補正込み)。
 * 一方(または両方)の系列が全馬同一値の場合、順位の分散が0になり相関係数を定義できないため
 * `null` を返す(0を返すと「無相関」という積極的な主張になってしまい、
 * 「定義できない」とは意味が異なる)。
 */
export function spearmanRankCorrelation(
  a: readonly number[],
  b: readonly number[],
): NullableMetric {
  if (a.length !== b.length) {
    return metric(null, "入力2系列の長さが一致しない");
  }
  const n = a.length;
  if (n < 2) {
    return metric(null, "頭数が2未満(順位相関を定義できない)");
  }
  const rankA = rankWithTies(a);
  const rankB = rankWithTies(b);
  const meanA = mean(rankA);
  const meanB = mean(rankB);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = rankA[i]! - meanA;
    const db = rankB[i]! - meanB;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa === 0 || sbb === 0) {
    return metric(null, "一方の系列が全馬同順位(順位の分散が0で相関係数を定義できない)");
  }
  return metric(sab / Math.sqrt(saa * sbb), null);
}

// ---------------------------------------------------------------------------
// (3) 分散比・max/min比
// ---------------------------------------------------------------------------

/** 分散比・max/min比の算出結果。 */
export interface VarianceRatioMetrics {
  /** sd(model)/sd(market)。1.0が市場と同等の散らばり。 */
  readonly sdRatio: NullableMetric;
  readonly maxMinRatioModel: NullableMetric;
  readonly maxMinRatioMarket: NullableMetric;
}

/** モデル確率・市場含意確率それぞれの標準偏差比・max/min比を算出する。 */
export function computeVarianceRatioMetrics(
  model: readonly number[],
  market: readonly number[],
): VarianceRatioMetrics {
  if (model.length !== market.length) {
    const reason = "入力2系列の長さが一致しない";
    return {
      sdRatio: metric(null, reason),
      maxMinRatioModel: metric(null, reason),
      maxMinRatioMarket: metric(null, reason),
    };
  }
  const sdModel = populationStdDev(model);
  const sdMarket = populationStdDev(market);
  const sdRatio =
    sdMarket === 0
      ? metric(null, "市場側の標準偏差が0(全馬同一の市場含意確率でゼロ除算)")
      : metric(sdModel / sdMarket, null);
  return {
    sdRatio,
    maxMinRatioModel: maxMinRatio(model),
    maxMinRatioMarket: maxMinRatio(market),
  };
}

// ---------------------------------------------------------------------------
// (4) 三連複同時分布の正規化KL
// ---------------------------------------------------------------------------

/**
 * 確率分布(合計1を想定)の一様分布からのKLダイバージェンスを `log(要素数)` で正規化する。
 * `KL(dist‖uniform) / log(m)`。生KLは組合せ数 m(=C(頭数,3))に依存しスケールしないため、
 * m が異なるレース間で比較可能にする(#35の看板「一様分布からの乖離」をスケール不変にしたもの)。
 *
 * - `m<=1` は `log(m)<=0` となり正規化できないため `null`。
 * - `p=0` の要素は `0·log(0/q) = 0`(標準的な情報理論の慣例)として扱い、寄与をスキップする
 *   (`Math.log(0)` による `-Infinity` や `0 * -Infinity = NaN` の伝播を避ける)。
 */
export function normalizedKlDivergenceFromUniform(
  probabilities: readonly number[],
): NullableMetric {
  const m = probabilities.length;
  if (m <= 1) {
    return metric(null, "組合せ数が1以下(log(組数)<=0でスケール不変にできない)");
  }
  const uniform = 1 / m;
  let kl = 0;
  for (const p of probabilities) {
    if (p <= 0) {
      continue;
    }
    kl += p * Math.log(p / uniform);
  }
  return metric(kl / Math.log(m), null);
}

/**
 * 三連複(上位3着の組合せ)の同時分布を `CONDITIONAL_BERNOULLI_MODEL` で構築し、
 * 一様分布からの正規化KLを求める。モデルpriorと市場含意確率のどちらを渡すかは
 * 呼び出し側が選ぶ(同一関数を確率の出どころだけ差し替えて2回呼ぶことで、
 * モデル側・市場側を必ず同じ土俵で比較できる。受け入れ条件5「使ったオッズの種別」を
 * 明示する設計の一部)。
 *
 * 頭数が3未満は三連複の組を構成できないため `null`(3頭ちょうどは組が1通り=m=1となり、
 * 上の `normalizedKlDivergenceFromUniform` 側の `m<=1` 判定で別途 `null` になる。
 * 「頭数<3」と「m=1(3頭ちょうど)」はテスト観点上区別する)。
 */
export function normalizedTrioJointKlDivergence(
  horses: readonly JointModelHorse[],
): NullableMetric {
  if (horses.length < 3) {
    return metric(null, "頭数が3未満(三連複の組を構成できない)");
  }
  const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses, 3);
  return normalizedKlDivergenceFromUniform(distribution.map((o) => o.probability));
}

// ---------------------------------------------------------------------------
// (1) 全点等額購入時の平均EV÷払戻率(三連複専用)
// ---------------------------------------------------------------------------

/** computeTrioAllPointEvOverPayoutRate の判定内訳(判定不能を分母に混ぜない。受け入れ条件7)。 */
export interface TrioAllPointMetricDiagnostics {
  /** 列挙した組合せ総数(= C(頭数,3))。 */
  readonly enumeratedCount: number;
  /** オッズを取得でき、平均EV・払戻率推定の両方に使った組の数。 */
  readonly presentCount: number;
  readonly unfetchedCount: number;
  readonly missingCount: number;
  readonly malformedCount: number;
}

/** computeTrioAllPointEvOverPayoutRate の算出結果。 */
export interface TrioAllPointEvOverPayoutRateResult {
  /** 平均EV ÷ 払戻率推定値(過大評価倍率)。算出不能なら null。 */
  readonly ratio: number | null;
  /** 全点等額購入時の平均EV(= mean(model_prob × odds)、present の組のみ)。 */
  readonly averageEv: number | null;
  /** 払戻率推定値(= 1/Σ(1/odds)、present の組のみ)。 */
  readonly estimatedPayoutRate: number | null;
  readonly diagnostics: TrioAllPointMetricDiagnostics;
  readonly reason: string | null;
}

/**
 * 全点等額購入時の平均EV÷払戻率(三連複専用。受け入れ条件6「ワイドに適用しない」)。
 *
 * 三連複は1レース1組的中のため、市場が効率的なら `Σ(1/odds) = 1/払戻率` が厳密に成立し、
 * 全点等額購入の真の回収率は払戻率そのものになる。モデルpriorから作った同時分布確率 `p_i` と
 * 実際のオッズ `odds_i` から `平均(p_i × odds_i)`(平均EV)を求め、`1/Σ(1/odds_i)`
 * (払戻率推定値)で割ると、モデルが市場含意確率からどれだけ系統的にズレているか
 * (較正の悪さ)を、結果(着順)を待たずに測れる。
 *
 * **部分網羅(unfetched/missing/malformedの組がある)の影響 — バイアスの向きに注意**:
 * 平均EVも払戻率推定値も `present`(オッズ取得済み・数値として正常)の組だけで計算する。
 * 組が一部欠けると `Σ(1/odds)` が本来より小さくなり、その逆数である払戻率推定値は
 * **本来より大きく**出る。「平均EV ÷ 払戻率推定値」の分母が大きくなるため、
 * **過大評価倍率(ratio)は実際より小さく(=モデルが実際より良く見える方向に)出る**。
 * つまりこのバイアスは**モデルに有利な方向**であり、安全側(過小評価側)ではない。
 * `diagnostics` の `unfetchedCount`/`missingCount`/`malformedCount` が0でない場合、
 * `ratio` を額面通りの過大評価倍率として使わないこと。
 *
 * @param horses 出走全頭のモデル確率(複勝圏内確率。同時分布の構築に使う)。
 * @param trioComboOdds 三連複の組合せオッズMap(`buildComboOddsKey`形式のキー)。
 *   4状態判別は既存の `resolveComboOdds`(`combo-bet-allocation.ts`)を再利用し、二重定義しない。
 */
export function computeTrioAllPointEvOverPayoutRate(
  horses: readonly JointModelHorse[],
  trioComboOdds: ReadonlyMap<string, number | null>,
): TrioAllPointEvOverPayoutRateResult {
  const emptyDiagnostics: TrioAllPointMetricDiagnostics = {
    enumeratedCount: 0,
    presentCount: 0,
    unfetchedCount: 0,
    missingCount: 0,
    malformedCount: 0,
  };
  if (horses.length < 3) {
    return {
      ratio: null,
      averageEv: null,
      estimatedPayoutRate: null,
      diagnostics: emptyDiagnostics,
      reason: "頭数が3未満(三連複の組を構成できない)",
    };
  }

  // comboSize(3) === topFinishCount(3) のため、buildDistribution が返す各 PlaceOutcome は
  // そのまま三連複の1組合せに1:1対応する(ワイドのような部分集合の和を取る必要が無い)。
  const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses, 3);

  let sumEv = 0;
  let sumInverseOdds = 0;
  let presentCount = 0;
  let unfetchedCount = 0;
  let missingCount = 0;
  let malformedCount = 0;

  for (const outcome of distribution) {
    const resolution = resolveComboOdds(trioComboOdds, outcome.placed);
    if (resolution.state === "unfetched") {
      unfetchedCount++;
      continue;
    }
    if (resolution.state === "missing") {
      missingCount++;
      continue;
    }
    if (resolution.state === "malformed") {
      malformedCount++;
      continue;
    }
    presentCount++;
    sumEv += outcome.probability * resolution.odds;
    sumInverseOdds += 1 / resolution.odds;
  }

  const diagnostics: TrioAllPointMetricDiagnostics = {
    enumeratedCount: distribution.length,
    presentCount,
    unfetchedCount,
    missingCount,
    malformedCount,
  };

  if (presentCount === 0) {
    return {
      ratio: null,
      averageEv: null,
      estimatedPayoutRate: null,
      diagnostics,
      reason: "オッズを取得できた組が0件",
    };
  }

  const averageEv = sumEv / presentCount;
  const estimatedPayoutRate = 1 / sumInverseOdds;
  return {
    ratio: averageEv / estimatedPayoutRate,
    averageEv,
    estimatedPayoutRate,
    diagnostics,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// 集約: buildProbabilityQualityReport(想定される唯一のエントリポイント)
// ---------------------------------------------------------------------------

/** prior の出どころ。本モジュールからは判別できない唯一の申告項目(上記JSDoc参照)。 */
export type PriorSource = "prior-only" | "llm-adjusted";

/** buildProbabilityQualityReport の1頭分の入力。 */
export interface ProbabilityQualityInputHorse {
  readonly umaban: number;
  /** 確率の質を測る対象確率(prior または LLM補正後確率。出どころは priorSource で明示)。 */
  readonly modelProb: number;
  /** 複勝オッズ下限(生の `OddsSnapshot.place[umaban].oddsMin`。yosoでは常にnull)。 */
  readonly placeOddsMin: number | null;
}

/** buildProbabilityQualityReport の入力。 */
export interface ProbabilityQualityReportInput {
  readonly horses: readonly ProbabilityQualityInputHorse[];
  /** `OddsSnapshot.oddsStatus` をそのまま渡す(自動導出。解釈を挟まない)。 */
  readonly oddsStatus: OddsStatus;
  /** 三連複の組合せオッズMap(`OddsSnapshot.trioCombo` を `Map`化したもの)。 */
  readonly trioComboOdds: ReadonlyMap<string, number | null>;
  /** 唯一の申告項目。本モジュールの入力からは判別できない外部の事実。 */
  readonly priorSource: PriorSource;
  /**
   * `filterRaceDataBefore` の実際の戻り値。適用していなければ `null`。
   * 「適用した」という自己申告のbooleanではなく、実測の診断値オブジェクトを渡す。
   */
  readonly leakFilter: SnapshotFilterDiagnostics | null;
}

/** 計測条件(受け入れ条件5・5')。数値と必ず同梱される。 */
export interface MeasurementConditions {
  readonly priorSource: PriorSource;
  readonly oddsStatus: OddsStatus;
  readonly fieldSize: number;
  readonly leakFilterApplied: boolean;
  readonly cutoffDate: string | null;
  readonly removedResultCount: number | null;
  /** 複勝オッズは「下限」であり単一の真値ではないことを明示する固定値(受け入れ条件6')。 */
  readonly placeOddsKind: "placeOddsMinLowerBound";
  /** 三連複オッズは単一値であることを明示する固定値(ワイドの下限とは異なる)。 */
  readonly trioComboOddsKind: "trioComboSingleValue";
}

/** buildProbabilityQualityReport の算出結果一式。 */
export interface ProbabilityQualityReport {
  readonly conditions: MeasurementConditions;
  readonly marketImpliedPlaceProbabilities: MarketImpliedPlaceProbabilities;
  readonly spearmanRho: NullableMetric;
  readonly sdRatio: NullableMetric;
  readonly maxMinRatioModel: NullableMetric;
  readonly maxMinRatioMarket: NullableMetric;
  readonly normalizedJointKlModel: NullableMetric;
  readonly normalizedJointKlMarket: NullableMetric;
  readonly trioAllPointEvOverPayoutRate: TrioAllPointEvOverPayoutRateResult;
}

/**
 * 確率の質の指標を1レース分まとめて算出する、本モジュールの想定エントリポイント。
 * 常に `conditions` を同梱するため、条件抜きの数値が単独で返ることはない
 * (受け入れ条件5)。個別の指標関数(`spearmanRankCorrelation` 等)は単体テスト・
 * 部品としての再利用のために公開しているが、本番の利用者はこの関数を使うことを想定する。
 */
export function buildProbabilityQualityReport(
  input: ProbabilityQualityReportInput,
): ProbabilityQualityReport {
  const fieldSize = input.horses.length;

  const market = computeMarketImpliedPlaceProbabilities(
    input.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.placeOddsMin })),
  );

  const modelProbs = input.horses.map((h) => h.modelProb);
  const marketUnavailableReason =
    market.reason === null
      ? null
      : `市場含意確率が算出できないため算出不能(${market.reason})`;

  let spearmanRho: NullableMetric;
  let varianceRatio: VarianceRatioMetrics;
  let normalizedJointKlMarket: NullableMetric;

  if (market.values === null) {
    spearmanRho = metric(null, marketUnavailableReason);
    varianceRatio = {
      sdRatio: metric(null, marketUnavailableReason),
      maxMinRatioModel: maxMinRatio(modelProbs),
      maxMinRatioMarket: metric(null, marketUnavailableReason),
    };
    normalizedJointKlMarket = metric(null, marketUnavailableReason);
  } else {
    const marketValues = market.values;
    const marketProbsAligned = input.horses.map((h) => marketValues.get(h.umaban)!);
    spearmanRho = spearmanRankCorrelation(modelProbs, marketProbsAligned);
    varianceRatio = computeVarianceRatioMetrics(modelProbs, marketProbsAligned);
    normalizedJointKlMarket = normalizedTrioJointKlDivergence(
      input.horses.map((h) => ({ umaban: h.umaban, placeProb: marketValues.get(h.umaban)! })),
    );
  }

  const jointHorsesModel: JointModelHorse[] = input.horses.map((h) => ({
    umaban: h.umaban,
    placeProb: h.modelProb,
  }));
  const normalizedJointKlModel = normalizedTrioJointKlDivergence(jointHorsesModel);
  const trioAllPointEvOverPayoutRate = computeTrioAllPointEvOverPayoutRate(
    jointHorsesModel,
    input.trioComboOdds,
  );

  return {
    conditions: {
      priorSource: input.priorSource,
      oddsStatus: input.oddsStatus,
      fieldSize,
      leakFilterApplied: input.leakFilter !== null,
      cutoffDate: input.leakFilter?.cutoffDate ?? null,
      removedResultCount: input.leakFilter?.removedCount ?? null,
      placeOddsKind: "placeOddsMinLowerBound",
      trioComboOddsKind: "trioComboSingleValue",
    },
    marketImpliedPlaceProbabilities: market,
    spearmanRho,
    sdRatio: varianceRatio.sdRatio,
    maxMinRatioModel: varianceRatio.maxMinRatioModel,
    maxMinRatioMarket: varianceRatio.maxMinRatioMarket,
    normalizedJointKlModel,
    normalizedJointKlMarket,
    trioAllPointEvOverPayoutRate,
  };
}
