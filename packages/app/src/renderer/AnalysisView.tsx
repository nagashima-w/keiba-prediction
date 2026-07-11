import type {
  AnalysisProgress,
  AnalysisResult,
} from "../shared/analysis-types.js";
import type { DiscordSendState } from "./analysis-reducer.js";
import {
  formatEv,
  formatOdds,
  formatPercent,
  formatReason,
  isHighlightRow,
  oddsStatusNote,
} from "./format.js";

/** 分析画面のプロパティ。 */
export interface AnalysisViewProps {
  /** 対象レースID(未選択は null)。 */
  readonly raceId: string | null;
  /** 分析実行中か。 */
  readonly running: boolean;
  /** 直近の進捗(無ければ null)。 */
  readonly progress: AnalysisProgress | null;
  /** 分析結果(無ければ null)。 */
  readonly result: AnalysisResult | null;
  /** 分析エラー(無ければ null)。 */
  readonly error: string | null;
  /** 「分析実行」操作。 */
  readonly onRun: () => void;
  /** Discord Webhook URL が設定済みか(未設定なら送信ボタンを無効化する)。 */
  readonly webhookConfigured: boolean;
  /** Discord送信の状態。 */
  readonly discordSend: DiscordSendState;
  /** 「Discordに送信」操作。 */
  readonly onSendDiscord: () => void;
}

/** 進捗を人間向けの1行にする(n/N が分かる場合は付与)。 */
function progressText(progress: AnalysisProgress): string {
  const count =
    progress.current !== null && progress.total !== null
      ? `(${progress.current}/${progress.total})`
      : "";
  return `${progress.stage}${count}: ${progress.message}`;
}

const thStyle: React.CSSProperties = {
  borderBottom: "2px solid #999",
  padding: "0.35rem 0.5rem",
  textAlign: "left",
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #ddd",
  padding: "0.3rem 0.5rem",
};

/**
 * 分析画面。選択レースを「分析実行」し、進捗表示のあと結果テーブルを描画する。
 * EVプラスの行は背景色でハイライトする(仕様要件)。
 */
export function AnalysisView(props: AnalysisViewProps): React.JSX.Element {
  const { result } = props;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem" }}>分析</h2>

      <button
        type="button"
        onClick={props.onRun}
        disabled={props.raceId === null || props.running}
      >
        {props.running ? "分析中…" : "分析実行"}
      </button>
      {props.raceId === null && (
        <span style={{ color: "#666", marginLeft: "0.5rem" }}>
          先にレースを選択してください。
        </span>
      )}

      {props.running && props.progress !== null && (
        <p style={{ color: "#0a58ca" }}>{progressText(props.progress)}</p>
      )}

      {props.error !== null && (
        <p style={{ color: "#c00" }}>分析に失敗しました: {props.error}</p>
      )}

      {result !== null && (
        <div>
          <p style={{ margin: "0.5rem 0", color: "#333" }}>
            {result.venueName} {result.raceName}({result.courseType}
            {result.distance}m){" "}
            {result.dateApproximate && (
              <span style={{ color: "#a60" }}>
                ※開催日は当日日付での近似({result.date})
              </span>
            )}
          </p>
          <p style={{ margin: "0.25rem 0", color: "#555", fontSize: "0.9rem" }}>
            LLM補正:{" "}
            {result.llmUsed
              ? result.fallback
                ? "実行(フェイルセーフでpriorに復帰)"
                : "実行"
              : `スキップ(${result.llmSkippedReason ?? "理由不明"})`}
          </p>
          {oddsStatusNote(result.oddsStatus) !== null && (
            <p style={{ margin: "0.25rem 0", color: "#a60", fontSize: "0.9rem" }}>
              ※{oddsStatusNote(result.oddsStatus)}
            </p>
          )}

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={thStyle}>馬番</th>
                <th style={thStyle}>馬名</th>
                <th style={thStyle}>prior</th>
                <th style={thStyle}>補正後</th>
                <th style={thStyle}>複勝下限</th>
                <th style={thStyle}>EV</th>
                <th style={thStyle}>LLM根拠</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr
                  key={row.umaban}
                  style={
                    isHighlightRow(row)
                      ? { background: "#e6ffea" }
                      : undefined
                  }
                >
                  <td style={tdStyle}>{row.umaban}</td>
                  <td style={tdStyle}>{row.horseName}</td>
                  <td style={tdStyle}>{formatPercent(row.prior)}</td>
                  <td style={tdStyle}>{formatPercent(row.adjustedProb)}</td>
                  <td style={tdStyle}>{formatOdds(row.placeOddsMin)}</td>
                  <td
                    style={{
                      ...tdStyle,
                      fontWeight: isHighlightRow(row) ? 700 : 400,
                      color: isHighlightRow(row) ? "#0a7f2e" : undefined,
                    }}
                  >
                    {formatEv(row.ev)}
                  </td>
                  <td style={tdStyle}>{formatReason(row.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.warnings.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.25rem" }}>
                取得時の警告
              </h3>
              <ul style={{ margin: 0, color: "#a60", fontSize: "0.85rem" }}>
                {result.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Discord送信(仕様「Discordに送信」ボタン)。URL未設定なら無効化+理由表示。 */}
          <div style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              onClick={props.onSendDiscord}
              disabled={
                !props.webhookConfigured ||
                props.discordSend.status === "sending"
              }
            >
              {props.discordSend.status === "sending"
                ? "Discordに送信中…"
                : "Discordに送信"}
            </button>
            {!props.webhookConfigured && (
              <span style={{ color: "#666", marginLeft: "0.5rem", fontSize: "0.85rem" }}>
                設定画面で Discord Webhook URL を登録すると送信できます。
              </span>
            )}
            {props.discordSend.status === "success" && (
              <span style={{ color: "#0a7f2e", marginLeft: "0.5rem" }}>
                送信しました。
              </span>
            )}
            {props.discordSend.status === "error" && (
              <span style={{ color: "#c00", marginLeft: "0.5rem" }}>
                送信に失敗しました: {props.discordSend.message}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
