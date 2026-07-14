/**
 * 検証タブの状態遷移(純関数 reducer)。
 *
 * 分析/検証のタブ切替、分析履歴一覧の取得、検証レポートの取得、結果取込の進行状態を管理する。
 * 副作用(IPC呼び出し)はコンポーネント側に置き、遷移規則だけをこの純関数に集約して単体テストで固定する。
 * すべての遷移は新しいオブジェクトを返し、入力 state を破壊しない(不変性)。
 */

import type {
  AnalysisHistoryItem,
  PromptVersionVerifyReportView,
  VerifyReportView,
} from "../shared/analysis-types.js";

/** タブの種別。 */
export type TabKey = "分析" | "検証" | "設定";

/** 検証タブの状態。 */
export interface VerifyState {
  /** 現在のタブ。 */
  readonly activeTab: TabKey;
  /** 分析履歴一覧。 */
  readonly history: readonly AnalysisHistoryItem[];
  /** 履歴取得中か。 */
  readonly loadingHistory: boolean;
  /** 履歴取得エラー(無ければ null)。 */
  readonly historyError: string | null;
  /** 検証レポート(無ければ null)。 */
  readonly report: VerifyReportView | null;
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
  /** 結果取込中のレースID(ボタン二重押下防止・表示用)。 */
  readonly importingRaceIds: readonly string[];
  /** 直近の取込エラー(無ければ null)。 */
  readonly importError: string | null;
}

/** reducer が処理するアクション。 */
export type VerifyAction =
  | { readonly type: "タブ切替"; readonly tab: TabKey }
  | { readonly type: "履歴取得開始" }
  | {
      readonly type: "履歴取得成功";
      readonly history: readonly AnalysisHistoryItem[];
    }
  | { readonly type: "履歴取得失敗"; readonly message: string }
  | { readonly type: "レポート取得開始" }
  | { readonly type: "レポート取得成功"; readonly report: VerifyReportView }
  | { readonly type: "レポート取得失敗"; readonly message: string }
  | { readonly type: "版別レポート取得開始" }
  | {
      readonly type: "版別レポート取得成功";
      readonly reports: readonly PromptVersionVerifyReportView[];
    }
  | { readonly type: "版別レポート取得失敗"; readonly message: string }
  | { readonly type: "取込開始"; readonly raceId: string }
  | { readonly type: "取込成功"; readonly raceId: string }
  | { readonly type: "取込失敗"; readonly raceId: string; readonly message: string };

/** 初期状態(分析タブ・空)。 */
export function createInitialVerifyState(): VerifyState {
  return {
    activeTab: "分析",
    history: [],
    loadingHistory: false,
    historyError: null,
    report: null,
    loadingReport: false,
    reportError: null,
    reportsByPromptVersion: [],
    loadingReportsByPromptVersion: false,
    reportsByPromptVersionError: null,
    importingRaceIds: [],
    importError: null,
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

    case "履歴取得開始":
      return { ...state, loadingHistory: true, historyError: null };

    case "履歴取得成功":
      return {
        ...state,
        loadingHistory: false,
        history: action.history,
        historyError: null,
      };

    case "履歴取得失敗":
      return { ...state, loadingHistory: false, historyError: action.message };

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

    case "取込開始":
      return {
        ...state,
        importingRaceIds: addImporting(state.importingRaceIds, action.raceId),
        importError: null,
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
      };

    default: {
      // 網羅性チェック(未知のアクションはコンパイル時に検出)。
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
