/**
 * probability-quality — 確率の質を測る計測基盤の公開エントリポイント(#40「#35-1a: 確率の質を
 * 測る計測基盤の健全化と指標の実装」)。
 *
 * ## このモジュールがやらないこと(スコープ外)
 * **測るだけ**で、確率の出し方には一切手を入れない。`prior.ts`・`place-joint-model.ts`・
 * `combo-bet-allocation.ts`・`expected-value.ts` の挙動は一切変更しない。較正(calibration)方式の
 * 実装・検討は #42、サンプル拡大・LLM実行は別Issue。
 *
 * ## 公開範囲を意図的に絞っている(受け入れ条件5'。code-reviewer指摘・boss判断(b)採用)
 * 4つの指標の低レベル実装(`spearmanRankCorrelation`・`computeVarianceRatioMetrics`・
 * `normalizedKlDivergenceFromUniform`・`normalizedTrioJointKlDivergence`・
 * `computeMarketImpliedPlaceProbabilities`・`computeTrioAllPointEvOverPayoutRate`)は
 * `./probability-quality-metrics.js`(`packages/core/package.json` の `exports` に**載せていない**
 * 内部ファイル)に置いた。このファイル(`probability-quality.ts`)は `exports` サブパス
 * `./ev/probability-quality` が指すファイルであり、**`buildProbabilityQualityReport` と
 * それが必要とする型だけを外部(パッケージ境界の外)へ公開する**。
 *
 * 以前は低レベル関数もこのファイルに同居し、`exports` サブパス経由で直接呼べてしまっていた
 * (`conditions` を伴わない裸の数値が取得できてしまう。JSDocの「本番の利用者はこの関数を使うことを
 * 想定する」は規約であって強制ではなかった)。ファイルを分けることで、「低レベル関数はパッケージ
 * 境界の外から到達できない」という制約を**TypeScriptのモジュール境界そのもの**で強制する
 * (grep等のソース走査ガードのように、後から静かに緩められたり回避されたりする余地が無い。
 * #28でソース走査ガードが退行を素通りした実績があるため、本タスクではこの形は採らなかった)。
 * `packages/core` 内部(自パッケージのテスト)は直接の相対パスで低レベル関数を参照できる
 * (パッケージ境界の内側なので `exports` の制約を受けない)。
 *
 * ## 計測条件は必ず添付する(受け入れ条件5・5')
 * `buildProbabilityQualityReport` が唯一の公開エントリポイントであり、常に `conditions` を
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
 */

import type { OddsStatus } from "../scraper/types.js";
import type { SnapshotFilterDiagnostics } from "../scorer/snapshot-filter.js";
import type { JointModelHorse } from "./place-joint-model.js";
import {
  computeMarketImpliedPlaceProbabilities,
  computeMaxMinRatio,
  computeTrioAllPointEvOverPayoutRate,
  computeVarianceRatioMetrics,
  normalizedTrioJointKlDivergence,
  spearmanRankCorrelation,
  type MarketImpliedPlaceProbabilities,
  type NullableMetric,
  type TrioAllPointEvOverPayoutRateResult,
  type VarianceRatioMetrics,
} from "./probability-quality-metrics.js";

// 低レベル関数・型は再exportしない(このファイルの公開範囲を意図的に絞る本体)。
// core内部で低レベル関数を直接使いたい場合は
// `./probability-quality-metrics.js` を直接importすること(パッケージ境界の内側限定)。
export type {
  MarketImpliedPlaceProbabilities,
  NullableMetric,
  TrioAllPointEvOverPayoutRateResult,
  VarianceRatioMetrics,
};

// ---------------------------------------------------------------------------
// 集約: buildProbabilityQualityReport(唯一の公開エントリポイント)
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
 * 確率の質の指標を1レース分まとめて算出する、本モジュールの唯一の公開エントリポイント。
 * 常に `conditions` を同梱するため、条件抜きの数値が単独で返ることはない(受け入れ条件5)。
 * 個々の指標の低レベル実装(`spearmanRankCorrelation` 等)は `./probability-quality-metrics.js`
 * にあり、このファイル(パッケージ境界)からは意図的に到達不能にしている(受け入れ条件5'。
 * 上記モジュールJSDoc参照)。
 */
export function buildProbabilityQualityReport(
  input: ProbabilityQualityReportInput,
): ProbabilityQualityReport {
  const fieldSize = input.horses.length;

  const market = computeMarketImpliedPlaceProbabilities(
    input.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.placeOddsMin })),
  );

  const modelProbs = input.horses.map((h) => h.modelProb);

  let spearmanRho: NullableMetric;
  let varianceRatio: VarianceRatioMetrics;
  let normalizedJointKlMarket: NullableMetric;

  if (market.values === null) {
    // 判別共用体により、この分岐では market.reason が string 型に確定する
    // (values:null と reason:string が必ずペアになる)。
    const marketUnavailableReason = `市場含意確率が算出できないため算出不能(${market.reason})`;
    spearmanRho = { value: null, reason: marketUnavailableReason };
    varianceRatio = {
      sdRatio: { value: null, reason: marketUnavailableReason },
      // 市場側が使えない場合でも、モデル側だけで完結するmax/min比は独立して算出する
      // (受け入れ条件・粒度を保つ設計。computeMaxMinRatio自身がNaN・Infinity・負値を検証する)。
      maxMinRatioModel: computeMaxMinRatio(modelProbs),
      maxMinRatioMarket: { value: null, reason: marketUnavailableReason },
    };
    normalizedJointKlMarket = { value: null, reason: marketUnavailableReason };
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
