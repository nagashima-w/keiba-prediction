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
 */

import type { AnalysisStore, StoredAnalysis } from "./analysis-store.js";

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
}

/** 既定のverify設定(latestモード: レースごとに最新分析のみ集計)。 */
export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  stakePerBet: 100,
  placeMaxRank: 3,
  calibrationBins: 10,
  includeAllAnalyses: false,
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
  const { stakePerBet, placeMaxRank, calibrationBins, includeAllAnalyses } = config;

  const bins: BinCounter[] = Array.from({ length: calibrationBins }, () => ({
    predicted: 0,
    placed: 0,
  }));

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
    calibration: bins.map((c, i) => finalizeBin(c, i, calibrationBins)),
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
