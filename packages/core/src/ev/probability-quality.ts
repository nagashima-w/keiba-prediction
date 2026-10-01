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
 *   **#39 以降の注意**: production(`runAnalysis`)が先読みリークを自分で遮断するようになった
 *   ため、`runAnalysis` の出力を測る限り、値は診断値の有無に関わらず遮断済みである。
 *   `leakFilterApplied=false` は「診断値が渡されなかった」の意味であり、「値がリークありである」
 *   ことは意味しない(リークありの値は `runAnalysis` からは作れない)。
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
  bootstrapBrierDifferenceByRace,
  brierSkillScore,
  computeBrierDecomposition,
  computeBrierScore,
  computeMarketImpliedPlaceProbabilities,
  computeMaxMinRatio,
  computeTrioAllPointEvOverPayoutRate,
  computeVarianceRatioMetrics,
  normalizedTrioJointKlDivergence,
  spearmanRankCorrelation,
  withinRacePermutationResolution,
  type BootstrapOptions,
  type BrierDecompositionResult,
  type BrierDifferenceBootstrapResult,
  type BrierObservation,
  type MarketImpliedPlaceProbabilities,
  type NullableMetric,
  type PermutationResolutionResult,
  type RaceSquaredErrorPair,
  type TrioAllPointEvOverPayoutRateResult,
  type VarianceRatioMetrics,
} from "./probability-quality-metrics.js";

// 低レベル関数・型は再exportしない(このファイルの公開範囲を意図的に絞る本体)。
// core内部で低レベル関数を直接使いたい場合は
// `./probability-quality-metrics.js` を直接importすること(パッケージ境界の内側限定)。
export type {
  BrierDecompositionResult,
  BrierDifferenceBootstrapResult,
  MarketImpliedPlaceProbabilities,
  NullableMetric,
  PermutationResolutionResult,
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

// ---------------------------------------------------------------------------
// Brier・Murphy 分解・対市場比較(#41「#35-1b」。着順が必要な指標。公開エントリポイント)
// ---------------------------------------------------------------------------

/**
 * 市場との比較に使う最小の出走頭数。複勝が3着まで払い戻されるのは8頭以上
 * (5〜7頭は2着まで・4頭以下は発売なし。`resolvePlaceBetTarget`)で、Σ=3 に正規化した
 * 市場含意確率は8頭以上のレースでしか「3着以内」と同じ事象を表さない。
 * **頭数は取消・除外を除いた出走頭数**(呼び出し側が取消馬を入力から除くこと)。
 */
export const MIN_FIELD_SIZE_FOR_PLACE_MARKET = 8;

/** buildBrierQualityReport の1頭分の入力(出走した馬のみ。取消・除外は呼び出し側で除く)。 */
export interface BrierQualityInputHorse {
  readonly raceId: string;
  readonly umaban: number;
  /** 確率の質を測る対象確率(prior または LLM補正後確率)。 */
  readonly modelProb: number;
  /** 実際に3着以内に入ったか(同着で4頭以上になる場合は全員 true)。 */
  readonly occurred: boolean;
  /** 複勝オッズ下限(生の `OddsSnapshot.place[umaban].oddsMin`)。 */
  readonly placeOddsMin: number | null;
  /** 複勝オッズ上限(生の `OddsSnapshot.place[umaban].oddsMax`)。中点版の感度に使う。 */
  readonly placeOddsMax: number | null;
}

/** buildBrierQualityReport の入力。 */
export interface BrierQualityReportInput {
  readonly horses: readonly BrierQualityInputHorse[];
  /** 申告項目(本モジュールからは判別できない)。 */
  readonly priorSource: PriorSource;
  /** レース単位ブートストラップの反復回数とシード(取得前の分析計画で固定した値を渡す)。 */
  readonly bootstrap: BootstrapOptions;
  /** resolution の参照値(レース内ラベル並べ替え)の反復回数とシード。 */
  readonly permutation: BootstrapOptions;
  /**
   * 市場比較に使えない(オッズが確定でない)レースの ID。呼び出し側(取得したオッズの状態を知っている側)が
   * 渡す。これらは市場比較から外し、`excludedRaces.oddsNotFinal` に数える(「複勝オッズの欠損・不正」には
   * 数えない)。頭数が8未満のレースは `smallField` が優先。モデル単独の集計には入る。
   */
  readonly oddsNotFinalRaceIds?: readonly string[];
}

/** 市場確率の作り方。 */
export type BrierMarketKind = "placeOddsMinLowerBound" | "placeOddsMidpoint";

/** Brier 計測の条件。数値と必ず同梱される。 */
export interface BrierQualityConditions {
  readonly priorSource: PriorSource;
  /** 市場比較に使う最小頭数(出走頭数)。 */
  readonly minFieldSizeForMarket: number;
  /** 主表(下限版)と感度(中点版)の市場確率の作り方。 */
  readonly marketKinds: {
    readonly lowerBound: "placeOddsMinLowerBound";
    readonly midpoint: "placeOddsMidpoint";
  };
  readonly bootstrap: BootstrapOptions;
  readonly permutation: BootstrapOptions;
}

/** 市場比較から除外したレース(理由別のレースID)。 */
export interface BrierMarketExclusions {
  /** 出走頭数が最小頭数(8)未満。 */
  readonly smallField: readonly string[];
  /** オッズが確定でない(呼び出し側の申告。`oddsNotFinalRaceIds`)。頭数が8未満ならそちらが優先。 */
  readonly oddsNotFinal: readonly string[];
  /** 複勝オッズ(下限、中点版では下限と上限)が1頭でも欠損・不正で、市場含意確率を作れない。 */
  readonly marketUnavailable: readonly string[];
  /** 市場含意確率が1を超える馬がいる(黙ってクリップせず、レースごと比較から外す)。 */
  readonly marketOutOfRange: readonly string[];
}

/** 市場との比較1通り分(同じレース集合の対で比べる)。 */
export interface BrierMarketComparison {
  readonly marketKind: BrierMarketKind;
  readonly eligibleRaceCount: number;
  readonly eligibleObservationCount: number;
  readonly excludedRaces: BrierMarketExclusions;
  /** 比較集合でのモデルの Brier。 */
  readonly modelBrier: NullableMetric;
  /** 比較集合での市場の Brier。 */
  readonly marketBrier: NullableMetric;
  /** 1 − BS_model / BS_market。正ならモデルが市場より良い。 */
  readonly brierSkillVsMarket: NullableMetric;
  readonly modelDecomposition: BrierDecompositionResult;
  readonly marketDecomposition: BrierDecompositionResult;
  /** Brier 差(model − market。正ならモデルが悪い)のレース単位ブートストラップ。 */
  readonly brierDifference: BrierDifferenceBootstrapResult;
}

/** buildBrierQualityReport の算出結果一式。 */
export interface BrierQualityReport {
  readonly conditions: BrierQualityConditions;
  readonly raceCount: number;
  readonly observationCount: number;
  /** モデル単独(全レース。頭数に依らない)。 */
  readonly model: {
    readonly brier: NullableMetric;
    readonly decomposition: BrierDecompositionResult;
    /** 気候値(全体の発生率を全馬に当てる予測)に対する skill = 1 − BS/UNC。 */
    readonly brierSkillVsClimatology: NullableMetric;
    /**
     * resolution の参照値(各レース内で結果の割り当てを並べ替えた場合の分布。平均と95点)。
     * 小標本では識別力が無くても resolution は正に偏るため、「0に近いか」はこれと並べて読む。
     */
    readonly resolutionNull: PermutationResolutionResult;
  };
  readonly marketComparison: {
    /** 主表: 複勝オッズ下限から作った市場含意確率。 */
    readonly lowerBound: BrierMarketComparison;
    /** 感度: 複勝オッズの下限と上限の中点から作った市場含意確率。 */
    readonly midpoint: BrierMarketComparison;
  };
}

/** raceId ごとに馬をまとめる(最初に現れた順を保つ)。 */
function groupByRace(
  horses: readonly BrierQualityInputHorse[],
): Array<{ readonly raceId: string; readonly horses: BrierQualityInputHorse[] }> {
  const map = new Map<string, BrierQualityInputHorse[]>();
  for (const h of horses) {
    const list = map.get(h.raceId);
    if (list === undefined) {
      map.set(h.raceId, [h]);
    } else {
      list.push(h);
    }
  }
  return Array.from(map, ([raceId, list]) => ({ raceId, horses: list }));
}

/** 複勝オッズ(下限・上限)から、その作り方に応じた「市場側が使うオッズ」を引く。 */
function oddsFor(kind: BrierMarketKind, h: BrierQualityInputHorse): number | null {
  if (kind === "placeOddsMinLowerBound") {
    return h.placeOddsMin;
  }
  if (h.placeOddsMin === null || h.placeOddsMax === null) {
    return null;
  }
  return (h.placeOddsMin + h.placeOddsMax) / 2;
}

function compareWithMarket(
  kind: BrierMarketKind,
  races: ReturnType<typeof groupByRace>,
  bootstrap: BootstrapOptions,
  oddsNotFinal: ReadonlySet<string>,
): BrierMarketComparison {
  const smallField: string[] = [];
  const oddsNotFinalExcluded: string[] = [];
  const marketUnavailable: string[] = [];
  const marketOutOfRange: string[] = [];
  const modelObservations: BrierObservation[] = [];
  const marketObservations: BrierObservation[] = [];
  const pairs: RaceSquaredErrorPair[] = [];

  for (const r of races) {
    if (r.horses.length < MIN_FIELD_SIZE_FOR_PLACE_MARKET) {
      smallField.push(r.raceId);
      continue;
    }
    if (oddsNotFinal.has(r.raceId)) {
      oddsNotFinalExcluded.push(r.raceId);
      continue;
    }
    const market = computeMarketImpliedPlaceProbabilities(
      r.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: oddsFor(kind, h) })),
    );
    if (market.values === null) {
      marketUnavailable.push(r.raceId);
      continue;
    }
    const values = market.values;
    const marketProbs = r.horses.map((h) => values.get(h.umaban)!);
    if (marketProbs.some((p) => p > 1)) {
      marketOutOfRange.push(r.raceId);
      continue;
    }
    let modelSse = 0;
    let marketSse = 0;
    r.horses.forEach((h, i) => {
      const outcome = h.occurred ? 1 : 0;
      modelObservations.push({ probability: h.modelProb, occurred: h.occurred });
      marketObservations.push({ probability: marketProbs[i]!, occurred: h.occurred });
      modelSse += (h.modelProb - outcome) ** 2;
      marketSse += (marketProbs[i]! - outcome) ** 2;
    });
    pairs.push({ count: r.horses.length, modelSse, marketSse });
  }

  const modelBrier = computeBrierScore(modelObservations);
  const marketBrier = computeBrierScore(marketObservations);
  const brierSkillVsMarket =
    modelBrier.value === null
      ? modelBrier
      : marketBrier.value === null
        ? marketBrier
        : brierSkillScore(modelBrier.value, marketBrier.value);

  return {
    marketKind: kind,
    eligibleRaceCount: pairs.length,
    eligibleObservationCount: modelObservations.length,
    excludedRaces: { smallField, oddsNotFinal: oddsNotFinalExcluded, marketUnavailable, marketOutOfRange },
    modelBrier,
    marketBrier,
    brierSkillVsMarket,
    modelDecomposition: computeBrierDecomposition(modelObservations),
    marketDecomposition: computeBrierDecomposition(marketObservations),
    brierDifference: bootstrapBrierDifferenceByRace(pairs, bootstrap),
  };
}

/**
 * 確率の質(着順が必要な指標)を全レース分まとめて算出する公開エントリポイント。
 * 常に `conditions` を同梱する(条件抜きの数値を返さない。`buildProbabilityQualityReport` と同じ方針)。
 *
 * - **モデル単独**: 頭数に関係なく全観測で Brier・Murphy 分解・気候値に対する skill。
 * - **市場との比較**: 出走8頭以上で、市場含意確率を作れて1を超えない馬だけのレースの
 *   **同じ集合の対**で比べる(モデル側もその集合に絞る)。除外したレースは理由別にIDを残す。
 *   主表は複勝オッズ下限版、感度として中点版を並記する。
 * - 範囲外の確率はクリップせず `reason` 付き null にする。
 */
export function buildBrierQualityReport(input: BrierQualityReportInput): BrierQualityReport {
  const races = groupByRace(input.horses);
  const notFinal = new Set(input.oddsNotFinalRaceIds ?? []);
  const modelObservations: BrierObservation[] = input.horses.map((h) => ({
    probability: h.modelProb,
    occurred: h.occurred,
  }));
  const decomposition = computeBrierDecomposition(modelObservations);
  const brierSkillVsClimatology: NullableMetric =
    decomposition.decomposition === null
      ? { value: null, reason: decomposition.reason }
      : brierSkillScore(decomposition.decomposition.brier, decomposition.decomposition.uncertainty);

  return {
    conditions: {
      priorSource: input.priorSource,
      minFieldSizeForMarket: MIN_FIELD_SIZE_FOR_PLACE_MARKET,
      marketKinds: { lowerBound: "placeOddsMinLowerBound", midpoint: "placeOddsMidpoint" },
      bootstrap: input.bootstrap,
      permutation: input.permutation,
    },
    raceCount: races.length,
    observationCount: input.horses.length,
    model: {
      brier: computeBrierScore(modelObservations),
      decomposition,
      brierSkillVsClimatology,
      resolutionNull: withinRacePermutationResolution(
        races.map((r) => r.horses.map((h) => ({ probability: h.modelProb, occurred: h.occurred }))),
        input.permutation,
      ),
    },
    marketComparison: {
      lowerBound: compareWithMarket("placeOddsMinLowerBound", races, input.bootstrap, notFinal),
      midpoint: compareWithMarket("placeOddsMidpoint", races, input.bootstrap, notFinal),
    },
  };
}
