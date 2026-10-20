/**
 * 締切直前の再計算(Issue #338〈#335-A1〉)の、画面に出す文言の組み立て(Issue #344〈#335-A2〉)。純関数だけで、D1・R2 には触れない。`analysis-view.ts` が使う。
 *
 * 文言は**サーバで組み立てる**(クライアントの束は日本語を `\uXXXX` で出すため、文言を置くと 1 文字 6 バイトかかる。前例は `combo-counts-view.ts`)。
 * クライアントは、ここで作った行をそのまま出す。表(配分)は分析時と同じ部品〈core の `buildAllocationProposalView`〉で、クライアントが描く。
 */
import type { AllocationDiff } from "../../packages/core/src/analysis/allocation-diff";
import { betRowLabels } from "../../packages/core/src/view/allocation-proposal-view";
import { jstHm as jstHmOfMs } from "../../packages/core/src/common/jst";
import { formatYen } from "../../packages/core/src/view/verify-format";
import type { CloseComboBasis, CloseReason, CloseStatus } from "./analysis-close";

/** 節の先頭に 1 行だけ添える説明(確率は分析時のまま。AI の再実行ではないことを伝える)。 */
export const CLOSE_NOTE = "オッズだけを取り直し、確率は分析時のまま計算した結果です(分析時の提案は変わりません)。";

/** 差分の主な行の上限(賭け金の変化の大きい順)。 */
export const CLOSE_DIFF_ROW_LIMIT = 5;

/** 理由(固定の語彙)→ 利用者に分かる文。語彙が増えたら、型エラーで気づく。 */
const REASON_TEXT: Readonly<Record<CloseReason, string>> = {
  unset: "資金の設定が0のため計算していません",
  "nar-unsupported": "地方は対象外です",
  "too-late": "時刻を過ぎていたため行いませんでした",
  "fetch-failed": "オッズを取り直せませんでした",
  blocked: "オッズを取り直せませんでした",
  "horse-set-mismatch": "出走馬が分析時と変わったため行いませんでした",
  "analysis-failed": "計算できませんでした",
  "compute-failed": "計算できませんでした",
  "combo-missing": "分析時の組合せのオッズを読めませんでした",
};

/** 組合せは分析時のオッズのまま(地方で組合せ ON の部分的な取り直し。Issue #379)であることを伝える 1 行。検証画面の説明文(`verify-close.ts`)とは別の文。 */
export const CLOSE_COMBO_ANALYSIS_NOTE = "組合せのオッズは分析時のまま(単勝・複勝だけ取り直し)";

export function closeReasonText(reason: CloseReason): string {
  return REASON_TEXT[reason];
}

/** 回の見出し。リード(分)が分かれば「発走N分前」、定数にない回は「第N回」。 */
export function closeLabelOf(round: number, leadMinutes: number | null): string {
  return leadMinutes === null ? `第${round}回` : `発走${leadMinutes}分前`;
}


/** ISO 8601 → JST の「HH:mm」。解釈できなければ null。 */
function jstHm(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return jstHmOfMs(time);
}

/**
 * 状態と理由・動いた時刻と遅れ(表の前に出す行)。遅れは 1 分以上のときだけ(分未満は切り捨て)。
 * `comboBasis` が `analysis`(組合せは分析時のオッズ)で、再計算できた(ok)回には、末尾に {@link CLOSE_COMBO_ANALYSIS_NOTE} を足す(失敗・行わなかった回は配分が無いので足さない)。
 */
export function closeSummaryLines(r: {
  readonly status: CloseStatus;
  readonly reason: CloseReason | null;
  readonly firedAt: string;
  readonly lateMs: number;
  readonly comboBasis?: CloseComboBasis;
}): string[] {
  const reason = r.reason === null ? "" : `(${closeReasonText(r.reason)})`;
  const head = r.status === "ok" ? "再計算した" : r.status === "failed" ? `失敗${reason}` : `行わなかった${reason}`;
  const hm = jstHm(r.firedAt);
  const lateMin = Math.floor(r.lateMs / 60_000);
  const lines = hm === null ? [head] : [head, `${hm}に実行${lateMin >= 1 ? `(${lateMin}分遅れ)` : ""}`];
  return r.status === "ok" && r.comboBasis === "analysis" ? [...lines, CLOSE_COMBO_ANALYSIS_NOTE] : lines;
}

interface DiffRow {
  readonly delta: number;
  readonly betType: string;
  readonly comboKey: string;
  readonly text: string;
}

/** 差分の行(追加・削除・賭け金の変化)を、変化の絶対値が大きい順(同値は券種・キー順)に並べる。 */
function diffRows(diff: AllocationDiff): DiffRow[] {
  const label = (betType: string, comboKey: string): string => {
    const l = betRowLabels(betType, comboKey);
    return `${l.betTypeLabel} ${l.comboLabel}`;
  };
  const rows: DiffRow[] = [
    ...diff.added.map((b) => ({ delta: b.stake, betType: b.betType, comboKey: b.comboKey, text: `追加 ${label(b.betType, b.comboKey)} ${formatYen(b.stake)}` })),
    ...diff.removed.map((b) => ({ delta: b.stake, betType: b.betType, comboKey: b.comboKey, text: `削除 ${label(b.betType, b.comboKey)} ${formatYen(b.stake)}` })),
    ...diff.changed.map((c) => ({
      delta: Math.abs(c.afterStake - c.beforeStake),
      betType: c.betType,
      comboKey: c.comboKey,
      text: `変化 ${label(c.betType, c.comboKey)} ${formatYen(c.beforeStake)}→${formatYen(c.afterStake)}`,
    })),
  ];
  return rows.sort((a, b) => b.delta - a.delta || (a.betType < b.betType ? -1 : a.betType > b.betType ? 1 : 0) || (a.comboKey < b.comboKey ? -1 : a.comboKey > b.comboKey ? 1 : 0));
}

/**
 * 分析時の提案との差分の行(表の後に出す)。`afterBetCount` は再計算した配分の点数(0 なら先頭に「配分は0点です」)。`diff` が null(分析時の提案の配分が無い)なら、差分の文は出さない。
 * 差分があれば、要約(追加・削除・賭け金の変化の点数。合計が変わったときだけ合計の増減)と、主な行(上限 {@link CLOSE_DIFF_ROW_LIMIT}。超えた分は「ほか N 点」)。
 * 賭け金が同じでオッズ・期待値だけが動いた買い目は、変化に数えない(core の `diffAllocationBets`)。
 */
export function closeDiffLines(diff: AllocationDiff | null, afterBetCount: number): string[] {
  const lines: string[] = afterBetCount === 0 ? ["配分は0点です"] : [];
  if (diff === null) return lines;
  if (!diff.hasChange) return [...lines, "分析時から変わりませんでした"];
  const total = diff.totalStakeBefore === diff.totalStakeAfter ? "" : `(合計 ${formatYen(diff.totalStakeBefore)} → ${formatYen(diff.totalStakeAfter)})`;
  lines.push(`追加 ${diff.added.length}点・削除 ${diff.removed.length}点・賭け金の変化 ${diff.changed.length}点${total}`);
  const rows = diffRows(diff);
  lines.push(...rows.slice(0, CLOSE_DIFF_ROW_LIMIT).map((r) => r.text));
  if (rows.length > CLOSE_DIFF_ROW_LIMIT) lines.push(`ほか ${rows.length - CLOSE_DIFF_ROW_LIMIT}点`);
  return lines;
}
