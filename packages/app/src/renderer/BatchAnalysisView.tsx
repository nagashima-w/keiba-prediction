import type { AnalysisResult, BatchProgress } from "../shared/analysis-types.js";
import type {
  BatchRaceEntry,
  DiscordSendState,
} from "./batch-analysis-reducer.js";
import {
  collectPerRaceHighlights,
  raceNumberFromRaceId,
  raceOpportunityRemark,
  rankRaceOpportunities,
  summarizeBatch,
} from "./batch-summary.js";
import {
  formatEstimatedEvSuffix,
  formatEv,
  formatMark,
  formatOdds,
  formatOpportunityScore,
  formatPercent,
  formatReason,
  isHighlightRow,
  LABEL_ADJUSTED_PROB,
  LABEL_PRIOR,
  MARK_LEGEND,
  oddsStatusNote,
  raceHeading,
} from "./format.js";

/** 一括分析画面のプロパティ。状態と操作は親(App)から受け取る。 */
export interface BatchAnalysisViewProps {
  /** 選択中のレース数(実行ボタンの有効判定に使う)。 */
  readonly selectedCount: number;
  /** 一括分析の実行中か。 */
  readonly running: boolean;
  /** 中断要求済み(境界での停止待ち)か。 */
  readonly canceling: boolean;
  /** 全体進捗(無ければ null)。 */
  readonly progress: BatchProgress | null;
  /** 実行対象レースのエントリ(実行順)。 */
  readonly outcomes: readonly BatchRaceEntry[];
  /** 詳細を展開中のレースID群。 */
  readonly expandedRaceIds: readonly string[];
  /** 「一括分析実行」操作。 */
  readonly onRun: () => void;
  /** 「中断」操作。 */
  readonly onCancel: () => void;
  /** レース詳細の開閉トグル。 */
  readonly onToggleDetail: (raceId: string) => void;
  /** Discord Webhook URL が設定済みか。 */
  readonly webhookConfigured: boolean;
  /** Discord送信の状態。 */
  readonly discordSend: DiscordSendState;
  /** 「Discordに送信」操作(サマリ1通)。 */
  readonly onSendDiscord: () => void;
}

const thStyle: React.CSSProperties = {
  borderBottom: "2px solid #999",
  padding: "0.3rem 0.5rem",
  textAlign: "left",
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #ddd",
  padding: "0.25rem 0.5rem",
};

/** 全体進捗を人間向けの1行にする。 */
function batchProgressText(progress: BatchProgress): string {
  const head = `全体 ${progress.completedRaces}/${progress.totalRaces}`;
  const race =
    progress.currentRaceName !== null
      ? ` — ${progress.currentRaceName}`
      : progress.currentRaceId !== null
        ? ` — ${progress.currentRaceId}`
        : "";
  const stage = progress.stage;
  const stagePart =
    stage !== null
      ? `: ${stage.stage}${
          stage.current !== null && stage.total !== null
            ? `(${stage.current}/${stage.total})`
            : ""
        } ${stage.message}`
      : "";
  return `${head}${race}${stagePart}`;
}

/** 1レース分の結果テーブル(成功時の詳細)。 */
function ResultTable(props: { result: AnalysisResult }): React.JSX.Element {
  const { result } = props;
  return (
    <div>
      <p style={{ margin: "0.25rem 0", color: "#555", fontSize: "0.85rem" }}>
        LLM補正:{" "}
        {result.llmUsed
          ? result.fallback
            ? "実行(フェイルセーフで3着内率に復帰)"
            : "実行"
          : `スキップ(${result.llmSkippedReason ?? "理由不明"})`}
        {result.dateApproximate && (
          <span style={{ color: "#a60", marginLeft: "0.5rem" }}>
            ※開催日は当日日付での近似({result.date})
          </span>
        )}
      </p>
      {oddsStatusNote(result.oddsStatus) !== null && (
        <p style={{ margin: "0.25rem 0", color: "#a60", fontSize: "0.85rem" }}>
          ※{oddsStatusNote(result.oddsStatus)}
        </p>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thStyle} title={MARK_LEGEND}>
              印
            </th>
            <th style={thStyle}>馬番</th>
            <th style={thStyle}>馬名</th>
            <th
              style={thStyle}
              title="モデルが数値データから推定した3着以内に入る確率(実績値ではありません)"
            >
              {LABEL_PRIOR}
            </th>
            <th
              style={thStyle}
              title="上記の3着内率をAI(LLM)が調教・コメント・展開から補正した確率"
            >
              {LABEL_ADJUSTED_PROB}
            </th>
            <th style={thStyle}>複勝下限</th>
            <th style={thStyle}>EV</th>
            <th style={thStyle}>LLM根拠</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr
              key={row.umaban}
              style={isHighlightRow(row) ? { background: "#e6ffea" } : undefined}
            >
              <td style={tdStyle}>{formatMark(row.mark)}</td>
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
                {row.evEstimated && (
                  <span style={{ color: "#a60", marginLeft: "0.25rem" }}>
                    {formatEstimatedEvSuffix(row.evEstimated)}
                  </span>
                )}
              </td>
              <td style={tdStyle}>{formatReason(row.reason)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.warnings.length > 0 && (
        <ul style={{ margin: "0.5rem 0 0", color: "#a60", fontSize: "0.8rem" }}>
          {result.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 実行状態のバッジ表示。 */
function statusBadge(entry: BatchRaceEntry): React.JSX.Element {
  const map: Record<
    BatchRaceEntry["status"],
    { label: string; color: string }
  > = {
    pending: { label: "待機", color: "#888" },
    success: { label: "成功", color: "#0a7f2e" },
    failure: { label: "失敗", color: "#c00" },
    skipped: { label: "スキップ", color: "#a60" },
  };
  const { label, color } = map[entry.status];
  return <span style={{ color, fontWeight: 700 }}>[{label}]</span>;
}

/**
 * 一括分析画面。選択したレースを直列に分析し、最上部に妙味レースランキング、
 * その下にレース別ハイライト(印あり・EVプラス馬をレースごとにブロック化。Task#29)、
 * さらにその下にレースごとの詳細(折りたたみ)を表示する。Discord送信はサマリ1通にまとめる。
 */
export function BatchAnalysisView(
  props: BatchAnalysisViewProps,
): React.JSX.Element {
  const { outcomes } = props;
  const counts = summarizeBatch(outcomes);
  // 妙味レースランキング(スコア降順、スコアnullは末尾)。詳細ヘッダ用に raceId→スコアの対応も作る。
  const ranking = rankRaceOpportunities(outcomes);
  // レース別ハイライト(印あり ∪ EVプラス馬)。並びは妙味レースランキングと同じ妙味スコア降順。
  const highlights = collectPerRaceHighlights(outcomes);
  const opportunityByRaceId = new Map(
    ranking.map((r) => [r.raceId, r.opportunity]),
  );
  const expandedSet = new Set(props.expandedRaceIds);
  // 実行前スナップショット(全pending)だけの状態では結果表示はまだ出さない。
  const hasCompleted = outcomes.some((o) => o.status !== "pending");

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem" }}>一括分析</h2>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={props.onRun}
          disabled={props.selectedCount === 0 || props.running}
        >
          {props.running
            ? "分析中…"
            : `一括分析実行(${props.selectedCount}件)`}
        </button>
        {props.running && (
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.canceling}
          >
            {props.canceling ? "中断待ち(現在のレースを完走中)…" : "中断"}
          </button>
        )}
        {props.selectedCount === 0 && !props.running && (
          <span style={{ color: "#666", fontSize: "0.9rem" }}>
            分析するレースを1つ以上選択してください。
          </span>
        )}
      </div>

      {props.running && props.progress !== null && (
        <p style={{ color: "#0a58ca" }}>{batchProgressText(props.progress)}</p>
      )}

      {hasCompleted && (
        <>
          <p style={{ margin: "0.75rem 0 0.25rem", color: "#333" }}>
            対象{counts.total}レース(成功{counts.success} / 失敗
            {counts.failure} / スキップ{counts.skipped})
          </p>

          {/* 最上部: 妙味レースランキング(スコア降順。大穴一辺倒を避け、買う価値の高いレースを上位に)。 */}
          <div style={{ marginTop: "0.5rem" }}>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
              妙味レースランキング
            </h3>
            {ranking.length === 0 ? (
              <p style={{ color: "#666" }}>該当なし</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>レース</th>
                    <th style={thStyle}>妙味スコア</th>
                    <th style={thStyle}>EVプラス頭数</th>
                    <th style={thStyle}>筆頭候補</th>
                    <th style={thStyle}>備考</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r) => {
                    const op = r.opportunity;
                    const scored = op.score !== null;
                    return (
                      <tr
                        key={r.raceId}
                        style={
                          scored ? undefined : { color: "#999" }
                        }
                      >
                        <td style={tdStyle}>{raceHeading(r)}</td>
                        <td
                          style={{
                            ...tdStyle,
                            fontWeight: scored ? 700 : 400,
                          }}
                        >
                          {formatOpportunityScore(op.score)}
                        </td>
                        <td style={tdStyle}>{op.evPlusCount}</td>
                        <td style={tdStyle}>
                          {op.bestPick !== null
                            ? `${op.bestPick.umaban}番 ${op.bestPick.horseName}`
                            : "-"}
                        </td>
                        <td style={{ ...tdStyle, fontSize: "0.8rem" }}>
                          {(() => {
                            const remark = raceOpportunityRemark(r);
                            return remark === "" ? (
                              ""
                            ) : (
                              <span style={{ color: "#a60" }}>{remark}</span>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/*
            レース別ハイライト(印あり ∪ EVプラス馬・Task#29)。
            従来は全レースの馬を1つの表に混在させていたため「どのレースの馬か分からない」という
            問題があった(ユーザー実機で判明)。レースごとにブロック化し、見出し(会場+R+レース名)を
            必ず添えることで、raceName が空でもレースを識別できるようにする。
            レースの並びは妙味レースランキングと同じ妙味スコア降順。
          */}
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
              レース別ハイライト(印あり・EVプラス)
            </h3>
            {highlights.length === 0 ? (
              <p style={{ color: "#666" }}>該当なし</p>
            ) : (
              highlights.map((highlight) => (
                <div
                  key={highlight.raceId}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    margin: "0 0 0.6rem",
                    padding: "0.4rem 0.6rem",
                  }}
                >
                  <p style={{ margin: "0 0 0.35rem", fontWeight: 700 }}>
                    {raceHeading(highlight)}
                    {highlight.opportunity.score !== null && (
                      <span
                        style={{
                          color: "#0a58ca",
                          fontWeight: 400,
                          marginLeft: "0.5rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        妙味スコア{" "}
                        {formatOpportunityScore(highlight.opportunity.score)}
                      </span>
                    )}
                    {highlight.evEstimated && (
                      <span
                        style={{
                          color: "#a60",
                          fontWeight: 400,
                          marginLeft: "0.5rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        発売前推定
                      </span>
                    )}
                  </p>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={thStyle} title={MARK_LEGEND}>
                          印
                        </th>
                        <th style={thStyle}>馬番</th>
                        <th style={thStyle}>馬名</th>
                        <th
                          style={thStyle}
                          title="3着内率をAI(LLM)が調教・コメント・展開から補正した確率"
                        >
                          {LABEL_ADJUSTED_PROB}
                        </th>
                        <th style={thStyle}>複勝下限</th>
                        <th style={thStyle}>EV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {highlight.horses.map((horse) => (
                        <tr
                          key={horse.umaban}
                          // ハイライト(緑背景)は isPositive(EVプラス判定)基準にする。
                          // ev !== null だけを条件にすると、印はあるがEVプラスでない馬
                          // (isPositive=false かつ ev≠null)まで誤って妙味ありと示唆してしまう
                          // (ResultTable の isHighlightRow と意味論を揃える)。
                          style={
                            horse.isPositive
                              ? { background: "#e6ffea" }
                              : undefined
                          }
                        >
                          <td style={tdStyle}>{formatMark(horse.mark)}</td>
                          <td style={tdStyle}>{horse.umaban}</td>
                          <td style={tdStyle}>{horse.horseName}</td>
                          <td style={tdStyle}>
                            {formatPercent(horse.adjustedProb)}
                          </td>
                          <td style={tdStyle}>
                            {formatOdds(horse.placeOddsMin)}
                          </td>
                          <td
                            style={{
                              ...tdStyle,
                              fontWeight: horse.isPositive ? 700 : 400,
                              color: horse.isPositive ? "#0a7f2e" : undefined,
                            }}
                          >
                            {formatEv(horse.ev)}
                            {horse.ev !== null && horse.evEstimated && (
                              <span
                                style={{
                                  color: "#a60",
                                  marginLeft: "0.25rem",
                                }}
                              >
                                {formatEstimatedEvSuffix(horse.evEstimated)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>

          {/* Discord送信(サマリ1通)。 */}
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
                : "サマリをDiscordに送信"}
            </button>
            {!props.webhookConfigured && (
              <span
                style={{
                  color: "#666",
                  marginLeft: "0.5rem",
                  fontSize: "0.85rem",
                }}
              >
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

          {/* レースごとの詳細(折りたたみ。既定は閉)。 */}
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
              レースごとの詳細
            </h3>
            {outcomes.map((entry) => {
              const expanded = expandedSet.has(entry.raceId);
              // raceName が空文字でも会場+レース番号で識別できるよう見出しヘルパーを共有する(Task#29)。
              // 成功時(result あり)はこちらを優先し、失敗・スキップ・未実行は従来どおりの
              // フォールバック(レース一覧のレース名→raceId)を使う。
              const label =
                entry.result !== null
                  ? raceHeading({
                      venueName: entry.result.venueName,
                      raceNumber: raceNumberFromRaceId(entry.result.raceId),
                      raceName: entry.result.raceName,
                    })
                  : (entry.raceName ?? entry.raceId);
              return (
                <div
                  key={entry.raceId}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    margin: "0 0 0.4rem",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => props.onToggleDetail(entry.raceId)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "0.4rem 0.6rem",
                      background: "#f7f7f7",
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <span>{expanded ? "▼" : "▶"}</span>
                    {statusBadge(entry)}
                    <span>{label}</span>
                    {entry.result !== null && (
                      <span style={{ color: "#666", fontSize: "0.85rem" }}>
                        ({entry.result.venueName} {entry.result.courseType}
                        {entry.result.distance}m)
                      </span>
                    )}
                    {opportunityByRaceId.has(entry.raceId) && (
                      <span style={{ color: "#0a58ca", fontSize: "0.85rem" }}>
                        妙味スコア{" "}
                        {formatOpportunityScore(
                          opportunityByRaceId.get(entry.raceId)!.score,
                        )}
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <div style={{ padding: "0.5rem 0.6rem" }}>
                      {entry.status === "success" && entry.result !== null && (
                        <ResultTable result={entry.result} />
                      )}
                      {entry.status === "failure" && (
                        <p style={{ color: "#c00", margin: 0 }}>
                          分析に失敗しました: {entry.error}
                        </p>
                      )}
                      {entry.status === "skipped" && (
                        <p style={{ color: "#a60", margin: 0 }}>
                          中断によりスキップされました。
                        </p>
                      )}
                      {entry.status === "pending" && (
                        <p style={{ color: "#888", margin: 0 }}>
                          未実行です。
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
