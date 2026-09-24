import { useEffect, useReducer, useRef } from "react";

import type { AnalysisResult, BatchProgress } from "../shared/analysis-types.js";
import type {
  BatchRaceEntry,
  DiscordSendState,
} from "./batch-analysis-reducer.js";
import {
  BET_ALLOCATION_UNSET_NOTE,
  buildAllocationNotices,
  CROSS_RACE_OVERBET_NOTE,
  evThresholdFootnote,
  formatAllocationSummary,
  formatBetLabel,
  KELLY_CAP_EXPLANATION_NOTE,
  placeBetUnavailableMessage,
} from "./bet-allocation-view.js";
import {
  createAllocationQueueRunner,
  createAllocationScheduler,
  type AllocationOutcome,
  type AllocationScheduler,
} from "./mixed-allocation-queue.js";
import {
  type MixedAllocationCache,
  type MixedAllocationCacheKey,
} from "./mixed-allocation-cache.js";
import {
  ALLOCATION_COMPUTE_ERROR_NOTE,
  allocationProgressText,
  buildHiddenAllocationsBlocks,
  buildMixedAllocationDisplay,
  buildMixedAllocationNotices,
  COMBO_EV_CALIBRATION_NOTE,
  formatUnjudgedNote,
  mixedBetTypeLabel,
  MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER,
  MIXED_ALLOCATION_INVALID_MESSAGE,
  totalUnjudgedCount,
  type MixedRaceAllocationDisplayView,
} from "./mixed-allocation-view.js";
import { isBetAllocationUnset, type RaceAllocationView } from "../shared/race-allocation.js";
import type { MixedAllocationSettings } from "../shared/mixed-race-allocation.js";
import { INCLUDE_COMBO_ODDS_BATCH_NOTE } from "../shared/settings.js";
import { CopyErrorButton } from "./CopyErrorButton.js";
import {
  collectPerRaceHighlights,
  raceNumberFromRaceId,
  raceOpportunityRemark,
  rankRaceOpportunities,
  summarizeBatch,
} from "./batch-summary.js";
import {
  formatConditionChangeTags,
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
  llmCorrectionStatusText,
  llmCorrectionTooltip,
  MARK_LEGEND,
  oddsStatusNote,
  raceHeading,
} from "./format.js";
import { formatYen } from "./verify-format.js";

/** 一括分析画面のプロパティ。状態と操作は親(App)から受け取る。 */
export interface BatchAnalysisViewProps {
  /** 選択中のレース数(実行ボタンの有効判定に使う)。 */
  readonly selectedCount: number;
  /**
   * 期間バッチが収集中/実行中などの理由で、実行ボタンを外部から無効化するか(タスクC2、
   * deriveBatchAvailability由来)。省略時は false(従来どおり)。
   */
  readonly disabledByOtherBatch?: boolean;
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
  /**
   * 分析データをエクスポートする操作(第一版・GitHub Issue#10)。対象は指定レースの
   * 「保存済みの最新分析」(main側で決定的に選ぶ。この画面から実行した分析がまさにその最新分析になる)。
   */
  readonly onExportAnalysis: (raceId: string) => void;
  /**
   * 馬券配分(機能C-2)の設定3項目+EV閾値+券種取得/選択の3項目(機能D-2c第4段・Issue #28)。
   * App.tsxがgetSettingsから流用して渡す(IPC追加なし)。bankroll/perRaceCapが未設定
   * (0以下)のときは配分ブロックを一切出さず、画面全体でBET_ALLOCATION_UNSET_NOTEを
   * 1点だけ表示する(仕様「未設定時は…注記は画面全体で1点だけ」)。
   *
   * **機能D-2c第4段でMixedAllocationSettingsへ統合した**: 第3段までは`includeComboOdds`を
   * 別のトップレベルprop(`includeComboOdds`)として受け取っていたが、第4段で
   * `buildMixedAllocationDisplay`へそのまま渡す必要があるため、この1つの設定オブジェクトに
   * 統合した(`includeComboOdds`の読み取りは`props.betAllocationSettings.includeComboOdds`に
   * なった)。
   */
  readonly betAllocationSettings: MixedAllocationSettings;
  /**
   * 券種横断の馬券配分の表示データキャッシュ(機能D-2c第4段・Issue #28・AC21)。
   *
   * **Issue #110(#24-C2)でApp.tsx側の所有に変更した**: 分析タブから離れて戻ると
   * `BatchAnalysisView`自体が再マウントされる(`App.tsx`の`{verify.activeTab === "分析" && ...}`
   * による条件描画)。キャッシュを本コンポーネントの`useRef`で持つと再マウントのたびに消え、
   * 設定を変えていなくても全レースを再計算してしまう。Appは分析タブへ切り替わっても
   * アンマウントされないため、Appが`useRef`で保持し、propsとして受け取ることで
   * 「戻ったときにそのまま当たる」を実現する(AC-5)。
   * キーの定義(9項目の全数列挙表)は`mixed-allocation-cache.ts`のJSDocが唯一の正であり、
   * 本コンポーネントはこれを組み立てて`peek`/`step`(`mixed-allocation-queue.ts`)に渡すだけ。
   */
  readonly mixedAllocationCache: MixedAllocationCache<AllocationOutcome<MixedRaceAllocationDisplayView>>;
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
function ResultTable(props: {
  result: AnalysisResult;
  /** 分析データをエクスポートする操作(第一版・GitHub Issue#10)。 */
  onExportAnalysis: (raceId: string) => void;
}): React.JSX.Element {
  const { result } = props;
  return (
    <div>
      <p
        style={{ margin: "0.25rem 0", color: "#555", fontSize: "0.85rem" }}
        // fallback(フェイルセーフでpriorに復帰)・marksDropped(印の制約違反による救済)の
        // 詳細理由をtitleで補足する(論点C: fallbackReasonのUI伝播・2026-07-19合意)。
        // 主文言(llmCorrectionStatusText)は簡潔にしつつ、理由は必要なら参照できるようにする。
        title={llmCorrectionTooltip(result)}
      >
        LLM補正: {llmCorrectionStatusText(result)}
        {result.dateApproximate && (
          <span style={{ color: "#a60", marginLeft: "0.5rem" }}>
            ※開催日は当日日付での近似({result.date})
          </span>
        )}
        <button
          type="button"
          onClick={() => props.onExportAnalysis(result.raceId)}
          style={{ marginLeft: "0.5rem" }}
        >
          分析データをエクスポート
        </button>
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
            <th style={thStyle}>単勝</th>
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
              <td style={tdStyle}>{formatOdds(row.winOdds)}</td>
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
 * 馬券配分ブロック(機能C-2)を1レース分描画する。buildRaceAllocationのkindごとに
 * 表示を出し分ける。kind="unset"は個別レースでは何も出さない(呼び出し元がisBetAllocationUnset
 * を先にチェックし、画面全体で1点だけ注記を出す設計のため。ここに来ること自体が想定外だが、
 * 呼び出し順序に依存しない防御として null を返す)。
 */
function renderBetAllocationBlock(
  view: RaceAllocationView,
  evThreshold: number,
): React.JSX.Element | null {
  if (view.kind === "unset") {
    return null;
  }
  if (view.kind === "yoso") {
    return (
      <p style={{ marginTop: "0.5rem", color: "#a60", fontSize: "0.85rem" }}>
        複勝が未発売のため、オッズ確定後に再分析してください。
      </p>
    );
  }
  if (view.kind === "unavailable") {
    return (
      <p style={{ marginTop: "0.5rem", color: "#666", fontSize: "0.85rem" }}>
        {placeBetUnavailableMessage(view.reason)}
      </p>
    );
  }
  // kind === "computed"
  const { result } = view;
  if (result.isSkip) {
    return (
      <p style={{ marginTop: "0.5rem", color: "#666", fontSize: "0.85rem" }}>
        配分見送り: {result.skipReason}
      </p>
    );
  }
  const notices = buildAllocationNotices(result);
  return (
    <div
      style={{
        marginTop: "0.5rem",
        padding: "0.5rem 0.6rem",
        background: "#f7f7f7",
        borderRadius: 4,
      }}
    >
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thStyle}>買い目</th>
            <th style={thStyle}>配分額</th>
          </tr>
        </thead>
        <tbody>
          {result.allocations
            .filter((a) => a.stake > 0)
            .map((a) => (
              <tr key={a.umaban}>
                <td style={tdStyle}>{formatBetLabel(a.umaban)}</td>
                <td style={tdStyle}>{formatYen(a.stake)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p style={{ margin: "0.4rem 0 0", fontWeight: 700, fontSize: "0.85rem" }}>
        {formatAllocationSummary(result)}
      </p>
      {notices.map((notice) => (
        <p key={notice} style={{ margin: "0.3rem 0 0", color: "#a60", fontSize: "0.8rem" }}>
          {notice}
        </p>
      ))}
      <p style={{ margin: "0.4rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {KELLY_CAP_EXPLANATION_NOTE}
      </p>
      <p style={{ margin: "0.2rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {CROSS_RACE_OVERBET_NOTE}
      </p>
      <p style={{ margin: "0.2rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {evThresholdFootnote(evThreshold)}
      </p>
    </div>
  );
}

/** 券種別内訳テーブルの1行(AC10・AC13の点数)。 */
function breakdownRow(
  label: string,
  breakdown: { readonly stake: number; readonly count: number },
): React.JSX.Element {
  return (
    <tr key={label}>
      <td style={tdStyle}>{label}</td>
      <td style={tdStyle}>{formatYen(breakdown.stake)}</td>
      <td style={tdStyle}>{breakdown.count}点</td>
    </tr>
  );
}

/**
 * 券種横断(複勝・ワイド・3連複)の馬券配分ブロック(機能D-2c第4段・Issue #28)を1レース分描画する。
 * `MixedRaceAllocationDisplayView`のkindごとに表示を出し分ける:
 * - `unset`/`yoso`/`unavailable`/`computed`(D-2フォールバック時、既存`buildRaceAllocation`の
 *   結果そのまま): 既存の`renderBetAllocationBlock`へそのまま委譲する(非破壊性・AC2)。
 * - `invalid`: core由来の生の例外メッセージではなく、ユーザー向け文言
 *   (`MIXED_ALLOCATION_INVALID_MESSAGE`)を表示する(AC17)。
 * - `mixed`: 券種別内訳(AC10・AC13の点数)・複勝のみの提案額との併記(AC11)・個々の買い目
 *   (AC13。上位`MIXED_ALLOCATION_VISIBLE_LIMIT`件+折りたたみ。Issue #15再スコープ)・
 *   判定不能件数(AC15)・券種別の状態注記(AC16)・#35較正注記(AC14)を表示する。
 */
function renderMixedAllocationBlock(
  view: MixedRaceAllocationDisplayView,
  evThreshold: number,
): React.JSX.Element | null {
  if (view.kind === "invalid") {
    return (
      <p style={{ marginTop: "0.5rem", color: "#c00", fontSize: "0.85rem" }}>
        {MIXED_ALLOCATION_INVALID_MESSAGE}
      </p>
    );
  }
  if (view.kind !== "mixed") {
    return renderBetAllocationBlock(view, evThreshold);
  }
  const { result, display } = view;
  if (result.isSkip) {
    return (
      <p style={{ marginTop: "0.5rem", color: "#666", fontSize: "0.85rem" }}>
        配分見送り: {result.skipReason}
      </p>
    );
  }
  // 表示順(advisory → 確率合計警告 → notDiversified)は既存の複勝専用経路
  // (buildAllocationNotices・bet-allocation-view.ts)と揃える(boss メタレビュー
  // 差し戻し2026-08-13対応: 混在経路で確率合計警告が欠落していたため追加した)。
  // 組み立てロジック自体はmixed-allocation-view.tsのbuildMixedAllocationNotices
  // (純関数)へ切り出し済み(再差し戻し対応: ソース走査ガードでは push の積み忘れを
  // 検出できないと判明したため、値として直接テストできる形にした)。ここでは戻り値を
  // 描画するだけにする。
  const notices = buildMixedAllocationNotices(result, display);
  const unjudgedCount = totalUnjudgedCount(display.unjudged);

  return (
    <div
      style={{
        marginTop: "0.5rem",
        padding: "0.5rem 0.6rem",
        background: "#f7f7f7",
        borderRadius: 4,
      }}
    >
      {/* AC3改訂: 頭数不可(4以下・5〜7)で複勝が対象外のときの一言注記(既存文言をそのまま使う)。 */}
      {display.placeUnavailableNote !== null && (
        <p style={{ margin: "0 0 0.4rem", color: "#666", fontSize: "0.8rem" }}>
          {display.placeUnavailableNote}
        </p>
      )}

      {/* 券種別内訳(AC10: 合計はtotalStakeと一致・AC13: 点数。Issue #90で4群化
          〈place/win/wide/trio〉。表示順は`MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`
          〈mixed-allocation-view.ts〉を`.map`するだけにし、券種を本ファイルで手書きしない)。 */}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thStyle}>券種</th>
            <th style={thStyle}>金額</th>
            <th style={thStyle}>点数</th>
          </tr>
        </thead>
        <tbody>
          {MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER.map((betType) =>
            breakdownRow(mixedBetTypeLabel(betType), display.breakdown[betType]),
          )}
        </tbody>
      </table>

      {/*
        AC11: 複勝のみの場合の提案額を、混在時の複勝配分額とは別々の値として併記する。
        boss メタレビュー差し戻し2026-08-13対応: 「この券種横断の配分」という表現が総額
        (上の内訳テーブルの合計)を指すように読め、複勝ぶんの金額(display.breakdown.place.stake)
        と取り違えられていたため、「この配分での複勝ぶん」に直した(値そのものは変更なし)。
      */}
      <p style={{ margin: "0.35rem 0 0", color: "#666", fontSize: "0.8rem" }}>
        参考: 複勝のみで計算した場合の提案額は
        {display.placeOnlyStake !== null ? formatYen(display.placeOnlyStake) : "算出できません"}
        でした(この配分での複勝ぶん〈{formatYen(display.breakdown.place.stake)}〉とは別の計算です)。
      </p>

      {/*
        AC13: 個々の買い目をstake降順(同額は馬番配列の辞書順)で列挙する。上位
        MIXED_ALLOCATION_VISIBLE_LIMIT件を常時表示し、残りは直後の折りたたみに入れる
        (Issue #15再スコープ)。「配分額の大きい順」以外の断定的なキャプション
        (例: 「上位20件」)は、実際に20件未満のとき嘘になるため付けない。
      */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.5rem" }}>
        <thead>
          <tr>
            <th style={thStyle}>券種</th>
            <th style={thStyle}>買い目</th>
            <th style={thStyle}>配分額</th>
          </tr>
        </thead>
        <tbody>
          {/*
            keyにbetTypeを含める(bossメタレビューR6)。umabansだけをkeyにすると、
            #23-Bで単勝を追加した際にwin:[5]とplace:[5]が同一keyになりうる
            (ALLOCATION_BET_TYPE_UMABAN_COUNTのJSDocが「#24で馬連を1箇所だけ足す事故を
            構造的に防ぐ」と述べているのと同種の一貫性)。
          */}
          {display.split.visible.map((a) => (
            <tr key={`${a.betType}-${a.umabans.join("-")}`}>
              <td style={tdStyle}>{mixedBetTypeLabel(a.betType)}</td>
              <td style={tdStyle}>{formatBetLabel(a.umabans)}</td>
              <td style={tdStyle}>{formatYen(a.stake)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        隠れている買い目の折りたたみ(Issue #15再スコープ)。hiddenCount===0のときは
        buildHiddenAllocationsBlocksが空配列を返すため、この.mapは何も描画しない
        (JSXに`hiddenCount > 0 &&`という条件式を書かない。AC1強化・boss指摘)。
        ネイティブ<details>/<summary>を使い、Reactのstateを持たない(再レンダーを
        起こさずメモ化の前提を崩さない。boss裁定)。
      */}
      {buildHiddenAllocationsBlocks(display.split).map((block) => (
        <details key="hidden-allocations" style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", color: "#666", fontSize: "0.8rem" }}>
            {block.summaryText}
          </summary>
          <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.3rem" }}>
            <thead>
              <tr>
                <th style={thStyle}>券種</th>
                <th style={thStyle}>買い目</th>
                <th style={thStyle}>配分額</th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map((a) => (
                <tr key={`${a.betType}-${a.umabans.join("-")}`}>
                  <td style={tdStyle}>{mixedBetTypeLabel(a.betType)}</td>
                  <td style={tdStyle}>{formatBetLabel(a.umabans)}</td>
                  <td style={tdStyle}>{formatYen(a.stake)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}

      <p style={{ margin: "0.4rem 0 0", fontWeight: 700, fontSize: "0.85rem" }}>
        {formatAllocationSummary(result)}
      </p>
      {notices.map((notice) => (
        <p key={notice} style={{ margin: "0.3rem 0 0", color: "#a60", fontSize: "0.8rem" }}>
          {notice}
        </p>
      ))}

      {/* AC15: 判定不能(missing/unfetched/malformed)が1件以上のときだけ件数を表示する。 */}
      {unjudgedCount > 0 && (
        <p style={{ margin: "0.3rem 0 0", color: "#a60", fontSize: "0.8rem" }}>
          {formatUnjudgedNote(display.unjudged)}
        </p>
      )}

      {/* AC16: {}を「発売なし」と断定しない、券種別の状態注記(無ければ表示しない)。 */}
      {display.wideNote !== null && (
        <p style={{ margin: "0.3rem 0 0", color: "#666", fontSize: "0.8rem" }}>
          ワイド: {display.wideNote}
        </p>
      )}
      {display.trioNote !== null && (
        <p style={{ margin: "0.2rem 0 0", color: "#666", fontSize: "0.8rem" }}>
          三連複: {display.trioNote}
        </p>
      )}

      <p style={{ margin: "0.4rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {KELLY_CAP_EXPLANATION_NOTE}
      </p>
      <p style={{ margin: "0.2rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {CROSS_RACE_OVERBET_NOTE}
      </p>
      <p style={{ margin: "0.2rem 0 0", color: "#666", fontSize: "0.75rem" }}>
        {evThresholdFootnote(evThreshold)}
      </p>
      {/* AC14: #35の較正注記(組合せ券種のEVは過大評価・較正未実施)。混在経路でのみ表示する。 */}
      <p style={{ margin: "0.2rem 0 0", color: "#a60", fontSize: "0.75rem" }}>
        {COMBO_EV_CALIBRATION_NOTE}
      </p>
    </div>
  );
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
  // 馬券配分(機能C-2)には出走全頭(候補外も含む)が必要なため、highlightの絞り込み済み
  // horsesではなく、outcomesから直接raceId→AnalysisResult(全rows)の対応を作る
  // (collectPerRaceHighlightsのRaceHighlight型は変更しない。既存出力の非破壊性のため)。
  const analysisResultByRaceId = new Map<string, AnalysisResult>();
  for (const o of outcomes) {
    if (o.status === "success" && o.result !== null) {
      analysisResultByRaceId.set(o.result.raceId, o.result);
    }
  }
  const betAllocationUnset = isBetAllocationUnset(props.betAllocationSettings);

  // ==========================================================================
  // 券種横断の馬券配分(機能D-2c第4段・Issue #28)を、レース単位に分けて進める仕組み
  // (Issue #110・#24-C2)。値の記憶(キャッシュ)は`props.mixedAllocationCache`として
  // App側から受け取る(寿命がBatchAnalysisViewを超えるようにするため。propの型JSDoc参照)。
  // 進め方(1ステップ=1レース・失敗の記録)は`mixed-allocation-queue.ts`に切り出し済み。
  //
  // `runner`自体はキャッシュへの参照以外の永続状態を持たない(直近の`setInputs`しか
  // 覚えない)ため、`BatchAnalysisView`が再マウントされてもローカルに新規作成してよい
  // (進捗=`props.mixedAllocationCache`の中身はAppが持ち続けているので引き継がれる)。
  // ==========================================================================
  const allocationRunnerRef = useRef<ReturnType<
    typeof createAllocationQueueRunner<MixedRaceAllocationDisplayView>
  > | null>(null);
  if (allocationRunnerRef.current === null) {
    allocationRunnerRef.current = createAllocationQueueRunner(props.mixedAllocationCache);
  }
  const allocationRunner = allocationRunnerRef.current;

  // 計算対象レースの表示順(ハイライトの表示順。Issue #110「計算の順番はハイライトの表示順」)。
  // 未設定時(betAllocationUnset)は対象自体が無い(画面全体の注記に一本化しているため)。
  const allocationOrder: readonly string[] = betAllocationUnset
    ? []
    : highlights
        .filter((h) => analysisResultByRaceId.has(h.raceId))
        .map((h) => h.raceId);

  // レースIDから「今の」キャッシュキーを組み立てる。毎レンダーで作り直す(過去のレンダーの
  // ものを使い回さない。AC-3'の要)。
  const keyForAllocation = (raceId: string): MixedAllocationCacheKey => {
    const fullResult = analysisResultByRaceId.get(raceId)!;
    const s = props.betAllocationSettings;
    return {
      raceId,
      race: fullResult,
      bankroll: s.bankroll,
      perRaceCap: s.perRaceCap,
      kellyFraction: s.kellyFraction,
      evThreshold: s.evThreshold,
      includeComboOdds: s.includeComboOdds,
      includeWideInAllocation: s.includeWideInAllocation,
      includeTrioInAllocation: s.includeTrioInAllocation,
    };
  };
  // 実際の計算。既存の同期経路(旧実装)と全く同じ関数・同じ引数で呼ぶ(AC-6: 答えを変えない)。
  const computeAllocation = (raceId: string): MixedRaceAllocationDisplayView => {
    const fullResult = analysisResultByRaceId.get(raceId)!;
    return buildMixedAllocationDisplay(fullResult, props.betAllocationSettings);
  };
  // 毎レンダーで最新の入力に差し替える(setInputsは呼ぶたびに全採用する契約。
  // mixed-allocation-queue.tsのJSDoc・AC-3'参照)。
  allocationRunner.setInputs({
    order: allocationOrder,
    keyFor: keyForAllocation,
    compute: (raceId) => computeAllocation(raceId),
  });
  const pendingAllocationRaceIds = allocationRunner.pendingRaceIds();
  const hasPendingAllocation = pendingAllocationRaceIds.length > 0;

  // 1ステップ=1レースで計算を進め、レースとレースの間に描画の機会を作る(AC-2)。
  //
  // ★Issue #110メタレビュー差し戻し(AC-9): 当初は`useEffect(..., [hasPendingAllocation])`
  // (未計算が1件以上あるかの**真偽値**を依存配列にする)で駆動していたが、code-reviewerが
  // React 18本体のソース(`ensureRootIsScheduled`)を根拠に指摘したとおり、Reactのバッチ処理
  // により「未計算0件」を経由しないコミットが起き、依存配列の値が`true→true`のまま変化せず
  // **ループが止まったまま二度と再開しない**経路が実在した。
  //
  // 対策として、判断ロジックを`createAllocationScheduler`(過去の真偽値を一切記憶せず、
  // 呼ばれた時点の「今、タイマーが張られているか」「今、未計算があるか」だけを見る冪等な
  // オブジェクト。`mixed-allocation-queue.ts`のJSDoc「設計上の危険その3」・
  // `mixed-allocation-queue.test.ts`のAC-9テスト参照)へ切り出した。
  //
  // ★Issue #110さらなるメタレビュー差し戻し: スケジューラの生成を**render中の`useRef`遅延
  // 初期化**にしていたが、これは`CopyErrorButton.tsx`が一度踏んだのと同じ罠だった。
  // `main.tsx`はアプリ全体を`<StrictMode>`で包んでおり、開発モードでは`useEffect`が
  // setup→cleanup→setupと2重実行される。render中生成だとインスタンスは1つしか作られず、
  // 1回目のcleanupで`dispose()`された唯一のインスタンスを2回目以降のsetup後も使い続けることに
  // なり、以後`sync()`は`disposed`を見て何もしなくなる(開発モードで配分が永遠に
  // 「計算中…」のままになる。本番ビルドは2重実行が無いため顕在化しない)。
  // `CopyErrorButton.tsx`の前例に倣い、**スケジューラの生成そのものを`useEffect(..., [])`の
  // 中へ移し**、setupのたびに新しいインスタンスを作って対応するcleanupでそのインスタンスだけを
  // `dispose()`する(クロージャで捕まえた自分自身の値と比較してからrefをnullに戻す。
  // StrictModeの1回目cleanupが2回目setup後のrefを誤って消さないようにするため)。
  // マウント直後の最初のコミットを取りこぼさないよう、生成直後に`sync()`を1回呼び、かつ
  // 「毎コミットsync()する」effectより**先に宣言する**(宣言順に実行されるため。
  // どちらか一方が欠けても、マウント直後の最初のsync()を取りこぼす経路が残る)。
  const [, forceAllocationRerender] = useReducer((c: number) => c + 1, 0);
  const allocationSchedulerRef = useRef<AllocationScheduler | null>(null);
  useEffect(() => {
    const scheduler = createAllocationScheduler({
      runner: allocationRunner,
      schedule: (callback) => window.setTimeout(callback, 0),
      cancel: (handle) => window.clearTimeout(handle),
      onStepped: forceAllocationRerender,
    });
    allocationSchedulerRef.current = scheduler;
    scheduler.sync();
    return () => {
      scheduler.dispose();
      // クロージャで捕まえた自分自身のインスタンスだけをnullに戻す
      // (CopyErrorButton.tsxと同じ理由。参照ではなく「このeffect実行が生成した値」で判定する)。
      if (allocationSchedulerRef.current === scheduler) {
        allocationSchedulerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    allocationSchedulerRef.current?.sync();
  });

  const expandedSet = new Set(props.expandedRaceIds);
  // 実行前スナップショット(全pending)だけの状態では結果表示はまだ出さない。
  const hasCompleted = outcomes.some((o) => o.status !== "pending");

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem" }}>一括分析</h2>

      {/*
        組合せオッズ取得設定(機能D-2c第3段・Issue #28): 設定がONのときだけ表示する固定注記1行
        (数値を含まない。対象レース数・所要時間の動的な見積りは判断済み・出さない。Issue #15再スコープ)。
      */}
      {props.betAllocationSettings.includeComboOdds && (
        <p style={{ color: "#a60", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
          {INCLUDE_COMBO_ODDS_BATCH_NOTE}
        </p>
      )}

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={props.onRun}
          disabled={
            props.selectedCount === 0 ||
            props.running ||
            (props.disabledByOtherBatch ?? false)
          }
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
                          {/* 筆頭候補馬の条件替わり(妙味材料)タグ。タグが無ければ何も表示しない
                              (raceId+umabanで自身のタグを引く。空バッジ等のノイズを出さない)。 */}
                          {formatConditionChangeTags(r.bestPickConditionChangeTags) !==
                            "" && (
                            <span
                              style={{
                                color: "#0a58ca",
                                marginLeft: "0.4rem",
                                fontSize: "0.8rem",
                              }}
                            >
                              {formatConditionChangeTags(r.bestPickConditionChangeTags)}
                            </span>
                          )}
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
            さらに、レース数が多いと縦に長くなりすぎるとのユーザー要望を受け、検証画面のレース一覧
            (VerifyView.tsx)と同じ流儀で details/summary によりレースごとに折りたたむ(既定は閉)。
          */}
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
              レース別ハイライト(印あり・EVプラス)
            </h3>
            {/*
              馬券配分(機能C-2): 総資金または1レース上限が未設定のとき、レースごとの配分ブロックは
              一切出さず、画面全体でこの注記を1点だけ表示する(レース数に比例して増やさない)。
            */}
            {betAllocationUnset && (
              <p style={{ color: "#a60", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
                {BET_ALLOCATION_UNSET_NOTE}
              </p>
            )}
            {/*
              配分計算の全体進捗(Issue #110・AC-1)。全部終わったら(hasPendingAllocationが
              falseになったら)表示を消す(裁定2の指示どおり)。
            */}
            {hasPendingAllocation && (
              <p style={{ color: "#0a58ca", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
                {allocationProgressText(
                  allocationOrder.length - pendingAllocationRaceIds.length,
                  allocationOrder.length,
                )}
              </p>
            )}
            {highlights.length === 0 ? (
              <p style={{ color: "#666" }}>該当なし</p>
            ) : (
              highlights.map((highlight) => (
                <details
                  key={highlight.raceId}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    margin: "0 0 0.6rem",
                    padding: "0.4rem 0.6rem",
                  }}
                >
                  <summary style={{ cursor: "pointer", fontWeight: 700 }}>
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
                  </summary>
                  <table
                    style={{
                      borderCollapse: "collapse",
                      width: "100%",
                      marginTop: "0.4rem",
                    }}
                  >
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
                        <th style={thStyle}>条件替わり</th>
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
                          <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                            {formatConditionChangeTags(horse.conditionChangeTags)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {/*
                    馬券配分(機能D-2c第4段・Issue #28)。未設定時はここに来ない(上の
                    betAllocationUnsetチェックで画面全体の注記に一本化しているため、
                    このブロックは常に判定対象)。券種横断の配分(buildMixedAllocationDisplay)
                    へ切り替え済み(D-2のフォールバック規則により、対象外設定時は既存の
                    複勝専用経路と完全に同じ結果になる)。greedySteps(貪欲配分の刻み幅)が
                    券種構成比を左右する事実・Issue #36の詳細は shared/mixed-race-allocation.ts の
                    JSDoc参照(Issue #57で計算本体と共にそちらへ移設した。本タスクではgreedySteps
                    自体は変更しない)。
                    AC21: レース単位でメモ化する(details開閉等の再レンダーで再計算しない)。
                    Issue #110: 計算をレース単位に分けて進めるため(AC-2)、ここでは`compute`を
                    誘発しない`peek`だけを見る。閉じた<details>の中でも(React自身は開閉に
                    関わらず子要素を評価するため)このIIFEは毎レンダー実行されるが、実際の
                    計算(`allocationRunner.step()`)は上の`useEffect`側で1ステップずつ
                    別途進む(ここでは「今の結果があるかどうか」を覗くだけで、無ければ
                    「計算中」を出す)。
                  */}
                  {!betAllocationUnset &&
                    (() => {
                      const fullResult = analysisResultByRaceId.get(highlight.raceId);
                      if (fullResult === undefined) {
                        return null;
                      }
                      const outcome = allocationRunner.peek(highlight.raceId);
                      if (outcome === undefined) {
                        return (
                          <p style={{ color: "#666", fontSize: "0.85rem" }}>
                            配分を計算中…
                          </p>
                        );
                      }
                      if (outcome.status === "error") {
                        return (
                          <p style={{ color: "#c0392b", fontSize: "0.85rem" }}>
                            {ALLOCATION_COMPUTE_ERROR_NOTE}
                          </p>
                        );
                      }
                      return renderMixedAllocationBlock(
                        outcome.value,
                        props.betAllocationSettings.evThreshold,
                      );
                    })()}
                </details>
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
                {props.discordSend.message !== null && (
                  <CopyErrorButton
                    operation="一括分析:Discord送信"
                    message={props.discordSend.message}
                  />
                )}
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
                        <ResultTable
                          result={entry.result}
                          onExportAnalysis={props.onExportAnalysis}
                        />
                      )}
                      {entry.status === "failure" && (
                        <p style={{ color: "#c00", margin: 0 }}>
                          分析に失敗しました: {entry.error}
                          {entry.error !== null && (
                            <CopyErrorButton
                              operation="一括分析:レース"
                              message={entry.error}
                              context={{ raceId: entry.raceId }}
                            />
                          )}
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
