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
 *
 * プロンプト版別集計(computeVerifyReportByPromptVersion、Task#27 プロンプト改善A):
 * - 「プロンプトを改善したときに本当に良くなったか」を版ごとの成績で比較できる土台。
 *   analyses.prompt_version(analyzer/build-prompt.ts の PROMPT_VERSION の保存値)でグループ化し、
 *   グループごとに既存 computeVerifyReport と同じロジック(latestモード・推定EV除外等)を
 *   独立に適用する。比較軸は prompt_version のみ(model 別比較は入れない。2026-07-14合意)。
 * - 版不明(promptVersion=null。列追加前の旧データ・LLM未使用の分析)も1グループとして扱う。
 *
 * 追加指示の要約(additionalInstructions、Task#28 プロンプト改善C):
 * - 追加指示(analyzer/build-prompt.ts の BuildPromptInput.additionalInstruction)は実質的に
 *   プロンプトを変えるため、PROMPT_VERSION(テンプレート本体の版)が同じでも追加指示が異なれば
 *   別条件として扱う必要がある(docs/prompt-improvement-plan.md 方式C)。そこで
 *   computeVerifyReportByPromptVersion は各版グループについて、そのグループ内の全分析
 *   (report集計時の絞り込み前。結果未保存・推定EV除外等とは無関係に「その版で実際に使われた
 *   追加指示」を把握する目的のため)から additionalInstruction の重複しない値を集めて返す。
 * - 順序は決定的: 非null値は文字列昇順、null(追加指示なし)は末尾。
 *
 * 未知mark文字列への防御(Task#26 boss観察1 / Task#27):
 * - markStats の集計は markCounters(PREDICTION_MARKS+nullの固定キー)への参照を前提にしていたが、
 *   DBのmark列は将来のスキーマ変更・手動DB改変で想定外の文字列が入りうる(analysis-store.ts の
 *   toStoredHorse は型どおりキャストするのみで値の検証はしていない)。非nullアサーション(!)での
 *   参照はその場合にクラッシュするため、未知のキーは「印なし」群にフォールバックする。
 *
 * レース単体の予実ブレークダウン(private buildRaceBreakdown。Task#34。旧公開関数
 * computeRaceBreakdown は検証画面UI統合でレース一覧(computeRaceLedger)に置き換えられ廃止したが、
 * 1レース分の予実を組み立てる下位ロジック自体は computeRaceLedger が引き続き再利用しているため
 * private ヘルパーとして残している):
 * - 検証画面にトータル集計だけでなく、レース単体ごとの予測(印・EVプラス馬・AI補正後3着内率)と
 *   結果(実着順・複勝的中の有無・そのレースの賭け金/払戻/回収)を並べて表示するための土台。
 * - 母集団は既存 computeVerifyReport(latestモードの二重計上防止・推定EV除外・結果未保存除外)と
 *   完全に一致させる(selectIncludedAnalyses に選定ロジックを集約し両者で共有。個別に再実装すると
 *   母集団がズレて「合計と内訳が一致しない」事故になるため)。computeRaceLedger はこの
 *   selectIncludedAnalyses による絞り込みを使わず(結果未保存・推定EVも母集団に含めるため)、
 *   latest選択(chooseLatestPerRace)のみを共有する点が異なる。
 * - 1頭ごとの賭け判定・払戻計算(EVプラス馬に stakePerBet 円賭ける・実配当優先/複勝オッズ下限近似
 *   フォールバック)も computeHorseBetOutcome に集約し、computeVerifyReportForAnalyses と
 *   buildRaceBreakdown の両方から呼ぶことで数値の完全一致を保証する。
 * - 着順不明(finishPosition=null。中止・除外)の馬は isPlaced=null・賭け金/払戻0として表示に含める
 *   (verifyの集計対象からは除外されるが、レース単位の表示では「結果不明」であることを示す必要が
 *   あるため行自体は残す。仕様注意点「値の有無」と「行の有無」の混同に注意)。
 * - 会場名・レース番号・開催日の見出し情報は raceId 由来(app層で venueNameFromRaceId 等により解決)
 *   のため、この core 層では raceId・kaisaiDate(analyses.kaisai_date)・promptVersion のみを返す。
 *
 * 開催区分(venueKind)別集計(Task#32):
 * 地方(毎日開催)を分析対象に入れると検証データが早く貯まる一方、中央と地方は条件が異なるため
 * 混ぜて見ると回収率・キャリブレーションの解釈を誤りうる。そこで computeVerifyReport に
 * 任意の venueKind 絞り込み(第3引数、既定 "all"=絞り込みなし)を追加し、「中央だけ」
 * 「地方だけ」でも同じ集計(累積回収率・キャリブレーション・trend)を出せるようにする。
 * 判定は raceId の場コードから既存の venueKindOfRaceId(scraper/ids.ts)を再利用する
 * (中央/地方の判定ロジックを二重実装しない)。DB変更は不要(raceId から都度導出するため)。
 * 絞り込みは selectIncludedAnalyses に渡す analyses 配列を事前にフィルタするだけで実現し、
 * 「結果未保存除外→latestモードの二重計上防止→推定EV除外」という既存の選定順序・ロジックには
 * 一切手を入れない。ある raceId の開催区分は raceId のみで決まり分析ごとに変わらないため、
 * 「中央のみ」「地方のみ」の chooseLatestPerRace は互いに素なレース集合に対して独立に動作し、
 * 両者の合算は「全体集計」の chooseLatestPerRace と完全に一致する。したがって件数・賭け金・払戻
 * いずれも「中央+地方=全体」が保証される(境界を跨ぐ二重計上・漏れは起きない)。
 * スコープ制限(ユーザー合意): 比較軸はここまで。プロンプト版別比較
 * (computeVerifyReportByPromptVersion)・レース単位の統合リスト(computeRaceLedger)への
 * venueKind 適用は行わない(全体のみのまま)。
 * venueKind="all"(既定)では従来どおり raceId を一切パースせず素通しする(既存挙動・既存テストの
 * raceId="R1" 等の非12桁フィクスチャに影響しない)。venueKind="central"/"nar" 指定時のみ判定のため
 * raceId のパースが必要になるが、通常運用では分析保存前に parseRaceId 済みの値しか raceId に
 * 入らない。それでも万一DBに不正な raceId が紛れ込んでいた場合に集計全体をクラッシュさせないよう、
 * 判定不能は「どちらの絞り込みにも含めない」(null)扱いにする防御を入れる(印別的中率の
 * 未知mark文字列フォールバックと同じ設計判断)。
 */

import type {
  AnalysisStore,
  RaceResultEntry,
  StoredAnalysis,
  StoredAnalysisHorse,
} from "./analysis-store.js";
import { PREDICTION_MARKS, type PredictionMark } from "../analyzer/parse-response.js";
import { parseRaceId, venueKindOfRaceId, type RaceIdVenueKind } from "../scraper/ids.js";

/**
 * verifyレポートの母集団を開催区分で絞り込むフィルタ(Task#32)。
 * "all" は絞り込みなし(既定・従来どおりの全体集計)。"central"/"nar" は raceId から
 * venueKindOfRaceId で判定した開催区分が一致する分析のみに絞り込む。
 */
export type VerifyVenueFilter = "all" | RaceIdVenueKind;

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

/**
 * プロンプト版別verifyレポートの1件(Task#27)。
 * computeVerifyReportByPromptVersion が返す配列の要素。report は既存 VerifyReport と同型
 * (回収率・キャリブレーション・trend を含む)で、その版番号の分析集合のみを対象に算出したもの。
 */
export interface PromptVersionVerifyReport {
  /** プロンプト版番号(analyzer/build-prompt.ts の PROMPT_VERSION)。版不明は null。 */
  readonly promptVersion: string | null;
  /** その版の分析集合のみを対象とした verifyレポート。 */
  readonly report: VerifyReport;
  /**
   * この版グループ内で実際に使われた追加指示(Task#28)の重複しない値の一覧。
   * 非null値は文字列昇順、追加指示なし(null)は末尾という決定的な順序。
   * 「同じ版でも追加指示が違えば別条件」であることを版別比較の解釈時に把握できるようにするための情報で、
   * report集計の絞り込み(結果未保存除外・推定EV除外等)とは独立に、その版の全分析を対象に算出する。
   */
  readonly additionalInstructions: readonly (string | null)[];
}

/**
 * レース単体の予実ブレークダウンの1頭分(Task#34)。
 * 予測側(mark・adjustedProb・isPositive)と結果側(finishPosition・isPlaced)を並べ、
 * 賭け判定の結果(stake・payout・payoutSource)も添える。
 */
export interface RaceBreakdownHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。 */
  readonly mark: PredictionMark | null;
  /** 補正後複勝確率(AI補正後3着内率)。 */
  readonly adjustedProb: number;
  /** 使用した複勝オッズ下限。欠損なら null。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損なら null。 */
  readonly ev: number | null;
  /** EVが閾値を上回るか(EVプラス馬の判定)。 */
  readonly isPositive: boolean;
  /** 実着順。非数値着順(中止・除外)・結果に馬番が無い場合は null(着順不明)。 */
  readonly finishPosition: number | null;
  /**
   * 複勝的中(finishPosition <= placeMaxRank)の有無。finishPosition が null(着順不明)なら
   * 判定不能のため null(verifyの集計対象外と対応する)。
   */
  readonly isPlaced: boolean | null;
  /**
   * この馬に賭けた金額(円)。EVプラス馬(isPositive かつ placeOddsMin!==null)かつ着順確定分のみ
   * stakePerBet が入り、それ以外は0(verifyの賭け判定と同一条件)。
   */
  readonly stake: number;
  /** この馬の払戻(円)。的中でなければ0。的中時は実配当優先・複勝オッズ下限近似のフォールバック。 */
  readonly payout: number;
  /** payout の算出根拠。的中かつ賭けた馬のみ "actual"/"approximate"、それ以外は null。 */
  readonly payoutSource: "actual" | "approximate" | null;
}

/**
 * レース単体の予実ブレークダウン(Task#34)。
 * 見出し情報(会場名・レース番号・開催日の表示整形)は app 層で raceId・kaisaiDate から組み立てる。
 */
export interface RaceBreakdown {
  /** レースID。 */
  readonly raceId: string;
  /** この予実の元になった分析ID。 */
  readonly analysisId: number;
  /** 分析日時(ISO文字列など)。 */
  readonly analyzedAt: string;
  /**
   * 開催日(YYYYMMDD、analyses.kaisai_date)。旧データ・選択済み開催日が渡らなかった分析は null
   * (日付不明。中央のレースIDからは開催日を復元できないため)。
   */
  readonly kaisaiDate: string | null;
  /** プロンプト版番号。版不明(旧データ・LLM未使用)は null。 */
  readonly promptVersion: string | null;
  /** 各馬の予実(馬番昇順)。 */
  readonly horses: readonly RaceBreakdownHorse[];
  /** このレースの賭け金合計(円。horses の stake 合計と一致)。 */
  readonly totalStake: number;
  /** このレースの払戻合計(円。horses の payout 合計と一致)。 */
  readonly totalReturn: number;
  /** このレースの回収率(totalReturn/totalStake)。賭け0点なら null。 */
  readonly recoveryRate: number | null;
  /** このレースで賭けた点数。 */
  readonly betCount: number;
}

/**
 * レース単位の統合リストの1件(検証画面UI統合)。
 * computeVerifyReport の母集団(結果取込済みのみ・推定EV除外。selectIncludedAnalyses)と異なり、
 * 母集団は「分析済みの全レース」(結果取込の有無・推定EVかどうかを問わない)。latest統合(同一
 * レースIDは最新分析のみ採用。chooseLatestPerRace を共有し、既存verifyの「最新」判定規則
 * (analyzedAt文字列比較、同時刻タイは id大)と完全に一致させる)。
 * horses・totalStake・totalReturn・recoveryRate・betCount は private buildRaceBreakdown をそのまま
 * 再利用する(結果未保存の場合は空配列 [] を渡すことで、全馬 finishPosition=null・stake/payout=0 として
 * 自然に「予測のみ・結果不明」を表現できる。二重実装を避け、数値算出ロジックを1箇所に保つ)。
 */
export interface RaceLedgerEntry {
  /** レースID。 */
  readonly raceId: string;
  /** この統合エントリの元になった分析ID(latest統合後の1件)。 */
  readonly analysisId: number;
  /** 分析日時(ISO文字列など)。 */
  readonly analyzedAt: string;
  /** 開催日(YYYYMMDD)。旧データ・選択済み開催日が渡らなかった分析は null。 */
  readonly kaisaiDate: string | null;
  /** プロンプト版番号。版不明(旧データ・LLM未使用)は null。 */
  readonly promptVersion: string | null;
  /** このレースの実結果(実着順)が取込済みか。 */
  readonly hasResult: boolean;
  /**
   * このレースの複勝確定払戻が取込済みか。着順のみ取込(確定直前など払戻テーブル欠損)では
   * hasResult=true でも hasPayout=false になる。
   */
  readonly hasPayout: boolean;
  /** 各馬の予測・結果(馬番昇順)。結果未取込なら finishPosition・isPlaced は全馬 null。 */
  readonly horses: readonly RaceBreakdownHorse[];
  /** このレースの賭け金合計(円)。結果未取込なら0。 */
  readonly totalStake: number;
  /** このレースの払戻合計(円)。結果未取込なら0。 */
  readonly totalReturn: number;
  /** このレースの回収率。賭け0点(結果未取込を含む)なら null。 */
  readonly recoveryRate: number | null;
  /** このレースで賭けた点数。結果未取込なら0。 */
  readonly betCount: number;
}

/**
 * レース単位の統合リスト(検証画面UI統合)を算出する。
 * computeVerifyReport(selectIncludedAnalysesによる絞り込み)と異なり、次の2点で母集団が広い:
 * - 結果未取込のレースも含める(hasResult=false として、予測側のみ返す)。
 * - 推定EV(evEstimated=true)の分析も除外しない(統合リストには予測として出してよい設計判断)。
 * latest統合(同一レースIDは最新分析のみ採用)は常に適用する(includeAllAnalyses相当のオプトインは
 * このビューには無い。統合リストの目的が「レースIDごとに最新の1件へまとめる」ことそのものであるため)。
 * 並び順は analyses の内部順序(id昇順→latestで絞り込んだ残り)のままで、開催日降順等の表示用の
 * 並び替えは呼び出し側(app層)に委ねる(private buildRaceBreakdownと同じ責務分担)。
 * @param store 分析・結果を保持する AnalysisStore
 * @param config verify設定(stakePerBet・placeMaxRank。省略時は既定)
 */
export function computeRaceLedger(
  store: AnalysisStore,
  config: VerifyConfig = DEFAULT_VERIFY_CONFIG,
): readonly RaceLedgerEntry[] {
  const analyses = store.listAnalyses();
  const chosenIds = chooseLatestPerRace(analyses);
  const latest = analyses.filter((a) => chosenIds.has(a.id));

  return latest.map((analysis) => {
    const results = store.getResult(analysis.raceId);
    const hasResult = results !== undefined;
    const hasPayout =
      hasResult &&
      results!.some((r) => r.placePayout !== null && r.placePayout !== undefined);
    const breakdown = buildRaceBreakdown(analysis, results ?? [], config);
    return {
      raceId: breakdown.raceId,
      analysisId: breakdown.analysisId,
      analyzedAt: breakdown.analyzedAt,
      kaisaiDate: breakdown.kaisaiDate,
      promptVersion: breakdown.promptVersion,
      hasResult,
      hasPayout,
      horses: breakdown.horses,
      totalStake: breakdown.totalStake,
      totalReturn: breakdown.totalReturn,
      recoveryRate: breakdown.recoveryRate,
      betCount: breakdown.betCount,
    };
  });
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
 * @param venueKind 開催区分フィルタ(Task#32、省略時は "all"=絞り込みなし)。
 *   "central"/"nar" を指定すると raceId から判定した開催区分が一致する分析のみを集計する
 *   (「中央+地方=全体」が不変条件として成り立つ。ファイル先頭コメント参照)。
 */
export function computeVerifyReport(
  store: AnalysisStore,
  config: VerifyConfig = DEFAULT_VERIFY_CONFIG,
  venueKind: VerifyVenueFilter = "all",
): VerifyReport {
  const analyses = filterAnalysesByVenueKind(store.listAnalyses(), venueKind);
  return computeVerifyReportForAnalyses(store, analyses, config);
}

/**
 * 分析集合を開催区分(venueKind)で絞り込む(Task#32)。
 * "all" は raceId を一切パースせず素通しする(既存の非12桁raceIdフィクスチャに影響しないため)。
 * "central"/"nar" は raceIdVenueKindSafe で判定し、一致するもののみを残す
 * (判定不能=null の分析はどちらの絞り込みにも含めない。ファイル先頭コメント参照)。
 */
function filterAnalysesByVenueKind(
  analyses: readonly StoredAnalysis[],
  venueKind: VerifyVenueFilter,
): readonly StoredAnalysis[] {
  if (venueKind === "all") {
    return analyses;
  }
  return analyses.filter((a) => raceIdVenueKindSafe(a.raceId) === venueKind);
}

/**
 * raceId から開催区分を判定する(非throw版、Task#32)。
 * 通常運用では分析保存前に parseRaceId 済みの値しか raceId に入らないため常に成功するはずだが、
 * 万一DBに不正な raceId(12桁数字でない・場コードが中央01〜10/地方30〜64のいずれでもない)が
 * 紛れ込んでいても集計全体をクラッシュさせないよう、判定不能は null で返す
 * (印別的中率の未知mark文字列フォールバックと同じ設計判断)。
 */
function raceIdVenueKindSafe(raceId: string): RaceIdVenueKind | null {
  try {
    return venueKindOfRaceId(parseRaceId(raceId));
  } catch {
    return null;
  }
}

/**
 * プロンプト版番号(prompt_version)ごとに分析を分けて集計する(Task#27 プロンプト改善A)。
 * 「プロンプトを改善したときに本当に良くなったか」を版ごとの成績で比較できるようにする土台。
 *
 * 比較軸は prompt_version のみ(model 別比較は入れない。docs/prompt-improvement-plan.md
 * 2026-07-14合意)。版不明(promptVersion=null。列追加前の旧データ・LLM未使用の分析)も
 * 1グループとして必ず扱う。各グループには既存 computeVerifyReport と同じロジック
 * (latestモードの二重計上防止・推定EV除外等)をそのグループ内の分析のみに適用する
 * (=版をまたいだ「最新」判定は行わない。同一版内での重複分析のみ防止する)。
 *
 * 返す配列は版番号の昇順([...String比較])で並べ、版不明(null)は末尾に置く決定的な順序とする。
 * @param store 分析・結果を保持する AnalysisStore
 * @param config verify設定(省略時は既定)
 */
export function computeVerifyReportByPromptVersion(
  store: AnalysisStore,
  config: VerifyConfig = DEFAULT_VERIFY_CONFIG,
): readonly PromptVersionVerifyReport[] {
  const analyses = store.listAnalyses();
  const groups = new Map<string | null, StoredAnalysis[]>();
  for (const analysis of analyses) {
    const key = analysis.promptVersion;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [analysis]);
    } else {
      group.push(analysis);
    }
  }

  const sortedVersions = [...groups.keys()]
    .filter((v): v is string => v !== null)
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys: Array<string | null> = groups.has(null)
    ? [...sortedVersions, null]
    : sortedVersions;

  return orderedKeys.map((key) => ({
    promptVersion: key,
    report: computeVerifyReportForAnalyses(store, groups.get(key)!, config),
    additionalInstructions: distinctAdditionalInstructions(groups.get(key)!),
  }));
}

/**
 * 分析集合から集計対象を選び、除外件数の内訳とともに返す(Task#34)。
 * computeVerifyReportForAnalyses(全体集計・版別集計)から呼ばれる母集団選定ロジック
 * (結果未保存除外→latestモードの二重計上防止→推定EV除外)。
 * 旧公開関数 computeRaceBreakdown もかつてこのロジックを共有していたが、検証画面UI統合で
 * computeRaceBreakdown は廃止された。computeRaceLedger は結果未保存・推定EVも母集団に含める
 * 設計のため、この selectIncludedAnalyses は使わず chooseLatestPerRace のみを共有する(下記参照)。
 */
function selectIncludedAnalyses(
  store: AnalysisStore,
  analyses: readonly StoredAnalysis[],
  config: VerifyConfig,
): {
  included: ReadonlyArray<{
    analysis: StoredAnalysis;
    results: readonly RaceResultEntry[];
  }>;
  excludedAnalysisCount: number;
  supersededAnalysisCount: number;
  excludedEstimatedCount: number;
} {
  // latestモードでは「レースごとに最新1件」の分析idを選ぶ。全件モードでは null(全採用)。
  const chosenIds = config.includeAllAnalyses ? null : chooseLatestPerRace(analyses);

  let excludedAnalysisCount = 0;
  let supersededAnalysisCount = 0;
  let excludedEstimatedCount = 0;
  const included: Array<{
    analysis: StoredAnalysis;
    results: readonly RaceResultEntry[];
  }> = [];

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
    included.push({ analysis, results });
  }

  return { included, excludedAnalysisCount, supersededAnalysisCount, excludedEstimatedCount };
}

/** computeHorseBetOutcome の算出結果(Task#34)。 */
interface HorseBetOutcome {
  /** 複勝的中の有無。finishPosition が null(着順不明)なら null。 */
  readonly isPlaced: boolean | null;
  /** EVプラス馬に賭けたか(isPositive かつ placeOddsMin!==null)。 */
  readonly betPlaced: boolean;
  /** 賭け金(円)。betPlaced かつ着順確定分のみ stakePerBet、それ以外は0。 */
  readonly stake: number;
  /** 払戻(円)。的中でなければ0。 */
  readonly payout: number;
  /** payout の算出根拠。的中かつ賭けた馬のみ非null。 */
  readonly payoutSource: "actual" | "approximate" | null;
}

/**
 * 1頭分の賭け判定・払戻計算(Task#34)。
 * computeVerifyReportForAnalyses の回収率集計ループと private buildRaceBreakdown(computeRaceLedgerが
 * 内部で再利用)の両方から呼ばれる共通ロジック(「EVプラス馬に stakePerBet 円賭ける・的中時は
 * 実配当優先/複勝オッズ下限で近似フォールバック」)。呼び出し元でのロジック分岐(if文の条件・
 * 払戻計算式)の重複を無くし、両者の数値が常に一致することを保証する。
 * @param horse 分析馬(prior/adjustedProb/placeOddsMin/isPositive等)
 * @param finishPosition 実着順。呼び出し元で既に「着順不明(undefined/null)」を弾いている場合は
 *   非null値を渡す想定だが、念のためnullも受け付け、その場合は判定不能として扱う。
 * @param actualPayout 複勝確定払戻(100円あたりの円)。未取込は null/undefined。
 * @param config verify設定(stakePerBet・placeMaxRank)
 */
function computeHorseBetOutcome(
  horse: StoredAnalysisHorse,
  finishPosition: number | null,
  actualPayout: number | null | undefined,
  config: VerifyConfig,
): HorseBetOutcome {
  const { stakePerBet, placeMaxRank } = config;
  const betPlaced = horse.isPositive && horse.placeOddsMin !== null;

  if (finishPosition === null) {
    // 着順不明(中止・除外・結果に馬番が無い)は判定不能。集計対象外(stake/payoutは0)。
    return { isPlaced: null, betPlaced, stake: 0, payout: 0, payoutSource: null };
  }
  const isPlaced = finishPosition <= placeMaxRank;
  if (!betPlaced) {
    return { isPlaced, betPlaced, stake: 0, payout: 0, payoutSource: null };
  }
  if (!isPlaced) {
    // 賭けたが不的中: 賭け金のみ計上、払戻は0。
    return { isPlaced, betPlaced, stake: stakePerBet, payout: 0, payoutSource: null };
  }
  // 的中時の払戻: 実配当(placePayout)があればそれを100円あたりで按分して用い、
  // 無ければ複勝オッズ下限で近似する。
  if (actualPayout !== undefined && actualPayout !== null) {
    return {
      isPlaced,
      betPlaced,
      stake: stakePerBet,
      payout: actualPayout * (stakePerBet / 100),
      payoutSource: "actual",
    };
  }
  return {
    isPlaced,
    betPlaced,
    stake: stakePerBet,
    // betPlaced=true は horse.placeOddsMin!==null を含意するため非nullアサーションで安全に参照できる。
    payout: stakePerBet * horse.placeOddsMin!,
    payoutSource: "approximate",
  };
}

/**
 * 1分析(1レース)分の RaceBreakdown を組み立てる(Task#34)。
 * @param analysis 集計対象として選定済みの分析
 * @param results その分析の実結果(馬番→着順・複勝確定払戻)
 * @param config verify設定
 */
function buildRaceBreakdown(
  analysis: StoredAnalysis,
  results: readonly RaceResultEntry[],
  config: VerifyConfig,
): RaceBreakdown {
  const finishByUmaban = new Map<number, number | null>(
    results.map((r) => [r.umaban, r.finishPosition]),
  );
  const payoutByUmaban = new Map<number, number | null | undefined>(
    results.map((r) => [r.umaban, r.placePayout]),
  );

  let totalStake = 0;
  let totalReturn = 0;
  let betCount = 0;

  const horses: RaceBreakdownHorse[] = analysis.horses.map((horse) => {
    // 結果に馬番が無い(undefined)場合も着順不明(null)として扱う
    // (「行の有無」と「値の有無」のどちらも「着順不明」表示に正規化する。仕様注意点)。
    const rawFinish = finishByUmaban.get(horse.umaban);
    const finishPosition = rawFinish === undefined ? null : rawFinish;
    const outcome = computeHorseBetOutcome(
      horse,
      finishPosition,
      payoutByUmaban.get(horse.umaban),
      config,
    );
    if (outcome.betPlaced && outcome.stake > 0) {
      betCount += 1;
    }
    totalStake += outcome.stake;
    totalReturn += outcome.payout;
    return {
      umaban: horse.umaban,
      mark: horse.mark,
      adjustedProb: horse.adjustedProb,
      placeOddsMin: horse.placeOddsMin,
      ev: horse.ev,
      isPositive: horse.isPositive,
      finishPosition,
      isPlaced: outcome.isPlaced,
      stake: outcome.stake,
      payout: outcome.payout,
      payoutSource: outcome.payoutSource,
    };
  });

  return {
    raceId: analysis.raceId,
    analysisId: analysis.id,
    analyzedAt: analysis.analyzedAt,
    kaisaiDate: analysis.kaisaiDate,
    promptVersion: analysis.promptVersion,
    horses,
    totalStake,
    totalReturn,
    recoveryRate: totalStake === 0 ? null : totalReturn / totalStake,
    betCount,
  };
}

/**
 * 分析集合から additionalInstruction の重複しない値を取り出す(Task#28)。
 * 非null値は文字列昇順、null(追加指示なし)は末尾という決定的な順序で返す。
 */
function distinctAdditionalInstructions(
  analyses: readonly StoredAnalysis[],
): readonly (string | null)[] {
  const values = new Set(analyses.map((a) => a.additionalInstruction));
  const nonNull = [...values]
    .filter((v): v is string => v !== null)
    .sort((a, b) => a.localeCompare(b));
  return values.has(null) ? [...nonNull, null] : nonNull;
}

/**
 * verifyレポート算出の共通本体。computeVerifyReport(全体集計)と
 * computeVerifyReportByPromptVersion(版別集計)の両方から、集計対象の分析集合だけを変えて呼ばれる。
 * @param store 実結果(getResult)の取得に使う AnalysisStore
 * @param analyses 集計対象の分析集合(呼び出し側で絞り込み済み)
 * @param config verify設定
 */
function computeVerifyReportForAnalyses(
  store: AnalysisStore,
  analyses: readonly StoredAnalysis[],
  config: VerifyConfig,
): VerifyReport {
  const { calibrationBins, directionEpsilon } = config;

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
  // 印なし群のカウンタ(未知mark文字列のフォールバック先として使い回す。Task#26 boss観察1対応)。
  const noMarkCounter = markCounters.get(null)!;

  // 集計対象の選定(結果未保存除外・latestモードの二重計上防止・推定EV除外)は
  // selectIncludedAnalyses に集約する(Task#34)。
  const selected = selectIncludedAnalyses(store, analyses, config);

  let betCount = 0;
  let totalStake = 0;
  let totalReturn = 0;
  let actualPayoutCount = 0;
  let approximatePayoutCount = 0;

  for (const { analysis, results } of selected.included) {
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
      // 賭け判定・払戻計算・複勝的中判定(isPlaced)は computeHorseBetOutcome に集約
      // (賭け判定・払戻計算は Task#34 でレース単位ブレークダウンと共有。isPlaced も同関数の
      // 戻り値を再利用することで、同じ式(finish <= placeMaxRank)をこのループ内で二重に
      // 計算しない)。finish は上で non-null 確定済みのため isPlaced も必ず non-null。
      const outcome = computeHorseBetOutcome(horse, finish, payoutByUmaban.get(horse.umaban), config);
      const isPlaced = outcome.isPlaced!;

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
      // 防御(Task#26 boss観察1 / Task#27): DBの mark 列は型どおりの値のみ書き込む前提だが、
      // 将来のスキーマ変更・手動DB改変で PREDICTION_MARKS に無い未知の文字列が紛れ込んでも
      // 集計処理自体がクラッシュしないよう、markCounters に無いキーは「印なし」群にフォールバックする。
      const mCounter = markCounters.get(horse.mark) ?? noMarkCounter;
      mCounter.count += 1;
      if (isPlaced) {
        mCounter.placed += 1;
      }
      if (finish === 1) {
        mCounter.won += 1;
      }

      // 回収率: EVプラス馬券のみ複勝を stakePerBet 円で購入したと仮定
      // (outcome は上で計算済み。賭け判定・払戻計算は computeHorseBetOutcome に集約し、
      // Task#34でレース単位ブレークダウンと共有)。
      if (outcome.betPlaced) {
        betCount += 1;
        totalStake += outcome.stake;
        totalReturn += outcome.payout;
        if (outcome.payoutSource === "actual") {
          actualPayoutCount += 1;
        } else if (outcome.payoutSource === "approximate") {
          approximatePayoutCount += 1;
        }
      }
    }
  }

  const calibration = bins.map((c, i) => finalizeBin(c, i, calibrationBins));

  return {
    includedAnalysisCount: selected.included.length,
    excludedAnalysisCount: selected.excludedAnalysisCount,
    supersededAnalysisCount: selected.supersededAnalysisCount,
    excludedEstimatedCount: selected.excludedEstimatedCount,
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
