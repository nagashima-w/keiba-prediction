import { useCallback, useEffect, useReducer } from "react";

import { CopyErrorButton } from "./CopyErrorButton.js";
import {
  BASE_SCORE_WEIGHT_KEYS,
  BASE_SCORE_WEIGHT_LABELS,
  BIAS_WEIGHT_KEYS,
  BIAS_WEIGHT_LABELS,
  isValidThreshold,
  isValidWebhookUrl,
  isValidWeight,
  type BaseScoreWeightKey,
  type BiasWeightKey,
} from "../shared/settings.js";
import {
  buildUpdate,
  createInitialSettingsState,
  isFormValid,
  settingsReducer,
} from "./settings-reducer.js";

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.85rem",
  fontWeight: 600,
  marginBottom: "0.2rem",
};
const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.9rem",
  width: "100%",
  boxSizing: "border-box",
};
const invalidStyle: React.CSSProperties = { ...inputStyle, borderColor: "#c00" };
const fieldStyle: React.CSSProperties = { marginBottom: "0.9rem", maxWidth: 480 };
const noteStyle: React.CSSProperties = {
  color: "#666",
  fontSize: "0.78rem",
  margin: "0.2rem 0 0",
};
const weightInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: "6rem",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "5rem",
  resize: "vertical",
  fontFamily: "inherit",
};

/**
 * 設定画面(仕様「5. ui」設定画面 / scorer末尾の重みconfig調整)。
 *
 * APIキー・Discord Webhook URL・EV閾値・主要な重み(バイアス7種+基礎6種)・自動送信ON/OFF を編集する。
 * 読込・保存・初期化は IPC 経由(getSettings/saveSettings/resetSettings)。フォーム状態は純関数 reducer に委ね、
 * ここでは副作用(IPC)と dispatch の橋渡し、および入力の見た目(検証エラーの縁色)に徹する。
 */
export function SettingsView(): React.JSX.Element {
  const [state, dispatch] = useReducer(
    settingsReducer,
    undefined,
    createInitialSettingsState,
  );

  // マウント時に現在の設定を読み込む(タブを開くたびに最新を取得)。
  useEffect(() => {
    dispatch({ type: "読込開始" });
    window.keibaApi
      .getSettings()
      .then((settings) => dispatch({ type: "読込成功", settings }))
      .catch((e: unknown) =>
        dispatch({ type: "読込失敗", message: errorMessage(e) }),
      );
  }, []);

  const handleSave = useCallback(() => {
    dispatch({ type: "保存開始" });
    window.keibaApi
      .saveSettings(buildUpdate(state))
      .then((settings) => dispatch({ type: "保存成功", settings }))
      .catch((e: unknown) =>
        dispatch({ type: "保存失敗", message: errorMessage(e) }),
      );
  }, [state]);

  const handleReset = useCallback(() => {
    dispatch({ type: "保存開始" });
    window.keibaApi
      .resetSettings()
      .then((settings) => dispatch({ type: "保存成功", settings }))
      .catch((e: unknown) =>
        dispatch({ type: "保存失敗", message: errorMessage(e) }),
      );
  }, []);

  // ログフォルダを開く(Task#36 受け入れ条件1)。main側でディレクトリ未作成なら作成してから開く。
  const handleOpenLogFolder = useCallback(() => {
    dispatch({ type: "ログフォルダを開く開始" });
    window.keibaApi
      .openLogFolder()
      .then(() => dispatch({ type: "ログフォルダを開く成功" }))
      .catch((e: unknown) =>
        dispatch({ type: "ログフォルダを開く失敗", message: errorMessage(e) }),
      );
  }, []);

  // 最新ログをエクスポート(Task#36 受け入れ条件2)。保存先はmain側のダイアログで選ばせる。
  const handleExportLogs = useCallback(() => {
    dispatch({ type: "ログエクスポート開始" });
    window.keibaApi
      .exportLogs()
      .then((outcome) => {
        if (outcome.status === "canceled") {
          dispatch({ type: "ログエクスポートキャンセル" });
          return;
        }
        dispatch({ type: "ログエクスポート成功", filePath: outcome.filePath });
      })
      .catch((e: unknown) =>
        dispatch({ type: "ログエクスポート失敗", message: errorMessage(e) }),
      );
  }, []);

  if (!state.loaded) {
    return (
      <section style={{ marginTop: "1rem" }}>
        <p style={{ color: "#666" }}>
          {state.status === "error"
            ? `設定の読み込みに失敗しました: ${state.message}`
            : "設定を読み込んでいます…"}
          {state.status === "error" && state.message !== null && (
            <CopyErrorButton
              operation="設定:読込"
              message={state.message}
            />
          )}
        </p>
      </section>
    );
  }

  const canSave = isFormValid(state) && state.status !== "saving";

  return (
    <section style={{ marginTop: "1rem" }}>
      <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.75rem" }}>設定</h2>

      {/* APIキー。 */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="api-key">
          Anthropic APIキー(ANTHROPIC_API_KEY)
        </label>
        <input
          id="api-key"
          type="password"
          style={inputStyle}
          value={state.apiKeyInput}
          placeholder={
            state.apiKeyMasked === ""
              ? "未設定(sk-ant-… を入力)"
              : `現在: ${state.apiKeyMasked}(変更する場合のみ入力)`
          }
          disabled={state.apiKeyFromEnv}
          onChange={(e) =>
            dispatch({ type: "APIキー入力", value: e.target.value })
          }
        />
        {state.apiKeyFromEnv ? (
          <p style={noteStyle}>
            環境変数 ANTHROPIC_API_KEY が設定されているため、そちらが優先されます(現在:
            {state.apiKeyMasked})。環境変数を外すと、保存済みキー(あれば)が使われます。
          </p>
        ) : (
          <p style={noteStyle}>
            APIキーは平文JSONで保存されます(個人利用専用の割り切り)。空欄のまま保存すると現在値を維持します。
          </p>
        )}
      </div>

      {/* Discord Webhook URL。 */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="webhook">
          Discord Webhook URL(Phase 5 で使用)
        </label>
        <input
          id="webhook"
          type="text"
          style={
            isValidWebhookUrl(state.discordWebhookUrl) ? inputStyle : invalidStyle
          }
          value={state.discordWebhookUrl}
          placeholder="https://discord.com/api/webhooks/…"
          onChange={(e) =>
            dispatch({ type: "Webhook入力", value: e.target.value })
          }
        />
        {!isValidWebhookUrl(state.discordWebhookUrl) && (
          <p style={{ ...noteStyle, color: "#c00" }}>
            URL形式(http/https)で入力してください。
          </p>
        )}
      </div>

      {/* EV閾値。 */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="ev-threshold">
          EV閾値(この値を超える馬券を抽出。既定1.0)
        </label>
        <input
          id="ev-threshold"
          type="number"
          step="0.05"
          min="0"
          style={isValidThreshold(state.evThreshold) ? inputStyle : invalidStyle}
          value={state.evThreshold}
          onChange={(e) =>
            dispatch({ type: "EV閾値入力", value: e.target.value })
          }
        />
        {!isValidThreshold(state.evThreshold) && (
          <p style={{ ...noteStyle, color: "#c00" }}>
            0より大きい数値を入力してください。
          </p>
        )}
      </div>

      {/* 自動送信ON/OFF。 */}
      <div style={fieldStyle}>
        <label style={{ fontSize: "0.9rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={state.autoSendDiscord}
            onChange={(e) =>
              dispatch({ type: "自動送信切替", value: e.target.checked })
            }
          />{" "}
          分析結果を自動でDiscordに送信する(Phase 5 で使用)
        </label>
      </div>

      {/* プロンプト追加指示(Task#28 プロンプト改善C)。 */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="additional-instruction">
          プロンプト追加指示(任意)
        </label>
        <textarea
          id="additional-instruction"
          style={textareaStyle}
          value={state.additionalInstruction}
          placeholder="例: 人気薄の複勝率は慎重に見積もること"
          onChange={(e) =>
            dispatch({ type: "追加指示入力", value: e.target.value })
          }
        />
        <p style={{ ...noteStyle, color: "#a60" }}>
          ここに書いた指示はLLMにそのまま渡されます。3着内率の推定を市場オッズ(人気)に近づける方向の指示は、
          本ツールの妙味検出を損なうため避けてください(市場から独立した確率推定×市場オッズで妙味を取る設計です)。
        </p>
        <p style={noteStyle}>
          空欄なら何も注入しません。次回の分析から反映され、どの追加指示で分析したかは検証画面に記録されます。
        </p>
      </div>

      {/* 重み(折りたたみ)。バイアス7種 + 基礎6種。 */}
      <details style={{ margin: "0.5rem 0 1rem", maxWidth: 480 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          スコアリングの重み(過剰補正に注意。verifyで調整)
        </summary>

        <h3 style={{ fontSize: "0.9rem", margin: "0.75rem 0 0.4rem" }}>
          環境・状態バイアス補正
        </h3>
        {BIAS_WEIGHT_KEYS.map((key: BiasWeightKey) => (
          <div
            key={key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.4rem",
            }}
          >
            <span style={{ flex: 1, fontSize: "0.85rem" }}>
              {BIAS_WEIGHT_LABELS[key]}
            </span>
            <input
              type="number"
              step="0.05"
              min="0"
              aria-label={BIAS_WEIGHT_LABELS[key]}
              style={
                isValidWeight(state.biasWeights[key])
                  ? weightInputStyle
                  : { ...weightInputStyle, borderColor: "#c00" }
              }
              value={state.biasWeights[key]}
              onChange={(e) =>
                dispatch({
                  type: "バイアス重み入力",
                  key,
                  value: e.target.value,
                })
              }
            />
          </div>
        ))}

        <h3 style={{ fontSize: "0.9rem", margin: "0.75rem 0 0.4rem" }}>
          基礎スコア
        </h3>
        {BASE_SCORE_WEIGHT_KEYS.map((key: BaseScoreWeightKey) => (
          <div
            key={key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.4rem",
            }}
          >
            <span style={{ flex: 1, fontSize: "0.85rem" }}>
              {BASE_SCORE_WEIGHT_LABELS[key]}
            </span>
            <input
              type="number"
              step="0.05"
              min="0"
              aria-label={BASE_SCORE_WEIGHT_LABELS[key]}
              style={
                isValidWeight(state.baseScoreWeights[key])
                  ? weightInputStyle
                  : { ...weightInputStyle, borderColor: "#c00" }
              }
              value={state.baseScoreWeights[key]}
              onChange={(e) =>
                dispatch({
                  type: "基礎重み入力",
                  key,
                  value: e.target.value,
                })
              }
            />
          </div>
        ))}
      </details>

      {/* 操作。 */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button type="button" onClick={handleSave} disabled={!canSave}>
          {state.status === "saving" ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={state.status === "saving"}
        >
          デフォルトに戻す
        </button>
        {state.status === "saved" && (
          <span style={{ color: "#0a7f2e", fontSize: "0.85rem" }}>
            保存しました(次回の分析から反映されます)。
          </span>
        )}
        {state.status === "error" && (
          <span style={{ color: "#c00", fontSize: "0.85rem" }}>
            失敗しました: {state.message}
            {state.message !== null && (
              <CopyErrorButton operation="設定:保存" message={state.message} />
            )}
          </span>
        )}
      </div>

      {/*
       * ログ取り出し導線(Task#36)。ユーザーが「ログを見て自分で対処+AIにログを添付して丸投げ」
       * できるよう、ログフォルダを直接開く操作と、現行ログ+ローテーション済みログを1ファイルに
       * まとめて保存する操作を提供する。
       */}
      <div style={{ marginTop: "1.5rem", maxWidth: 480 }}>
        <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.4rem" }}>ログ</h3>
        <p style={noteStyle}>
          エラーが起きたときは、ログフォルダを開いて中身を確認するか、ログをエクスポートしてAIに貼り付けて
          相談できます。
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={handleOpenLogFolder}
            disabled={state.logFolderStatus === "opening"}
          >
            {state.logFolderStatus === "opening" ? "開いています…" : "ログフォルダを開く"}
          </button>
          <button
            type="button"
            onClick={handleExportLogs}
            disabled={state.logExportStatus === "exporting"}
          >
            {state.logExportStatus === "exporting"
              ? "エクスポート中…"
              : "最新ログをエクスポート"}
          </button>
        </div>
        {state.logFolderStatus === "error" && state.logFolderMessage !== null && (
          <p style={{ color: "#c00", fontSize: "0.85rem" }}>
            ログフォルダを開けませんでした: {state.logFolderMessage}
            <CopyErrorButton
              operation="設定:ログフォルダを開く"
              message={state.logFolderMessage}
            />
          </p>
        )}
        {state.logExportStatus === "saved" && state.logExportMessage !== null && (
          <p style={{ color: "#0a7f2e", fontSize: "0.85rem" }}>
            保存しました: {state.logExportMessage}
          </p>
        )}
        {state.logExportStatus === "canceled" && (
          <p style={{ color: "#666", fontSize: "0.85rem" }}>
            エクスポートをキャンセルしました。
          </p>
        )}
        {state.logExportStatus === "error" && state.logExportMessage !== null && (
          <p style={{ color: "#c00", fontSize: "0.85rem" }}>
            エクスポートに失敗しました: {state.logExportMessage}
            <CopyErrorButton
              operation="設定:ログエクスポート"
              message={state.logExportMessage}
            />
          </p>
        )}
      </div>
    </section>
  );
}
