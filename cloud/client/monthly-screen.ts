/**
 * 月報画面(`#report=YYYYMM`。日報の画面の中の「月」)の制御(Issue #265・#279・#280)。取得・月の切替・更新・管理者の作成と作り直し・完了と失敗のポーリング。
 * DOM・fetch・タイマーは注入する(Node でテストできる)。画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。
 * 作成・作り直し・ポーリングは日報の画面(`report-screen.ts`。#235・#268・#246)と同じ作り(定数・応答の分類・文言の一部は共有する)。
 *
 *  - 開く(`enter(month)`): `GET /api/monthly-reports`(月の一覧)と、表示する月の `GET /api/monthly-reports/{month}` だけを取る。他の API には出ない(作成・作り直しの POST を除く)。
 *    同じ月で重ねて呼んでも取得は増えない。月が変わったら(同じ画面の中の切替)本文だけを取り直す(一覧はそのまま)。
 *  - 「この月の月報を作る」(`onRun`。管理者の、終わった月で月報が無い月だけ): `POST /api/monthly-reports/run`(本文は `{ month }`)。受け付けたら作成中の表示にして、{@link REPORT_POLL_MS} おきに本文を取り直す。
 *    月報が現れたら止める(一覧も取り直す)。作成が失敗(failed)したら止める。依頼を受け付けたのに月報もジョブも無い(進行状況が取れたうえで)なら「分析が無く作られなかった」と案内して止める。{@link REPORT_MAX_POLLS} 回で止める。
 *  - 「月報を作り直す」(`onRegenOpen`・`onRegenGo`・`onRegenCancel`。管理者の、終わった月で月報がある月だけ): 開くと**確認の段階**が出る(実行を選ぶまで POST は出ない。LLM の費用が発生し、いまの月報を置き換えるため)。
 *    実行すると `POST /api/monthly-reports/run`(本文は `{ month, regenerate: true }`)。受け付けたら作り直し中の表示にして、同じ間隔で本文を取り直す。**作成時刻(`createdAt`)が依頼の時点から変われば完了**、
 *    作り直しのジョブ(`job.regenerate`)が failed なら失敗(前の月報のまま。置き換えを断られた〈kept〉場合も同じ)。作成時刻が変わらずジョブも見えない間は、完了にせず確認を続ける。
 *  - 作成中・作り直し中(サーバの `job` が running)の月を開いたときも、自動で取り直す。**非表示の間は止め**、表示に戻ったら(確認中なら)即時に 1 回取って再開する。`setInterval` は使わない。
 *  - 確認を続けている状態(`watching`): 取得の結果が running のとき立て、月報が現れた・作成が失敗(running 以外の job)・進行状況が無いと分かった(`job_status` が `ok` で job なし)・最初の取得が通信の失敗、のいずれかで下ろす。
 *    **進行状況を取得できなかった(`unavailable`)応答と、確認中(`poll`)の通信の失敗では変えない**(日報と同じ。立っている間は確認を止めず、固定の案内を出す)。月の切替・画面を離れると捨てる。「更新」では保つ。
 *  - 「更新」(`onRefresh`): 一覧と本文を取り直す。取得中・開く前は無視する。失敗・完了の表示を消す。
 *  - 世代: 本文は `gen`・`seq`(離れる・開き直す・月を替える・取り直すたびに進める)、一覧は `epoch`(開く・離れるだけ。一覧は月に依らないので、月を替える間に届いても反映する)。**古い応答は反映しない**。
 */
import type { FetchLike } from "./api";
import { fetchMonthly, fetchMonthlyList, monthlyFetchFailureMessage, postMonthlyRun } from "./api-monthly";
import { reportRunFailureMessage, type ReportRunOutcome } from "./api-report";
import { buildMonthlyModel, type MonthlyDetailState, type MonthlyListState, type MonthlyModel } from "./monthly-model";
import { REGEN_LIMIT_MESSAGE, type ReportRegenState, type ReportRunState } from "./report-model";
import { REPORT_MAX_FAILURES, REPORT_MAX_POLLS, REPORT_POLL_MS } from "./report-screen";

export interface MonthlyScreenDeps {
  readonly fetch: FetchLike;
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  /** 今日(JST、YYYYMMDD)。 */
  readonly today: () => string;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
  /** 閲覧者。作成・作り直しのボタンを出さず、操作しても何もしない(サーバも 403)。省略は false(管理者)。 */
  readonly readOnly?: boolean;
}

export interface MonthlyScreen {
  /** 画面に入った(または同じ画面の中で月が変わった)。`month` は `#report=` の月(YYYYMM)。重ねて呼んでも、同じ月の取得は増えない。 */
  enter(month: string): void;
  /** 画面を離れた。タイマー・状態を捨てる。 */
  leave(): void;
  /** 「この月の月報を作る」。依頼中・月報がある月・今月と先の月・閲覧者・画面に居ないときは何もしない。 */
  onRun(): void;
  /** 「月報を作り直す」を押した: 確認の段階を開く(管理者・終わった月・月報がある月・作り直し中でないときだけ)。 */
  onRegenOpen(): void;
  /** 確認で「作り直す」を選んだ: 依頼する。確認が開いていなければ何もしない。 */
  onRegenGo(): void;
  /** 確認で「やめる」を選んだ。 */
  onRegenCancel(): void;
  /** 「更新」。取得中・開く前は無視。 */
  onRefresh(): void;
  onVisibilityChange(): void;
  model(): MonthlyModel;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

/** 依頼が断られた・失敗したときの固定の文言(月報を主語にする)。1 日の回数の上限(`daily-limit`。作り直しだけが返す)は専用の案内。 */
function refusedMessage(outcome: Exclude<ReportRunOutcome, { kind: "accepted" | "accepted-malformed" | "in-progress" }>): string {
  if (outcome.kind === "daily-limit") return REGEN_LIMIT_MESSAGE;
  return reportRunFailureMessage(outcome.kind === "failed" ? outcome.failure : { kind: "unexpected", httpStatus: 409 }).replace(/日報/g, "月報");
}

export function createMonthlyScreen(deps: MonthlyScreenDeps): MonthlyScreen {
  let active = false;
  let shown = deps.today().slice(0, 6);
  let list: MonthlyListState = { kind: "loading" };
  let detail: MonthlyDetailState | null = null;
  let run: ReportRunState = { kind: "idle" };
  let regen: ReportRegenState = { kind: "idle" };
  let busy = false;
  let pollStopped = false;
  let watching = false;
  let failures = 0;
  let polls = 0;
  let timer: unknown = null;
  /** 画面に居る間の世代(開く・離れるで進める)。一覧の応答の有効性。月を替えても進めない(一覧は月に依らないので、月を替えた間に届いても反映する)。 */
  let epoch = 0;
  /** 本文の世代(開く・離れる・月を替えるで進める)と取得の通し番号。古い本文の応答は反映しない。 */
  let gen = 0;
  let seq = 0;
  const inflight = new Set<Promise<unknown>>();

  const readOnly = (): boolean => deps.readOnly === true;
  /** 作成・作り直しは終わった月だけ(今月の月報は最終日の夜の自動作成でだけ作る。サーバも断る)。 */
  const ended = (): boolean => shown < deps.today().slice(0, 6);

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

  /** 作成中・作り直し中(確認を続けるべき)か。進行状況を取れなかった間も、確認を続けている途中(`watching`)なら続ける。 */
  function waiting(): boolean {
    if (detail === null || detail.kind !== "ready") return false;
    const job = detail.job ?? null;
    if (detail.report !== null) return regen.kind === "requested" || (job !== null && job.regenerate === true && job.status === "running");
    return (job !== null && job.status === "running") || run.kind === "requested" || (watching && detail.jobUnavailable === true);
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

  /** 本文を 1 回取る。`first`: 開いたとき・月の切替・更新(失敗はエラー表示)。`poll`: 作成中の確認(失敗しても前の表示を残し、連続の失敗を数える)。 */
  function fetchDetail(mode: "first" | "poll"): void {
    const g = gen;
    seq += 1;
    const mySeq = seq;
    const month = shown;
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
      fetchMonthly(deps.fetch, month).then((result) => {
        if (g !== gen || mySeq !== seq) return; // 離れた・月を替えた・取り直した(古い応答)
        busy = false;
        if (result.ok) {
          const hadReport = detail !== null && detail.kind === "ready" && detail.report !== null;
          detail = { kind: "ready", report: result.report, job: result.job, jobUnavailable: result.jobStatus === "unavailable" };
          failures = 0;
          // 確認を続ける状態: running を見たら立て、月報が現れた・失敗した・進行状況が無いと分かった(`ok` で job なし)ら下ろす。`unavailable` では変えない。
          if (result.report !== null || (result.job !== null && result.job.status !== "running") || (result.job === null && result.jobStatus === "ok")) watching = false;
          else if (result.job !== null) watching = true;
          if (result.report !== null && regen.kind === "requested") {
            // 作り直しの確認: 作り直しのジョブが失敗したなら失敗(表示はジョブから)。作成時刻が変わったなら完了。どちらでもなければ確認を続ける。
            if (result.job !== null && result.job.regenerate === true && result.job.status === "failed") regen = { kind: "idle" };
            else if (result.report.createdAt !== regen.since) regen = { kind: "done" };
          }
          if (result.report !== null) {
            run = { kind: "idle" };
            // 確認中に新しく現れた月報を一覧に入れる(前後のリンクが使う)。開いたとき・更新の取得では一覧の取り直しを増やさない。
            if (mode === "poll" && !hadReport && list.kind === "ready" && !list.items.some((i) => i.month === month)) fetchList();
          } else if (run.kind === "requested" && result.job !== null && result.job.status === "failed") {
            run = { kind: "idle" };
          } else if (run.kind === "requested" && result.job === null && result.jobStatus === "ok") {
            // 依頼は受け付けられた(ジョブは依頼の時点で作られる)のに、月報も進行状況も無い = 作られずに終わった(その月の分析が無い)。**進行状況を取得できなかった(`unavailable`)ときは入らない**(分からない)。
            run = { kind: "no-report" };
          }
        } else if (mode === "first") {
          detail = { kind: "error", message: monthlyFetchFailureMessage(result.error) };
          watching = false;
        } else {
          failures += 1;
          if (failures >= REPORT_MAX_FAILURES) pollStopped = true;
        }
        schedule();
        deps.onChange();
      }),
    );
  }

  function fetchList(): void {
    const e = epoch;
    track(
      fetchMonthlyList(deps.fetch).then((result) => {
        if (e !== epoch) return;
        if (result.ok) list = { kind: "ready", items: result.reports };
        else if (list.kind !== "ready") list = { kind: "error", message: monthlyFetchFailureMessage(result.error) };
        deps.onChange();
      }),
    );
  }

  function resetOperations(): void {
    run = { kind: "idle" };
    regen = { kind: "idle" };
    watching = false;
  }

  function enter(month: string): void {
    if (active && month === shown) return; // 同じ指定で重ねて呼ばれた
    const wasActive = active;
    active = true;
    shown = month;
    gen += 1;
    resetOperations();
    if (!wasActive) {
      epoch += 1;
      list = { kind: "loading" };
      fetchList();
    }
    fetchDetail("first");
  }

  function leave(): void {
    epoch += 1;
    gen += 1;
    seq += 1;
    clearTimer();
    active = false;
    list = { kind: "loading" };
    detail = null;
    resetOperations();
    busy = false;
    pollStopped = false;
    failures = 0;
    polls = 0;
  }

  /** 依頼を出して、結果に応じて状態を進める共通の処理。`regenerate` は作り直し。 */
  function request(regenerate: boolean, since: string | null): void {
    const g = gen;
    const month = shown;
    track(
      postMonthlyRun(deps.fetch, month, regenerate).then((outcome) => {
        if (g !== gen || month !== shown) return;
        if (outcome.kind === "accepted" || outcome.kind === "accepted-malformed" || outcome.kind === "in-progress") {
          // サーバは依頼を受け付けている(または既に作成中)。作成中・作り直し中の表示にして、確認を始める。
          if (regenerate) regen = { kind: "requested", since: since! };
          else run = { kind: "requested" };
          pollStopped = false;
          failures = 0;
          polls = 0;
          fetchDetail("poll");
        } else if (outcome.kind === "already-exists" && !regenerate) {
          run = { kind: "idle" };
          fetchDetail("first");
        } else if (regenerate) {
          regen = { kind: "error", message: refusedMessage(outcome) };
        } else {
          run = { kind: "error", message: refusedMessage(outcome) };
        }
        deps.onChange();
      }),
    );
  }

  /** 作成を始められる状態か: 管理者・この画面に居る・終わった月で月報が無い・作成中でない。 */
  function canRun(): boolean {
    return !readOnly() && active && ended() && detail !== null && detail.kind === "ready" && detail.report === null && !waiting() && run.kind !== "posting" && run.kind !== "requested" && run.kind !== "no-report";
  }

  function onRun(): void {
    if (!canRun()) return;
    run = { kind: "posting" };
    deps.onChange();
    request(false, null);
  }

  /** 作り直しを始められる状態か: 管理者・この画面に居る・終わった月で月報がある・作り直し中でない。 */
  function canRegen(): boolean {
    return !readOnly() && active && ended() && detail !== null && detail.kind === "ready" && detail.report !== null && !waiting();
  }

  function onRegenOpen(): void {
    if (!canRegen() || regen.kind === "posting" || regen.kind === "confirm") return;
    regen = { kind: "confirm" };
    deps.onChange();
  }

  function onRegenCancel(): void {
    if (regen.kind !== "confirm") return;
    regen = { kind: "idle" };
    deps.onChange();
  }

  function onRegenGo(): void {
    if (regen.kind !== "confirm" || !canRegen() || detail === null || detail.kind !== "ready" || detail.report === null) return;
    const since = detail.report.createdAt;
    regen = { kind: "posting" };
    deps.onChange();
    request(true, since);
  }

  function onRefresh(): void {
    if (!active || busy || detail === null || detail.kind === "loading") return;
    run = run.kind === "error" || run.kind === "no-report" ? { kind: "idle" } : run;
    regen = regen.kind === "error" || regen.kind === "done" ? { kind: "idle" } : regen;
    fetchList();
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
    onRegenOpen,
    onRegenGo,
    onRegenCancel,
    onRefresh,
    onVisibilityChange,
    model: () => buildMonthlyModel({ today: deps.today(), shownMonth: shown, list, detail, run, regen, pollStopped, watching, readOnly: readOnly() }),
    pending: () => [...inflight],
  };
}
