/**
 * 日報画面(`#report`・`#report=YYYYMMDD`)の表示用データ(Issue #235。純関数)。`view.ts` がこれを VNode にする。状態(一覧・本文・作成の依頼の状態)を受け取り、
 * 文言・数値の整形だけを行う(DOM・fetch・時計に触れない)。数値の整形は検証画面と同じ(`verify-format.ts`)。
 *
 * **サーバ由来の「文」は、LLM が書いた文章(総括・良かった点・改善点・レースごとの一言・生の文章)だけ**を、そのまま(テキストとして)出す。それ以外の文言
 * (文章が無い理由・状態の説明)はすべてクライアントの固定の文言(サーバの `note` は読まない)。
 */
import type { ReportDetail, ReportJob, ReportListItem, ReportRace, ReportStats, ReportTemplateStat } from "./api-report";
import { formatJstDateTime, ymdToInput } from "./date";
import { buildReportHash } from "./route";
import { formatExpectedHits } from "../src/expected-format";
import { formatRecoveryPercent } from "../src/recovery-format";
import { formatTemplateStat, TEMPLATE_LABELS, templateLabel } from "../src/whatif-format";
import { formatYen, PROPOSED_BET_LABELS } from "./verify-format";

/** 一覧(日付の並び)の状態。 */
export type ReportListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly ReportListItem[] };

/** 表示中の日の本文の状態。 */
export type ReportDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  /** `jobUnavailable`(Issue #245): 日報の進行状況を**取得できなかった**(`job` が null なのは「ジョブが無い」のではなく「分からない」)。省略は false。 */
  | { readonly kind: "ready"; readonly report: ReportDetail | null; readonly job: ReportJob | null; readonly jobUnavailable?: boolean };

/**
 * 「この日の日報を作る」の状態。`requested`: 依頼を受け付けた(作成中の表示に切り替わるまでの間)。
 * `no-report`: 依頼は受け付けられたが、日報は作られずに終わった(サーバの進行状況が無く、日報も無い = その日の分析が無い)。
 */
export type ReportRunState =
  | { readonly kind: "idle" }
  | { readonly kind: "posting" }
  | { readonly kind: "requested" }
  | { readonly kind: "no-report" }
  | { readonly kind: "error"; readonly message: string };

/**
 * 「日報を作り直す」(Issue #268。日報がある日の管理者だけ)の状態。`confirm`: 確認の段階を開いている(押しても、ここで実行を選ぶまで依頼は出ない)。`posting`: 依頼中。
 * `requested`: 依頼を受け付けた(`since` は依頼の時点の日報の作成時刻。これが変われば作り直しが済んだ)。`done`: 新しい日報に替わった。`error`: 断られた・失敗した(固定の文言)。
 */
export type ReportRegenState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirm" }
  | { readonly kind: "posting" }
  | { readonly kind: "requested"; readonly since: string }
  | { readonly kind: "done" }
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
  /** 作り直し(Issue #268)の状態。省略は idle。 */
  readonly regen?: ReportRegenState;
  /** 自動の更新(作成中の確認)を止めている。 */
  readonly pollStopped: boolean;
  /** 作成中(running)を見て確認を続けている(Issue #246)。進行状況を取れなかった(`jobUnavailable`)ときに、依頼していなくても固定の案内を出す。省略は false。 */
  readonly watching?: boolean;
  /** 閲覧者(Issue #238)。作成のボタンと、ボタンに言及する案内を出さない。省略は false(管理者)。 */
  readonly readOnly?: boolean;
}

export type Tone = "info" | "ok" | "error" | "wait";

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

/** 直近 28 日の累計の節(Issue #264)。 */
export interface RollingView {
  readonly heading: string;
  /** 期間・開催日数・レース数。 */
  readonly meta: string;
  readonly tiles: readonly TileView[];
}

/** 印の定型の買い方(もしも)の節(Issue #272)。 */
export interface WhatIfView {
  readonly heading: string;
  readonly note: string;
  /** その日・直近 28 日の累計。 */
  readonly groups: readonly { readonly title: string; readonly rows: readonly RowView[] }[];
  /** 惜しかったレース。この項目を持たない日報では null。 */
  readonly near: { readonly heading: string; readonly items: readonly string[]; readonly empty: string | null } | null;
}

export interface ReportBodyView {
  readonly heading: string;
  /** 作成時刻・モデル・レース数。 */
  readonly meta: string;
  readonly tiles: readonly TileView[];
  /** 直近 28 日の累計(Issue #264)。この項目を持つ前の日報では null。 */
  readonly rolling: RollingView | null;
  /** 印の定型の買い方(Issue #272)。この項目を持つ前の日報・旧形のジョブで作った日報では null。 */
  readonly whatIf: WhatIfView | null;
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
  /** 日付の入力(`<input type="date">`)の値(YYYY-MM-DD)。表示中の日(Issue #273)。 */
  readonly dateInput: string;
  /** 前・今日・次のリンク(`#report=YYYYMMDD`)。前後は日報のある日で、無ければ null。今日は常にある(管理者が今日の日報を作る入口)。 */
  readonly dateNav: { readonly prevHref: string | null; readonly todayHref: string; readonly nextHref: string | null };
  /** 表示している日の見出し(`2026年10月10日(土)`)。 */
  readonly shownLabel: string;
  readonly notice: { readonly tone: Tone; readonly text: string } | null;
  /**
   * 「この日の日報を作る」。日報が無く、作成中でもない日だけ出す。`caution` は常に出す注意(押した時点の分析と結果で作る。作ったあとの作り直しは管理者の「日報を作り直す」)。
   * `todayCaution` は表示中の日が今日のときだけ(まだ自動の作成条件を満たしていない可能性があるため、強めの注意)。
   */
  readonly create: { readonly label: string; readonly disabled: boolean; readonly caution: string; readonly todayCaution: string | null } | null;
  /**
   * 「日報を作り直す」(Issue #268)。日報がある日の**管理者**だけ(閲覧者・日報の無い日・作り直し中は null)。`confirm` があるときは、ボタンの代わりに確認(文面・実行・やめる)を出す。
   * 実行を選ぶまでは依頼を出さない(LLM の費用が発生し、いまの日報を置き換えるため)。
   */
  readonly regen: { readonly label: string; readonly disabled: boolean; readonly confirm: { readonly text: string; readonly goLabel: string; readonly cancelLabel: string } | null } | null;
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

/** 手動の作成の注意(固定文言)。作ったあとは、管理者が「日報を作り直す」で作り直せる(Issue #268。回数に上限がある)。 */
export const CREATE_CAUTION = "押した時点の分析と結果で日報を作ります。作ったあとも「日報を作り直す」で作り直せます(1 日の回数に上限があります)。";
/** 今日の日付のときの強めの注意(固定文言)。 */
export const CREATE_TODAY_CAUTION =
  "今日の日報は、まだ分析していないレース(夜の地方など)や、結果の取り込みが終わっていないレースがあるうちに押すと、それらを含まないまま作られます。通常は、その日の分析と結果が揃うと自動で作られるので、急がなければ待ってください。";
/** 作り直しの確認の文面(Issue #268。固定文言)。費用・置き換え(元に戻せない)・回数の上限・Discord に送らないこと。 */
export const REGEN_CONFIRM_TEXT =
  "いまの分析と結果でこの日の日報を作り直し、いまの日報を置き換えます(元に戻せません)。LLM を呼ぶため API の費用がかかり、1 日の回数に上限があります。Discord には送りません。";
export const REGEN_REQUESTED_NOTICE = "日報の作り直しを依頼しました。しばらくすると新しい日報に替わります(この画面は自動で更新します)。";
export const REGEN_DONE_NOTICE = "日報を作り直しました。";
export const REGEN_FAILED_NOTICE = "日報の作り直しに失敗しました。前の日報のままです。";
export const REGEN_LIMIT_MESSAGE = "今日の作り直しの上限に達しました。日付が変わってから(日本時間)もう一度押してください。";
/** 依頼したが日報が作られずに終わったときの固定文言。 */
export const NO_REPORT_NOTICE = "この日は分析したレースが無いため、日報は作られませんでした。";

/**
 * 日報の進行状況を取得できなかったとき(Issue #245)。「作られなかった」と断定せず、確認を続けることを伝える固定の文言。
 * 出るのは次の 2 つの場合(Issue #246): (1) 作成を依頼したあと(`run` が `requested`)、(2) 作成中(running)を見て確認を続けている途中(`watching`。依頼はしていない)。
 * どちらでも、進行状況を取得できなかった(`jobUnavailable`)応答のときだけ出る。
 */
export const JOB_UNAVAILABLE_NOTICE = "作成の状況を確認できませんでした。確認を続けます(この画面は自動で更新します)。";

/**
 * 前・今日・次のリンク(Issue #273)。前後は、一覧(`GET /api/reports`。サーバが返す上限は 60 件)の日付のうち、表示中の日の直前・直後の日報の日。
 * 表示中の日が一覧に無くても(日報の無い日・一覧より古い日)その日を基準にする。一覧が読み込み中・失敗のときは前後なし。
 * **限界**: 一覧は新しい 60 件までなので、表示中の日が一覧の最古以前だと「前」は出ない(実際には前の日報があっても)。日付の入力からは届く。
 */
function dateNavOf(input: ReportModelInput): ReportModel["dateNav"] {
  let prev: string | null = null;
  let next: string | null = null;
  if (input.list.kind === "ready") {
    for (const { date } of input.list.items) {
      if (date < input.shownDate && (prev === null || date > prev)) prev = date;
      if (date > input.shownDate && (next === null || date < next)) next = date;
    }
  }
  return { prevHref: prev === null ? null : buildReportHash(prev), todayHref: buildReportHash(input.today), nextHref: next === null ? null : buildReportHash(next) };
}

function horseText(umaban: number, name: string | null): string {
  return name === null ? `${umaban}番` : `${umaban}番 ${name}`;
}

/** 返還(取消・除外の馬への買い目。Issue #278)の内訳。点数が無い(この項目を持つ前の日報)・0 点なら添えない。 */
const refundText = (count: number | undefined): string => (count !== undefined && count > 0 ? `(うち返還 ${count} 点)` : "");

/** そのレースの実際の買い目の概要(レースごとの行と、惜しかったレースが使う)。 */
function betsText(r: ReportRace): string {
  if (r.judgedBetCount === 0 && r.unjudgedBetCount === 0) {
    return r.allocationNote ?? "買い目なし";
  }
  const parts: string[] = [];
  if (r.judgedBetCount > 0) parts.push(`${r.judgedBetCount} 点中 ${r.hitCount} 点的中${refundText(r.refundedBetCount)}・賭け金 ${formatYen(r.totalStake)}・払戻 ${formatYen(r.totalReturn)}`);
  if (r.unjudgedBetCount > 0) parts.push(`判定不能 ${r.unjudgedBetCount} 点`);
  return `買い目: ${parts.join("・")}`;
}

function raceRow(r: ReportRace): RaceRowView {
  const result = r.hasResult ? (r.top3.length === 0 ? "着順の記録なし" : r.top3.map((t) => `${t.finishPosition}着 ${horseText(t.umaban, t.name)}`).join(" / ")) : "結果なし(未取得・中止などで取り込めていません)";
  const marks = r.marks.length === 0 ? null : r.marks.map((m) => `${m.mark} ${horseText(m.umaban, m.name)}${m.finishPosition === null ? "" : ` → ${m.finishPosition}着`}`).join(" / ");
  return { raceId: r.raceId, title: r.title, result, marks, bets: betsText(r), comment: r.comment };
}

/** 賭け金・払戻・回収率・的中(+ 見込みと実際)のタイル。その日と累計で同じ書き方。見込みは、この項目を持つ日報で、確率のある買い目があるときだけ。 */
function statTiles(s: ReportStats): TileView[] {
  const tiles: TileView[] = [
    { label: "賭け金", value: formatYen(s.totalStake), strong: false },
    { label: "払戻", value: formatYen(s.totalReturn), strong: false },
    { label: "回収率", value: s.recoveryRate === null ? "-" : formatRecoveryPercent(s.recoveryRate), strong: true },
    { label: "的中", value: `${s.judgedBetCount} 点中 ${s.hitBetCount} 点${refundText(s.refundedBetCount)}`, strong: false },
  ];
  const expected = formatExpectedHits(s); // 項目が欠けた(この項目を持つ前の)日報では null
  if (expected !== null) tiles.push({ label: "見込みと実際", value: expected, strong: false });
  return tiles;
}

const ymd = (d: string): string => `${Number(d.slice(0, 4))}年${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日`;

function rollingOf(report: ReportDetail): RollingView | null {
  const t = report.rolling?.total;
  return t === undefined
    ? null
    : { heading: "直近 28 日の累計(その日を含む)", meta: `${ymd(t.fromDate)}〜${ymd(t.toDate)}・開催 ${t.dayCount} 日・${t.raceCount} レース`, tiles: statTiles(t) };
}

/** 型ごとの行(決まった順。未知の id は id のまま末尾)。 */
function templateRows(w: Readonly<Record<string, ReportTemplateStat>>): RowView[] {
  const known = new Set(TEMPLATE_LABELS.map(([id]) => id));
  return [...TEMPLATE_LABELS.map(([id]) => id), ...Object.keys(w).filter((id) => !known.has(id))]
    .filter((id) => w[id] !== undefined)
    .map((id) => ({ label: templateLabel(id), value: formatTemplateStat(w[id]!, formatYen) }));
}

function whatIfOf(report: ReportDetail): WhatIfView | null {
  const day = report.stats.whatIf;
  if (day === null || day === undefined) return null;
  const groups = [{ title: "その日", rows: templateRows(day) }];
  const total = report.rolling?.total.whatIf;
  if (total !== null && total !== undefined) groups.push({ title: "直近 28 日の累計(その日を含む)", rows: templateRows(total) });
  const nm = report.nearMisses;
  const near =
    nm === undefined
      ? null
      : {
          heading: `惜しかったレース(全 ${nm.total} 件${nm.total > nm.shown.length ? `のうち、払戻の多い順に ${nm.shown.length} 件` : ""})`,
          items: nm.shown.map((n) => {
            const race = report.races.find((r) => r.raceId === n.raceId);
            return `${race?.title ?? n.raceId}: ${templateLabel(n.templateId)}が的中していた(定型の払戻 ${formatYen(n.payout)})${race === undefined ? "" : `。実際の${betsText(race)}`}`;
          }),
          empty: nm.shown.length === 0 ? "該当するレースはありませんでした。" : null,
        };
  return {
    heading: "もしも(印の定型の買い方。各100円)",
    note: "毎レース各100円で買っていたときの成績です(印の付いたレース全部が対象。実際の配分とは点数も賭け金も揃いません)。判定不能と対象外は成績に含めません。取消・除外の馬を含む型は返還として、賭け金と払戻に含めます。",
    groups,
    near,
  };
}

function bodyOf(report: ReportDetail): ReportBodyView {
  const s = report.stats;
  const tiles = statTiles(s);
  const typeRows: RowView[] = PROPOSED_BET_LABELS.filter(({ type }) => s.byBetType[type] !== undefined).map(({ type, label }) => {
    const t = s.byBetType[type]!;
    return { label, value: `${t.betCount} 点中 ${t.hitCount} 点的中${refundText(t.refundCount)}・賭け金 ${formatYen(t.stake)}・払戻 ${formatYen(t.payout)}` };
  });
  // 券種名が既知のラベルに無いもの(将来の券種)は、キーのまま末尾に出す(黙って落とさない)。
  const known = new Set(PROPOSED_BET_LABELS.map((l) => l.type as string));
  for (const [type, t] of Object.entries(s.byBetType)) {
    if (!known.has(type)) typeRows.push({ label: type, value: `${t.betCount} 点中 ${t.hitCount} 点的中${refundText(t.refundCount)}・賭け金 ${formatYen(t.stake)}・払戻 ${formatYen(t.payout)}` });
  }
  const metaParts = [`作成 ${formatJstDateTime(report.createdAt)}`, `${report.raceCount} レース`, report.model === null ? "LLM の文章なし" : `モデル ${report.model}`];
  if (s.noResultRaceCount > 0) metaParts.push(`結果なし ${s.noResultRaceCount} レース`);
  if (s.unjudgedBetCount > 0) metaParts.push(`判定不能の買い目 ${s.unjudgedBetCount} 点(賭け金 ${formatYen(s.unjudgedStake)}。成績に含めません)`);
  return {
    heading: `${dateLabel(report.date)}の日報`,
    meta: metaParts.join("・"),
    tiles,
    rolling: rollingOf(report),
    whatIf: whatIfOf(report),
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
    dateInput: ymdToInput(input.shownDate),
    dateNav: dateNavOf(input),
    shownLabel: dateLabel(input.shownDate),
  };
  const loading = list.kind === "loading" || detail === null || detail.kind === "loading";
  const refreshDisabled = loading || run.kind === "posting" || input.regen?.kind === "posting";
  let error: string | null = null;
  if (list.kind === "error") error = list.message;
  else if (detail !== null && detail.kind === "error") error = detail.message;

  let body: ReportBodyView | null = null;
  let notice: ReportModel["notice"] = null;
  let create: ReportModel["create"] = null;
  let regen: ReportModel["regen"] = null;
  if (detail !== null && detail.kind === "ready") {
    if (detail.report !== null) {
      body = bodyOf(detail.report);
      const g = input.regen ?? { kind: "idle" };
      const job = detail.job;
      const running = g.kind === "requested" || (job !== null && job.regenerate === true && job.status === "running");
      if (running) {
        notice = { tone: "wait", text: g.kind === "requested" && detail.jobUnavailable === true ? JOB_UNAVAILABLE_NOTICE : REGEN_REQUESTED_NOTICE };
      } else if (g.kind === "done") {
        notice = { tone: "ok", text: REGEN_DONE_NOTICE };
      } else if (g.kind === "error") {
        notice = { tone: "error", text: g.message };
      } else if (g.kind !== "posting" && job !== null && job.regenerate === true && job.status === "failed") {
        notice = { tone: "error", text: REGEN_FAILED_NOTICE };
      }
      // 閲覧者(Issue #238)には出さない(作り直しは管理者だけ。サーバも 403)。作り直し中も出さない。
      if (input.readOnly !== true && !running) {
        regen = { label: g.kind === "posting" ? "依頼中…" : "日報を作り直す", disabled: g.kind === "posting", confirm: g.kind === "confirm" ? { text: REGEN_CONFIRM_TEXT, goLabel: "作り直す", cancelLabel: "やめる" } : null };
      }
    } else if (detail.job !== null && detail.job.status === "running") {
      notice = { tone: "wait", text: "日報を作成中です。しばらくすると表示されます(この画面は自動で更新します)。" };
    } else if (run.kind === "requested" || (input.watching === true && detail.jobUnavailable === true)) {
      notice =
        detail.jobUnavailable === true
          ? { tone: "wait", text: JOB_UNAVAILABLE_NOTICE }
          : { tone: "wait", text: "日報の作成を依頼しました。しばらくすると表示されます(この画面は自動で更新します)。" };
    } else if (run.kind === "no-report") {
      notice = { tone: "info", text: NO_REPORT_NOTICE };
    } else {
      const readOnly = input.readOnly === true;
      if (detail.job !== null && detail.job.status === "failed") {
        notice = { tone: "error", text: readOnly ? "日報の作成に失敗しました。" : "日報の作成に失敗しました。もう一度作成を依頼できます。" };
      } else {
        notice = {
          tone: "info",
          text: `この日の日報はまだありません。その日に分析したレースがあれば、分析と結果が揃ったあとに自動で作られます(分析したレースが無い日は作られません)。${readOnly ? "" : "すぐに作るときは、下のボタンで依頼できます。"}`,
        };
      }
      // 閲覧者(Issue #238)には作成のボタンを出さない(作成は管理者だけ。サーバも 403)。
      create = readOnly
        ? null
        : {
            label: run.kind === "posting" ? "依頼中…" : "この日の日報を作る",
            disabled: run.kind === "posting",
            caution: CREATE_CAUTION,
            todayCaution: input.shownDate === input.today ? CREATE_TODAY_CAUTION : null,
          };
    }
  }
  if (run.kind === "error") {
    notice = { tone: "error", text: run.message };
  }
  if (input.pollStopped && notice !== null && notice.tone === "wait") {
    notice = { tone: "wait", text: "作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。" };
  }
  return { ...base, loading, refreshDisabled, error, notice, create, regen, body };
}
