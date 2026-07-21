import type {
  CalibrationBiasBinView,
  CalibrationBinView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";
import type { VerifyState } from "./verify-reducer.js";
import { CopyErrorButton } from "./CopyErrorButton.js";
import { inputToYyyymmdd, yyyymmddToInput } from "./date-input.js";
import { formatEv, MARK_LEGEND } from "./format.js";
import {
  formatFailedRaceErrors,
  summarizeBulkImport,
} from "./import-batch-summary.js";
import {
  distinctVenueNames,
  filterRaceLedger,
  isRaceLedgerFilterActive,
  type RaceLedgerFilter,
} from "./race-ledger-filter.js";
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
  promptVersionCalibrationHeading,
  promptVersionLabel,
  raceBreakdownHeading,
  raceLedgerFilterSummary,
  raceLedgerPositiveCount,
  raceLedgerStatusLabel,
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
   * (プロンプト版別比較・レース一覧はスコープ外。全体のまま)。
   */
  readonly onVenueFilterChange: (venueFilter: VerifyVenueFilter) => void;
  /**
   * レース一覧の検索/絞り込み条件を変更する操作。IPC往復を伴わない表示専用の絞り込みのため、
   * verify-reducerへの dispatch を橋渡しするだけの薄いコールバック(onVenueFilterChangeと違い
   * report等の再取得は行わない)。
   */
  readonly onRaceLedgerFilterChange: (filter: RaceLedgerFilter) => void;
  /** レース一覧の検索/絞り込み条件をクリアする操作。 */
  readonly onRaceLedgerFilterClear: () => void;
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
 * キャリブレーション表(推定確率帯ごとの予測件数・実複勝率・過信バイアス・帯グラフ)の6列。
 * 全体レポート(下記「キャリブレーション」セクション)とプロンプト版別比較の各版(D-1)の
 * 両方で同じ体裁の表を出すため、JSXをここに共通化する(表示設計はユーザー承認済み: 版別も
 * 全体表と完全同体裁の6列)。過信バイアスは calibration と同じ帯順(index整合)で
 * calibrationBias を参照する(全体表の既存挙動と同じ)。
 */
function CalibrationTable(props: {
  readonly calibration: readonly CalibrationBinView[];
  readonly calibrationBias: readonly CalibrationBiasBinView[];
}): React.JSX.Element {
  return (
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
        {props.calibration.map((bin, index) => {
          const bias = props.calibrationBias[index] ?? null;
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
  );
}

/**
 * 検証画面(仕様「5. ui」検証画面 / 注意事項のキャリブレーション表)。
 *
 * - レース一覧(検証画面UI統合): レースID単位(latest統合)の折りたたみリスト。旧「分析履歴」
 *   テーブル(分析単位・重複あり)と旧「レース別予実」セクション(結果取込済みのみ)を統合し、
 *   母集団は「分析済みの全レース」(結果取込の有無を問わない。state.raceLedger)。
 * - 累積回収率(賭け数・投資額・回収額・回収率。実配当/近似の内訳注記)。
 * - キャリブレーション表(確率帯ごとの予測件数・実複勝率。CSSバーの簡易帯グラフ)。
 * - 補正傾向サマリ(Task#26 プロンプト改善B): 補正方向×結果・キャリブレーションの過信バイアス
 *   (既存キャリブレーション表に「予測−実績」列を追加)・印別的中率。いずれも report.trend
 *   (機械可読な構造体)を純関数(verify-format.ts)で整形して表示するのみで、JSXは配線のみ。
 * - プロンプト版別比較(Task#27 プロンプト改善A): state.reportsByPromptVersion(版ごとの
 *   VerifyReport一覧)を表にし、回収率等を版ごとに並べて比較できるようにする。全体レポート
 *   (上記の累積回収率等)は従来どおり残し、版別は別セクションとして追加する。
 * - レース一覧の検索/絞り込み: 分析が貯まって一覧が縦に長くなる問題への対応。日付・期間/会場
 *   (中央地方の別・競馬場名)/レースID・会場名キーワードの3軸(race-ledger-filter.ts の
 *   filterRaceLedger、純関数)で**表示のみ**を絞り込む。上部の「検証レポートの地域フィルタ」
 *   (#32 venueFilter。累積回収率等の集計対象を切替)とは役割が異なるため、混同を避けるため
 *   セクションを離し文言も変える(下記「レース一覧の絞り込み」参照)。
 */
export function VerifyView(props: VerifyViewProps): React.JSX.Element {
  const { state } = props;
  const report = state.report;
  // レース一覧の検索/絞り込み(表示専用)。state.raceLedger自体・reportは一切変えない。
  const filteredRaceLedger = filterRaceLedger(state.raceLedger, state.raceLedgerFilter);
  // デフォルト(絞り込み未入力)では一覧を表示しない(Task#25)。入力があるときだけ絞り込み結果を出す。
  const isFiltering = isRaceLedgerFilterActive(state.raceLedgerFilter);
  const displayedRaceLedger = isFiltering ? filteredRaceLedger : [];
  const venueNameOptions = distinctVenueNames(state.raceLedger);

  return (
    <section style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>検証</h2>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={state.loadingRaceLedger || state.loadingReport}
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
       * プロンプト版別比較・レース一覧はスコープ外(常に全体)。
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

      {/*
       * 版別キャリブレーション(D-1)。クリップ幅A/B実験等の効果を版別較正で比較できるようにする
       * 土台。上の版別比較テーブル(回収率行)はそのまま残し、版ごとに折りたたみ(details/summary。
       * レース一覧と同流儀)で展開するとその版のキャリブレーション表(全体表と完全同体裁の6列。
       * CalibrationTable を共通利用)が出る形(表示設計はユーザー承認済み)。見出しには
       * promptVersionCalibrationHeading で版番号+追加指示の要約を併記し、どの条件の較正かを
       * 展開前から分かるようにする。サンプル過少の注意喚起等の新規ロジックはここでは追加しない
       * (既存の集計件数・予測件数の表示に委ねる)。venueKindの版別適用はスコープ外(全体のみ)。
       */}
      {state.reportsByPromptVersion.length > 0 && (
        <>
          <h4
            style={{
              fontSize: "0.88rem",
              margin: "0.6rem 0 0.25rem",
              color: "#555",
            }}
          >
            版別キャリブレーション(クリックで展開)
          </h4>
          {state.reportsByPromptVersion.map(
            ({ promptVersion, report: r, additionalInstructions }) => (
              <details
                key={promptVersion ?? "版不明"}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  margin: "0 0 0.4rem",
                  padding: "0.3rem 0.6rem",
                }}
              >
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  {promptVersionCalibrationHeading(
                    promptVersion,
                    additionalInstructions,
                  )}
                </summary>
                {r.calibration.length === 0 ? (
                  <p style={{ color: "#666", margin: "0.4rem 0 0" }}>
                    データがありません。
                  </p>
                ) : (
                  <div style={{ marginTop: "0.4rem" }}>
                    <CalibrationTable
                      calibration={r.calibration}
                      calibrationBias={r.trend.calibrationBias}
                    />
                  </div>
                )}
              </details>
            ),
          )}
        </>
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
        <CalibrationTable
          calibration={report.calibration}
          calibrationBias={report.trend.calibrationBias}
        />
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

      {/*
       * レース一覧(検証画面UI統合)。旧「分析履歴」テーブル(分析単位・重複あり・未取込含む)と
       * 旧「レース別予実」セクション(レース単位・結果取込済みのみ)を、レースID単位(latest統合)の
       * 折りたたみリスト1つに統合する。母集団は「分析済みの全レース」(結果取込の有無を問わない。
       * core computeRaceLedger)。予測側(印・馬番・AI補正後3着内率・EV)は常に表示し、
       * 結果取込済みなら実着順・複勝的中・賭け金・払戻・払戻根拠の列を追加、未取込なら案内+取込ボタンを
       * 出す(件数が多くなるため details/summary で1レースずつ開ける形。既存UIの流儀を踏襲)。
       */}
      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.25rem" }}>レース一覧</h3>

      {/*
       * レース一覧の検索/絞り込み(表示専用)。上の「検証レポートの地域フィルタ」(#32
       * venueFilter)とは役割が別: あちらは累積回収率・キャリブレーション等の**集計対象**を
       * 切り替え、こちらは既に取得済みのレース一覧の**見た目の表示件数**を絞り込むだけで
       * state.raceLedger自体・report等の集計には一切影響しない。見出し・配置を離して
       * 混同を避ける。
       */}
      <div
        role="group"
        aria-label="レース一覧の絞り込み"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
          margin: "0.25rem 0 0.5rem",
          padding: "0.4rem 0.6rem",
          border: "1px solid #ddd",
          borderRadius: "4px",
          fontSize: "0.85rem",
        }}
      >
        <label>
          開催日{" "}
          <input
            type="date"
            aria-label="開催日(開始)"
            value={yyyymmddToInput(state.raceLedgerFilter.dateFrom ?? "")}
            onChange={(e) => {
              const raw = inputToYyyymmdd(e.target.value);
              props.onRaceLedgerFilterChange({
                ...state.raceLedgerFilter,
                dateFrom: raw === "" ? null : raw,
              });
            }}
          />
        </label>
        <span>〜</span>
        <input
          type="date"
          aria-label="開催日(終了)"
          value={yyyymmddToInput(state.raceLedgerFilter.dateTo ?? "")}
          onChange={(e) => {
            const raw = inputToYyyymmdd(e.target.value);
            props.onRaceLedgerFilterChange({
              ...state.raceLedgerFilter,
              dateTo: raw === "" ? null : raw,
            });
          }}
        />
        <label>
          会場区分{" "}
          <select
            aria-label="会場区分(中央/地方)"
            value={state.raceLedgerFilter.venueKind}
            onChange={(e) =>
              props.onRaceLedgerFilterChange({
                ...state.raceLedgerFilter,
                venueKind: e.target.value as VerifyVenueFilter,
              })
            }
          >
            {(["all", "central", "nar"] as const).map((venueKind) => (
              <option key={venueKind} value={venueKind}>
                {venueFilterLabel(venueKind)}
              </option>
            ))}
          </select>
        </label>
        <label>
          競馬場{" "}
          <select
            aria-label="競馬場"
            value={state.raceLedgerFilter.venueName ?? ""}
            onChange={(e) =>
              props.onRaceLedgerFilterChange({
                ...state.raceLedgerFilter,
                venueName: e.target.value === "" ? null : e.target.value,
              })
            }
          >
            <option value="">すべて</option>
            {venueNameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          aria-label="レースID・会場名で検索"
          placeholder="レースID・会場名で検索"
          value={state.raceLedgerFilter.keyword}
          onChange={(e) =>
            props.onRaceLedgerFilterChange({
              ...state.raceLedgerFilter,
              keyword: e.target.value,
            })
          }
        />
        <button type="button" onClick={props.onRaceLedgerFilterClear}>
          絞り込みをクリア
        </button>
      </div>
      {state.raceLedger.length > 0 && (
        <p style={{ color: "#666", margin: "0 0 0.5rem" }}>
          {raceLedgerFilterSummary(state.raceLedger.length, displayedRaceLedger.length)}
        </p>
      )}

      {state.raceLedgerError !== null ? (
        <p style={{ color: "#c00" }}>
          レース一覧の取得に失敗しました: {state.raceLedgerError}
          <CopyErrorButton
            operation="検証:レース一覧取得"
            message={state.raceLedgerError}
          />
        </p>
      ) : state.raceLedger.length === 0 ? (
        <p style={{ color: "#666" }}>
          {state.loadingRaceLedger ? "読み込み中…" : "分析済みのレースがありません。"}
        </p>
      ) : !isFiltering ? (
        <p style={{ color: "#666" }}>検索条件を入力するとレースが表示されます。</p>
      ) : filteredRaceLedger.length === 0 ? (
        <p style={{ color: "#666" }}>
          絞り込み条件に一致するレースがありません。条件を変えるか「絞り込みをクリア」をお試しください。
        </p>
      ) : (
        displayedRaceLedger.map((rb) => {
          const importing = state.importingRaceIds.includes(rb.raceId);
          return (
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
                  分析日時 {rb.analyzedAt} / EVプラス{" "}
                  {raceLedgerPositiveCount(rb.horses)}/{rb.horses.length} / 結果{" "}
                  {raceLedgerStatusLabel(rb)}
                  {rb.hasResult && (
                    <>
                      {" "}
                      / 賭け{rb.betCount}点 / 投資額 {formatYen(rb.totalStake)} /
                      回収額 {formatYen(rb.totalReturn)} / 回収率{" "}
                      <strong>{formatRate(rb.recoveryRate)}</strong>
                    </>
                  )}
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
                    {rb.hasResult && (
                      <>
                        <th style={thStyle}>実着順</th>
                        <th style={thStyle}>複勝的中</th>
                        <th style={thStyle}>賭け金</th>
                        <th style={thStyle}>払戻</th>
                        <th style={thStyle}>払戻根拠</th>
                      </>
                    )}
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
                      {rb.hasResult && (
                        <>
                          <td style={tdStyle}>
                            {formatFinishPosition(horse.finishPosition)}
                          </td>
                          <td style={tdStyle}>{placedLabel(horse.isPlaced)}</td>
                          <td style={tdStyle}>{formatYen(horse.stake)}</td>
                          <td style={tdStyle}>{formatYen(horse.payout)}</td>
                          <td style={tdStyle}>
                            {payoutSourceLabel(horse.payoutSource)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rb.hasResult && (
                <p style={{ color: "#a60", margin: "0.4rem 0 0" }}>
                  結果が未取込です
                </p>
              )}
              {needsImport(rb) && (
                <button
                  type="button"
                  onClick={() => props.onImport(rb.raceId)}
                  disabled={isRowImportDisabled(importing, state.bulkImport.running)}
                  style={{ marginTop: "0.4rem" }}
                >
                  {importing ? "取込中…" : importButtonLabel(rb)}
                </button>
              )}
            </details>
          );
        })
      )}
    </section>
  );
}
