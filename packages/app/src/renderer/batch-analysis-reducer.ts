/**
 * レース複数選択+一括分析画面の状態遷移(純関数 reducer)。
 *
 * 既存の単一レース用 analysis-reducer を置き換えるのではなく、複数選択・一括実行という
 * 別モデルとして切り出す(単一選択=1件だけ選んで実行、は本reducerに自然に包含される)。
 * 副作用(IPC呼び出し)はコンポーネント側に置き、状態遷移規則だけをこの純関数へ集約する。
 * すべての遷移は新しいオブジェクトを返し、入力 state を破壊しない(不変性)。
 */

import type {
  AnalysisResult,
  BatchProgress,
  BatchRaceOutcome,
  RaceListItem,
  RaceVenueKind,
} from "../shared/analysis-types.js";

/** Discord送信の状態。 */
export type DiscordSendStatus = "idle" | "sending" | "success" | "error";

/** Discord送信の状態(ステータス+失敗理由)。 */
export interface DiscordSendState {
  /** 送信状態。 */
  readonly status: DiscordSendStatus;
  /** 失敗時のメッセージ(それ以外は null)。 */
  readonly message: string | null;
}

/** 実行対象1レースの状態(実行前は pending、完了で success/failure/skipped に確定)。 */
export type BatchRaceEntryStatus =
  | "pending"
  | "success"
  | "failure"
  | "skipped";

/** 実行対象1レースのエントリ(結果表示用)。 */
export interface BatchRaceEntry {
  /** レースID。 */
  readonly raceId: string;
  /** レース名(引けない場合は null)。 */
  readonly raceName: string | null;
  /** 実行状態。 */
  readonly status: BatchRaceEntryStatus;
  /** 成功時の結果(それ以外は null)。 */
  readonly result: AnalysisResult | null;
  /** 失敗時のエラー(それ以外は null)。 */
  readonly error: string | null;
}

/** レース選択画面の状態(複数選択)。 */
export interface BatchSelectionState {
  /** 日付入力(YYYYMMDD)。 */
  readonly date: string;
  /** レース一覧の取得中か。 */
  readonly loadingRaces: boolean;
  /** 取得済みのレース一覧。 */
  readonly races: readonly RaceListItem[];
  /** 一覧取得エラー(無ければ null)。 */
  readonly racesError: string | null;
  /** 選択中のレースID群(選択操作順。実行時は一覧順に整列してスナップショットする)。 */
  readonly selectedRaceIds: readonly string[];
  /** 開催区分(中央/地方)。既定は "central"。切替に応じて listRaces / listNarRaces を呼び分ける。 */
  readonly venueKind: RaceVenueKind;
  /**
   * 交流重賞(Jpn1/2/3)のみに絞り込むか(タスクB1)。既定は false。
   * venueKind="nar" のときのみ意味を持つ(3択UI「地方(Jpnのみ)」選択時にtrueになる)。
   * venueKind="central" のときは常に false(中央+Jpn限定で一覧が全滅する事故を防ぐガード。
   * race-list-target.ts の raceListTargetToSelection がこの不変条件を担保する)。
   */
  readonly jpnOnly: boolean;
}

/** 一括分析の実行状態。 */
export interface BatchRunState {
  /** 一括分析の実行中か。 */
  readonly running: boolean;
  /** 中断が要求され、レース境界での停止を待っているか。 */
  readonly canceling: boolean;
  /** 直近の全体進捗(無ければ null)。 */
  readonly progress: BatchProgress | null;
  /** 実行対象レースのエントリ(実行順)。実行前スナップショットから完了で確定。 */
  readonly outcomes: readonly BatchRaceEntry[];
  /** 実行世代ID(古い実行の進捗・完了イベントを弾く in-flight ガード用)。 */
  readonly runId: number;
  /** レース詳細を展開中のレースID群(既定は空=すべて閉じている)。 */
  readonly expandedRaceIds: readonly string[];
  /** Discord送信(サマリ1通)の状態。 */
  readonly discordSend: DiscordSendState;
}

/** 画面全体の状態。 */
export interface BatchAppState {
  readonly selection: BatchSelectionState;
  readonly run: BatchRunState;
}

/** reducer が処理するアクション。 */
export type BatchAppAction =
  | { readonly type: "日付変更"; readonly date: string }
  | {
      readonly type: "開催区分変更";
      readonly venueKind: RaceVenueKind;
      readonly jpnOnly: boolean;
    }
  | { readonly type: "レース取得開始" }
  | { readonly type: "レース取得成功"; readonly races: readonly RaceListItem[] }
  | { readonly type: "レース取得失敗"; readonly message: string }
  | { readonly type: "レース選択トグル"; readonly raceId: string }
  | { readonly type: "会場全選択"; readonly raceIds: readonly string[] }
  | { readonly type: "会場全解除"; readonly raceIds: readonly string[] }
  | { readonly type: "全解除" }
  | { readonly type: "一括分析開始" }
  | {
      readonly type: "一括進捗更新";
      readonly runId: number;
      readonly progress: BatchProgress;
    }
  | {
      readonly type: "一括分析完了";
      readonly runId: number;
      readonly outcomes: readonly BatchRaceOutcome[];
    }
  | { readonly type: "中断要求" }
  | { readonly type: "詳細開閉トグル"; readonly raceId: string }
  | { readonly type: "Discord送信開始" }
  | { readonly type: "Discord送信成功" }
  | { readonly type: "Discord送信失敗"; readonly message: string };

/** Discord送信の初期状態(未送信)。 */
const IDLE_DISCORD_SEND: DiscordSendState = { status: "idle", message: null };

/** 実行状態の初期値(未実行)。 */
const EMPTY_RUN: BatchRunState = {
  running: false,
  canceling: false,
  progress: null,
  outcomes: [],
  runId: 0,
  expandedRaceIds: [],
  discordSend: IDLE_DISCORD_SEND,
};

/**
 * 実行状態をクリアする(旧バッチ結果・進捗・送信状態を空へ)。
 * runId は巻き戻さず保持し、実行世代の単調増加を保つ(遅延イベントの取り違え防止)。
 */
function clearedRun(prev: BatchRunState): BatchRunState {
  return { ...EMPTY_RUN, runId: prev.runId };
}

/** 指定日付で初期状態を作る。 */
export function createInitialBatchState(date: string): BatchAppState {
  return {
    selection: {
      date,
      loadingRaces: false,
      races: [],
      racesError: null,
      selectedRaceIds: [],
      venueKind: "central",
      jpnOnly: false,
    },
    run: EMPTY_RUN,
  };
}

/** 選択集合を更新するヘルパ(不変)。 */
function withSelection(
  state: BatchAppState,
  selectedRaceIds: readonly string[],
): BatchAppState {
  return {
    ...state,
    selection: { ...state.selection, selectedRaceIds },
  };
}

/** レース一覧の並び順で選択IDをスナップショットする(実行順を一覧順に固定する)。 */
function snapshotInListOrder(state: BatchAppState): BatchRaceEntry[] {
  const selected = new Set(state.selection.selectedRaceIds);
  const nameOf = new Map(state.selection.races.map((r) => [r.raceId, r.name]));
  return state.selection.races
    .filter((r) => selected.has(r.raceId))
    .map((r) => ({
      raceId: r.raceId,
      raceName: nameOf.get(r.raceId) ?? null,
      status: "pending" as const,
      result: null,
      error: null,
    }));
}

/** 状態遷移(純関数)。 */
export function batchAnalysisReducer(
  state: BatchAppState,
  action: BatchAppAction,
): BatchAppState {
  switch (action.type) {
    case "日付変更":
      // 実行中の選択・一覧変更は禁止(in-flight の取り違え防止)。
      if (state.run.running) {
        return state;
      }
      // 日付を変えると旧一覧に対する選択は無意味になるため、選択と旧バッチ結果(横断サマリ・
      // レース詳細)をここでクリアする。残すと「選択中N件」の誤表示や、別日付の結果が
      // 混在表示される不整合を招くため(設計判断: クリアを採用)。
      return {
        ...state,
        selection: {
          ...state.selection,
          date: action.date,
          selectedRaceIds: [],
        },
        run: clearedRun(state.run),
      };

    case "開催区分変更":
      // 実行中の開催区分変更は禁止(in-flight の取り違え防止。日付変更と同じ扱い)。
      if (state.run.running) {
        return state;
      }
      // no-op: 現在値と同じ開催区分・同じjpnOnlyを指定した場合は状態をそのまま返す(参照等価)。
      // トグルの再クリック等で選択・旧結果が意図せず消えるのを防ぐ。
      // タスクB1: 3択(中央/地方(全て)/地方(Jpnのみ))のうち「地方(全て)→地方(Jpnのみ)」の
      // ようにvenueKindが同じでjpnOnlyだけ変わる遷移も「一覧の意味が変わる」ため no-op としない。
      if (
        action.venueKind === state.selection.venueKind &&
        action.jpnOnly === state.selection.jpnOnly
      ) {
        return state;
      }
      // 開催区分(またはjpnOnly)が変わると一覧の意味が変わるため、日付変更と同様に選択・
      // 旧バッチ結果をクリアする(一覧自体は次の「取得」操作まで残る。呼び出し側が
      // listRaces / listNarRaces を呼び分け、jpnOnly は main 層でのフィルタ適用に使う)。
      return {
        ...state,
        selection: {
          ...state.selection,
          venueKind: action.venueKind,
          jpnOnly: action.jpnOnly,
          selectedRaceIds: [],
        },
        run: clearedRun(state.run),
      };

    case "レース取得開始":
      if (state.run.running) {
        return state;
      }
      return {
        ...state,
        selection: {
          ...state.selection,
          loadingRaces: true,
          racesError: null,
        },
      };

    case "レース取得成功":
      // 一覧を取り直したら選択対象も変わるため、旧選択と旧バッチ結果をクリアして
      // 新しい一覧に差し替える(旧結果パネルの残留を防ぐ)。
      return {
        ...state,
        selection: {
          ...state.selection,
          loadingRaces: false,
          races: action.races,
          racesError: null,
          selectedRaceIds: [],
        },
        run: clearedRun(state.run),
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

    case "レース選択トグル": {
      if (state.run.running) {
        return state;
      }
      const current = state.selection.selectedRaceIds;
      const next = current.includes(action.raceId)
        ? current.filter((id) => id !== action.raceId)
        : [...current, action.raceId];
      return withSelection(state, next);
    }

    case "会場全選択": {
      if (state.run.running) {
        return state;
      }
      const set = new Set(state.selection.selectedRaceIds);
      const additions = action.raceIds.filter((id) => !set.has(id));
      if (additions.length === 0) {
        return state;
      }
      return withSelection(state, [
        ...state.selection.selectedRaceIds,
        ...additions,
      ]);
    }

    case "会場全解除": {
      if (state.run.running) {
        return state;
      }
      const remove = new Set(action.raceIds);
      return withSelection(
        state,
        state.selection.selectedRaceIds.filter((id) => !remove.has(id)),
      );
    }

    case "全解除":
      if (state.run.running) {
        return state;
      }
      if (state.selection.selectedRaceIds.length === 0) {
        return state;
      }
      return withSelection(state, []);

    case "一括分析開始": {
      const outcomes = snapshotInListOrder(state);
      return {
        ...state,
        run: {
          running: true,
          canceling: false,
          progress: null,
          outcomes,
          runId: state.run.runId + 1,
          expandedRaceIds: [],
          discordSend: IDLE_DISCORD_SEND,
        },
      };
    }

    case "一括進捗更新":
      // in-flight ガード: 現在の実行世代の進捗のみ反映する。
      if (action.runId !== state.run.runId) {
        return state;
      }
      return {
        ...state,
        run: { ...state.run, progress: action.progress },
      };

    case "一括分析完了": {
      // in-flight ガード: 現在の実行世代の完了のみ反映する。
      if (action.runId !== state.run.runId) {
        return state;
      }
      const outcomes: BatchRaceEntry[] = action.outcomes.map((o) => ({
        raceId: o.raceId,
        raceName: o.result?.raceName ?? o.raceName,
        status: o.status,
        result: o.result,
        error: o.error,
      }));
      return {
        ...state,
        run: {
          ...state.run,
          running: false,
          canceling: false,
          progress: null,
          outcomes,
          // 新しい結果を得たので送信ステータスは未送信へ戻す。
          discordSend: IDLE_DISCORD_SEND,
        },
      };
    }

    case "中断要求":
      // 実行中のみ有効。running は境界での停止(完了アクション)まで維持する。
      if (!state.run.running) {
        return state;
      }
      return {
        ...state,
        run: { ...state.run, canceling: true },
      };

    case "詳細開閉トグル": {
      const expanded = state.run.expandedRaceIds;
      const next = expanded.includes(action.raceId)
        ? expanded.filter((id) => id !== action.raceId)
        : [...expanded, action.raceId];
      return {
        ...state,
        run: { ...state.run, expandedRaceIds: next },
      };
    }

    case "Discord送信開始":
      return {
        ...state,
        run: {
          ...state.run,
          discordSend: { status: "sending", message: null },
        },
      };

    case "Discord送信成功":
      return {
        ...state,
        run: {
          ...state.run,
          discordSend: { status: "success", message: null },
        },
      };

    case "Discord送信失敗":
      return {
        ...state,
        run: {
          ...state.run,
          discordSend: { status: "error", message: action.message },
        },
      };

    default: {
      // 網羅性チェック(未知のアクションはコンパイル時に検出)。
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
