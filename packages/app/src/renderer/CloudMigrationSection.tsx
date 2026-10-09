import { useCallback, useReducer } from "react";

import { CopyErrorButton } from "./CopyErrorButton.js";
import {
  buildCloudMigrationSummaryText,
  cloudMigrationReducer,
  createInitialCloudMigrationState,
  isCloudMigrationBusy,
} from "./cloud-migration-reducer.js";

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const noteStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "#666",
  margin: "0.2rem 0 0.5rem",
};

/**
 * 設定画面の「クラウドへの移行」の節(Issue #215・#167-A AC4)。
 * 分析と結果(取得キャッシュは除く)を、クラウド版へ取り込める 1 ファイルに書き出す。
 * 保存先はダイアログ(main 側)で選ぶ。書き出し中はボタンを無効化して「書き出し中…」と出し、終わったら
 * 件数・ファイルの大きさ・保存先を出す。キャンセルしたら何もしない。失敗時はメッセージ+ログのコピーボタン。
 * 状態遷移と文面は cloud-migration-reducer.ts(純関数)に置き、ここは IPC と dispatch の橋渡しだけを担う。
 */
export function CloudMigrationSection(): React.JSX.Element {
  const [state, dispatch] = useReducer(
    cloudMigrationReducer,
    undefined,
    createInitialCloudMigrationState,
  );

  const handleExport = useCallback(() => {
    dispatch({ type: "書き出し開始" });
    window.keibaApi
      .exportCloudMigration()
      .then((outcome) => {
        if (outcome.status === "canceled") {
          dispatch({ type: "書き出しキャンセル" });
          return;
        }
        dispatch({ type: "書き出し成功", outcome });
      })
      .catch((e: unknown) =>
        dispatch({ type: "書き出し失敗", message: errorMessage(e) }),
      );
  }, []);

  return (
    <div style={{ marginTop: "1.5rem", maxWidth: 480 }}>
      <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.4rem" }}>クラウドへの移行</h3>
      <p style={noteStyle}>
        これまでの分析と結果(出馬表の写し・LLMの応答・馬ごとの内訳を含む。取得キャッシュは含みません)を、
        クラウド版の画面から取り込めるファイルに書き出します。取り込みはクラウド版の画面で行います。
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button type="button" onClick={handleExport} disabled={isCloudMigrationBusy(state)}>
          {isCloudMigrationBusy(state) ? "書き出し中…" : "クラウド移行用に書き出す"}
        </button>
      </div>
      {state.status === "saved" && state.saved !== null && (
        <p style={{ color: "#0a7f2e", fontSize: "0.85rem", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          書き出しました: {buildCloudMigrationSummaryText(state.saved)}
        </p>
      )}
      {state.status === "canceled" && (
        <p style={{ color: "#666", fontSize: "0.85rem" }}>書き出しをキャンセルしました。</p>
      )}
      {state.status === "error" && state.message !== null && (
        <p style={{ color: "#c00", fontSize: "0.85rem" }}>
          書き出しに失敗しました: {state.message}
          <CopyErrorButton operation="設定:クラウド移行の書き出し" message={state.message} />
        </p>
      )}
    </div>
  );
}
