/**
 * 日報画面(`#report`・`#report=YYYYMMDD`)の制御(Issue #235)。取得・日付の切替・手動の作成の依頼・作成中のポーリング。DOM・fetch・タイマーは注入する(Node でテストできる)。
 * 画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。
 *
 *  - 開く(`enter(date)`): `GET /api/reports`(日付の一覧)と、表示する日の `GET /api/reports/{date}` を取る。日付が未指定(`#report`)なら、一覧が届いたあと最新の日報の日、
 *    日報が 1 件も無ければ今日を表示する。他の API には出ない。日付のリンクを押すとハッシュが変わり、`app.ts` が同じ `enter` を新しい日付で呼ぶ(同じ画面の中の切替)。
 *  - 「この日の日報を作る」(`onRun`): `POST /api/reports/run`(表示中の日)。受け付けたら作成中の表示にして、{@link REPORT_POLL_MS} おきに本文を取り直す。
 *    日報が現れたら止める(一覧も取り直す)。作成が失敗(`failed`)したら止める。{@link REPORT_MAX_POLLS} 回で止める。
 *  - 作成中(サーバの `job` が running)の日を開いたときも、同じく自動で取り直す。**非表示の間は止め**、表示に戻ったら(作成中なら)即時に 1 回取って再開する。`setInterval` は使わない。
 *  - 世代(`gen`)と取得の通し番号(`seq`): 離れる・開き直す・日付を替えるたびに進め、**古い応答は反映しない**。
 */
import { fetchReport, fetchReportList, postReportRun, reportFetchFailureMessage, reportRunFailureMessage } from "./api-report";
import type { FetchLike } from "./api";
import { buildReportModel, type ReportDetailState, type ReportListState, type ReportModel, type ReportRunState } from "./report-model";

/** 作成中の確認の間隔。 */
export const REPORT_POLL_MS = 5_000;
/** 自動更新の上限回数(最初の取得は数えない)。5 秒 × 120 = 10 分。 */
export const REPORT_MAX_POLLS = 120;
/** ポーリング中の通信の失敗がこの回数続いたら止める。 */
export const REPORT_MAX_FAILURES = 3;

export interface ReportScreenDeps {
  readonly fetch: FetchLike;
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  /** 今日(JST、YYYYMMDD)。 */
  readonly today: () => string;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
  /** 閲覧者(Issue #238)。作成のボタンを出さず、`onRun` も何もしない(日報の作成は管理者だけ。サーバも 403)。省略は false(管理者)。 */
  readonly readOnly?: boolean;
}

export interface ReportScreen {
  /** 画面に入った(または同じ画面の中で日付が変わった)。`date` は `#report=` の日付。未指定は null。重ねて呼んでも、同じ日の取得は増えない。 */
  enter(date: string | null): void;
  /** 画面を離れた。タイマー・状態を捨てる。 */
  leave(): void;
  /** 「この日の日報を作る」。依頼中・日報がある日・画面に居ないときは何もしない。 */
  onRun(): void;
  /** 「更新」。取得中は無視。 */
  onRefresh(): void;
  onVisibilityChange(): void;
  model(): ReportModel;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

export function createReportScreen(deps: ReportScreenDeps): ReportScreen {
  let active = false;
  let routeDate: string | null = null;
  let shown: string = deps.today();
  let list: ReportListState = { kind: "loading" };
  let detail: ReportDetailState | null = null;
  let run: ReportRunState = { kind: "idle" };
  let busy = false;
  let pollStopped = false;
  let failures = 0;
  let polls = 0;
  let timer: unknown = null;
  let gen = 0;
  let seq = 0;
  const inflight = new Set<Promise<unknown>>();

  function clearTimer(): void {
    if (timer !== null) {
      deps.timers.clear(timer);
      timer = null;
    }
  }

  function track(promise: Promise<unknown>): void {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  /** 作成中(確認を続けるべき)か: サーバの job が running、または依頼を受け付けた直後。 */
  function waiting(): boolean {
    return detail !== null && detail.kind === "ready" && detail.report === null && ((detail.job !== null && detail.job.status === "running") || run.kind === "requested");
  }

  function schedule(): void {
    clearTimer();
    if (!active || pollStopped || !deps.isVisible() || !waiting()) return;
    if (polls >= REPORT_MAX_POLLS) {
      pollStopped = true;
      return;
    }
    const g = gen;
    timer = deps.timers.set(() => {
      timer = null;
      if (g === gen) fetchDetail("poll");
    }, REPORT_POLL_MS);
  }

  function resolveShown(): string {
    if (routeDate !== null) return routeDate;
    if (list.kind === "ready" && list.items.length > 0) return list.items[0]!.date;
    return deps.today();
  }

  /** 本文を 1 回取る。`first`: 開いたとき・日付の切替・更新(失敗はエラー表示)。`poll`: 作成中の確認(失敗しても前の表示を残し、連続の失敗を数える)。 */
  function fetchDetail(mode: "first" | "poll"): void {
    const g = gen;
    seq += 1;
    const mySeq = seq;
    const date = shown;
    busy = true;
    if (mode === "first") {
      detail = { kind: "loading" };
      pollStopped = false;
      failures = 0;
      polls = 0;
      clearTimer();
      deps.onChange();
    } else {
      polls += 1;
    }
    track(
      fetchReport(deps.fetch, date).then((result) => {
        if (g !== gen || mySeq !== seq) return; // 離れた・日付を替えた・取り直した(古い応答)
        busy = false;
        if (result.ok) {
          detail = { kind: "ready", report: result.report, job: result.job, jobUnavailable: result.jobStatus === "unavailable" };
          failures = 0;
          if (result.report !== null) {
            run = { kind: "idle" };
            // 新しく現れた日報を日付の並びに入れる。
            if (list.kind === "ready" && !list.items.some((i) => i.date === date)) refreshList();
          } else if (run.kind === "requested" && result.job !== null && result.job.status === "failed") {
            run = { kind: "idle" };
          } else if (run.kind === "requested" && result.job === null && result.jobStatus === "ok") {
            // 依頼は受け付けられた(ジョブは依頼の時点で作られる)のに、日報も進行状況も無い = 作られずに終わった(その日の分析が無い)。固定の案内を出して確認を止める。
            // **進行状況を取得できなかった(`unavailable`)ときは、ここに入らない**(Issue #245): ジョブが無いのではなく分からないので、`requested` のまま確認を続ける
            // (失敗の連続にも数えない。止まるのは日報が現れたとき・作成が失敗したとき・REPORT_MAX_POLLS 回のとき)。
            run = { kind: "no-report" };
          }
        } else if (mode === "first") {
          detail = { kind: "error", message: reportFetchFailureMessage(result.error) };
        } else {
          failures += 1;
          if (failures >= REPORT_MAX_FAILURES) pollStopped = true;
        }
        schedule();
        deps.onChange();
      }),
    );
  }

  /** 一覧を取る。日付が未指定(`#report`)で最初の取得なら、届いたあと最新の日を表示する。 */
  function fetchList(isFirst: boolean): void {
    const g = gen;
    track(
      fetchReportList(deps.fetch).then((result) => {
        if (g !== gen) return;
        if (result.ok) {
          list = { kind: "ready", items: result.reports };
        } else if (list.kind !== "ready") {
          list = { kind: "error", message: reportFetchFailureMessage(result.error) };
        }
        // 日付の指定が無いなら、一覧が届いてから表示する日が決まり、本文を取り始める(最新の日報の日。一覧が失敗した・日報が無ければ今日)。
        if (isFirst && routeDate === null) {
          shown = result.ok ? resolveShown() : deps.today();
          fetchDetail("first");
          return;
        }
        deps.onChange();
      }),
    );
  }

  function refreshList(): void {
    fetchList(false);
  }

  function enter(date: string | null): void {
    if (active && date === routeDate) return; // 同じ指定で重ねて呼ばれた
    const wasActive = active;
    active = true;
    routeDate = date;
    if (!wasActive) {
      gen += 1;
      list = { kind: "loading" };
      run = { kind: "idle" };
      shown = date ?? deps.today();
      fetchList(true);
      if (date !== null) fetchDetail("first"); // 日付の指定が無いときは、一覧が届いてから(最新の日が決まってから)本文を取る
      return;
    }
    // 同じ画面の中で日付が変わった: 本文だけ取り直す(一覧はそのまま)。
    gen += 1;
    run = { kind: "idle" };
    shown = resolveShown();
    fetchDetail("first");
  }

  function leave(): void {
    gen += 1;
    seq += 1;
    clearTimer();
    active = false;
    routeDate = null;
    list = { kind: "loading" };
    detail = null;
    run = { kind: "idle" };
    busy = false;
    pollStopped = false;
    failures = 0;
    polls = 0;
  }

  function onRun(): void {
    if (deps.readOnly === true || !active || run.kind === "posting" || run.kind === "requested" || run.kind === "no-report" || detail === null || detail.kind !== "ready" || detail.report !== null) return;
    if (detail.job !== null && detail.job.status === "running") return;
    const g = gen;
    const date = shown;
    run = { kind: "posting" };
    deps.onChange();
    track(
      postReportRun(deps.fetch, date).then((outcome) => {
        if (g !== gen || date !== shown) return;
        if (outcome.kind === "accepted" || outcome.kind === "accepted-malformed" || outcome.kind === "in-progress") {
          // サーバは依頼を受け付けている(または既に作成中)。作成中の表示にして、確認を始める。
          run = { kind: "requested" };
          pollStopped = false;
          failures = 0;
          polls = 0;
          fetchDetail("poll");
        } else if (outcome.kind === "already-exists") {
          run = { kind: "idle" };
          fetchDetail("first");
        } else {
          run = { kind: "error", message: reportRunFailureMessage(outcome.failure) };
        }
        deps.onChange();
      }),
    );
  }

  function onRefresh(): void {
    if (!active || busy || detail === null || detail.kind === "loading") return;
    run = run.kind === "error" || run.kind === "no-report" ? { kind: "idle" } : run;
    fetchList(false);
    fetchDetail("first");
  }

  function onVisibilityChange(): void {
    if (!active) return;
    if (!deps.isVisible()) {
      clearTimer();
      return;
    }
    if (waiting() && !pollStopped && !busy && timer === null) {
      fetchDetail("poll");
    }
  }

  return {
    enter,
    leave,
    onRun,
    onRefresh,
    onVisibilityChange,
    model: () => buildReportModel({ today: deps.today(), shownDate: shown, list, detail, run, pollStopped, readOnly: deps.readOnly === true }),
    pending: () => [...inflight],
  };
}
