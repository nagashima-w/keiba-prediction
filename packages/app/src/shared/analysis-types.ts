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
 * 予想印(core PredictionMark のプレーン写し。IPC越しの共有用)。
 * ◎本命/〇対抗/▲単穴/△連下/☆穴(勝ち目)/注 穴(3着)。印なし・LLM未使用時は null。
 */
export type PredictionMark = "◎" | "〇" | "▲" | "△" | "☆" | "注";

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
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。Task#23。 */
  readonly mark: PredictionMark | null;
  /**
   * このEV(ev/placeOddsMin)が推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。
   * true のときは確定EVより誤差が大きい(±20〜30%程度)概算であり、UIで「(推定)」等の
   * 表記により確定EVと明確に区別する。レース単位(oddsStatus=yoso)で一律に決まるため、
   * 同一レース内の全行で同じ値になる。
   */
  readonly evEstimated: boolean;
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
  /** 会場名(レース見出しの組み立てに使う。Task#29)。 */
  readonly venueName: string;
  /** レース番号(1〜12。レース見出しの組み立てに使う。Task#29)。 */
  readonly raceNumber: number;
  /** レース名(表示用)。空文字の場合があるため、識別には venueName+raceNumber も併用する(Task#29)。 */
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
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。Task#23。 */
  readonly mark: PredictionMark | null;
  /** このEVが推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。 */
  readonly evEstimated: boolean;
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

/**
 * 検証画面: 補正方向の分類(core AdjustmentDirection のプレーン写し。IPC越しの共有用)。
 * "raised"=上げ(adjustedProb>prior)/"lowered"=下げ/"unchanged"=据え置き。Task#26。
 */
export type AdjustmentDirection = "raised" | "lowered" | "unchanged";

/** 検証画面: 補正方向×結果の1群(表示用。core DirectionGroupStat のプレーン写し)。Task#26。 */
export interface DirectionGroupView {
  /** 補正方向の分類。 */
  readonly direction: AdjustmentDirection;
  /** この群に入った件数。 */
  readonly count: number;
  /** 実際の複勝率。件数0なら null。 */
  readonly actualPlaceRate: number | null;
  /** 平均補正幅(符号付き)。件数0なら null。 */
  readonly averageAdjustment: number | null;
}

/**
 * 検証画面: キャリブレーション帯の過信バイアス(表示用。core CalibrationBiasBin のプレーン写し)。
 * Task#26。
 */
export interface CalibrationBiasBinView {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** 代表予測値(帯の中央値)。 */
  readonly representativeProb: number;
  /** この帯の予測件数。 */
  readonly predictedCount: number;
  /** 実際の複勝率。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
  /** 過信バイアス(代表予測値 − 実複勝率)。正なら過信、負なら過小評価。予測0件なら null。 */
  readonly overconfidenceGap: number | null;
}

/** 検証画面: 印別的中率の1群(表示用。core MarkStat のプレーン写し)。Task#26。 */
export interface MarkStatView {
  /** 予想印(◎〇▲△☆注のいずれか。印なしは null)。 */
  readonly mark: PredictionMark | null;
  /** この印が付いた件数。 */
  readonly count: number;
  /** 複勝率。件数0なら null。 */
  readonly placeRate: number | null;
  /** 勝率(finish=1)。件数0なら null。 */
  readonly winRate: number | null;
}

/** 検証画面: 補正傾向サマリ(表示用。core VerifyTrendReport のプレーン写し)。Task#26。 */
export interface VerifyTrendReportView {
  /** (1) 補正方向×結果。raised・lowered・unchanged の3群。 */
  readonly directionGroups: readonly DirectionGroupView[];
  /** (2) キャリブレーションの過信バイアス。 */
  readonly calibrationBias: readonly CalibrationBiasBinView[];
  /** (3) 印別的中率。 */
  readonly markStats: readonly MarkStatView[];
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
  /** 推定EV(発売前の概算)のため集計から除外した分析件数(Task#25)。 */
  readonly excludedEstimatedCount: number;
  /** 累積回収率サマリ。 */
  readonly bet: VerifyBetView;
  /** 推定確率帯ごとのキャリブレーション表。 */
  readonly calibration: readonly CalibrationBinView[];
  /** 補正傾向サマリ(Task#26)。 */
  readonly trend: VerifyTrendReportView;
}

/**
 * 検証画面: プロンプト版別verifyレポートの1件(表示用。core PromptVersionVerifyReport の
 * プレーン写し)。Task#27。版ごとに回収率・主要指標を並べて比較するために使う。
 */
export interface PromptVersionVerifyReportView {
  /** プロンプト版番号。版不明(旧データ・LLM未使用の分析)は null。 */
  readonly promptVersion: string | null;
  /** その版の分析集合のみを対象とした検証レポート(全体レポートと同型)。 */
  readonly report: VerifyReportView;
  /**
   * この版グループ内で実際に使われた追加指示(表示用。core PromptVersionVerifyReport の
   * additionalInstructions のプレーン写し)。Task#28。非null値は文字列昇順、
   * 追加指示なし(null)は末尾という決定的な順序。「同じ版でも追加指示が違えば別条件」であることを
   * 版別比較の解釈時に把握できるようにするための情報。
   */
  readonly additionalInstructions: readonly (string | null)[];
}

/**
 * 結果取込の結果(1レース分)。status で確定/未確定を判別する判別共用体。
 *
 * - "imported": 結果が確定していて着順を保存した(複勝払戻は無いこともある。hasPayout で判別)。
 * - "not_confirmed": まだ発走前・結果確定前で着順を取得できなかった(何も保存していない)。
 *   例外ではなく正常応答として返すことで、一括取込側が自動スキップしやすくする(Task#31)。
 */
export type ImportResultOutcome =
  | {
      /** 結果を確定・取込済み。 */
      readonly status: "imported";
      /** レースID(12桁)。 */
      readonly raceId: string;
      /** 取り込んだ着順の頭数。 */
      readonly horseCount: number;
      /** 取り込んだ複勝払戻の点数。 */
      readonly placePayoutCount: number;
      /** 複勝の払戻テーブルが取得できたか(着順は取れたが払戻未確定なら false)。 */
      readonly hasPayout: boolean;
    }
  | {
      /** まだ結果が確定していない(発走前・確定前)。何も保存していない。 */
      readonly status: "not_confirmed";
      /** レースID(12桁)。 */
      readonly raceId: string;
    };

/**
 * 一括取込: 1レース分の結果(main→renderer に invoke の戻り値として返す)。Task#31。
 * - "imported": 結果を確定・取込済み(複勝払戻の有無は問わない)。
 * - "not_confirmed": まだ発走前・確定前(#30の判定を自動スキップとして扱う。エラーではない)。
 * - "failure": 取込処理中に例外が発生した(error にメッセージが入る)。
 * - "skipped": 中断要求により未実行のまま打ち切られた。
 */
export interface BulkImportRaceOutcome {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 実行結果の区分。 */
  readonly status: "imported" | "not_confirmed" | "failure" | "skipped";
  /** 失敗時のエラーメッセージ(それ以外は null)。 */
  readonly error: string | null;
}

/**
 * 一括取込の全体進捗(main→renderer に webContents.send で通知)。Task#31。
 * 既存の一括分析(BatchProgress)と異なり、取込にはレース内段階が無いため単純な件数のみ持つ。
 */
export interface BulkImportProgress {
  /** 完了したレース数(0起点。実行中レースは含まない)。 */
  readonly completedRaces: number;
  /** 対象レースの総数。 */
  readonly totalRaces: number;
  /** 現在処理中のレースID(境界・完了時は null)。 */
  readonly currentRaceId: string | null;
}

/**
 * ログエクスポート(main→renderer に invoke の戻り値として返す)。Task#36。
 * - "saved": 保存先ダイアログでファイルを選び、集約ログ(現行+ローテーション済み)を書き出した。
 * - "canceled": 保存先ダイアログをキャンセルした(何もしていない)。
 */
export type LogExportOutcome =
  | { readonly status: "saved"; readonly filePath: string }
  | { readonly status: "canceled" };

/**
 * 検証画面: レース単体の予実ブレークダウンの1頭分(表示用。core RaceBreakdownHorse の
 * プレーン写し)。Task#34。
 */
export interface RaceBreakdownHorseView {
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
  /** 複勝的中の有無。finishPosition が null(着順不明)なら判定不能のため null。 */
  readonly isPlaced: boolean | null;
  /** この馬に賭けた金額(円)。賭けていない・着順不明なら0。 */
  readonly stake: number;
  /** この馬の払戻(円)。的中でなければ0。 */
  readonly payout: number;
  /** payout の算出根拠。的中かつ賭けた馬のみ非null。 */
  readonly payoutSource: "actual" | "approximate" | null;
}

/**
 * 検証画面: レース単体の予実ブレークダウン(表示用。core RaceBreakdown に会場名・レース番号を
 * 加えたもの)。Task#34。見出し(会場+R+開催日)の組み立てに使う。
 */
export interface RaceBreakdownView {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 会場名(レースIDの場コードから導出)。 */
  readonly venueName: string;
  /** レース番号(1〜12。レースIDの末尾2桁から導出)。 */
  readonly raceNumber: number;
  /**
   * 開催日(YYYYMMDD)。旧データ・選択済み開催日が渡らなかった分析は null(日付不明。中央のレースIDから
   * は開催日を復元できないため)。
   */
  readonly kaisaiDate: string | null;
  /** この予実の元になった分析ID。 */
  readonly analysisId: number;
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
  /** プロンプト版番号。版不明(旧データ・LLM未使用)は null。 */
  readonly promptVersion: string | null;
  /** 各馬の予実(馬番昇順)。 */
  readonly horses: readonly RaceBreakdownHorseView[];
  /** このレースの賭け金合計(円)。 */
  readonly totalStake: number;
  /** このレースの払戻合計(円)。 */
  readonly totalReturn: number;
  /** このレースの回収率。賭け0点なら null。 */
  readonly recoveryRate: number | null;
  /** このレースで賭けた点数。 */
  readonly betCount: number;
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
