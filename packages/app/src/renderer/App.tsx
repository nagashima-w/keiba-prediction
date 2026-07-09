import { useCallback, useEffect, useReducer } from "react";

import { analysisReducer, createInitialState } from "./analysis-reducer.js";
import { AnalysisView } from "./AnalysisView.js";
import { RaceSelection } from "./RaceSelection.js";

/** 今日を YYYYMMDD で返す(日付ピッカーの初期値)。 */
function todayYyyymmdd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ルート画面。レース選択(日付→一覧→選択)と分析(実行→進捗→結果テーブル)を束ねる。
 * 状態遷移は純関数 reducer(analysis-reducer)に委ね、ここでは IPC 呼び出し(副作用)と
 * dispatch の橋渡しに徹する。
 */
export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(
    analysisReducer,
    todayYyyymmdd(),
    createInitialState,
  );

  // 進捗イベント(main→renderer)の購読。マウント中1度だけ登録し、アンマウントで解除する。
  useEffect(() => {
    const unsubscribe = window.keibaApi.onAnalysisProgress((progress) => {
      dispatch({ type: "進捗更新", progress });
    });
    return unsubscribe;
  }, []);

  const handleFetch = useCallback(() => {
    const date = state.selection.date;
    dispatch({ type: "レース取得開始" });
    window.keibaApi
      .listRaces(date)
      .then((races) => dispatch({ type: "レース取得成功", races }))
      .catch((e: unknown) =>
        dispatch({ type: "レース取得失敗", message: errorMessage(e) }),
      );
  }, [state.selection.date]);

  const handleRun = useCallback(() => {
    const raceId = state.selection.selectedRaceId;
    if (raceId === null) {
      return;
    }
    const date = state.selection.date;
    dispatch({ type: "分析開始" });
    window.keibaApi
      .runAnalysis(raceId, date)
      // 実行を開始したレース(raceId)を成否アクションに添えて、reducer 側で
      // in-flight ガード(切替後の旧結果表示防止)を効かせる。
      .then((result) => dispatch({ type: "分析成功", raceId, result }))
      .catch((e: unknown) =>
        dispatch({ type: "分析失敗", raceId, message: errorMessage(e) }),
      );
  }, [state.selection.selectedRaceId, state.selection.date]);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "1.5rem 2rem",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ marginBottom: "0.25rem", fontSize: "1.4rem" }}>
        競馬期待値分析ツール
      </h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: "0.9rem" }}>
        レースを選んで分析すると、複勝の期待値(EV)を推定します。EVプラスの行を
        ハイライトします。
      </p>

      <hr
        style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #ddd" }}
      />

      <RaceSelection
        date={state.selection.date}
        loading={state.selection.loadingRaces}
        races={state.selection.races}
        error={state.selection.racesError}
        selectedRaceId={state.selection.selectedRaceId}
        // 分析実行中は日付変更・取得・レース切替を禁止し、in-flight の取り違えを防ぐ。
        disabled={state.analysis.running}
        onDateChange={(date) => dispatch({ type: "日付変更", date })}
        onFetch={handleFetch}
        onSelect={(raceId) => dispatch({ type: "レース選択", raceId })}
      />

      <AnalysisView
        raceId={state.selection.selectedRaceId}
        running={state.analysis.running}
        progress={state.analysis.progress}
        result={state.analysis.result}
        error={state.analysis.analysisError}
        onRun={handleRun}
      />
    </main>
  );
}
