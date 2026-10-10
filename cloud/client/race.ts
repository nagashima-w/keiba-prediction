/**
 * レース画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出しの下に「朝の準備」「発走前」の 2 枚のカード(状態・失敗時のエラー文・起動のボタン〈Issue #186〉)。朝が完了していれば prior の順位、発走前が完了していれば**最新の分析の結果を最初からカードの中に出す**
 * (Issue #188。旧「結果を見る」のリンクは廃止。結果の画面〈`#analysis=<id>`〉は過去の分析の一覧のリンク用に残る)。
 * **最新の分析 = 板の発走前の行が `done` で `analysisId` を持つときのその id**(`latestAnalysisIdOf`。取得するかどうか〈`app.ts`〉と表示するかどうかの唯一の判定)。実行中・失敗・未実行のときは出さない(再実行で前の結果を見せない)。
 * その下に過去の分析の一覧(結果の画面へのリンク)。
 * **カードの行は「最新の板」(ポーリング・起動のオーバーレイを反映したもの)から導く**(Issue #186。`app.ts` が `status.rows` に渡す。`status?race_id=` は prior と板の初期値)。
 * 状態(`status?race_id=`)と過去の分析(`GET /api/analyses`)の取得は互いに独立(片方の失敗で、もう片方を隠さない)。
 */
import { formatPercent } from "../../packages/app/src/renderer/format";
import type { BoardRow, MorningPriorView, RaceRow, TaskMode, TaskStatus } from "./api";
import type { PastAnalysis } from "./api-analysis";
import { formatJstDateTime } from "./date";
import { badgeOf, pick, type Badge } from "./list";
import { contentOf, type ResultContent, type ResultSource } from "./result";
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
  /** 最新の分析(`latestAnalysisIdOf`)の結果のソース(Issue #188)。最新の分析があるのに省略・loading のときは「読み込み中」。最新の分析が無いときは使わない。 */
  readonly result?: ResultSource;
  /** 発走前のカードの結果が開いているか(Issue #188)。省略は開(既定)。 */
  readonly resultOpen?: boolean;
}

/**
 * 発走前のカードの中の結果(Issue #188)。読み込み中・失敗は開閉に関係なく出す(失敗を畳みで隠さない)ので、開閉(`open`)は ready だけが持つ。
 * `date`・`raceId` は開閉のクリック処理に渡す値(`view.ts` が `data-*` にも出す)。
 */
export type CardResult =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly content: ResultContent; readonly open: boolean; readonly date: string; readonly raceId: string };

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
  /** そのカードが何をするかの説明(1〜2行。定数。板の状態に依らず出す。Issue #191)。 */
  readonly description: string;
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
  /** 発走前のカードだけ: 最新の分析の結果(最新の分析が無いときは null)。 */
  readonly result: CardResult | null;
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

/**
 * カードの説明(Issue #191)。**実際の挙動に合わせた文言**(根拠は #189 の着手前確認 §6。**画面に出す文には、Issue 番号を書かない**):
 *  - 朝の準備: 取得するのは出馬表・オッズ・各馬の戦績・調教(`race-day-core.ts` の `runFetch`。組合せオッズは取らない)。**調教は中央だけ**(`scrape-race.ts` の `if (!isNar)`。地方にはページが無く、取得を試みない)
 *    なので、地方のレースにも出るこのカードでは「調教(調教は中央のみ)」と書く。所要時間は gate の最小間隔(`GATE_MIN_INTERVAL_MS`)× 取得の本数(中央は頭数 N なら N+3 本〈出馬表1・戦績N・調教1・オッズ1。
 *    16頭で19本〉、地方は調教が無いので N+2 本)なので、頭数により1分弱(実測はしていない)。発走前で使い回されるのは戦績・調教
 *    (キャッシュの鮮度は戦績・調教とも 24 時間〈調教は #191 で 6 時間から延ばした〉。出馬表 10 分・オッズは取り直す)。朝の prior は DO にだけ置き、D1・R2 の分析の履歴には残さない。
 *  - 発走前: 出馬表・オッズを取り直す(オッズはキャッシュを迂回。組合せオッズは設定 `includeComboOdds` が ON のときだけ)。3着内率・EV(複勝 EV = 3着内率 × 複勝オッズの下限。LLM が効いたときは補正後の3着内率から計算)を作って D1・R2 に保存する。
 *    **LLM(Issue #194・#195)は、Worker の secret `ANTHROPIC_API_KEY` が登録されているときだけ使う**(未登録なら LLM なしで保存する)ので、説明は「API キーがあれば…、キーが無い間は統計のみ」と**どちらの状態でも嘘にならない書き方**にする
 *    (画面からキーの有無は分からない)。**cloud のプロンプトに何が入っているか(調教・コメント・展開・同日の傾向・重賞の傾向)は、この文で約束しない**(同日の傾向は、取り込み済みの前のレースが2つ以上あるときだけ入る〈Issue #209〉。重賞の傾向は、重賞のレースで取得できて条件に合う過去回が3回以上あるときだけ入る〈Issue #181〉)。
 *    **配分は、総資金・1レースの上限を設定しているときだけ出る**(既定は両方 0=配分を出さない。結果の部分は「配分の提案は出ていません」と出す)ので、説明にも条件を付ける。
 *    スマホで1〜2行に収まる長さにする(組合せオッズ・EV の定義の括弧は省く。設定の画面・結果の画面が補う)。
 */
export const CARD_DESCRIPTIONS: Readonly<Record<TaskMode, string>> = {
  morning:
    "netkeiba から出馬表・オッズ・各馬の戦績・調教(調教は中央のみ)を取得し、統計で3着内率の順位を出します。頭数によりますが1分弱かかります。戦績・調教は発走前に使い回します。分析の履歴には残しません。",
  pre_race:
    "出馬表とオッズを取り直し、3着内率・EV を出して記録に残します。API キーがあれば LLM が3着内率を補正して印と根拠を付け(EV は補正後の値で計算)、キーが無い間は統計のみです。資金と1レースの上限があれば配分も出します。",
};

function titleOf(route: Route, listRow: RaceRow | undefined, prior: MorningPriorView | null): string {
  const raceId = route.race!;
  if (listRow !== undefined) {
    // 発走予定時刻(Issue #236)は、一覧の行から作るときだけ(prior・レース ID だけの経路は時刻を持たない。見出しのために取得を足さない)。
    return `${listRow.venueName ?? ""}${listRow.raceNumber}R ${listRow.raceName}${listRow.startTime === null ? "" : ` ${listRow.startTime}発走`}`;
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

/**
 * そのレースの最新の分析 id(板の発走前の行が `done` で `analysisId` があるときだけ。無ければ null)。
 * `app.ts` が「`GET /api/analyses/{id}` を取るかどうか」に、`buildRaceModel` が「カードに結果を出すかどうか」に、**同じこの関数**を使う(二重に持たない)。
 */
export function latestAnalysisIdOf(rows: readonly BoardRow[], raceId: string): number | null {
  const found = pick(rows, raceId, "pre_race");
  return found !== undefined && found.status === "done" ? found.analysisId : null;
}

function cardResult(route: Route, rows: readonly BoardRow[], result: ResultSource | undefined, open: boolean): CardResult | null {
  const raceId = route.race!;
  if (latestAnalysisIdOf(rows, raceId) === null) return null;
  if (result === undefined || result.kind === "loading") return { kind: "loading" };
  if (result.kind === "error") return { kind: "error", message: result.message };
  return { kind: "ready", content: contentOf(result.analysis), open, date: route.date, raceId };
}

function card(
  route: Route,
  rows: readonly BoardRow[],
  prior: MorningPriorView | null,
  mode: TaskMode,
  run: RunUi | undefined,
  priorNotice: string | null,
  result: ResultSource | undefined,
  resultOpen: boolean,
): TaskCard {
  const raceId = route.race!;
  const found = pick(rows, raceId, mode);
  const failedError = found !== undefined && found.status === "failed" && found.error !== null && found.error !== "" ? found.error.slice(0, ERROR_MAX) : null;
  const showPrior = mode === "morning" && found !== undefined && found.status === "done" && found.prior && prior !== null;
  const sending = run?.kind === "sending";
  return {
    mode,
    description: CARD_DESCRIPTIONS[mode],
    button: { label: runButtonLabel(mode, found?.status, sending), disabled: sending || isRunning(found?.status), date: route.date, raceId, mode },
    runError: run?.kind === "error" ? run.message : null,
    runInfo: run?.kind === "already" && isRunning(found?.status) ? "すでに実行中です。状態を追跡します。" : null,
    priorNotice: mode === "morning" ? priorNotice : null,
    title: mode === "morning" ? "朝の準備" : "発走前",
    badge: badgeOf(found),
    error: failedError,
    result: mode === "pre_race" ? cardResult(route, rows, result, resultOpen) : null,
    prior: showPrior ? prior.rows.map((r) => ({ rank: r.rank, umaban: r.umaban, name: r.horseName, value: formatPercent(r.prior) })) : null,
  };
}

export function buildRaceModel(input: RaceModelInput): RaceModel {
  const { route, status, past, listRow } = input;
  const prior = status.kind === "ready" ? status.prior : null;
  const cards =
    status.kind === "ready"
      ? (["morning", "pre_race"] as const).map((mode) => card(route, status.rows, status.prior, mode, input.runs?.get(mode), status.priorNotice ?? null, input.result, input.resultOpen ?? true))
      : null;
  return {
    kind: "race",
    title: titleOf(route, listRow, prior),
    backHref: buildHash({ date: route.date, venue: route.venue }),
    // 結果の取得中も「更新」を無効にする(取得中の連打で、同じものを同時に 2 本取らない)。
    loading: status.kind === "loading" || past.kind === "loading" || (cards ?? []).some((c) => c.result?.kind === "loading"),
    statusNotice: status.kind === "error" ? status.message : null,
    cards,
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
