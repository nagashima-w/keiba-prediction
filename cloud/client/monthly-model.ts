/**
 * 月報の画面(`#report=YYYYMM`。日報の画面の中の「月」)の表示用データ(Issue #265・#279。純関数)。`view.ts` がこれを VNode にする。状態(一覧・本文)を受け取り、
 * 文言・数値の整形だけを行う(DOM・fetch・時計に触れない)。数値の整形・券種別・印別・もしもの行は日報と同じ関数(`report-model.ts`)を通す。
 *
 * LLM の文章(総括・良かった点・改善点・来月に向けて。Issue #280)は、サーバが書いた文をそのまま出す(`textContent` に載せるだけ。HTML として解釈しない)。それ以外の文言(注記・案内・確認)はすべてクライアントの固定の文言。
 * 管理者だけの「この月の月報を作る」(終わった月で月報が無い月)と「月報を作り直す」(終わった月で月報がある月。確認つき)の出し分け・進行の案内も、ここで決める(日報の #235・#268 と同じ作り)。
 */
import type { MonthlyDayRow, MonthlyDetail, MonthlyFitSection, MonthlyJob, MonthlyListItem, MonthlyVersionRow } from "./api-monthly";
import { formatJstDateTime } from "./date";
import { dateLabel, JOB_UNAVAILABLE_NOTICE, MARK_HEADING, markRowsOf, refundText, statTiles, templateRows, typeRowsOf, WHATIF_HEADING, WHATIF_NOTE, ymd, type ReportModel, type ReportRegenState, type ReportRunState, type RowView, type TileView, type Tone } from "./report-model";
import { buildMonthlyHash, buildReportHash, REPORT_HASH } from "./route";
import { formatRecoveryPercent } from "../src/recovery-format";
import { formatYen } from "../../packages/core/src/view/verify-format";

/** 一覧(月の並び)の状態。 */
export type MonthlyListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly MonthlyListItem[] };

/**
 * 表示中の月の本文の状態。`report: null` は、その月の月報が無い。`job` は月報の DO の進行状況(管理者だけ。無ければ null/省略)、
 * `jobUnavailable` はその取得に失敗した(ジョブがあるか分からない。サーバの `job_status: "unavailable"`)。
 */
export type MonthlyDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly report: MonthlyDetail | null; readonly job?: MonthlyJob | null; readonly jobUnavailable?: boolean };

export interface MonthlyModelInput {
  /** 今日(JST、YYYYMMDD)。月報が無い月の案内(今月・先の月・過去の月)に使う。 */
  readonly today: string;
  /** 表示する月(YYYYMM)。 */
  readonly shownMonth: string;
  readonly list: MonthlyListState;
  /** 表示する月の本文。取得を始める前は null。 */
  readonly detail: MonthlyDetailState | null;
  /** 「この月の月報を作る」(Issue #280)の状態。省略は idle。日報の `ReportRunState` と同じ。 */
  readonly run?: ReportRunState;
  /** 「月報を作り直す」(Issue #280)の状態。省略は idle。日報の `ReportRegenState` と同じ。 */
  readonly regen?: ReportRegenState;
  /** 自動の更新(作成中の確認)を止めている。 */
  readonly pollStopped?: boolean;
  /** 作成中(running)を見て確認を続けている。進行状況を取れなかったときに、依頼していなくても固定の案内を出す。省略は false。 */
  readonly watching?: boolean;
  /** 閲覧者。作成・作り直しのボタンを出さない。省略は false(管理者)。 */
  readonly readOnly?: boolean;
}

/** 日ごとの行。`href` はその日の日報(`#report=YYYYMMDD`)。 */
export interface MonthlyDayRowView {
  readonly label: string;
  readonly href: string;
  readonly value: string;
}

export interface MonthlyBodyView {
  readonly heading: string;
  /** 作成時刻・レース数・開催日数・期間(+ 結果なし・判定不能)。 */
  readonly meta: string;
  readonly tiles: readonly TileView[];
  /** 数字の読み方の固定の注記(最終日の未確定〈あるとき〉・日報の合計との食い違い)。 */
  readonly notes: readonly string[];
  /** 文章が無い・生の文章を載せている旨の固定の説明。構造のある文章があるときは null。 */
  readonly textNote: string | null;
  /** LLM の総括。文章が無い・読めなかったときは null。 */
  readonly summary: string | null;
  readonly good: readonly string[];
  readonly improve: readonly string[];
  /** 来月に向けて。 */
  readonly outlook: readonly string[];
  /** 応答が構造として読めなかったときの生の文章(構造のある文章があるときは null)。 */
  readonly raw: string | null;
  readonly dayHeading: string;
  readonly dayRows: readonly MonthlyDayRowView[];
  readonly typeHeading: string;
  readonly typeRows: readonly RowView[];
  readonly markHeading: string;
  readonly markRows: readonly RowView[];
  /** 印の定型の買い方(もしも)。成績が無い月報は null。 */
  readonly whatIf: { readonly heading: string; readonly note: string; readonly rows: readonly RowView[] } | null;
  /** プロンプトの版ごと。版が 2 つ以上のときだけ(1 つの月は null)。 */
  readonly versions: { readonly heading: string; readonly rows: readonly RowView[]; readonly note: string } | null;
  /** 補正の当たり具合の節(Issue #509)。サーバが見出し・注・行の文面まで作ったものを、そのまま渡す。無い月報は空。 */
  readonly fit: readonly MonthlyFitSection[];
}

export interface MonthlyModel {
  readonly kind: "monthly";
  readonly backHref: "#";
  readonly heading: string;
  readonly loading: boolean;
  readonly refreshDisabled: boolean;
  /** 一覧・本文の取得の失敗(固定の文言)。 */
  readonly error: string | null;
  /** 日報と月報の切り替え(同じ画面の中の 2 つのタブ)。日は最新の日報、月は表示中の月。 */
  readonly tabs: { readonly dayHref: string; readonly monthHref: string };
  /** 前・次の月報(月報のある月)と、最新の月報へのリンク。無ければ null(最新は、表示中が最新のときも null)。 */
  readonly monthNav: { readonly prevHref: string | null; readonly nextHref: string | null; readonly latestHref: string | null };
  /** 表示している月の見出し(`2026年10月`)。 */
  readonly shownLabel: string;
  readonly notice: { readonly tone: Tone; readonly text: string } | null;
  /**
   * 「この月の月報を作る」(Issue #280)。管理者の、終わった月で月報が無く、作成中でもない月だけ(閲覧者・今月と先の月・月報がある月は null)。`caution` は常に出す注意。
   * 型は日報の `create` と同じ(`todayCaution` は月報では常に null)。
   */
  readonly create: ReportModel["create"];
  /** 「月報を作り直す」(Issue #280)。管理者の、終わった月で月報がある月だけ(作り直し中は null)。`confirm` があるときは、ボタンの代わりに確認を出す。型は日報の `regen` と同じ。 */
  readonly regen: ReportModel["regen"];
  readonly body: MonthlyBodyView | null;
}

/** `202610` → `2026年10月`。形が違えばそのまま。 */
export function monthLabel(month: string): string {
  const m = /^(\d{4})(\d{2})$/.exec(month);
  return m === null ? month : `${Number(m[1])}年${Number(m[2])}月`;
}

/** 固定の注記。 */
export const MONTHLY_DISCREPANCY_NOTE =
  "月の数字は、作成した時点の分析と結果から数え直したものです。日報の合計と一致しないことがあります(日報は作成後に取り込まれた結果を反映しないため)。";
export const MONTHLY_LAST_DAY_PENDING_NOTE =
  "最終日の結果または日報がそろう前に作ったため、最終日の分は一部が反映されていない場合があります。";
export const MONTHLY_NO_TEXT_NOTE = "LLM の振り返りの文章はありません(統計だけの月報です)。";
export const MONTHLY_RAW_NOTE = "LLM の応答を構造として読めなかったため、生の文章を載せています。";
/** 手動の作成の注意(固定文言)。費用・Discord に送らないこと・作ったあとの作り直し・回数の上限。 */
export const MONTHLY_CREATE_CAUTION = "押した時点の分析と結果で月報を作ります(LLM を呼ぶため API の費用がかかります)。Discord には送りません。作ったあとも「月報を作り直す」で作り直せます(1 日の回数に上限があります)。";
/** 作り直しの確認の文面(固定文言)。費用・置き換え(元に戻せない)・回数の上限(日報とは別の枠)・Discord に送らないこと。 */
export const MONTHLY_REGEN_CONFIRM_TEXT =
  "いまの分析と結果でこの月の月報を作り直し、いまの月報を置き換えます(元に戻せません)。LLM を呼ぶため API の費用がかかり、1 日の回数に上限があります(月報の枠で、日報の作り直しとは別です)。Discord には送りません。";
export const MONTHLY_REGEN_REQUESTED_NOTICE = "月報の作り直しを依頼しました。しばらくすると新しい月報に替わります(この画面は自動で更新します)。";
export const MONTHLY_REGEN_DONE_NOTICE = "月報を作り直しました。";
/** 作り直しが失敗したとき(LLM が使えず、文章のある前の月報を残した場合を含む)。 */
export const MONTHLY_REGEN_FAILED_NOTICE = "月報の作り直しに失敗しました。前の月報のままです(LLM の文章を作れなかった場合は、文章のある前の月報を残します)。";
export const MONTHLY_CREATING_NOTICE = "月報を作成中です。しばらくすると表示されます(この画面は自動で更新します)。";
export const MONTHLY_CREATE_REQUESTED_NOTICE = "月報の作成を依頼しました。しばらくすると表示されます(この画面は自動で更新します)。";
export const MONTHLY_NO_REPORT_NOTICE = "この月は分析したレースが無いため、月報は作られませんでした。";
export const MONTHLY_CREATE_FAILED_NOTICE = "月報の作成に失敗しました。もう一度作成を依頼できます。";
const POLL_STOPPED_NOTICE = "作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。";
export const MONTHLY_VERSION_NOTE = "版ごとの件数は少なく、回収率の差は偶然の範囲のことが多いです。版の優劣を決める材料にはしないでください。";

/** 日ごと・版ごとに共通の「回収率・的中・賭け金・払戻」の文。 */
function resultText(r: { readonly totalStake: number; readonly totalReturn: number; readonly recoveryRate: number | null; readonly judgedBetCount: number; readonly hitBetCount: number }, refund: number | undefined): string {
  const rate = r.recoveryRate === null ? "-" : formatRecoveryPercent(r.recoveryRate);
  return `回収率 ${rate}・${r.judgedBetCount} 点中 ${r.hitBetCount} 点的中${refundText(refund)}・賭け金 ${formatYen(r.totalStake)}・払戻 ${formatYen(r.totalReturn)}`;
}

function dayRowOf(d: MonthlyDayRow): MonthlyDayRowView {
  const races = `${d.raceCount} レース${d.noResultRaceCount > 0 ? `(結果なし ${d.noResultRaceCount})` : ""}`;
  return { label: dateLabel(d.date), href: buildReportHash(d.date), value: `${races}・${resultText(d, d.refundedBetCount)}` };
}

function versionRowOf(v: MonthlyVersionRow): RowView {
  return { label: v.promptVersion ?? "版不明", value: `${v.raceCount} レース・${resultText(v, undefined)}` };
}

function bodyOf(report: MonthlyDetail): MonthlyBodyView {
  const s = report.stats;
  const metaParts = [`作成 ${formatJstDateTime(report.createdAt)}`, `${report.raceCount} レース`, `開催 ${s.dayCount} 日`, `${ymd(s.fromDate)}〜${ymd(s.toDate)}`, report.model === null ? "LLM の文章なし" : `モデル ${report.model}`];
  if (s.noResultRaceCount > 0) metaParts.push(`結果なし ${s.noResultRaceCount} レース`);
  if (s.unjudgedBetCount > 0) metaParts.push(`判定不能の買い目 ${s.unjudgedBetCount} 点(賭け金 ${formatYen(s.unjudgedStake)}。成績に含めません)`);
  const whatIf = s.whatIf === null || s.whatIf === undefined ? null : { heading: WHATIF_HEADING, note: WHATIF_NOTE, rows: templateRows(s.whatIf) };
  return {
    heading: `${monthLabel(report.month)}の月報`,
    meta: metaParts.join("・"),
    tiles: statTiles(s),
    notes: [...(report.lastDayPending ? [MONTHLY_LAST_DAY_PENDING_NOTE] : []), MONTHLY_DISCREPANCY_NOTE],
    textNote: report.narrative !== null ? null : report.narrativeRaw !== null ? MONTHLY_RAW_NOTE : MONTHLY_NO_TEXT_NOTE,
    summary: report.narrative?.summary ?? null,
    good: report.narrative?.good ?? [],
    improve: report.narrative?.improve ?? [],
    outlook: report.narrative?.outlook ?? [],
    raw: report.narrative === null ? report.narrativeRaw : null,
    dayHeading: "開催日ごと(日付から日報を開けます)",
    dayRows: s.days.map(dayRowOf),
    typeHeading: "券種別の成績",
    typeRows: typeRowsOf(s.byBetType),
    markHeading: MARK_HEADING,
    markRows: markRowsOf(s.byMark),
    whatIf,
    fit: report.fit ?? [],
    versions: s.byVersion.length >= 2 ? { heading: "プロンプトの版ごと", rows: s.byVersion.map(versionRowOf), note: MONTHLY_VERSION_NOTE } : null,
  };
}

/** 前・次の月報(一覧の月のうち、表示中の月の直前・直後)と最新。表示中の月が一覧に無くても、その月を基準にする。一覧が読み込み中・失敗のときは全部 null。 */
function monthNavOf(input: MonthlyModelInput): MonthlyModel["monthNav"] {
  if (input.list.kind !== "ready") return { prevHref: null, nextHref: null, latestHref: null };
  let prev: string | null = null;
  let next: string | null = null;
  let latest: string | null = null;
  for (const { month } of input.list.items) {
    if (month < input.shownMonth && (prev === null || month > prev)) prev = month;
    if (month > input.shownMonth && (next === null || month < next)) next = month;
    if (latest === null || month > latest) latest = month;
  }
  return {
    prevHref: prev === null ? null : buildMonthlyHash(prev),
    nextHref: next === null ? null : buildMonthlyHash(next),
    latestHref: latest === null || latest === input.shownMonth ? null : buildMonthlyHash(latest),
  };
}

/** 月報が無い月の案内(固定の文言)。今月・先の月・過去の月で分ける。 */
function missingNotice(shownMonth: string, today: string): string {
  const thisMonth = today.slice(0, 6);
  if (shownMonth > thisMonth) return "まだ先の月です。月報は、月の最終日の夜に作られます。";
  if (shownMonth === thisMonth) return "今月の月報は、月の最終日の夜(22 時ごろ)に自動で作られます。";
  return "この月の月報はまだありません。月の最終日の夜に自動で作られます(分析したレースが無い月は作られません)。作成中のときは、しばらくしてから「更新」を押してください。";
}

export function buildMonthlyModel(input: MonthlyModelInput): MonthlyModel {
  const { list, detail } = input;
  const run = input.run ?? { kind: "idle" };
  const regenState = input.regen ?? { kind: "idle" };
  const readOnly = input.readOnly === true;
  const loading = list.kind === "loading" || detail === null || detail.kind === "loading";
  let error: string | null = null;
  if (list.kind === "error") error = list.message;
  else if (detail !== null && detail.kind === "error") error = detail.message;
  // 手動の作成・作り直しは終わった月だけ(今月の月報は最終日の夜の自動作成でだけ作る。サーバも断る)。
  const ended = input.shownMonth < input.today.slice(0, 6);

  let body: MonthlyBodyView | null = null;
  let notice: MonthlyModel["notice"] = null;
  let create: MonthlyModel["create"] = null;
  let regen: MonthlyModel["regen"] = null;
  if (detail !== null && detail.kind === "ready") {
    const job = detail.job ?? null;
    if (detail.report !== null) {
      body = bodyOf(detail.report);
      // 作り直し(job.regenerate)の進行・失敗。作り直しではないジョブ(通常の作成)は、月報がある月の表示に影響しない。
      const running = regenState.kind === "requested" || (job !== null && job.regenerate === true && job.status === "running");
      if (running) {
        notice = { tone: "wait", text: regenState.kind === "requested" && detail.jobUnavailable === true ? JOB_UNAVAILABLE_NOTICE : MONTHLY_REGEN_REQUESTED_NOTICE };
      } else if (regenState.kind === "done") {
        notice = { tone: "ok", text: MONTHLY_REGEN_DONE_NOTICE };
      } else if (regenState.kind === "error") {
        notice = { tone: "error", text: regenState.message };
      } else if (regenState.kind !== "posting" && job !== null && job.regenerate === true && job.status === "failed") {
        notice = { tone: "error", text: MONTHLY_REGEN_FAILED_NOTICE };
      }
      if (!readOnly && ended && !running) {
        regen = {
          label: regenState.kind === "posting" ? "依頼中…" : "月報を作り直す",
          disabled: regenState.kind === "posting",
          confirm: regenState.kind === "confirm" ? { text: MONTHLY_REGEN_CONFIRM_TEXT, goLabel: "作り直す", cancelLabel: "やめる" } : null,
        };
      }
    } else if (job !== null && job.status === "running") {
      notice = { tone: "wait", text: MONTHLY_CREATING_NOTICE };
    } else if (run.kind === "requested" || (input.watching === true && detail.jobUnavailable === true)) {
      notice = { tone: "wait", text: detail.jobUnavailable === true ? JOB_UNAVAILABLE_NOTICE : MONTHLY_CREATE_REQUESTED_NOTICE };
    } else if (run.kind === "no-report") {
      notice = { tone: "info", text: MONTHLY_NO_REPORT_NOTICE };
    } else {
      notice = job !== null && job.status === "failed" ? { tone: "error", text: MONTHLY_CREATE_FAILED_NOTICE } : { tone: "info", text: missingNotice(input.shownMonth, input.today) };
      if (!readOnly && ended) {
        create = { label: run.kind === "posting" ? "依頼中…" : "この月の月報を作る", disabled: run.kind === "posting", caution: MONTHLY_CREATE_CAUTION, todayCaution: null };
      }
    }
  }
  if (run.kind === "error") {
    notice = { tone: "error", text: run.message };
  }
  if (input.pollStopped === true && notice !== null && notice.tone === "wait") {
    notice = { tone: "wait", text: POLL_STOPPED_NOTICE };
  }
  return {
    kind: "monthly",
    backHref: "#",
    heading: "月報",
    loading,
    refreshDisabled: loading || run.kind === "posting" || regenState.kind === "posting",
    error,
    tabs: { dayHref: REPORT_HASH, monthHref: buildMonthlyHash(input.shownMonth) },
    monthNav: monthNavOf(input),
    shownLabel: monthLabel(input.shownMonth),
    notice,
    create,
    regen,
    body,
  };
}
