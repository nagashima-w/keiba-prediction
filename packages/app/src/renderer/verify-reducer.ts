/**
 * 検証タブの状態遷移(純関数 reducer)。
 *
 * 分析/検証のタブ切替、分析履歴一覧の取得、検証レポートの取得、結果取込の進行状態を管理する。
 * 副作用(IPC呼び出し)はコンポーネント側に置き、遷移規則だけをこの純関数に集約して単体テストで固定する。
 * すべての遷移は新しいオブジェクトを返し、入力 state を破壊しない(不変性)。
 */

import type {
  BulkImportProgress,
  BulkImportRaceOutcome,
  PromptVersionVerifyReportView,
  RaceLedgerView,
  VerifyReportView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";
import {
  EMPTY_RACE_LEDGER_FILTER,
  type RaceLedgerFilter,
} from "./race-ledger-filter.js";

/** タブの種別。 */
export type TabKey = "分析" | "検証" | "設定";

/** 検証タブの状態。 */
export interface VerifyState {
  /** 現在のタブ。 */
  readonly activeTab: TabKey;
  /** 検証レポート(無ければ null)。 */
  readonly report: VerifyReportView | null;
  /**
   * 検証レポートの地域フィルタ(Task#32)。既定 "all"(全体)。"central"/"nar" に切り替えると
   * トータル集計・キャリブレーション・傾向(report)の表示対象が絞り込まれる
   * (プロンプト版別比較・レース一覧はスコープ外で常に全体のまま)。
   */
  readonly venueFilter: VerifyVenueFilter;
  /** レポート取得中か。 */
  readonly loadingReport: boolean;
  /** レポート取得エラー(無ければ null)。 */
  readonly reportError: string | null;
  /** プロンプト版別の検証レポート一覧(Task#27。未取得は空配列)。 */
  readonly reportsByPromptVersion: readonly PromptVersionVerifyReportView[];
  /** 版別レポート取得中か。 */
  readonly loadingReportsByPromptVersion: boolean;
  /** 版別レポート取得エラー(無ければ null)。 */
  readonly reportsByPromptVersionError: string | null;
  /**
   * レース単位の統合リスト(検証画面UI統合。未取得は空配列)。
   * 旧「分析履歴」テーブル(history)と旧「レース別予実」セクション(raceBreakdown)を
   * レースID単位(latest統合)の1リストへ統合したもの。母集団は「分析済みの全レース」
   * (結果取込の有無を問わない)。
   */
  readonly raceLedger: readonly RaceLedgerView[];
  /** レース一覧取得中か。 */
  readonly loadingRaceLedger: boolean;
  /** レース一覧取得エラー(無ければ null)。 */
  readonly raceLedgerError: string | null;
  /**
   * レース一覧の検索/絞り込み条件(表示専用。分析が貯まって縦に長くなる一覧から目的のレースを
   * 見つけやすくするためのもの)。#32 の venueFilter(検証レポート集計の母集団の絞り込み)とは
   * 役割が別で、こちらは raceLedger 自体には影響しない(表示直前に race-ledger-filter.ts の
   * filterRaceLedger に通すだけ)。初期値は絞り込みなし(EMPTY_RACE_LEDGER_FILTER)。
   */
  readonly raceLedgerFilter: RaceLedgerFilter;
  /** 結果取込中のレースID(ボタン二重押下防止・表示用)。 */
  readonly importingRaceIds: readonly string[];
  /** 直近の取込エラー(無ければ null)。 */
  readonly importError: string | null;
  /**
   * importError が発生したレースID(無ければ null)。Task#36「このエラーのログをコピー」で
   * コンテキストとして添えるために保持する(importError 自体は文字列のみで raceId を含まないため)。
   */
  readonly importErrorRaceId: string | null;
  /**
   * 直近の取込案内(無ければ null)。未確定レース(発走前・確定前)を取り込もうとした際に、
   * importError(赤エラー)とは別に穏やかな案内として表示するためのメッセージ。
   */
  readonly importNotice: string | null;
  /** 一括取込(Task#31)の実行状態。 */
  readonly bulkImport: BulkImportState;
  /** 版不明(prompt_version=null)分析の削除(Task#33)を実行中か。 */
  readonly deletingUnknownPromptVersion: boolean;
  /** 直近の版不明削除エラー(無ければ null)。 */
  readonly deleteUnknownPromptVersionError: string | null;
  /**
   * 直近に完了した版不明削除の件数(IPCの戻り値をそのまま格納。Task#33)。
   * 未実行・実行中は null(「まだ完了フィードバックを表示すべきでない」ことと「0件削除した」ことを
   * 区別するため、削除0件は 0 として区別可能に保つ)。表示整形は
   * verify-format.ts の deleteUnknownPromptVersionResultMessage に委ねる(他フィールドと同じく
   * reducerには生データだけを持たせる)。
   */
  readonly deleteUnknownPromptVersionDeletedCount: number | null;
}

/**
 * 一括取込(分析済みで結果未取込のレースをまとめて取り込む。Task#31)の実行状態。
 * 一括分析(BatchRunState)と同じく runId による in-flight ガードを持つ
 * (実行完了後に遅れて届く旧実行の進捗・完了イベントを弾くため)。
 */
export interface BulkImportState {
  /** 一括取込の実行中か。 */
  readonly running: boolean;
  /** 中断が要求され、レース境界での停止を待っているか。 */
  readonly canceling: boolean;
  /** 直近の全体進捗(無ければ null)。 */
  readonly progress: BulkImportProgress | null;
  /** 完了した取込のレースごとの結果(実行順)。未完了は空配列。 */
  readonly outcomes: readonly BulkImportRaceOutcome[];
  /** 実行世代ID(古い実行の進捗・完了イベントを弾く in-flight ガード用)。 */
  readonly runId: number;
}

/** 一括取込の初期状態(未実行)。 */
const EMPTY_BULK_IMPORT: BulkImportState = {
  running: false,
  canceling: false,
  progress: null,
  outcomes: [],
  runId: 0,
};

/** 未確定レース(発走前・確定前)取込時の案内メッセージ(赤エラーではなく穏やかな案内として表示)。 */
export const IMPORT_NOT_CONFIRMED_MESSAGE =
  "まだ結果が確定していません(発走前・確定前)。確定後に再度取り込んでください";

/** reducer が処理するアクション。 */
export type VerifyAction =
  | { readonly type: "タブ切替"; readonly tab: TabKey }
  | { readonly type: "レポート取得開始" }
  | { readonly type: "レポート取得成功"; readonly report: VerifyReportView }
  | { readonly type: "レポート取得失敗"; readonly message: string }
  | {
      readonly type: "地域フィルタ変更";
      readonly venueFilter: VerifyVenueFilter;
    }
  | { readonly type: "版別レポート取得開始" }
  | {
      readonly type: "版別レポート取得成功";
      readonly reports: readonly PromptVersionVerifyReportView[];
    }
  | { readonly type: "版別レポート取得失敗"; readonly message: string }
  | { readonly type: "レース一覧取得開始" }
  | {
      readonly type: "レース一覧取得成功";
      readonly raceLedger: readonly RaceLedgerView[];
    }
  | { readonly type: "レース一覧取得失敗"; readonly message: string }
  | {
      readonly type: "レース一覧フィルタ変更";
      readonly filter: RaceLedgerFilter;
    }
  | { readonly type: "レース一覧フィルタクリア" }
  | { readonly type: "取込開始"; readonly raceId: string }
  | { readonly type: "取込成功"; readonly raceId: string }
  | { readonly type: "取込失敗"; readonly raceId: string; readonly message: string }
  | { readonly type: "取込未確定"; readonly raceId: string }
  | { readonly type: "一括取込開始" }
  | {
      readonly type: "一括取込進捗更新";
      readonly runId: number;
      readonly progress: BulkImportProgress;
    }
  | {
      readonly type: "一括取込完了";
      readonly runId: number;
      readonly outcomes: readonly BulkImportRaceOutcome[];
    }
  | { readonly type: "一括取込中断要求" }
  | { readonly type: "版不明削除開始" }
  | { readonly type: "版不明削除成功"; readonly deletedCount: number }
  | { readonly type: "版不明削除失敗"; readonly message: string };

/** 初期状態(分析タブ・空)。 */
export function createInitialVerifyState(): VerifyState {
  return {
    activeTab: "分析",
    report: null,
    venueFilter: "all",
    loadingReport: false,
    reportError: null,
    reportsByPromptVersion: [],
    loadingReportsByPromptVersion: false,
    reportsByPromptVersionError: null,
    raceLedger: [],
    loadingRaceLedger: false,
    raceLedgerError: null,
    raceLedgerFilter: EMPTY_RACE_LEDGER_FILTER,
    importingRaceIds: [],
    importError: null,
    importErrorRaceId: null,
    importNotice: null,
    bulkImport: EMPTY_BULK_IMPORT,
    deletingUnknownPromptVersion: false,
    deleteUnknownPromptVersionError: null,
    deleteUnknownPromptVersionDeletedCount: null,
  };
}

/** raceId を集合的に追加する(重複は増やさない)。 */
function addImporting(ids: readonly string[], raceId: string): string[] {
  return ids.includes(raceId) ? [...ids] : [...ids, raceId];
}

/** raceId を取り除く。 */
function removeImporting(ids: readonly string[], raceId: string): string[] {
  return ids.filter((id) => id !== raceId);
}

/** 状態遷移(純関数)。 */
export function verifyReducer(
  state: VerifyState,
  action: VerifyAction,
): VerifyState {
  switch (action.type) {
    case "タブ切替":
      return { ...state, activeTab: action.tab };

    case "レポート取得開始":
      return { ...state, loadingReport: true, reportError: null };

    case "レポート取得成功":
      return {
        ...state,
        loadingReport: false,
        report: action.report,
        reportError: null,
      };

    case "レポート取得失敗":
      return { ...state, loadingReport: false, reportError: action.message };

    case "地域フィルタ変更":
      // venueFilter のみ更新する(実際のレポート再取得は呼び出し側がこのあと
      // 「レポート取得開始」→ IPC呼び出し→「レポート取得成功/失敗」を別途dispatchする。
      // タブ切替でloadVerifyDataを別途呼ぶ既存の設計と同じ責務分離)。
      return { ...state, venueFilter: action.venueFilter };

    case "版別レポート取得開始":
      return {
        ...state,
        loadingReportsByPromptVersion: true,
        reportsByPromptVersionError: null,
      };

    case "版別レポート取得成功":
      return {
        ...state,
        loadingReportsByPromptVersion: false,
        reportsByPromptVersion: action.reports,
        reportsByPromptVersionError: null,
      };

    case "版別レポート取得失敗":
      return {
        ...state,
        loadingReportsByPromptVersion: false,
        reportsByPromptVersionError: action.message,
      };

    case "レース一覧取得開始":
      return { ...state, loadingRaceLedger: true, raceLedgerError: null };

    case "レース一覧取得成功":
      return {
        ...state,
        loadingRaceLedger: false,
        raceLedger: action.raceLedger,
        raceLedgerError: null,
      };

    case "レース一覧取得失敗":
      return {
        ...state,
        loadingRaceLedger: false,
        raceLedgerError: action.message,
      };

    case "レース一覧フィルタ変更":
      // raceLedgerFilter のみ更新する(表示専用。raceLedger自体・report等は一切変えない)。
      return { ...state, raceLedgerFilter: action.filter };

    case "レース一覧フィルタクリア":
      return { ...state, raceLedgerFilter: EMPTY_RACE_LEDGER_FILTER };

    case "取込開始":
      return {
        ...state,
        importingRaceIds: addImporting(state.importingRaceIds, action.raceId),
        importError: null,
        importErrorRaceId: null,
        importNotice: null,
      };

    case "取込成功":
      return {
        ...state,
        importingRaceIds: removeImporting(state.importingRaceIds, action.raceId),
      };

    case "取込失敗":
      return {
        ...state,
        importingRaceIds: removeImporting(state.importingRaceIds, action.raceId),
        importError: action.message,
        importErrorRaceId: action.raceId,
      };

    case "取込未確定":
      // 赤エラー(importError)ではなく穏やかな案内(importNotice)として表示する。
      // 未確定は「取込済み」にはならない(saveResultを呼んでいないためレース一覧側も未取込のまま)。
      return {
        ...state,
        importingRaceIds: removeImporting(state.importingRaceIds, action.raceId),
        importNotice: IMPORT_NOT_CONFIRMED_MESSAGE,
      };

    case "一括取込開始":
      // 二重実行防止: 既に実行中なら現状維持(参照等価)。
      if (state.bulkImport.running) {
        return state;
      }
      return {
        ...state,
        bulkImport: {
          running: true,
          canceling: false,
          progress: null,
          outcomes: [],
          runId: state.bulkImport.runId + 1,
        },
      };

    case "一括取込進捗更新":
      // in-flight ガード: 現在の実行世代の進捗のみ反映する。
      if (action.runId !== state.bulkImport.runId) {
        return state;
      }
      return {
        ...state,
        bulkImport: { ...state.bulkImport, progress: action.progress },
      };

    case "一括取込完了":
      // in-flight ガード: 現在の実行世代の完了のみ反映する。
      if (action.runId !== state.bulkImport.runId) {
        return state;
      }
      return {
        ...state,
        bulkImport: {
          ...state.bulkImport,
          running: false,
          canceling: false,
          progress: null,
          outcomes: action.outcomes,
        },
      };

    case "一括取込中断要求":
      // 実行中のみ有効。running は境界での停止(完了アクション)まで維持する。
      if (!state.bulkImport.running) {
        return state;
      }
      return {
        ...state,
        bulkImport: { ...state.bulkImport, canceling: true },
      };

    case "版不明削除開始":
      // 直前の完了フィードバック(エラー・削除件数)を新しい実行の開始でクリアする
      // (他の「〜開始」アクションと同じ流儀)。
      return {
        ...state,
        deletingUnknownPromptVersion: true,
        deleteUnknownPromptVersionError: null,
        deleteUnknownPromptVersionDeletedCount: null,
      };

    case "版不明削除成功":
      return {
        ...state,
        deletingUnknownPromptVersion: false,
        deleteUnknownPromptVersionDeletedCount: action.deletedCount,
        deleteUnknownPromptVersionError: null,
      };

    case "版不明削除失敗":
      return {
        ...state,
        deletingUnknownPromptVersion: false,
        deleteUnknownPromptVersionError: action.message,
      };

    default: {
      // 網羅性チェック(未知のアクションはコンパイル時に検出)。
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
