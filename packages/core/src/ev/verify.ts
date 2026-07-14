/**
 * verify集計。仕様「4. ev」の verify機能、および仕様「注意事項」:
 *   「verify結果に『推定確率帯ごとの実際の複勝率』を出力すること」。
 *
 * 保存済み分析(AnalysisStore)×実結果から次を算出する:
 * - 累積回収率: EVプラス馬券を複勝100円ずつ買ったと仮定した回収率。
 * - キャリブレーション表: 推定確率帯(0-10%..90-100%)ごとの予測件数と実際の複勝率。
 *
 * 同一レースの複数分析の扱い(二重計上防止):
 * - 同一レースは発走前と発走直前(オッズ再取得)で複数回分析されうる。すべてを独立に集計すると、
 *   同じレース結果で回収率もキャリブレーションも二重計上され、指標が歪む。
 * - **既定モード(latest)**: レースごとに最新の分析1件のみを集計する。「最新」は analyzed_at の
 *   文字列比較で最大のもの、同時刻タイのときは id の大きい方(後に保存した方)を採用する決定的規則。
 *   集計しなかった同一レースの旧分析は supersededAnalysisCount に計上する。
 * - **includeAllAnalyses=true(全件モード)**: 従来どおり全分析を独立に集計する(旧挙動のオプトイン)。
 *   同一レースを複数回分析している場合は上記の二重計上が起きる点に注意。集計対象の重複を意図する
 *   バックテスト等で使う。このモードでは supersededAnalysisCount は常に0。
 *
 * 回収率(実配当優先・近似フォールバック):
 * - 結果取込で複勝の確定払戻(placePayout。100円あたりの円)を保存していれば、的中時の払戻に
 *   実配当を用いる(賭け金が100円以外でも 100円あたりで按分)。これが本来の回収率。
 * - 実配当が未取込(旧データ・払戻テーブル欠損)の場合のみ、「保存済み複勝オッズ下限 × 賭け金」で
 *   近似する。下限を使うため近似時の回収率は保守的(実際よりやや低め)に出る。
 * - どちらで払戻を計上したかは bet.actualPayoutCount / bet.approximatePayoutCount に内訳を出す
 *   (的中して払戻を計上した点のみが対象。不的中は払戻0でどちらのカウンタにも入らない)。
 * - 的中判定は実着順3着以内(複勝圏)。着順不明・非数値(finishPosition=null)は集計対象外とし、
 *   賭け金・払戻の双方から除外する(勝敗が確定できないため)。
 *
 * 結果が保存されていない分析はレポートから除外し、その件数を報告する(仕様の要件)。
 *
 * 推定EV分析の除外(Task#25):
 * - 発売前(oddsStatus=yoso)は単勝オッズから推定した複勝下限でEVを概算するため、確定EVより
 *   誤差が大きい(±20〜30%程度)。回収率・キャリブレーションの数値に紛れ込むと指標の信頼性を
 *   損なうため、evEstimated=true の分析は既定でレポートから丸ごと除外する
 *   (回収率集計だけでなくキャリブレーション表からも除外する設計判断。理由: verifyは元々
 *   「確定した実績で精度を検証する」機能であり、確定オッズでの再分析が前提の推定値をキャリブレー
 *   ションに混ぜると「確率推定は当たっているが価格は外れている」ケースと見分けが付かなくなる)。
 *   除外件数は excludedEstimatedCount に計上する(結果未保存の excludedAnalysisCount とは別カウンタ)。
 * - 同一レースが推定EV分析の後に確定EV分析で再分析されている場合、latestモードでは通常
 *   確定EV分析の方が新しいため、そちらが「最新」として採用され、推定EV分析は
 *   supersededAnalysisCount(旧分析扱い)に計上される(excludedEstimatedCountには計上しない)。
 *   確定EVへの再分析が行われないまま結果だけが記録された場合にのみ、推定EV分析自体が
 *   「最新」として選ばれ、excludedEstimatedCount に計上される。
 *
 * 補正傾向サマリ(VerifyTrendReport、Task#26 プロンプト改善B):
 * - 回収率・キャリブレーションと同じ母集団(latest選択・推定EV除外・着順不明除外・結果未保存除外)
 *   を対象に、「補正がどう外れているか」を機械可読な構造体で算出する(将来Task#26案Dで
 *   LLMに改善提案を出させる際にそのまま渡せるよう、表示専用の整形文字列は含めない設計)。
 * - (1) 補正方向×結果: 各馬を adjustedProb と prior の差(diff)で「上げ(raised, diff>ε)」
 *   「下げ(lowered, diff<-ε)」「据え置き(unchanged, |diff|<=ε)」の3群に分類し、群ごとに
 *   件数・実複勝率(finish<=placeMaxRank)・平均補正幅(diffの単純平均)を算出する。
 *   ε(directionEpsilon)は VerifyConfig で調整可能(既定0.005)。
 * - (2) 過信バイアス: 既存キャリブレーション表の各帯について、代表予測値(帯の中央値。
 *   例 20-30%帯→0.25)と actualPlaceRate の差(overconfidenceGap = 代表予測値 − 実績。
 *   正なら過信、負なら過小評価)を算出する。予測0件の帯は null。
 * - (3) 印別的中率: mark(◎〇▲△☆注)ごとに件数・複勝率(finish<=placeMaxRank)・
 *   勝率(finish=1)を算出する。mark=null(印なし)も1群として必ず含める。
 */

import type { AnalysisStore, StoredAnalysis } from "./analysis-store.js";
import { PREDICTION_MARKS, type PredictionMark } from "../analyzer/parse-response.js";

/** verify集計の設定。 */
export interface VerifyConfig {
  /** 1点あたりの賭け金(円、既定100)。 */
  readonly stakePerBet: number;
  /** 複勝圏(的中)とみなす上限着順(既定3)。 */
  readonly placeMaxRank: number;
  /** キャリブレーション表の分割数(既定10 → 0-10%..90-100%)。 */
  readonly calibrationBins: number;
  /**
   * true のとき同一レースの全分析を独立に集計する(旧挙動のオプトイン)。既定 false(latestモード:
   * レースごとに最新分析1件のみ)。true では同一レースの複数分析が二重計上されうる点に注意。
   */
  readonly includeAllAnalyses: boolean;
  /**
   * 補正傾向サマリ(1) 補正方向×結果の分類しきい値ε(Task#26)。
   * adjustedProb − prior の差(diff)が ε より大きければ「上げ」、−ε より小さければ「下げ」、
   * それ以外(|diff|<=ε、境界含む)は「据え置き」に分類する。既定0.005。
   */
  readonly directionEpsilon: number;
}

/** 既定のverify設定(latestモード: レースごとに最新分析のみ集計)。 */
export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  stakePerBet: 100,
  placeMaxRank: 3,
  calibrationBins: 10,
  includeAllAnalyses: false,
  directionEpsilon: 0.005,
};

/** キャリブレーション表の1帯。 */
export interface CalibrationBin {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** この帯に入った予測件数(着順不明は除く)。 */
  readonly predictedCount: number;
  /** うち実際に複勝圏(3着以内)に入った件数。 */
  readonly placedCount: number;
  /** 実際の複勝率(placedCount/predictedCount)。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
}

/** 補正方向の分類(Task#26)。「上げ」「下げ」「据え置き」の3値。 */
export type AdjustmentDirection = "raised" | "lowered" | "unchanged";

/** 補正方向×結果の1群(Task#26)。 */
export interface DirectionGroupStat {
  /** 補正方向の分類。 */
  readonly direction: AdjustmentDirection;
  /** この群に入った件数(着順不明は除く)。 */
  readonly count: number;
  /** 実際の複勝率(finish<=placeMaxRank)。件数0なら null。 */
  readonly actualPlaceRate: number | null;
  /** 平均補正幅(adjustedProb − prior の単純平均。符号付き)。件数0なら null。 */
  readonly averageAdjustment: number | null;
}

/** キャリブレーション帯ごとの過信バイアス(Task#26)。既存 CalibrationBin を拡張した構造。 */
export interface CalibrationBiasBin {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** 代表予測値(帯の中央値。例 20-30%帯→0.25)。 */
  readonly representativeProb: number;
  /** この帯に入った予測件数。 */
  readonly predictedCount: number;
  /** 実際の複勝率。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
  /** 過信バイアス(代表予測値 − actualPlaceRate)。正なら過信、負なら過小評価。予測0件なら null。 */
  readonly overconfidenceGap: number | null;
}

/** 印(mark)別の的中率(Task#26)。mark=null(印なし)も1群として含む。 */
export interface MarkStat {
  /** 予想印(◎〇▲△☆注のいずれか。印なしは null)。 */
  readonly mark: PredictionMark | null;
  /** この印が付いた件数(着順不明は除く)。 */
  readonly count: number;
  /** 複勝率(finish<=placeMaxRank)。件数0なら null。 */
  readonly placeRate: number | null;
  /** 勝率(finish=1)。件数0なら null。 */
  readonly winRate: number | null;
}

/**
 * 補正傾向サマリ(Task#26 プロンプト改善B)。将来LLMへ改善提案を出させる際にそのまま渡せるよう、
 * 数値と分類のみで構成する(表示専用の整形文字列は含めない)。
 */
export interface VerifyTrendReport {
  /** (1) 補正方向×結果。raised・lowered・unchanged の3群(必ずこの順で3件)。 */
  readonly directionGroups: readonly DirectionGroupStat[];
  /** (2) キャリブレーションの過信バイアス。既存 calibration と同じ帯構成・同じ順序。 */
  readonly calibrationBias: readonly CalibrationBiasBin[];
  /** (3) 印別的中率。PREDICTION_MARKS の順 + 印なし(null)を末尾に付けた7群。 */
  readonly markStats: readonly MarkStat[];
}

/** 回収率サマリ。 */
export interface VerifyBetSummary {
  /** EVプラスで購入した点数(着順確定分のみ)。 */
  readonly betCount: number;
  /** 賭け金合計(円)。 */
  readonly totalStake: number;
  /**
   * 払戻合計(円)。的中時の払戻は、実配当(placePayout)があればそれを、無ければ
   * 複勝オッズ下限で近似する(下記2カウンタの内訳を参照)。
   */
  readonly totalReturn: number;
  /** 回収率(totalReturn/totalStake)。購入0点なら null。 */
  readonly recoveryRate: number | null;
  /** 的中時の払戻を実配当(placePayout)で計上した件数。 */
  readonly actualPayoutCount: number;
  /** 的中時の払戻を複勝オッズ下限で近似計上した件数(実配当が未取込の分)。 */
  readonly approximatePayoutCount: number;
}

/** verifyレポート。 */
export interface VerifyReport {
  /** 集計に含めた分析件数(結果が保存済みで、集計対象に採用したもの)。 */
  readonly includedAnalysisCount: number;
  /** 結果未保存で除外した分析件数。 */
  readonly excludedAnalysisCount: number;
  /**
   * 結果は保存済みだが、latestモードで同一レースの新しい分析に取って代わられ集計しなかった件数。
   * includeAllAnalyses=true(全件モード)では常に0。
   */
  readonly supersededAnalysisCount: number;
  /**
   * 推定EV(evEstimated=true)のため集計から除外した分析件数(Task#25)。
   * 結果未保存(excludedAnalysisCount)・旧分析(supersededAnalysisCount)のいずれにも
   * 該当しないが、推定EVという理由だけで除外された件数。
   */
  readonly excludedEstimatedCount: number;
  /** 累積回収率サマリ。 */
  readonly bet: VerifyBetSummary;
  /** 推定確率帯ごとのキャリブレーション表。 */
  readonly calibration: CalibrationBin[];
  /** 補正傾向サマリ(Task#26)。 */
  readonly trend: VerifyTrendReport;
}

/** 帯集計の可変カウンタ。 */
interface BinCounter {
  predicted: number;
  placed: number;
}

/**
 * 保存済み分析と実結果から verifyレポートを算出する。
 * @param store 分析・結果を保持する AnalysisStore
 * @param config verify設定(省略時は既定)
 */
export function computeVerifyReport(
  store: AnalysisStore,
  config: VerifyConfig = DEFAULT_VERIFY_CONFIG,
): VerifyReport {
  const { stakePerBet, placeMaxRank, calibrationBins, includeAllAnalyses, directionEpsilon } =
    config;

  const bins: BinCounter[] = Array.from({ length: calibrationBins }, () => ({
    predicted: 0,
    placed: 0,
  }));

  // 補正傾向サマリ(Task#26)の可変カウンタ。回収率・キャリブレーションと同じループで計上する
  // (母集団を既存verifyと揃えるため)。
  const directionCounters: Record<AdjustmentDirection, DirectionCounter> = {
    raised: { count: 0, placed: 0, adjustmentSum: 0 },
    lowered: { count: 0, placed: 0, adjustmentSum: 0 },
    unchanged: { count: 0, placed: 0, adjustmentSum: 0 },
  };
  const markCounters = new Map<PredictionMark | null, MarkCounter>(
    [...PREDICTION_MARKS, null].map((mark) => [mark, { count: 0, placed: 0, won: 0 }]),
  );

  const analyses = store.listAnalyses();
  // latestモードでは「レースごとに最新1件」の分析idを選ぶ。全件モードでは null(全採用)。
  const chosenIds = includeAllAnalyses ? null : chooseLatestPerRace(analyses);

  let includedAnalysisCount = 0;
  let excludedAnalysisCount = 0;
  let supersededAnalysisCount = 0;
  let excludedEstimatedCount = 0;
  let betCount = 0;
  let totalStake = 0;
  let totalReturn = 0;
  let actualPayoutCount = 0;
  let approximatePayoutCount = 0;

  for (const analysis of analyses) {
    const results = store.getResult(analysis.raceId);
    if (results === undefined) {
      // 実結果が未保存の分析はレポートから除外(件数のみ計上)。
      excludedAnalysisCount += 1;
      continue;
    }
    // latestモードで最新に取って代わられた同一レースの旧分析(結果はあるが集計しない)。
    if (chosenIds !== null && !chosenIds.has(analysis.id)) {
      supersededAnalysisCount += 1;
      continue;
    }
    // 推定EV(Task#25): 確定EVより誤差が大きいため、既定でレポートから丸ごと除外する。
    if (analysis.evEstimated) {
      excludedEstimatedCount += 1;
      continue;
    }
    includedAnalysisCount += 1;

    // 馬番 → 実着順(finishPosition)。非数値着順は null。
    const finishByUmaban = new Map<number, number | null>(
      results.map((r) => [r.umaban, r.finishPosition]),
    );
    // 馬番 → 複勝確定払戻(100円あたりの円)。未取込は null/undefined。
    const payoutByUmaban = new Map<number, number | null | undefined>(
      results.map((r) => [r.umaban, r.placePayout]),
    );

    for (const horse of analysis.horses) {
      const finish = finishByUmaban.get(horse.umaban);
      // 実着順が確定していない(結果に馬番がない/非数値)馬は集計対象外。
      if (finish === undefined || finish === null) {
        continue;
      }
      const isPlaced = finish <= placeMaxRank;

      // キャリブレーション: 全馬(推定確率帯ごと)に計上する。
      const binIndex = binIndexFor(horse.adjustedProb, calibrationBins);
      bins[binIndex]!.predicted += 1;
      if (isPlaced) {
        bins[binIndex]!.placed += 1;
      }

      // 補正傾向サマリ(1) 補正方向×結果: diff の符号とεで3群に分類する(Task#26)。
      const diff = horse.adjustedProb - horse.prior;
      const direction: AdjustmentDirection =
        diff > directionEpsilon ? "raised" : diff < -directionEpsilon ? "lowered" : "unchanged";
      const dCounter = directionCounters[direction];
      dCounter.count += 1;
      dCounter.adjustmentSum += diff;
      if (isPlaced) {
        dCounter.placed += 1;
      }

      // 補正傾向サマリ(3) 印別的中率: mark(印なしのnullを含む)ごとに計上する(Task#26)。
      const mCounter = markCounters.get(horse.mark)!;
      mCounter.count += 1;
      if (isPlaced) {
        mCounter.placed += 1;
      }
      if (finish === 1) {
        mCounter.won += 1;
      }

      // 回収率: EVプラス馬券のみ複勝を stakePerBet 円で購入したと仮定。
      if (horse.isPositive && horse.placeOddsMin !== null) {
        betCount += 1;
        totalStake += stakePerBet;
        if (isPlaced) {
          // 的中時の払戻: 実配当(placePayout)があればそれを100円あたりで按分して用い、
          // 無ければ複勝オッズ下限で近似する。どちらを使ったかを件数で記録する。
          const actualPayout = payoutByUmaban.get(horse.umaban);
          if (actualPayout !== undefined && actualPayout !== null) {
            totalReturn += actualPayout * (stakePerBet / 100);
            actualPayoutCount += 1;
          } else {
            totalReturn += stakePerBet * horse.placeOddsMin;
            approximatePayoutCount += 1;
          }
        }
      }
    }
  }

  const calibration = bins.map((c, i) => finalizeBin(c, i, calibrationBins));

  return {
    includedAnalysisCount,
    excludedAnalysisCount,
    supersededAnalysisCount,
    excludedEstimatedCount,
    bet: {
      betCount,
      totalStake,
      totalReturn,
      recoveryRate: totalStake === 0 ? null : totalReturn / totalStake,
      actualPayoutCount,
      approximatePayoutCount,
    },
    calibration,
    trend: {
      directionGroups: (["raised", "lowered", "unchanged"] as const).map((direction) =>
        finalizeDirectionGroup(direction, directionCounters[direction]),
      ),
      calibrationBias: calibration.map(toCalibrationBiasBin),
      markStats: [...PREDICTION_MARKS, null].map((mark) =>
        finalizeMarkStat(mark, markCounters.get(mark)!),
      ),
    },
  };
}

/** 補正方向×結果の可変カウンタ(Task#26)。 */
interface DirectionCounter {
  count: number;
  placed: number;
  adjustmentSum: number;
}

/** 印別的中率の可変カウンタ(Task#26)。 */
interface MarkCounter {
  count: number;
  placed: number;
  won: number;
}

/** DirectionCounter を DirectionGroupStat(件数0は null)へ確定する。 */
function finalizeDirectionGroup(
  direction: AdjustmentDirection,
  counter: DirectionCounter,
): DirectionGroupStat {
  return {
    direction,
    count: counter.count,
    actualPlaceRate: counter.count === 0 ? null : counter.placed / counter.count,
    averageAdjustment: counter.count === 0 ? null : counter.adjustmentSum / counter.count,
  };
}

/** MarkCounter を MarkStat(件数0は null)へ確定する。 */
function finalizeMarkStat(mark: PredictionMark | null, counter: MarkCounter): MarkStat {
  return {
    mark,
    count: counter.count,
    placeRate: counter.count === 0 ? null : counter.placed / counter.count,
    winRate: counter.count === 0 ? null : counter.won / counter.count,
  };
}

/**
 * 確定済み CalibrationBin から CalibrationBiasBin(代表予測値・過信バイアス付き)を導出する。
 * 既存キャリブレーションと同じ集計(母集団・件数・実複勝率)をそのまま再利用する。
 */
function toCalibrationBiasBin(bin: CalibrationBin): CalibrationBiasBin {
  const representativeProb = (bin.lowerBound + bin.upperBound) / 2;
  return {
    lowerBound: bin.lowerBound,
    upperBound: bin.upperBound,
    representativeProb,
    predictedCount: bin.predictedCount,
    actualPlaceRate: bin.actualPlaceRate,
    overconfidenceGap:
      bin.actualPlaceRate === null ? null : representativeProb - bin.actualPlaceRate,
  };
}

/**
 * レースごとに最新の分析1件を選び、その分析idの集合を返す(latestモード用)。
 * 「最新」は analyzed_at の文字列比較で最大のもの。同時刻タイのときは id の大きい方
 * (後に保存した方)を採用する決定的規則とする(ISO日時文字列は辞書順=時系列順)。
 */
function chooseLatestPerRace(analyses: readonly StoredAnalysis[]): Set<number> {
  const latestByRace = new Map<string, StoredAnalysis>();
  for (const a of analyses) {
    const current = latestByRace.get(a.raceId);
    if (current === undefined || isNewer(a, current)) {
      latestByRace.set(a.raceId, a);
    }
  }
  return new Set(Array.from(latestByRace.values(), (a) => a.id));
}

/** a が b より新しいか(analyzed_at 優先、タイは id 大)。決定的な順序規則。 */
function isNewer(a: StoredAnalysis, b: StoredAnalysis): boolean {
  if (a.analyzedAt !== b.analyzedAt) {
    return a.analyzedAt > b.analyzedAt;
  }
  return a.id > b.id;
}

/**
 * 推定確率を確率帯インデックスに写す。帯は下限を含み上限を含まない。
 * 確率1.0(および>1のはみ出し)は最終帯に丸める。負値は先頭帯に丸める。
 */
function binIndexFor(prob: number, binCount: number): number {
  const raw = Math.floor(prob * binCount);
  return Math.min(Math.max(raw, 0), binCount - 1);
}

/** カウンタを CalibrationBin(境界と複勝率付き)へ確定する。 */
function finalizeBin(
  counter: BinCounter,
  index: number,
  binCount: number,
): CalibrationBin {
  return {
    lowerBound: index / binCount,
    upperBound: (index + 1) / binCount,
    predictedCount: counter.predicted,
    placedCount: counter.placed,
    actualPlaceRate:
      counter.predicted === 0 ? null : counter.placed / counter.predicted,
  };
}
