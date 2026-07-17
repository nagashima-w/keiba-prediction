import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { BatchRaceOutcome, VerifyVenueFilter } from "../shared/analysis-types.js";
import {
  batchAnalysisReducer,
  createInitialBatchState,
} from "./batch-analysis-reducer.js";
import { collectEvPlusSummary } from "./batch-summary.js";
import { BatchAnalysisView } from "./BatchAnalysisView.js";
import { buildRendererErrorPayload } from "./renderer-error-payload.js";
import { RaceSelection } from "./RaceSelection.js";
import { SettingsView } from "./SettingsView.js";
import { VerifyView } from "./VerifyView.js";
import {
  createInitialVerifyState,
  verifyReducer,
  type TabKey,
} from "./verify-reducer.js";
import {
  deleteUnknownPromptVersionConfirmMessage,
  unknownPromptVersionAnalysisCount,
} from "./verify-format.js";

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
 * ルート画面。レース選択(日付→一覧→複数選択)と一括分析(直列実行→全体進捗→横断サマリ+
 * レースごとの詳細)を束ねる。状態遷移は純関数 reducer(batch-analysis-reducer)に委ね、
 * ここでは IPC 呼び出し(副作用)と dispatch の橋渡しに徹する。
 */
export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(
    batchAnalysisReducer,
    todayYyyymmdd(),
    createInitialBatchState,
  );
  const [verify, verifyDispatch] = useReducer(
    verifyReducer,
    undefined,
    createInitialVerifyState,
  );

  // Discord通知の設定スナップショット(送信ボタンの有効化判定・自動送信の判定に使う)。
  const [notify, setNotify] = useState({
    webhookConfigured: false,
    autoSend: false,
  });
  // 自動送信判定で解決時の最新設定を参照するための ref。
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // 実行中バッチの世代ID。一括分析開始時に固定し、完了で null に戻す。
  // 進捗イベントにはこの「開始時に固定した runId」を添えるため、完了後に遅れて届いた
  // 旧バッチの進捗は reducer の runId ガードで確実に弾かれる(恒真ガードにならない)。
  const activeBatchRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.keibaApi.onBatchProgress((progress) => {
      // バッチ非実行中(null)は現状の runId と一致しない -1 を渡し、reducer 側で無視させる。
      dispatch({
        type: "一括進捗更新",
        runId: activeBatchRunIdRef.current ?? -1,
        progress,
      });
    });
    return unsubscribe;
  }, []);

  // 実行中一括取込(Task#31)の世代ID。一括分析と同じ in-flight ガードの仕組み。
  const activeBulkImportRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.keibaApi.onBulkImportProgress((progress) => {
      verifyDispatch({
        type: "一括取込進捗更新",
        runId: activeBulkImportRunIdRef.current ?? -1,
        progress,
      });
    });
    return unsubscribe;
  }, []);

  // Discord通知設定(Webhook URL 設定有無・自動送信ON/OFF)を読み込む。
  const loadNotifySettings = useCallback(() => {
    window.keibaApi
      .getSettings()
      .then((s) =>
        setNotify({
          webhookConfigured: s.discordWebhookUrl.trim() !== "",
          autoSend: s.autoSendDiscord,
        }),
      )
      .catch(() => {
        setNotify({ webhookConfigured: false, autoSend: false });
      });
  }, []);

  useEffect(() => {
    loadNotifySettings();
  }, [loadNotifySettings]);

  // 一括サマリの Discord送信(手動・自動共通)。EVプラスが横断で1頭も無ければ送らない。
  const handleSendDiscord = useCallback((outcomes: readonly BatchRaceOutcome[]) => {
    dispatch({ type: "Discord送信開始" });
    window.keibaApi
      .sendBatchDiscord(outcomes)
      .then(() => dispatch({ type: "Discord送信成功" }))
      .catch((e: unknown) =>
        dispatch({ type: "Discord送信失敗", message: errorMessage(e) }),
      );
  }, []);

  const loadVerifyData = useCallback(() => {
    verifyDispatch({ type: "履歴取得開始" });
    window.keibaApi
      .listAnalyses()
      .then((history) => verifyDispatch({ type: "履歴取得成功", history }))
      .catch((e: unknown) =>
        verifyDispatch({ type: "履歴取得失敗", message: errorMessage(e) }),
      );
    verifyDispatch({ type: "レポート取得開始" });
    window.keibaApi
      .getVerifyReport(verify.venueFilter)
      .then((report) => verifyDispatch({ type: "レポート取得成功", report }))
      .catch((e: unknown) =>
        verifyDispatch({ type: "レポート取得失敗", message: errorMessage(e) }),
      );
    verifyDispatch({ type: "版別レポート取得開始" });
    window.keibaApi
      .getVerifyReportByPromptVersion()
      .then((reports) =>
        verifyDispatch({ type: "版別レポート取得成功", reports }),
      )
      .catch((e: unknown) =>
        verifyDispatch({
          type: "版別レポート取得失敗",
          message: errorMessage(e),
        }),
      );
    verifyDispatch({ type: "レース別予実取得開始" });
    window.keibaApi
      .getRaceBreakdown()
      .then((raceBreakdown) =>
        verifyDispatch({ type: "レース別予実取得成功", raceBreakdown }),
      )
      .catch((e: unknown) =>
        verifyDispatch({
          type: "レース別予実取得失敗",
          message: errorMessage(e),
        }),
      );
  }, [verify.venueFilter]);

  // 検証画面の地域フィルタ切替(Task#32)。venueFilter を更新したうえで、
  // トータル集計・キャリブレーション・傾向(report)のみを絞り込み条件で再取得する
  // (履歴・版別比較・レース別予実はスコープ外のため呼び直さない。loadVerifyDataの
  // 全量再取得より軽い)。
  const handleVenueFilterChange = useCallback(
    (venueFilter: VerifyVenueFilter) => {
      verifyDispatch({ type: "地域フィルタ変更", venueFilter });
      verifyDispatch({ type: "レポート取得開始" });
      window.keibaApi
        .getVerifyReport(venueFilter)
        .then((report) => verifyDispatch({ type: "レポート取得成功", report }))
        .catch((e: unknown) =>
          verifyDispatch({ type: "レポート取得失敗", message: errorMessage(e) }),
        );
    },
    [],
  );

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      verifyDispatch({ type: "タブ切替", tab });
      if (tab === "検証") {
        loadVerifyData();
      }
      if (tab === "分析") {
        loadNotifySettings();
      }
    },
    [loadVerifyData, loadNotifySettings],
  );

  const handleImport = useCallback(
    (raceId: string) => {
      verifyDispatch({ type: "取込開始", raceId });
      window.keibaApi
        .importResult(raceId)
        .then((outcome) => {
          // 未確定レース(発走前・確定前)は例外ではなく正常応答で返る。
          // 赤エラーにはせず、穏やかな案内を出すだけで取込済み扱いにはしない(履歴再読込も不要)。
          if (outcome.status === "not_confirmed") {
            verifyDispatch({ type: "取込未確定", raceId });
            return;
          }
          verifyDispatch({ type: "取込成功", raceId });
          loadVerifyData();
        })
        .catch((e: unknown) =>
          verifyDispatch({
            type: "取込失敗",
            raceId,
            message: errorMessage(e),
          }),
        );
    },
    [loadVerifyData],
  );

  // 「未取込をまとめて取り込む」(Task#31)。main側でNOT EXISTS判定した未取込レースを直列取込する。
  const handleRunBulkImport = useCallback(() => {
    const runId = verify.bulkImport.runId + 1;
    activeBulkImportRunIdRef.current = runId;
    verifyDispatch({ type: "一括取込開始" });
    window.keibaApi
      .runBulkImport()
      .then((outcomes) => {
        activeBulkImportRunIdRef.current = null;
        verifyDispatch({ type: "一括取込完了", runId, outcomes });
        // 取込後に検証レポート・履歴を再読込する(取込結果を画面に反映する)。
        loadVerifyData();
      })
      .catch((e: unknown) => {
        // 通常は per-race の失敗として outcomes に記録されるため、ここに到達するのは
        // resourceManager 取得失敗等の予期しない全体失敗のみ(稀)。
        // main側のログファイルへ集約する(Task#35)。ログ集約自体の失敗はUI表示に影響させない
        // (ベストエフォート。呼び出し失敗を無視する)。
        window.keibaApi
          .logRendererError(buildRendererErrorPayload("renderer:bulk-import", e))
          .catch(() => {});
        activeBulkImportRunIdRef.current = null;
        verifyDispatch({ type: "一括取込完了", runId, outcomes: [] });
        // 一部のレースは取込に成功した後で全体例外が伝播した可能性があるため、
        // 画面が古いまま残らないよう安全側でレポート・履歴を再読込する(code-reviewer提案対応)。
        loadVerifyData();
      });
  }, [verify.bulkImport.runId, loadVerifyData]);

  const handleCancelBulkImport = useCallback(() => {
    verifyDispatch({ type: "一括取込中断要求" });
    // main 側の中断フラグを立てる(次のレース境界で停止)。失敗は無視(UI表示は境界停止で反映)。
    window.keibaApi.cancelBulkImport().catch(() => {});
  }, []);

  // 版不明(prompt_version=null)分析の削除(Task#33)。取り消せない破壊的操作のため、
  // window.confirm で件数付きの確認を必ず経てから呼ぶ。件数は既に読み込み済みの版別レポート
  // (reportsByPromptVersion)から求め、追加のIPC往復は行わない。
  const handleDeleteUnknownPromptVersionAnalyses = useCallback(() => {
    const count = unknownPromptVersionAnalysisCount(verify.reportsByPromptVersion);
    if (!window.confirm(deleteUnknownPromptVersionConfirmMessage(count))) {
      return;
    }
    verifyDispatch({ type: "版不明削除開始" });
    window.keibaApi
      .deleteUnknownPromptVersionAnalyses()
      .then(({ deletedCount }) => {
        verifyDispatch({ type: "版不明削除成功", deletedCount });
        // 削除後に検証データ(レポート・版別比較・履歴・レース別予実)を再読込する(仕様の受け入れ条件)。
        loadVerifyData();
      })
      .catch((e: unknown) =>
        verifyDispatch({
          type: "版不明削除失敗",
          message: errorMessage(e),
        }),
      );
  }, [verify.reportsByPromptVersion, loadVerifyData]);

  const handleFetch = useCallback(() => {
    const date = state.selection.date;
    const venueKind = state.selection.venueKind;
    dispatch({ type: "レース取得開始" });
    window.keibaApi
      .listRaces(date, venueKind)
      .then((races) => dispatch({ type: "レース取得成功", races }))
      .catch((e: unknown) =>
        dispatch({ type: "レース取得失敗", message: errorMessage(e) }),
      );
  }, [state.selection.date, state.selection.venueKind]);

  const handleRun = useCallback(() => {
    const raceIds = state.selection.races
      .filter((r) => state.selection.selectedRaceIds.includes(r.raceId))
      .map((r) => r.raceId);
    if (raceIds.length === 0) {
      return;
    }
    const date = state.selection.date;
    // 開始と同時に実行世代を1つ進める。この runId を進捗・完了アクションに添えて in-flight ガードを効かせる。
    const runId = state.run.runId + 1;
    activeBatchRunIdRef.current = runId;
    dispatch({ type: "一括分析開始" });
    window.keibaApi
      .runBatchAnalysis(raceIds, date)
      .then((outcomes) => {
        // このバッチは完了。以降に遅れて届く進捗イベントは無視させる。
        activeBatchRunIdRef.current = null;
        dispatch({ type: "一括分析完了", runId, outcomes });
        // 自動送信: ON かつ Webhook 設定済みで、横断EVプラスが1頭以上あれば1通送る。
        if (
          notifyRef.current.autoSend &&
          notifyRef.current.webhookConfigured &&
          collectEvPlusSummary(outcomes).length > 0
        ) {
          handleSendDiscord(outcomes);
        }
      })
      .catch((e: unknown) => {
        // 一括分析そのものの失敗(通常は個別レース失敗として outcomes に入るため稀)。
        // main側のログファイルへ集約する(Task#35 code-reviewer指摘: 要修正3-a)。
        // ログ集約自体の失敗はUI表示に影響させない(ベストエフォート。呼び出し失敗を無視する)。
        window.keibaApi
          .logRendererError(buildRendererErrorPayload("renderer:batch-analysis", e))
          .catch(() => {});
        activeBatchRunIdRef.current = null;
        dispatch({
          type: "一括分析完了",
          runId,
          outcomes: raceIds.map((raceId) => ({
            raceId,
            raceName: null,
            status: "failure" as const,
            result: null,
            error: errorMessage(e),
          })),
        });
      });
  }, [
    state.selection.races,
    state.selection.selectedRaceIds,
    state.selection.date,
    state.run.runId,
    handleSendDiscord,
  ]);

  const handleCancel = useCallback(() => {
    dispatch({ type: "中断要求" });
    // main 側の中断フラグを立てる(次のレース境界で停止)。失敗は無視(UI表示は境界停止で反映)。
    window.keibaApi.cancelBatchAnalysis().catch(() => {});
  }, []);

  // 完了済みアウトカムを BatchRaceOutcome 形へ(送信・自動送信で使う)。
  const completedOutcomes: BatchRaceOutcome[] = state.run.outcomes
    .filter((o) => o.status !== "pending")
    .map((o) => ({
      raceId: o.raceId,
      raceName: o.raceName,
      status: o.status === "pending" ? "skipped" : o.status,
      result: o.result,
      error: o.error,
    }));

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
        レースを複数選んで一括分析すると、各レースの複勝期待値(EV)を推定し、
        EVプラスの馬を横断でまとめて表示します。
      </p>

      <nav style={{ display: "flex", gap: "0.5rem", margin: "0.75rem 0" }}>
        {(["分析", "検証", "設定"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => handleTabChange(tab)}
            style={{
              padding: "0.35rem 0.9rem",
              border: "1px solid #ccc",
              borderBottom:
                verify.activeTab === tab ? "2px solid #4c8bf5" : "1px solid #ccc",
              background: verify.activeTab === tab ? "#eef4ff" : "#f7f7f7",
              fontWeight: verify.activeTab === tab ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {tab}
          </button>
        ))}
      </nav>

      <hr
        style={{ margin: "0 0 1rem", border: "none", borderTop: "1px solid #ddd" }}
      />

      {verify.activeTab === "分析" && (
        <>
          <RaceSelection
            date={state.selection.date}
            venueKind={state.selection.venueKind}
            loading={state.selection.loadingRaces}
            races={state.selection.races}
            error={state.selection.racesError}
            selectedRaceIds={state.selection.selectedRaceIds}
            // 一括分析実行中は日付変更・取得・選択変更を禁止し、in-flight の取り違えを防ぐ。
            disabled={state.run.running}
            onDateChange={(date) => dispatch({ type: "日付変更", date })}
            onVenueKindChange={(venueKind) =>
              dispatch({ type: "開催区分変更", venueKind })
            }
            onFetch={handleFetch}
            onToggle={(raceId) =>
              dispatch({ type: "レース選択トグル", raceId })
            }
            onSelectVenue={(raceIds) =>
              dispatch({ type: "会場全選択", raceIds })
            }
            onDeselectVenue={(raceIds) =>
              dispatch({ type: "会場全解除", raceIds })
            }
            onClearAll={() => dispatch({ type: "全解除" })}
          />

          <BatchAnalysisView
            selectedCount={state.selection.selectedRaceIds.length}
            running={state.run.running}
            canceling={state.run.canceling}
            progress={state.run.progress}
            outcomes={state.run.outcomes}
            expandedRaceIds={state.run.expandedRaceIds}
            onRun={handleRun}
            onCancel={handleCancel}
            onToggleDetail={(raceId) =>
              dispatch({ type: "詳細開閉トグル", raceId })
            }
            webhookConfigured={notify.webhookConfigured}
            discordSend={state.run.discordSend}
            onSendDiscord={() => handleSendDiscord(completedOutcomes)}
          />
        </>
      )}

      {verify.activeTab === "検証" && (
        <VerifyView
          state={verify}
          onImport={handleImport}
          onRefresh={loadVerifyData}
          onVenueFilterChange={handleVenueFilterChange}
          onRunBulkImport={handleRunBulkImport}
          onCancelBulkImport={handleCancelBulkImport}
          onDeleteUnknownPromptVersionAnalyses={
            handleDeleteUnknownPromptVersionAnalyses
          }
        />
      )}

      {verify.activeTab === "設定" && <SettingsView />}
    </main>
  );
}
