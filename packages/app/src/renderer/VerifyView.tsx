import type { VerifyVenueFilter } from "../shared/analysis-types.js";
import type { VerifyState } from "./verify-reducer.js";
import { CopyErrorButton } from "./CopyErrorButton.js";
import { formatEv, MARK_LEGEND } from "./format.js";
import {
  formatFailedRaceErrors,
  summarizeBulkImport,
} from "./import-batch-summary.js";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  deleteUnknownPromptVersionResultMessage,
  directionLabel,
  formatAdjustment,
  formatBinRange,
  formatFinishPosition,
  formatPayoutBreakdown,
  formatRate,
  formatYen,
  hasUnknownPromptVersionGroup,
  importButtonLabel,
  isRowImportDisabled,
  markLabel,
  needsImport,
  overconfidenceLabel,
  payoutSourceLabel,
  placedLabel,
  promptVersionLabel,
  raceBreakdownHeading,
  venueFilterLabel,
} from "./verify-format.js";

/** 検証画面のプロパティ。 */
export interface VerifyViewProps {
  /** 検証タブの状態(履歴・レポート・取込中)。 */
  readonly state: VerifyState;
  /** レース結果を取り込む操作。 */
  readonly onImport: (raceId: string) => void;
  /** 履歴・レポートを再取得する操作。 */
  readonly onRefresh: () => void;
  /**
   * 検証レポートの地域フィルタ(全体/中央のみ/地方のみ)を切り替える操作(Task#32)。
   * トータル集計・キャリブレーション・傾向(report)の表示対象のみに効く
   * (プロンプト版別比較・レース別予実はスコープ外。全体のまま)。
   */
  readonly onVenueFilterChange: (venueFilter: VerifyVenueFilter) => void;
  /** 「未取込をまとめて取り込む」操作(Task#31)。 */
  readonly onRunBulkImport: () => void;
  /** 一括取込の中断操作(Task#31)。 */
  readonly onCancelBulkImport: () => void;
  /**
   * 版不明(prompt_version=null)分析の削除操作(Task#33)。取り消せない破壊的操作のため、
   * 呼び出し元(App.tsx)で確認ダイアログを出したうえで呼ぶ想定。
   */
  readonly onDeleteUnknownPromptVersionAnalyses: () => void;
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
 * - 補正傾向サマリ(Task#26 プロンプト改善B): 補正方向×結果・キャリブレーションの過信バイアス
 *   (既存キャリブレーション表に「予測−実績」列を追加)・印別的中率。いずれも report.trend
 *   (機械可読な構造体)を純関数(verify-format.ts)で整形して表示するのみで、JSXは配線のみ。
 * - プロンプト版別比較(Task#27 プロンプト改善A): state.reportsByPromptVersion(版ごとの
 *   VerifyReport一覧)を表にし、回収率等を版ごとに並べて比較できるようにする。全体レポート
 *   (上記の累積回収率等)は従来どおり残し、版別は別セクションとして追加する。
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
        <p style={{ color: "#c00" }}>
          結果取込に失敗しました: {state.importError}
          <CopyErrorButton
            operation="検証:結果取込"
            message={state.importError}
            context={{ raceId: state.importErrorRaceId }}
          />
        </p>
      )}
      {state.importNotice !== null && (
        <p style={{ color: "#666" }}>{state.importNotice}</p>
      )}

      {/*
       * 検証レポートの地域フィルタ(全体/中央のみ/地方のみ、Task#32)。
       * 中央と地方は開催条件が異なるため、混ぜて見ると回収率・キャリブレーションの解釈を誤りうる
       * (docs/handover-next-session.md「プロンプト改善の運用目安」)。切替は下の累積回収率・
       * 補正方向×結果・キャリブレーション・印別的中率(いずれも report 由来)の表示対象に効く。
       * プロンプト版別比較・レース別予実はスコープ外(常に全体)。
       * RaceSelection の開催区分トグル(role=group + aria-pressed のボタン群)と同じ流儀。
       */}
      <div
        role="group"
        aria-label="検証レポートの地域フィルタ"
        style={{ display: "flex", gap: "0", margin: "0.5rem 0" }}
      >
        {(["all", "central", "nar"] as const).map((venueKind, index) => {
          const active = state.venueFilter === venueKind;
          return (
            <button
              key={venueKind}
              type="button"
              aria-pressed={active}
              onClick={() => props.onVenueFilterChange(venueKind)}
              style={{
                padding: "0.3rem 0.9rem",
                border: "1px solid #888",
                borderRight: index === 2 ? "1px solid #888" : "none",
                background: active ? "#0a58ca" : "#fff",
                color: active ? "#fff" : "#333",
                fontWeight: active ? 700 : 400,
                cursor: "pointer",
              }}
            >
              {venueFilterLabel(venueKind)}
            </button>
          );
        })}
      </div>

      {/* 累積回収率サマリ。 */}
      <h3 style={{ fontSize: "0.95rem", marginBottom: "0.25rem" }}>累積回収率</h3>
      {state.reportError !== null ? (
        <p style={{ color: "#c00" }}>
          レポート取得に失敗しました: {state.reportError}
          <CopyErrorButton operation="検証:レポート取得" message={state.reportError} />
        </p>
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

      {/*
       * プロンプト版別比較(Task#27 プロンプト改善A)。
       * プロンプトを改善したときに「本当に良くなったか」を版ごとの成績(回収率・集計件数)で
       * 比較できる土台。版が1つ(または版不明のみ)でも表を1行で表示するだけで破綻しない。
       */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          margin: "1rem 0 0.25rem",
        }}
      >
        <h3 style={{ fontSize: "0.95rem", margin: 0 }}>プロンプト版別比較</h3>
        {/*
         * 版不明分析の削除(Task#33)。版不明(prompt_version=null)グループが存在するときだけ
         * ボタンを表示する(hasUnknownPromptVersionGroup。存在しなければ削除対象が無い)。
         * 確認(取り消せない旨・件数)は呼び出し元(App.tsx の onDeleteUnknownPromptVersionAnalyses)が
         * window.confirm で行う。
         * ボタン文言は簡潔さを優先し、削除対象の詳細(版記録導入前の旧データ+LLM未使用の分析の
         * 2種類が混在する点。区別不能な理由は AnalysisStore.deleteAnalysesWithUnknownPromptVersion の
         * JSDoc参照)は title属性(ホバー説明)と下の注記文で補う(code-reviewer指摘対応)。
         */}
        {hasUnknownPromptVersionGroup(state.reportsByPromptVersion) && (
          <button
            type="button"
            onClick={props.onDeleteUnknownPromptVersionAnalyses}
            disabled={state.deletingUnknownPromptVersion}
            title="版不明=版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析(DB上は区別できません)"
          >
            {state.deletingUnknownPromptVersion ? "削除中…" : "版不明の分析を削除"}
          </button>
        )}
      </div>
      {hasUnknownPromptVersionGroup(state.reportsByPromptVersion) && (
        <p style={{ margin: "0.15rem 0", color: "#666", fontSize: "0.85rem" }}>
          「版不明」は版記録導入前の旧データと、APIキー未設定で実行したLLM未使用の分析の両方を含みます(DB上は区別できません)。削除しても再分析(一括取込)で復元できます。
        </p>
      )}
      {state.deleteUnknownPromptVersionError !== null && (
        <p style={{ color: "#c00" }}>
          版不明分析の削除に失敗しました: {state.deleteUnknownPromptVersionError}
          <CopyErrorButton
            operation="検証:版不明分析の削除"
            message={state.deleteUnknownPromptVersionError}
          />
        </p>
      )}
      {state.deleteUnknownPromptVersionDeletedCount !== null && (
        <p style={{ color: "#666" }}>
          {deleteUnknownPromptVersionResultMessage(
            state.deleteUnknownPromptVersionDeletedCount,
          )}
        </p>
      )}
      {state.reportsByPromptVersionError !== null && (
        <p style={{ color: "#c00" }}>
          版別レポート取得に失敗しました: {state.reportsByPromptVersionError}
          <CopyErrorButton
            operation="検証:版別レポート取得"
            message={state.reportsByPromptVersionError}
          />
        </p>
      )}
      {state.reportsByPromptVersion.length === 0 ? (
        <p style={{ color: "#666" }}>
          {state.loadingReportsByPromptVersion
            ? "読み込み中…"
            : "集計対象がありません。"}
        </p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>プロンプト版</th>
              <th style={thStyle}>追加指示</th>
              <th style={thStyle}>集計件数</th>
              <th style={thStyle}>賭け数</th>
              <th style={thStyle}>投資額</th>
              <th style={thStyle}>回収額</th>
              <th style={thStyle}>回収率</th>
            </tr>
          </thead>
          <tbody>
            {state.reportsByPromptVersion.map(
              ({ promptVersion, report: r, additionalInstructions }) => (
                <tr key={promptVersion ?? "版不明"}>
                  <td style={tdStyle}>{promptVersionLabel(promptVersion)}</td>
                  <td
                    style={tdStyle}
                    title={additionalInstructionsFullText(additionalInstructions)}
                  >
                    {additionalInstructionsSummary(additionalInstructions)}
                  </td>
                  <td style={tdStyle}>{r.includedAnalysisCount}</td>
                  <td style={tdStyle}>{r.bet.betCount}点</td>
                  <td style={tdStyle}>{formatYen(r.bet.totalStake)}</td>
                  <td style={tdStyle}>{formatYen(r.bet.totalReturn)}</td>
                  <td style={tdStyle}>
                    <strong>{formatRate(r.bet.recoveryRate)}</strong>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      {/* 補正方向×結果(AIが確率を上げた馬/下げた馬/据え置いた馬が実際に来たか)。Task#26。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>
        補正方向×結果
      </h3>
      {report === null ? (
        <p style={{ color: "#666" }}>データがありません。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>分類</th>
              <th style={thStyle}>件数</th>
              <th style={thStyle}>実複勝率</th>
              <th style={thStyle}>平均補正幅</th>
            </tr>
          </thead>
          <tbody>
            {report.trend.directionGroups.map((group) => (
              <tr key={group.direction}>
                <td style={tdStyle}>{directionLabel(group.direction)}</td>
                <td style={tdStyle}>{group.count}</td>
                <td style={tdStyle}>{formatRate(group.actualPlaceRate)}</td>
                <td style={tdStyle}>{formatAdjustment(group.averageAdjustment)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* キャリブレーション表(推定確率帯ごとの実複勝率)+ 過信バイアス列(Task#26)。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>
        キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)
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
              <th style={thStyle}>予測−実績</th>
              <th style={{ ...thStyle, width: "30%" }}>帯グラフ</th>
            </tr>
          </thead>
          <tbody>
            {report.calibration.map((bin, index) => {
              const bias = report.trend.calibrationBias[index] ?? null;
              return (
                <tr key={bin.lowerBound}>
                  <td style={tdStyle}>{formatBinRange(bin)}</td>
                  <td style={tdStyle}>{bin.predictedCount}</td>
                  <td style={tdStyle}>{bin.placedCount}</td>
                  <td style={tdStyle}>{formatRate(bin.actualPlaceRate)}</td>
                  <td style={tdStyle}>
                    {formatAdjustment(bias?.overconfidenceGap ?? null)}
                    {bias !== null && bias.overconfidenceGap !== null && (
                      <span style={{ color: "#666" }}>
                        {" "}
                        ({overconfidenceLabel(bias.overconfidenceGap)})
                      </span>
                    )}
                  </td>
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
              );
            })}
          </tbody>
        </table>
      )}

      {/* 印別的中率(印付けが機能しているか)。Task#26。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>
        印別的中率
      </h3>
      {report === null ? (
        <p style={{ color: "#666" }}>データがありません。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>印</th>
              <th style={thStyle}>件数</th>
              <th style={thStyle}>複勝率</th>
              <th style={thStyle}>勝率</th>
            </tr>
          </thead>
          <tbody>
            {report.trend.markStats.map((stat) => (
              <tr key={stat.mark ?? "null"}>
                <td style={tdStyle}>{markLabel(stat.mark)}</td>
                <td style={tdStyle}>{stat.count}</td>
                <td style={tdStyle}>{formatRate(stat.placeRate)}</td>
                <td style={tdStyle}>{formatRate(stat.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
       * レース別予実(Task#34)。トータル集計(累積回収率・キャリブレーション等)だけでなく、
       * レース単体ごとに予測(印・EVプラス馬・AI補正後3着内率)と結果(実着順・複勝的中の有無・
       * そのレースの賭け金/払戻/回収)を並べて表示する。母集団・賭け判定ロジックは既存verifyの
       * computeVerifyReport と共通(core computeRaceBreakdown。数値の乖離を防ぐため共有)。
       * 件数が多くなるため details/summary で1レースずつ開ける形にする(既存UIの流儀。
       * SettingsView.tsx の重み設定折りたたみと同じ形式)。
       */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>
        レース別予実
      </h3>
      {state.raceBreakdownError !== null ? (
        <p style={{ color: "#c00" }}>
          レース別予実の取得に失敗しました: {state.raceBreakdownError}
          <CopyErrorButton
            operation="検証:レース別予実取得"
            message={state.raceBreakdownError}
          />
        </p>
      ) : state.raceBreakdown.length === 0 ? (
        <p style={{ color: "#666" }}>
          {state.loadingRaceBreakdown ? "読み込み中…" : "該当レースがありません。"}
        </p>
      ) : (
        state.raceBreakdown.map((rb) => (
          <details
            key={rb.raceId}
            style={{
              border: "1px solid #ddd",
              borderRadius: "4px",
              margin: "0 0 0.4rem",
              padding: "0.3rem 0.6rem",
            }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              {raceBreakdownHeading(rb)}
              <span
                style={{
                  color: "#666",
                  fontWeight: 400,
                  fontSize: "0.85rem",
                  marginLeft: "0.5rem",
                }}
              >
                賭け{rb.betCount}点 / 投資額 {formatYen(rb.totalStake)} / 回収額{" "}
                {formatYen(rb.totalReturn)} / 回収率{" "}
                <strong>{formatRate(rb.recoveryRate)}</strong>
              </span>
            </summary>
            <table
              style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.4rem" }}
            >
              <thead>
                <tr>
                  <th style={thStyle} title={MARK_LEGEND}>
                    印
                  </th>
                  <th style={thStyle}>馬番</th>
                  <th style={thStyle}>AI補正後3着内率</th>
                  <th style={thStyle}>EV</th>
                  <th style={thStyle}>実着順</th>
                  <th style={thStyle}>複勝的中</th>
                  <th style={thStyle}>賭け金</th>
                  <th style={thStyle}>払戻</th>
                  <th style={thStyle}>払戻根拠</th>
                </tr>
              </thead>
              <tbody>
                {rb.horses.map((horse) => (
                  <tr
                    key={horse.umaban}
                    // ハイライト(緑背景)はisPositive基準(ev!==nullではない。仕様注意点)。
                    style={
                      horse.isPositive ? { background: "#e6ffea" } : undefined
                    }
                  >
                    <td style={tdStyle}>{markLabel(horse.mark)}</td>
                    <td style={tdStyle}>{horse.umaban}</td>
                    <td style={tdStyle}>{formatRate(horse.adjustedProb)}</td>
                    <td
                      style={{
                        ...tdStyle,
                        fontWeight: horse.isPositive ? 700 : 400,
                        color: horse.isPositive ? "#0a7f2e" : undefined,
                      }}
                    >
                      {formatEv(horse.ev)}
                    </td>
                    <td style={tdStyle}>{formatFinishPosition(horse.finishPosition)}</td>
                    <td style={tdStyle}>{placedLabel(horse.isPlaced)}</td>
                    <td style={tdStyle}>{formatYen(horse.stake)}</td>
                    <td style={tdStyle}>{formatYen(horse.payout)}</td>
                    <td style={tdStyle}>{payoutSourceLabel(horse.payoutSource)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}

      {/*
       * 結果の一括取込(Task#31)。分析済みで結果未取込(race_results に行が1件も無い)の
       * レースを列挙し、直列に取り込む。境界でキャンセル可能。実行中は再実行を無効化する。
       */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>結果の一括取込</h3>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button
          type="button"
          onClick={props.onRunBulkImport}
          disabled={state.bulkImport.running}
        >
          {state.bulkImport.running ? "取込中…" : "未取込をまとめて取り込む"}
        </button>
        {state.bulkImport.running && (
          <button
            type="button"
            onClick={props.onCancelBulkImport}
            disabled={state.bulkImport.canceling}
          >
            {state.bulkImport.canceling ? "中断待ち…" : "中断"}
          </button>
        )}
        {state.bulkImport.progress !== null && (
          <span style={{ color: "#666", fontSize: "0.9rem" }}>
            {state.bulkImport.progress.completedRaces}/
            {state.bulkImport.progress.totalRaces}
            {state.bulkImport.progress.currentRaceId !== null &&
              ` — ${state.bulkImport.progress.currentRaceId}`}
          </span>
        )}
      </div>
      {!state.bulkImport.running && state.bulkImport.outcomes.length > 0 && (
        (() => {
          const summary = summarizeBulkImport(state.bulkImport.outcomes);
          return (
            <div style={{ color: "#333", fontSize: "0.9rem", marginTop: "0.35rem" }}>
              <p style={{ margin: "0.15rem 0" }}>
                完了: 取込{summary.importedCount}件 / 未確定スキップ
                {summary.notConfirmedCount}件 / 失敗{summary.failureCount}件
                {summary.skippedCount > 0 && ` / 中断スキップ${summary.skippedCount}件`}
              </p>
              {summary.notConfirmedRaceIds.length > 0 && (
                <p style={{ margin: "0.15rem 0", color: "#a60" }}>
                  未確定スキップ: {summary.notConfirmedRaceIds.join(", ")}
                </p>
              )}
              {summary.failedRaceErrors.length > 0 && (
                <div style={{ margin: "0.15rem 0", color: "#c00" }}>
                  <p style={{ margin: "0.15rem 0" }}>
                    失敗: {summary.failedRaceIds.join(", ")}
                    <CopyErrorButton
                      operation="検証:結果の一括取込"
                      message={formatFailedRaceErrors(summary.failedRaceErrors)}
                    />
                  </p>
                  {/*
                   * 各レースの失敗理由(AIに渡す前に人が見ても分かるように、
                   * コピーせずとも画面上でそのまま確認できるようにする)。
                   */}
                  <ul style={{ margin: "0.15rem 0", paddingLeft: "1.2rem" }}>
                    {summary.failedRaceErrors.map((failedRace) => (
                      <li key={failedRace.raceId}>
                        {failedRace.raceId}: {failedRace.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })()
      )}

      {/* 分析履歴一覧。 */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>分析履歴</h3>
      {state.historyError !== null && (
        <p style={{ color: "#c00" }}>
          履歴取得に失敗しました: {state.historyError}
          <CopyErrorButton operation="検証:履歴取得" message={state.historyError} />
        </p>
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
                        disabled={isRowImportDisabled(
                          importing,
                          state.bulkImport.running,
                        )}
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
