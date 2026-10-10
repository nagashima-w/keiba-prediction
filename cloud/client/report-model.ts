/**
 * 日報画面(`#report`・`#report=YYYYMMDD`)の表示用データ(Issue #235。純関数)。`view.ts` がこれを VNode にする。状態(一覧・本文・作成の依頼の状態)を受け取り、
 * 文言・数値の整形だけを行う(DOM・fetch・時計に触れない)。数値の整形は検証画面と同じ(`verify-format.ts`)。
 *
 * **サーバ由来の「文」は、LLM が書いた文章(総括・良かった点・改善点・レースごとの一言・生の文章)だけ**を、そのまま(テキストとして)出す。それ以外の文言
 * (文章が無い理由・状態の説明)はすべてクライアントの固定の文言(サーバの `note` は読まない)。
 */
import type { ReportDetail, ReportJob, ReportListItem, ReportRace } from "./api-report";
import { formatJstDateTime } from "./date";
import { buildReportHash } from "./route";
import { formatRate, formatYen, PROPOSED_BET_LABELS } from "./verify-format";

/** 一覧(日付の並び)の状態。 */
export type ReportListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly ReportListItem[] };

/** 表示中の日の本文の状態。 */
export type ReportDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly report: ReportDetail | null; readonly job: ReportJob | null };

/** 「この日の日報を作る」の状態。`requested`: 依頼を受け付けた(作成中の表示に切り替わるまでの間)。 */
export type ReportRunState =
  | { readonly kind: "idle" }
  | { readonly kind: "posting" }
  | { readonly kind: "requested" }
  | { readonly kind: "error"; readonly message: string };

export interface ReportModelInput {
  /** 今日(JST、YYYYMMDD)。日報がまだ 1 件も無いとき、表示する日になる。 */
  readonly today: string;
  /** 表示する日(YYYYMMDD)。 */
  readonly shownDate: string;
  readonly list: ReportListState;
  /** 表示する日の本文。取得を始める前は null。 */
  readonly detail: ReportDetailState | null;
  readonly run: ReportRunState;
  /** 自動の更新(作成中の確認)を止めている。 */
  readonly pollStopped: boolean;
}

export type Tone = "info" | "ok" | "error" | "wait";

export interface DateChip {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface TileView {
  readonly label: string;
  readonly value: string;
  readonly strong: boolean;
}

export interface RowView {
  readonly label: string;
  readonly value: string;
}

export interface RaceRowView {
  readonly raceId: string;
  readonly title: string;
  /** 着順(`1着 7番 馬名 / …`)または結果なし。 */
  readonly result: string;
  /** 印の付いた馬と着順。印が無ければ null。 */
  readonly marks: string | null;
  /** 買い目の成績(判定できたもの)。買い目が無ければその旨。 */
  readonly bets: string;
  /** LLM のレース別の一言。 */
  readonly comment: string | null;
}

export interface ReportBodyView {
  readonly heading: string;
  /** 作成時刻・モデル・レース数。 */
  readonly meta: string;
  readonly tiles: readonly TileView[];
  /** 文章が無い・生の文章のときの固定の説明。 */
  readonly textNote: string | null;
  /** LLM の総括。 */
  readonly summary: string | null;
  readonly good: readonly string[];
  readonly improve: readonly string[];
  /** 構造として読めなかった生の文章。 */
  readonly raw: string | null;
  readonly typeHeading: string;
  readonly typeRows: readonly RowView[];
  readonly markHeading: string;
  readonly markRows: readonly RowView[];
  readonly racesHeading: string;
  readonly races: readonly RaceRowView[];
}

export interface ReportModel {
  readonly kind: "report";
  readonly backHref: "#";
  readonly heading: string;
  readonly loading: boolean;
  readonly refreshDisabled: boolean;
  /** 一覧・本文の取得の失敗(固定の文言)。 */
  readonly error: string | null;
  readonly dateChips: readonly DateChip[];
  /** 表示している日の見出し(`2026年10月10日(土)`)。 */
  readonly shownLabel: string;
  readonly notice: { readonly tone: Tone; readonly text: string } | null;
  /** 「この日の日報を作る」。日報が無く、作成中でもない日だけ出す。 */
  readonly create: { readonly label: string; readonly disabled: boolean } | null;
  readonly body: ReportBodyView | null;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** `20261010` → `2026年10月10日(土)`。形が違えばそのまま。 */
export function dateLabel(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (m === null) return ymd;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return `${y}年${mo}月${d}日(${WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]!})`;
}

/** 日付の並び(今日 → 日報のある日の新しい順)。表示中の日が並びに無くても(古い日・日報が無い日)先頭側に足す。最大 {@link MAX_CHIPS} 個。 */
export const MAX_CHIPS = 14;

function chipsOf(input: ReportModelInput): DateChip[] {
  const dates: string[] = [input.today];
  if (input.list.kind === "ready") {
    for (const item of input.list.items) if (!dates.includes(item.date)) dates.push(item.date);
  }
  const limited = dates.slice(0, MAX_CHIPS);
  if (!limited.includes(input.shownDate)) limited.push(input.shownDate);
  return limited.map((date) => ({ label: date === input.today ? `今日 ${date.slice(4, 6)}/${date.slice(6, 8)}` : `${date.slice(4, 6)}/${date.slice(6, 8)}`, href: buildReportHash(date), current: date === input.shownDate }));
}

function horseText(umaban: number, name: string | null): string {
  return name === null ? `${umaban}番` : `${umaban}番 ${name}`;
}

function raceRow(r: ReportRace): RaceRowView {
  const result = r.hasResult ? (r.top3.length === 0 ? "着順の記録なし" : r.top3.map((t) => `${t.finishPosition}着 ${horseText(t.umaban, t.name)}`).join(" / ")) : "結果なし(未取得・中止などで取り込めていません)";
  const marks = r.marks.length === 0 ? null : r.marks.map((m) => `${m.mark} ${horseText(m.umaban, m.name)}${m.finishPosition === null ? "" : ` → ${m.finishPosition}着`}`).join(" / ");
  let bets: string;
  if (r.judgedBetCount === 0 && r.unjudgedBetCount === 0) {
    bets = r.allocationNote ?? "買い目なし";
  } else {
    const parts: string[] = [];
    if (r.judgedBetCount > 0) parts.push(`${r.judgedBetCount} 点中 ${r.hitCount} 点的中・賭け金 ${formatYen(r.totalStake)}・払戻 ${formatYen(r.totalReturn)}`);
    if (r.unjudgedBetCount > 0) parts.push(`判定不能 ${r.unjudgedBetCount} 点`);
    bets = `買い目: ${parts.join("・")}`;
  }
  return { raceId: r.raceId, title: r.title, result, marks, bets, comment: r.comment };
}

function bodyOf(report: ReportDetail): ReportBodyView {
  const s = report.stats;
  const tiles: TileView[] = [
    { label: "賭け金", value: formatYen(s.totalStake), strong: false },
    { label: "払戻", value: formatYen(s.totalReturn), strong: false },
    { label: "回収率", value: formatRate(s.recoveryRate), strong: true },
    { label: "的中", value: `${s.judgedBetCount} 点中 ${s.hitBetCount} 点`, strong: false },
  ];
  const typeRows: RowView[] = PROPOSED_BET_LABELS.filter(({ type }) => s.byBetType[type] !== undefined).map(({ type, label }) => {
    const t = s.byBetType[type]!;
    return { label, value: `${t.betCount} 点中 ${t.hitCount} 点的中・賭け金 ${formatYen(t.stake)}・払戻 ${formatYen(t.payout)}` };
  });
  // 券種名が既知のラベルに無いもの(将来の券種)は、キーのまま末尾に出す(黙って落とさない)。
  const known = new Set(PROPOSED_BET_LABELS.map((l) => l.type as string));
  for (const [type, t] of Object.entries(s.byBetType)) {
    if (!known.has(type)) typeRows.push({ label: type, value: `${t.betCount} 点中 ${t.hitCount} 点的中・賭け金 ${formatYen(t.stake)}・払戻 ${formatYen(t.payout)}` });
  }
  const metaParts = [`作成 ${formatJstDateTime(report.createdAt)}`, `${report.raceCount} レース`, report.model === null ? "LLM の文章なし" : `モデル ${report.model}`];
  if (s.noResultRaceCount > 0) metaParts.push(`結果なし ${s.noResultRaceCount} レース`);
  if (s.unjudgedBetCount > 0) metaParts.push(`判定不能の買い目 ${s.unjudgedBetCount} 点(賭け金 ${formatYen(s.unjudgedStake)}。成績に含めません)`);
  return {
    heading: `${dateLabel(report.date)}の日報`,
    meta: metaParts.join("・"),
    tiles,
    textNote:
      report.narrative !== null
        ? null
        : report.narrativeRaw !== null
          ? "LLM の応答を構造として読めなかったため、生の文章を載せています。"
          : "LLM の文章はありません(キーが未登録、または LLM を使えなかったため、統計だけの日報です)。",
    summary: report.narrative?.summary ?? null,
    good: report.narrative?.good ?? [],
    improve: report.narrative?.improve ?? [],
    raw: report.narrative === null ? report.narrativeRaw : null,
    typeHeading: "券種別の成績",
    typeRows,
    markHeading: "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)",
    markRows: s.byMark.map((m) => ({ label: m.mark, value: `${m.count} 頭 / ${m.win} / ${m.top3}` })),
    racesHeading: "レースごと",
    races: report.races.map(raceRow),
  };
}

export function buildReportModel(input: ReportModelInput): ReportModel {
  const { list, detail, run } = input;
  const base = {
    kind: "report" as const,
    backHref: "#" as const,
    heading: "日報",
    dateChips: chipsOf(input),
    shownLabel: dateLabel(input.shownDate),
  };
  const loading = list.kind === "loading" || detail === null || detail.kind === "loading";
  const refreshDisabled = loading || run.kind === "posting";
  let error: string | null = null;
  if (list.kind === "error") error = list.message;
  else if (detail !== null && detail.kind === "error") error = detail.message;

  let body: ReportBodyView | null = null;
  let notice: ReportModel["notice"] = null;
  let create: ReportModel["create"] = null;
  if (detail !== null && detail.kind === "ready") {
    if (detail.report !== null) {
      body = bodyOf(detail.report);
    } else if (detail.job !== null && detail.job.status === "running") {
      notice = { tone: "wait", text: "日報を作成中です。しばらくすると表示されます(この画面は自動で更新します)。" };
    } else if (run.kind === "requested") {
      notice = { tone: "wait", text: "日報の作成を依頼しました。しばらくすると表示されます(この画面は自動で更新します)。" };
    } else {
      if (detail.job !== null && detail.job.status === "failed") {
        notice = { tone: "error", text: "日報の作成に失敗しました。もう一度作成を依頼できます。" };
      } else {
        notice = { tone: "info", text: "この日の日報はまだありません。その日の分析と結果が揃うと自動で作られます。すぐに作るときは、下のボタンで依頼できます。" };
      }
      create = { label: run.kind === "posting" ? "依頼中…" : "この日の日報を作る", disabled: run.kind === "posting" };
    }
  }
  if (run.kind === "error") {
    notice = { tone: "error", text: run.message };
  }
  if (input.pollStopped && notice !== null && notice.tone === "wait") {
    notice = { tone: "wait", text: "作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。" };
  }
  return { ...base, loading, refreshDisabled, error, notice, create, body };
}
