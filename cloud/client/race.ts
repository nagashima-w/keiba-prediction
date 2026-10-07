/**
 * レース画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出しの下に「朝の準備」「発走前」の 2 枚のカード(状態・失敗時のエラー文・起動のボタン〈Issue #186〉)。朝が完了していれば prior の順位、発走前が完了していれば「結果を見る」(**リンク=利用者の明示の操作で開く。自動では開かない**)。
 * その下に過去の分析の一覧(結果の画面へのリンク)。
 * **カードの行は「最新の板」(ポーリング・起動のオーバーレイを反映したもの)から導く**(Issue #186。`app.ts` が `status.rows` に渡す。`status?race_id=` は prior と板の初期値)。
 * 状態(`status?race_id=`)と過去の分析(`GET /api/analyses`)の取得は互いに独立(片方の失敗で、もう片方を隠さない)。
 */
import { formatPercent } from "../../packages/app/src/renderer/format";
import type { BoardRow, MorningPriorView, RaceRow, TaskMode, TaskStatus } from "./api";
import type { PastAnalysis } from "./api-analysis";
import { formatJstDateTime } from "./date";
import { badgeOf, pick, type Badge } from "./list";
import { buildHash, type Route } from "./route";

export type RaceStatusSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly rows: readonly BoardRow[];
      readonly prior: MorningPriorView | null;
      /** prior の取り直し(朝の完了のあと)に失敗した注記(カードは残す)。省略は無し。 */
      readonly priorNotice?: string | null;
    };

export type PastSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly analyses: readonly PastAnalysis[] };

/** 起動の操作の表示(モードごと。無ければ何も押していない)。 */
export type RunUi = { readonly kind: "sending" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "already" };

export interface RaceModelInput {
  /** `race` が non-null のルート。 */
  readonly route: Route;
  /** 起動の操作の表示(モードごと)。省略は「何も押していない」。 */
  readonly runs?: ReadonlyMap<TaskMode, RunUi>;
  /** 追跡の停止の注記(止まっているときだけ。省略・null は出さない)。 */
  readonly tracking?: string | null;
  readonly status: RaceStatusSource;
  readonly past: PastSource;
  /** 一覧のキャッシュにあれば、そのレースの行(見出し用。無くても一覧は取りに行かない)。 */
  readonly listRow: RaceRow | undefined;
}

export interface PriorItem {
  readonly rank: number;
  readonly umaban: number;
  readonly name: string | null;
  /** 3着内率(「52.3%」)。 */
  readonly value: string;
}

/** 起動のボタン。クリック処理に渡す値(開催日・レース・モード)は、`data-*` にも出す(`view.ts`)。 */
export interface RunButton {
  readonly label: string;
  readonly disabled: boolean;
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly raceId: string;
  readonly mode: TaskMode;
}

export interface TaskCard {
  readonly mode: TaskMode;
  readonly button: RunButton;
  /** 起動の失敗の固定の文言(そのカードだけ)。 */
  readonly runError: string | null;
  /** 「すでに実行中」の注記(409 のあと、板が実行中の間だけ)。 */
  readonly runInfo: string | null;
  /** 朝のカードだけ: prior の取り直しに失敗した注記。 */
  readonly priorNotice: string | null;
  readonly title: "朝の準備" | "発走前";
  readonly badge: Badge;
  /** 失敗のときだけ、板の `error`(サーバが 200 文字に切った診断。テキストノードで描く)。 */
  readonly error: string | null;
  /** 発走前が完了していて分析 id があるときの、結果の画面へのハッシュ。 */
  readonly resultHref: string | null;
  /** 朝が完了していて prior があるときの順位。 */
  readonly prior: readonly PriorItem[] | null;
}

export type PastModel =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly { readonly id: number; readonly label: string; readonly href: string }[] };

export interface RaceModel {
  readonly kind: "race";
  readonly title: string;
  readonly backHref: string;
  /** 状態または過去の分析を取得中(「更新」を無効にする)。 */
  readonly loading: boolean;
  /** 状態の取得に失敗したときの注記(このとき `cards` は null)。 */
  readonly statusNotice: string | null;
  /** 状態を取得できていないとき null(「未実行」と誤読させない。このとき起動のボタンも出ない)。 */
  readonly cards: readonly TaskCard[] | null;
  /** 追跡の停止の注記(「状態を更新」つき)。止まっていないとき null。 */
  readonly tracking: string | null;
  readonly past: PastModel;
}

const ERROR_MAX = 200;

function titleOf(route: Route, listRow: RaceRow | undefined, prior: MorningPriorView | null): string {
  const raceId = route.race!;
  if (listRow !== undefined) {
    return `${listRow.venueName ?? ""}${listRow.raceNumber}R ${listRow.raceName}`;
  }
  if (prior !== null) {
    const number = Number(raceId.slice(10));
    return `${prior.venueName ?? ""}${number}R${prior.raceName === null ? "" : ` ${prior.raceName}`}`;
  }
  return `レース ${raceId}`;
}

const isRunning = (status: TaskStatus | undefined): boolean => status === "queued" || status === "fetched";

/** 起動のボタンの文言(板の状態から)。送信中は状態によらず「送信中…」。 */
export function runButtonLabel(mode: TaskMode, status: TaskStatus | undefined, sending: boolean): string {
  if (sending) return "送信中…";
  switch (status) {
    case "queued":
      return "待ち";
    case "fetched":
      return "取得済み";
    case "failed":
      return "再試行";
    case "done":
      return mode === "morning" ? "朝の準備をやり直す" : "再実行(新しい分析として保存されます)";
    case undefined:
      return mode === "morning" ? "朝の準備を実行" : "発走前の分析を実行";
  }
}

function card(route: Route, rows: readonly BoardRow[], prior: MorningPriorView | null, mode: TaskMode, run: RunUi | undefined, priorNotice: string | null): TaskCard {
  const raceId = route.race!;
  const found = pick(rows, raceId, mode);
  const failedError = found !== undefined && found.status === "failed" && found.error !== null && found.error !== "" ? found.error.slice(0, ERROR_MAX) : null;
  const resultHref =
    mode === "pre_race" && found !== undefined && found.status === "done" && found.analysisId !== null
      ? buildHash({ date: route.date, venue: route.venue, analysis: found.analysisId })
      : null;
  const showPrior = mode === "morning" && found !== undefined && found.status === "done" && found.prior && prior !== null;
  const sending = run?.kind === "sending";
  return {
    mode,
    button: { label: runButtonLabel(mode, found?.status, sending), disabled: sending || isRunning(found?.status), date: route.date, raceId, mode },
    runError: run?.kind === "error" ? run.message : null,
    runInfo: run?.kind === "already" && isRunning(found?.status) ? "すでに実行中です。状態を追跡します。" : null,
    priorNotice: mode === "morning" ? priorNotice : null,
    title: mode === "morning" ? "朝の準備" : "発走前",
    badge: badgeOf(found),
    error: failedError,
    resultHref,
    prior: showPrior ? prior.rows.map((r) => ({ rank: r.rank, umaban: r.umaban, name: r.horseName, value: formatPercent(r.prior) })) : null,
  };
}

export function buildRaceModel(input: RaceModelInput): RaceModel {
  const { route, status, past, listRow } = input;
  const prior = status.kind === "ready" ? status.prior : null;
  return {
    kind: "race",
    title: titleOf(route, listRow, prior),
    backHref: buildHash({ date: route.date, venue: route.venue }),
    loading: status.kind === "loading" || past.kind === "loading",
    statusNotice: status.kind === "error" ? status.message : null,
    cards: status.kind === "ready" ? (["morning", "pre_race"] as const).map((mode) => card(route, status.rows, status.prior, mode, input.runs?.get(mode), status.priorNotice ?? null)) : null,
    tracking: input.tracking ?? null,
    past:
      past.kind === "ready"
        ? {
            kind: "ready",
            items: past.analyses.map((a) => ({ id: a.id, label: formatJstDateTime(a.analyzedAt), href: buildHash({ date: route.date, venue: route.venue, analysis: a.id }) })),
          }
        : past,
  };
}
