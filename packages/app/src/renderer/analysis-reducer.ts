/**
 * レース選択画面+分析画面の状態遷移(純関数 reducer)。
 *
 * React の useReducer から使う。副作用(IPC呼び出し)はコンポーネント側に置き、
 * 状態の遷移規則だけをこの純関数に集約して単体テストで固定する。
 * すべての遷移は新しいオブジェクトを返し、入力 state を破壊しない(不変性)。
 */

import type {
  AnalysisProgress,
  AnalysisResult,
  RaceListItem,
} from "../shared/analysis-types.js";

/** レース選択画面の状態。 */
export interface RaceSelectionState {
  /** 日付入力(YYYYMMDD)。 */
  readonly date: string;
  /** レース一覧の取得中か。 */
  readonly loadingRaces: boolean;
  /** 取得済みのレース一覧。 */
  readonly races: readonly RaceListItem[];
  /** 一覧取得エラー(無ければ null)。 */
  readonly racesError: string | null;
  /** 選択中のレースID(未選択は null)。 */
  readonly selectedRaceId: string | null;
}

/** 分析画面の状態。 */
export interface AnalysisState {
  /** 分析実行中か。 */
  readonly running: boolean;
  /** 直近の進捗(無ければ null)。 */
  readonly progress: AnalysisProgress | null;
  /** 分析結果(無ければ null)。 */
  readonly result: AnalysisResult | null;
  /** 分析エラー(無ければ null)。 */
  readonly analysisError: string | null;
}

/** 画面全体の状態。 */
export interface AppState {
  readonly selection: RaceSelectionState;
  readonly analysis: AnalysisState;
}

/** reducer が処理するアクション。 */
export type AppAction =
  | { readonly type: "日付変更"; readonly date: string }
  | { readonly type: "レース取得開始" }
  | { readonly type: "レース取得成功"; readonly races: readonly RaceListItem[] }
  | { readonly type: "レース取得失敗"; readonly message: string }
  | { readonly type: "レース選択"; readonly raceId: string }
  | { readonly type: "分析開始" }
  | { readonly type: "進捗更新"; readonly progress: AnalysisProgress }
  | {
      readonly type: "分析成功";
      readonly raceId: string;
      readonly result: AnalysisResult;
    }
  | {
      readonly type: "分析失敗";
      readonly raceId: string;
      readonly message: string;
    };

/** 分析状態の初期値(未実行)。 */
const EMPTY_ANALYSIS: AnalysisState = {
  running: false,
  progress: null,
  result: null,
  analysisError: null,
};

/** 指定日付で初期状態を作る。 */
export function createInitialState(date: string): AppState {
  return {
    selection: {
      date,
      loadingRaces: false,
      races: [],
      racesError: null,
      selectedRaceId: null,
    },
    analysis: EMPTY_ANALYSIS,
  };
}

/** 状態遷移(純関数)。 */
export function analysisReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "日付変更":
      return {
        ...state,
        selection: { ...state.selection, date: action.date },
      };

    case "レース取得開始":
      return {
        ...state,
        selection: {
          ...state.selection,
          loadingRaces: true,
          racesError: null,
        },
      };

    case "レース取得成功":
      return {
        ...state,
        selection: {
          ...state.selection,
          loadingRaces: false,
          races: action.races,
          racesError: null,
        },
      };

    case "レース取得失敗":
      return {
        ...state,
        selection: {
          ...state.selection,
          loadingRaces: false,
          races: [],
          racesError: action.message,
        },
      };

    case "レース選択":
      // 別レースを選び直したら、前回の分析結果・進捗・エラーは無効なのでリセットする。
      return {
        ...state,
        selection: { ...state.selection, selectedRaceId: action.raceId },
        analysis: EMPTY_ANALYSIS,
      };

    case "分析開始":
      return {
        ...state,
        analysis: {
          running: true,
          progress: null,
          result: null,
          analysisError: null,
        },
      };

    case "進捗更新":
      return {
        ...state,
        analysis: { ...state.analysis, progress: action.progress },
      };

    case "分析成功":
      // in-flight ガード: 実行を開始したレース(action.raceId)が現在の選択と一致する場合のみ反映する。
      // 実行中にレースを切り替えると、遅れて届いた旧レースの結果が新選択下に表示されるのを防ぐ。
      if (action.raceId !== state.selection.selectedRaceId) {
        return state;
      }
      return {
        ...state,
        analysis: {
          running: false,
          progress: null,
          result: action.result,
          analysisError: null,
        },
      };

    case "分析失敗":
      // 分析成功と同じ in-flight ガード。切替後に届いた旧レースの失敗は無視する。
      if (action.raceId !== state.selection.selectedRaceId) {
        return state;
      }
      return {
        ...state,
        analysis: {
          ...state.analysis,
          running: false,
          analysisError: action.message,
        },
      };

    default: {
      // 網羅性チェック(未知のアクションはコンパイル時に検出)。
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
