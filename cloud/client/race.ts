/**
 * レース画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出しの下に「朝の準備」「発走前」の 2 枚のカード(状態・失敗時のエラー文)。朝が完了していれば prior の順位、発走前が完了していれば「結果を見る」(**リンク=利用者の明示の操作で開く。自動では開かない**)。
 * その下に過去の分析の一覧(結果の画面へのリンク)。**この段階(#185)に起動のボタンは無い**(#186)。
 * 状態(`status?race_id=`)と過去の分析(`GET /api/analyses`)の取得は互いに独立(片方の失敗で、もう片方を隠さない)。
 */
import { formatPercent } from "../../packages/app/src/renderer/format";
import type { BoardRow, MorningPriorView, RaceRow, TaskMode } from "./api";
import type { PastAnalysis } from "./api-analysis";
import { formatJstDateTime } from "./date";
import { badgeOf, pick, type Badge } from "./list";
import { buildHash, type Route } from "./route";

export type RaceStatusSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly rows: readonly BoardRow[]; readonly prior: MorningPriorView | null };

export type PastSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly analyses: readonly PastAnalysis[] };

export interface RaceModelInput {
  /** `race` が non-null のルート。 */
  readonly route: Route;
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

export interface TaskCard {
  readonly mode: TaskMode;
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
  /** 状態を取得できていないとき null(「未実行」と誤読させない)。 */
  readonly cards: readonly TaskCard[] | null;
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

function card(route: Route, rows: readonly BoardRow[], prior: MorningPriorView | null, mode: TaskMode): TaskCard {
  const raceId = route.race!;
  const found = pick(rows, raceId, mode);
  const failedError = found !== undefined && found.status === "failed" && found.error !== null && found.error !== "" ? found.error.slice(0, ERROR_MAX) : null;
  const resultHref =
    mode === "pre_race" && found !== undefined && found.status === "done" && found.analysisId !== null
      ? buildHash({ date: route.date, venue: route.venue, analysis: found.analysisId })
      : null;
  const showPrior = mode === "morning" && found !== undefined && found.status === "done" && found.prior && prior !== null;
  return {
    mode,
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
    cards: status.kind === "ready" ? (["morning", "pre_race"] as const).map((mode) => card(route, status.rows, status.prior, mode)) : null,
    past:
      past.kind === "ready"
        ? {
            kind: "ready",
            items: past.analyses.map((a) => ({ id: a.id, label: formatJstDateTime(a.analyzedAt), href: buildHash({ date: route.date, venue: route.venue, analysis: a.id }) })),
          }
        : past,
  };
}
