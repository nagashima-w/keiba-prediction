/**
 * 分析パイプラインの結果・進捗・レース一覧の共有型。
 *
 * main(生成側)・preload(型付き公開)・renderer(表示側)の三者が参照するため、
 * core(better-sqlite3 等のネイティブ依存を含む)には依存させず、この shared 層に
 * 純粋な TypeScript インターフェースとして置く。すべて IPC でシリアライズ可能な
 * プレーンオブジェクト(ブランド型・関数を含まない)であることを不変条件とする。
 */

/** 分析パイプラインの進捗段階(仕様「5. ui」の進捗表示要件)。 */
export type ProgressStage = "スクレイピング" | "スコアリング" | "LLM分析" | "保存";

/**
 * レースの開催区分(中央/地方)。core RaceIdVenueKind のプレーン写し(IPC越しの共有用)。
 * UI表記は「中央」「地方」とし、"NAR" という略語は画面に出さない(コード内は central/nar のまま)。
 */
export type RaceVenueKind = "central" | "nar";

/**
 * オッズの発売状態(core OddsSnapshot.oddsStatus のプレーン写し)。
 * - "result": 確定オッズ。
 * - "middle": 発売中の暫定オッズ。
 * - "yoso":   前売り前の予想オッズ(複勝未発売のためEV計算不可)。
 */
export type OddsStatus = "result" | "middle" | "yoso";

/** 進捗イベント(main→renderer に webContents.send で通知)。 */
export interface AnalysisProgress {
  /** 現在の段階。 */
  readonly stage: ProgressStage;
  /** 段階内の進捗(n頭目)。頭数が定まらない段階では null。 */
  readonly current: number | null;
  /** 段階内の総数(N頭)。定まらない段階では null。 */
  readonly total: number | null;
  /** 画面表示用のメッセージ。 */
  readonly message: string;
}

/** 結果テーブルの1行(馬単位)。 */
export interface AnalysisRow {
  /** 馬番。 */
  readonly umaban: number;
  /** 枠番。 */
  readonly wakuban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** scorer の prior(事前複勝確率)。 */
  readonly prior: number;
  /** 補正後複勝確率(LLM未使用時は prior と同値)。 */
  readonly adjustedProb: number;
  /** 使用した複勝オッズ下限。欠損なら null。 */
  readonly placeOddsMin: number | null;
  /**
   * 期待値(補正後確率 × 複勝下限)。オッズ欠損なら null。
   * TODO(将来改善): EV=null の行に対し、core HorseEv.excludedReason(「複勝オッズに該当馬番が無い」等)を
   * 行レベルでUI表示する。現状は null を一律「-」表示にしており、対象外の理由までは画面に出していない。
   */
  readonly ev: number | null;
  /** EVが閾値を上回るか(ハイライト対象)。 */
  readonly isPositive: boolean;
  /** LLMの補正根拠。LLM未使用・prior採用なら null(表示は「-」)。 */
  readonly reason: string | null;
  /**
   * この馬のキャリア走数(戦績 results.length)。0 は新馬相当(=判明した低データ)。
   * 戦績が取得できなかった(不明な)馬は null とし、低データ判定の集計から除外する
   * (取得失敗を新馬と混同しないため。スクレイピング警告は result.warnings に別途載る)。
   * レース妙味スコア(computeRaceOpportunity)の低データ判定に用いる。
   */
  readonly careerRunCount: number | null;
}

/** 1レース分の分析結果。 */
export interface AnalysisResult {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 会場名(レースIDの場コードから導出)。 */
  readonly venueName: string;
  /** レース名。 */
  readonly raceName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** 開催日(YYYY/MM/DD)。取得できず当日日付で近似した場合は dateApproximate=true。 */
  readonly date: string;
  /** date が当日日付での近似値かどうか(仕様: 近似である旨を結果に含める)。 */
  readonly dateApproximate: boolean;
  /** LLM分析を実行したか(false ならAPIキー未設定などでスキップし prior を採用)。 */
  readonly llmUsed: boolean;
  /** LLMをスキップした理由(実行時は null)。 */
  readonly llmSkippedReason: string | null;
  /** LLM分析がフェイルセーフで prior にフォールバックしたか。 */
  readonly fallback: boolean;
  /**
   * オッズの発売状態(確定/発売中/予想)。
   * "yoso" は複勝未発売のため全馬のEVが null になる(UIで注記表示)。
   */
  readonly oddsStatus: OddsStatus;
  /** 結果行(馬番昇順)。 */
  readonly rows: readonly AnalysisRow[];
  /** スクレイピング時の非致命的警告(戦績・調教の取得失敗など)。 */
  readonly warnings: readonly string[];
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
}

/**
 * 一括分析: 1レース分の最終結果(main→renderer に invoke の戻り値として返す)。
 * - "success": result に AnalysisResult が入る(error は null)。
 * - "failure": error にユーザー向けメッセージが入る(result は null)。
 * - "skipped": 中断により未実行(result・error ともに null)。
 */
export interface BatchRaceOutcome {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** レース名(一覧から引けない場合は null。成功時は result.raceName を優先表示)。 */
  readonly raceName: string | null;
  /** 実行結果の区分。 */
  readonly status: "success" | "failure" | "skipped";
  /** 成功時の分析結果(それ以外は null)。 */
  readonly result: AnalysisResult | null;
  /** 失敗時のエラーメッセージ(それ以外は null)。 */
  readonly error: string | null;
}

/**
 * 一括分析の全体進捗(main→renderer に webContents.send で通知)。
 * 既存の1レース内段階(AnalysisProgress)を stage に内包し、全体の何レース目かを併せて伝える。
 */
export interface BatchProgress {
  /** 完了したレース数(0起点。実行中レースは含まない)。 */
  readonly completedRaces: number;
  /** 対象レースの総数。 */
  readonly totalRaces: number;
  /** 現在実行中のレースID(境界・完了時は null)。 */
  readonly currentRaceId: string | null;
  /** 現在実行中のレース名(引けない場合・完了時は null)。 */
  readonly currentRaceName: string | null;
  /** 現在のレース内段階(レース境界・全体完了時は null)。 */
  readonly stage: AnalysisProgress | null;
}

/**
 * 横断「EVプラス馬サマリ」の1行(全レースのEVプラス馬を1つに集約したもの)。
 * EV降順に並べて画面最上部に表示する。
 */
export interface EvPlusSummaryRow {
  /** そのEVプラス馬が属するレースID。 */
  readonly raceId: string;
  /** レース名(表示用)。 */
  readonly raceName: string;
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** 補正後複勝確率(0〜1)。 */
  readonly adjustedProb: number;
  /** 複勝オッズ下限(欠損なら null)。 */
  readonly placeOddsMin: number | null;
  /** 期待値(EVプラスなので閾値超え)。 */
  readonly ev: number;
}

/** 検証画面: 分析履歴の1件(一覧表示用)。 */
export interface AnalysisHistoryItem {
  /** 分析ID(採番)。 */
  readonly analysisId: number;
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
  /** この分析での総頭数。 */
  readonly horseCount: number;
  /** EVプラス(is_positive)の馬数。 */
  readonly positiveCount: number;
  /** このレースの結果(実着順)が取込済みか。 */
  readonly hasResult: boolean;
  /**
   * このレースの複勝確定払戻が取込済みか。着順のみ取込(確定直前など払戻テーブル欠損)では
   * hasResult=true でも hasPayout=false になり、UIは実配当への更新導線(再取込)を出し続ける。
   */
  readonly hasPayout: boolean;
}

/** 検証画面: キャリブレーション帯(表示用。core CalibrationBin のプレーン写し)。 */
export interface CalibrationBinView {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** この帯の予測件数。 */
  readonly predictedCount: number;
  /** うち実際に複勝圏に入った件数。 */
  readonly placedCount: number;
  /** 実際の複勝率。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
}

/** 検証画面: 回収率サマリ(表示用)。 */
export interface VerifyBetView {
  /** 購入点数(着順確定分のみ)。 */
  readonly betCount: number;
  /** 賭け金合計(円)。 */
  readonly totalStake: number;
  /** 払戻合計(円)。 */
  readonly totalReturn: number;
  /** 回収率。購入0点なら null。 */
  readonly recoveryRate: number | null;
  /** 実配当で払戻計上した点数。 */
  readonly actualPayoutCount: number;
  /** 近似(複勝下限)で払戻計上した点数。 */
  readonly approximatePayoutCount: number;
}

/**
 * 検証画面: 検証レポート(表示用)。
 * core の VerifyReport は既にプレーン構造なので、main はそれを構造的にこの型として返す。
 */
export interface VerifyReportView {
  /** 集計に含めた分析件数。 */
  readonly includedAnalysisCount: number;
  /** 結果未取込で除外した分析件数。 */
  readonly excludedAnalysisCount: number;
  /** 同一レースの新しい分析に取って代わられ集計しなかった件数。 */
  readonly supersededAnalysisCount: number;
  /** 累積回収率サマリ。 */
  readonly bet: VerifyBetView;
  /** 推定確率帯ごとのキャリブレーション表。 */
  readonly calibration: readonly CalibrationBinView[];
}

/** 結果取込の結果(1レース分)。 */
export interface ImportResultOutcome {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 取り込んだ着順の頭数。 */
  readonly horseCount: number;
  /** 取り込んだ複勝払戻の点数。 */
  readonly placePayoutCount: number;
  /** 複勝の払戻テーブルが取得できたか(未確定レースは false)。 */
  readonly hasPayout: boolean;
}

/** レース一覧の1レース(renderer 表示用)。 */
export interface RaceListItem {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** レース名(一覧では切り詰められている場合あり)。 */
  readonly name: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** 出走頭数。 */
  readonly entryCount: number;
  /** 会場名(取得できない構造では null)。 */
  readonly venue: string | null;
  /** レース番号(1〜12)。 */
  readonly raceNumber: number;
}
