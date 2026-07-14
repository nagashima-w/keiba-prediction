import type { VerifyState } from "./verify-reducer.js";
import {
  calibrationBarWidthPercent,
  formatBinRange,
  formatPayoutBreakdown,
  formatRate,
  formatYen,
  importButtonLabel,
  needsImport,
} from "./verify-format.js";

/** 検証画面のプロパティ。 */
export interface VerifyViewProps {
  /** 検証タブの状態(履歴・レポート・取込中)。 */
  readonly state: VerifyState;
  /** レース結果を取り込む操作。 */
  readonly onImport: (raceId: string) => void;
  /** 履歴・レポートを再取得する操作。 */
  readonly onRefresh: () => void;
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
 * 検証画面(仕様「5. ui」検証画面 / 注意事項のキャリブレーション表)。
 *
 * - 分析履歴一覧(レースID・日時・EVプラス数・結果取込済みか)と未取込レースの取込ボタン。
 * - 累積回収率(賭け数・投資額・回収額・回収率。実配当/近似の内訳注記)。
 * - キャリブレーション表(確率帯ごとの予測件数・実複勝率。CSSバーの簡易帯グラフ)。
 */
export function VerifyView(props: VerifyViewProps): React.JSX.Element {
  const { state } = props;
  const report = state.report;

  return (
    <section style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>検証</h2>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={state.loadingHistory || state.loadingReport}
        >
          再読み込み
        </button>
      </div>

      {state.importError !== null && (
        <p style={{ color: "#c00" }}>結果取込に失敗しました: {state.importError}</p>
      )}

      {/* 累積回収率サマリ。 */}
      <h3 style={{ fontSize: "0.95rem", marginBottom: "0.25rem" }}>累積回収率</h3>
      {state.reportError !== null ? (
        <p style={{ color: "#c00" }}>レポート取得に失敗しました: {state.reportError}</p>
      ) : report === null ? (
        <p style={{ color: "#666" }}>集計対象がありません。</p>
      ) : (
        <div style={{ color: "#333", fontSize: "0.9rem" }}>
          <p style={{ margin: "0.15rem 0" }}>
            賭け数 {report.bet.betCount}点 / 投資額 {formatYen(report.bet.totalStake)}{" "}
            / 回収額 {formatYen(report.bet.totalReturn)} / 回収率{" "}
            <strong>{formatRate(report.bet.recoveryRate)}</strong>
          </p>
          <p style={{ margin: "0.15rem 0", color: "#666" }}>
            払戻内訳: {formatPayoutBreakdown(report.bet)}(実配当が無い点は複勝下限で近似)
          </p>
          <p style={{ margin: "0.15rem 0", color: "#666" }}>
            集計{report.includedAnalysisCount}件 / 結果未取込で除外
            {report.excludedAnalysisCount}件 / 旧分析除外
            {report.supersededAnalysisCount}件 / 発売前推定のため除外
            {report.excludedEstimatedCount}件
          </p>
        </div>
      )}

      {/* キャリブレーション表(推定確率帯ごとの実複勝率)。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>
        キャリブレーション(推定確率帯ごとの実複勝率)
      </h3>
      {report === null || report.calibration.length === 0 ? (
        <p style={{ color: "#666" }}>データがありません。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>推定確率帯</th>
              <th style={thStyle}>予測件数</th>
              <th style={thStyle}>複勝件数</th>
              <th style={thStyle}>実複勝率</th>
              <th style={{ ...thStyle, width: "40%" }}>帯グラフ</th>
            </tr>
          </thead>
          <tbody>
            {report.calibration.map((bin) => (
              <tr key={bin.lowerBound}>
                <td style={tdStyle}>{formatBinRange(bin)}</td>
                <td style={tdStyle}>{bin.predictedCount}</td>
                <td style={tdStyle}>{bin.placedCount}</td>
                <td style={tdStyle}>{formatRate(bin.actualPlaceRate)}</td>
                <td style={tdStyle}>
                  <div
                    style={{
                      background: "#eee",
                      borderRadius: 3,
                      height: "0.8rem",
                      width: "100%",
                    }}
                  >
                    <div
                      style={{
                        background: "#4c8bf5",
                        borderRadius: 3,
                        height: "100%",
                        width: `${calibrationBarWidthPercent(bin.actualPlaceRate)}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 分析履歴一覧。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>分析履歴</h3>
      {state.historyError !== null && (
        <p style={{ color: "#c00" }}>履歴取得に失敗しました: {state.historyError}</p>
      )}
      {state.history.length === 0 ? (
        <p style={{ color: "#666" }}>
          {state.loadingHistory ? "読み込み中…" : "分析履歴がありません。"}
        </p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>レースID</th>
              <th style={thStyle}>分析日時</th>
              <th style={thStyle}>EVプラス</th>
              <th style={thStyle}>結果</th>
              <th style={thStyle}>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.history.map((item) => {
              const importing = state.importingRaceIds.includes(item.raceId);
              return (
                <tr key={item.analysisId}>
                  <td style={tdStyle}>{item.raceId}</td>
                  <td style={tdStyle}>{item.analyzedAt}</td>
                  <td style={tdStyle}>
                    {item.positiveCount}/{item.horseCount}
                  </td>
                  <td style={tdStyle}>
                    {!item.hasResult ? (
                      <span style={{ color: "#a60" }}>未取込</span>
                    ) : item.hasPayout ? (
                      <span style={{ color: "#0a7f2e" }}>取込済</span>
                    ) : (
                      <span style={{ color: "#a60" }}>着順のみ(払戻待ち)</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {needsImport(item) ? (
                      <button
                        type="button"
                        onClick={() => props.onImport(item.raceId)}
                        disabled={importing}
                      >
                        {importing ? "取込中…" : importButtonLabel(item)}
                      </button>
                    ) : (
                      <span style={{ color: "#666" }}>-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
