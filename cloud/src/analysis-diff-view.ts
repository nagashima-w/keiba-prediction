/**
 * 前の分析との差(Issue #583)。同じレースの「表示中の分析」と「その 1 つ前の分析」を比べ、変わったところだけを日本語の行にする。純関数だけで、D1・R2 には触れない。
 *
 * 文言は**サーバで組み立てる**(クライアントの束は日本語を `\uXXXX` で出し、1 文字 6 バイトかかる。前例は `close-view.ts`・`combo-counts-view.ts`)。クライアントは行を並べるだけ。
 * 比べるのは印・買い目と金額・3 着内率(統計モデルと AI 補正後)の 3 つ。オッズの動きは見せない。
 * 材料はすべて D1 の値(`GET /api/analyses/{id}` で閲覧者にも見えている項目)だけで、R2 を読まない。管理者だけが見る項目(追加指示・LLM の記録・費用)は使わない。
 */
import { diffAllocationBets } from "../../packages/core/src/analysis/allocation-diff";
import { jstHm } from "../../packages/core/src/common/jst";
import { formatPercent } from "../../packages/core/src/view/format";
import { formatYen } from "../../packages/core/src/view/verify-format";
import { CLOSE_DIFF_ROW_LIMIT, diffRows } from "./close-view";
import type { AnalysisViewAllocation, AnalysisViewHorse } from "./analysis-view";

/** 3 着内率の行に出す最小の動き(ポイント。0.1 ポイントに丸めた値で比べる)。 */
export const DIFF_PROB_MIN_POINTS = 1.0;
/** 3 着内率の行の上限(動きの大きい順。超えたぶんは「ほか N頭」)。 */
export const DIFF_PROB_ROW_LIMIT = 5;
/** 変わったところが無いときの 1 行。 */
export const NO_CHANGE_LINE = "変わったところはありません";

type DiffHorse = Pick<AnalysisViewHorse, "umaban" | "name" | "mark" | "prior" | "adjustedProb">;
type DiffSide = {
  /** LLM のモデル(AI を使わなかった分析は null)。 */
  readonly model: string | null;
  /** LLM が使われなかった・一部しか使われなかった理由(固定文言。無ければ null)。 */
  readonly llmNote: string | null;
  /** 配分(記録が無ければ null)。 */
  readonly allocation: AnalysisViewAllocation | null;
};

/** 今回(表示中)の分析のうち、差に使う部分(`AnalysisView` が満たす)。 */
export interface DiffCurrent extends DiffSide {
  readonly horses: readonly DiffHorse[];
}

/** 前の分析(D1 から読んだもの)。馬名は使わない(今回の分析の馬名で出す)。 */
export interface DiffPrevious extends DiffSide {
  readonly id: number;
  readonly analyzedAt: string;
  readonly horses: readonly DiffHorse[];
}

/** 応答の `previousDiff`。 */
export interface AnalysisViewPreviousDiff {
  readonly previousId: number;
  /** 見出し(「前の分析(11/9 10:30)との差」。時刻は JST)。 */
  readonly title: string;
  readonly lines: readonly string[];
}

/** AI を使った分析か(モデルがあり、LLM の注記が無い)。使わなかった・一部だけの分析では、補正後の確率が統計モデルと同じ値か混ざった値になる。 */
const usedAi = (s: DiffSide): boolean => s.model !== null && s.llmNote === null;

const SETTING_KEYS = [
  "bankroll",
  "perRaceCap",
  "evThreshold",
  "includeComboOdds",
  "includeWide",
  "includeTrio",
  "includeQuinella",
  "includeExacta",
  "includeTrifecta",
  "includeBracketQuinella",
] as const satisfies readonly (keyof AnalysisViewAllocation)[];

const label = (h: DiffHorse): string => `${h.umaban}番${h.name === null ? "" : ` ${h.name}`}`;

/** ポイントの動き(0.1 ポイントに丸める)。 */
const points = (before: number, after: number): number => Math.round((after - before) * 1000) / 10;
const signed = (p: number): string => `${p > 0 ? "+" : ""}${p.toFixed(1)}`;

function jstMdHm(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "日時不明";
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jstHm(ms)}`;
}

function betLines(before: AnalysisViewAllocation, after: AnalysisViewAllocation): string[] {
  const diff = diffAllocationBets(before.bets, after.bets);
  if (!diff.hasChange) return [];
  const total = diff.totalStakeBefore === diff.totalStakeAfter ? "" : `(合計 ${formatYen(diff.totalStakeBefore)} → ${formatYen(diff.totalStakeAfter)})`;
  const rows = diffRows(diff);
  const lines = [`買い目 追加 ${diff.added.length}点・削除 ${diff.removed.length}点・金額の変化 ${diff.changed.length}点${total}`];
  lines.push(...rows.slice(0, CLOSE_DIFF_ROW_LIMIT).map((r) => `　${r.text}`));
  if (rows.length > CLOSE_DIFF_ROW_LIMIT) lines.push(`　ほか ${rows.length - CLOSE_DIFF_ROW_LIMIT}点`);
  return lines;
}

export function buildPreviousDiff(current: DiffCurrent, previous: DiffPrevious): AnalysisViewPreviousDiff {
  const prevByUmaban = new Map(previous.horses.map((h) => [h.umaban, h]));
  const common = [...current.horses].sort((a, b) => a.umaban - b.umaban).flatMap((c) => {
    const p = prevByUmaban.get(c.umaban);
    return p === undefined ? [] : [{ c, p }];
  });
  const changes: string[] = [];
  const notices: string[] = [];

  // 馬の集合
  const onlyPrev = previous.horses.length - common.length;
  const onlyCur = current.horses.length - common.length;
  if (onlyPrev > 0 || onlyCur > 0) {
    changes.push(`前にだけ ${onlyPrev}頭・今回にだけ ${onlyCur}頭(両方にいる馬だけ比べます)`);
  }

  // 印
  for (const { c, p } of common) {
    if (c.mark !== p.mark) changes.push(`印 ${label(c)}: ${p.mark ?? "なし"} → ${c.mark ?? "なし"}`);
  }

  // 買い目と金額
  if (previous.allocation !== null && current.allocation !== null) {
    changes.push(...betLines(previous.allocation, current.allocation));
    if (SETTING_KEYS.some((k) => previous.allocation![k] !== current.allocation![k])) notices.push("設定が前の分析と違います");
  } else if (previous.allocation === null && current.allocation !== null) {
    notices.push("買い目 前の分析には配分の記録がありません");
  } else if (previous.allocation !== null && current.allocation === null) {
    notices.push("買い目 今回の分析には配分の記録がありません");
  }

  // 3 着内率
  const bothAi = usedAi(previous) && usedAi(current);
  if (!bothAi) {
    const who = [usedAi(previous) ? null : "前の分析", usedAi(current) ? null : "今回の分析"].filter((w) => w !== null).join("・");
    notices.push(`AI を使っていない分析(${who})があるため、補正後の比較は省きます`);
  }
  const moved = common
    .map(({ c, p }) => ({ c, p, key: points(bothAi ? p.adjustedProb : p.prior, bothAi ? c.adjustedProb : c.prior) }))
    .filter((m) => Math.abs(m.key) >= DIFF_PROB_MIN_POINTS)
    .sort((a, b) => Math.abs(b.key) - Math.abs(a.key) || a.c.umaban - b.c.umaban);
  const shown = (key: "prior" | "adjustedProb", name: string, c: DiffHorse, p: DiffHorse): string =>
    `${name} ${formatPercent(p[key])} → ${formatPercent(c[key])}(${signed(points(p[key], c[key]))})`;
  for (const m of moved.slice(0, DIFF_PROB_ROW_LIMIT)) {
    const parts = bothAi ? [shown("adjustedProb", "補正後", m.c, m.p), shown("prior", "統計", m.c, m.p)] : [shown("prior", "統計", m.c, m.p)];
    changes.push(`3着内率 ${label(m.c)}: ${parts.join("・")}`);
  }
  if (moved.length > DIFF_PROB_ROW_LIMIT) changes.push(`3着内率 ほか ${moved.length - DIFF_PROB_ROW_LIMIT}頭`);

  return {
    previousId: previous.id,
    title: `前の分析(${jstMdHm(previous.analyzedAt)})との差`,
    lines: [...(changes.length === 0 ? [NO_CHANGE_LINE] : changes), ...notices],
  };
}
