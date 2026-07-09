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
  /** 期待値(補正後確率 × 複勝下限)。オッズ欠損なら null。 */
  readonly ev: number | null;
  /** EVが閾値を上回るか(ハイライト対象)。 */
  readonly isPositive: boolean;
  /** LLMの補正根拠。LLM未使用・prior採用なら null(表示は「-」)。 */
  readonly reason: string | null;
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
  /** 結果行(馬番昇順)。 */
  readonly rows: readonly AnalysisRow[];
  /** スクレイピング時の非致命的警告(戦績・調教の取得失敗など)。 */
  readonly warnings: readonly string[];
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
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
