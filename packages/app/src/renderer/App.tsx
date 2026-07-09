import { useEffect, useState } from "react";

import type { AppInfo } from "../main/app-info.js";

/**
 * 最小画面。アプリ名・バージョン・開発フェーズを表示し、
 * IPC 経由で main から取得した core 要約値を表示する(core 読み込み確認)。
 * 本格的な画面(分析/検証/設定)は後続タスクで実装する。
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // preload が公開した API 経由で main の IPC ハンドラを呼び出す。
    window.keibaApi
      .getAppInfo()
      .then(setInfo)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.6 }}>
      <h1 style={{ marginBottom: "0.25rem" }}>{info?.appName ?? "競馬期待値分析ツール"}</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        バージョン {info?.appVersion ?? "…"} / {info?.phase ?? "Phase 4 開発中"}
      </p>

      <hr style={{ margin: "1.5rem 0", border: "none", borderTop: "1px solid #ddd" }} />

      <section>
        <h2 style={{ fontSize: "1rem" }}>core 読み込み確認(IPC)</h2>
        {error !== null ? (
          <p style={{ color: "#c00" }}>取得に失敗しました: {error}</p>
        ) : info === null ? (
          <p>読み込み中…</p>
        ) : (
          <ul>
            <li>バイアス補正の最小サンプル数: {info.core.minSampleForBias}</li>
            <li>prior 下限: {info.core.priorMin}</li>
            <li>prior 上限: {info.core.priorMax}</li>
          </ul>
        )}
      </section>
    </main>
  );
}
