/**
 * 一覧の画面の制御(Issue #184)。取得・メモリキャッシュ・遷移。DOM・fetch・時計は注入する(Node でテストできる)。
 *
 * **netkeiba への取得と DO の起動を、画面の操作で増やさない**:
 *  - 一覧(`GET /api/races`)は (開催日, 区分) ごとに 1 回。画面の往復(一覧 → レース → 一覧、中央 → 地方 → 中央)で取り直さない
 *  - 板(`GET /api/analyses/status`。race_id なし)は開催日ごとに 1 回。区分を切り替えても取り直さない
 *  - 失敗は自動で再試行しない(「更新」だけが、現在の一覧と板を取り直す)。同じものを同時に 2 本取らない(取得中の再要求は束ねる)
 *  - 手動の取得の「同じものを同時に 2 本取らない」は、一覧・板・レース画面・結果画面の取得の話。**追跡(ポーリング)の板の取得は、この束ねの対象外**(止まった取得に束ねると再開できないため。
 *    応答の順序は `board-state.ts` の通し番号が守る)
 * Issue #185: レース画面(`#…&race=`)は、状態(`status?race_id=`)と過去の分析の一覧(`GET /api/analyses`)を (開催日, race_id) ごとに 1 回ずつ取る。
 * 結果画面(`#analysis=`)は `GET /api/analyses/{id}` を id ごとに 1 回(⚠️ サーバは R2 の操作回数を使う)。いずれも画面の往復で取り直さず、失敗も自動で再試行しない
 * (「更新」だけが、そのレースの 2 本、または失敗した分析の 1 本を取り直す。成功した分析に「更新」は無い)。
 * **レース画面・結果画面は、一覧(netkeiba に出る)と板(race_id なし)を取らない**。`race` と `analysis` が両方あれば結果画面(analysis)。
 * 表示は「現在のハッシュ + キャッシュ」から毎回導く(遅れて届いた結果は、キャッシュに入るだけで、今の画面を壊さない)。
 *
 * **Issue #186(起動と追跡)**:
 *  - 起動(`onRun`): `POST /api/analyses/run`。同期の印(`runStates`)を `await` の前に立てて二重押しを防ぐ。202・409 は板にオーバーレイ(待ち等)を重ねて追跡を始める。失敗は固定の文言(`runFailureMessage`)。
 *  - 追跡(`tracker.ts`): `status`(race_id なし)を、実行中の開催日ごとに取る。持ち主はアプリ全体(一覧のバッジ・見出しの要約・レース画面のカードに反映)。
 *    追跡の開始: 起動の 202・409、画面を開いたとき(初めて取った板)に queued・fetched がある、手動の「更新」・「状態を更新」(停止中なら再開)。ポーリングの結果は追跡を再開しない。
 *  - 板は `board-state.ts`(開催日ごとの行・通し番号・オーバーレイ・完了の検知)に持つ。レース画面のカードの行は最新の板から導く(`status?race_id=` は prior と板の初期値)。
 *  - 完了への遷移(同じ完了は 1 回): 朝は prior(`status?race_id=`)、発走前は過去の分析を取り直す(そのレースの画面にいれば取り直し、いなければキャッシュを捨てて、開いたときに取る)。
 *  - `/api/analyses/{id}`・`/api/races`・`status?race_id=`(完了時の取り直しを除く)は、ポーリングで呼ばない。
 */
import { failureMessage, fetchBoard, fetchRaces, fetchRaceStatus, type BoardRow, type FetchLike, type MorningPriorView, type RaceRow, type TaskMode } from "./api";
import { fetchAnalysis, fetchPastAnalyses, type AnalysisDetail, type PastAnalysis } from "./api-analysis";
import { postRun, runFailureMessage, type RunOutcome } from "./api-run";
import { createBoardStore, type BoardCompletion } from "./board-state";
import { inputToYmd, todayJst } from "./date";
import { buildListModel, type BoardSource, type ListSource } from "./list";
import { buildRaceModel, type PastSource, type RaceStatusSource, type RunUi } from "./race";
import { buildResultModel, type ResultSource } from "./result";
import { buildHash, parseHash, type Route, type Venue } from "./route";
import { createTracker, trackingMessage, type CycleResult } from "./tracker";
import { renderScreen } from "./view";
import type { VNode } from "./vnode";

export interface AppDeps {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  /** 描画。`force` が true のときは、木が同じでも DOM を置き換える(日付の入力欄を画面の値に戻すため。`createMounter`)。 */
  readonly render: (tree: VNode, force?: boolean) => void;
  readonly getHash: () => string;
  readonly setHash: (hash: string) => void;
  /** 追跡のタイマー(Issue #186。`setTimeout` の薄い包み。テストでは偽物を渡して時間を手で進める)。 */
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  /** ページが表示されているか(`document.visibilityState`)。非表示の間、追跡は一時停止する。 */
  readonly isVisible: () => boolean;
}

export interface App {
  start(): void;
  onHashChange(): void;
  /** `visibilitychange` のとき(Issue #186)。 */
  onVisibilityChange(): void;
  /** 取得中のものがすべて終わるまで待つ(テスト用。画面は使わない)。 */
  whenIdle(): Promise<void>;
}

const listKey = (date: string, venue: Venue): string => `${date}:${venue}`;
const raceKey = (date: string, raceId: string): string => `${date}:${raceId}`;

interface RaceStatusEntry {
  readonly rows: readonly BoardRow[];
  readonly prior: MorningPriorView | null;
}

const runKey = (date: string, raceId: string, mode: TaskMode): string => `${date}:${raceId}:${mode}`;

/** prior の取り直しに失敗したときの注記の前置き(カードは残す)。 */
const PRIOR_NOTICE_PREFIX = "順位を取得できませんでした。";

export function createApp(deps: AppDeps): App {
  let route: Route = parseHash(deps.getHash(), todayJst(deps.now()));

  const races = new Map<string, readonly RaceRow[]>();
  const raceErrors = new Map<string, string>();
  const raceInflight = new Map<string, Promise<void>>();
  // 板(`status`。race_id なし)は開催日ごと。行・通し番号・オーバーレイ・完了の検知は board-state.ts。手動の取得(開いたとき・「更新」)の失敗・取得中だけをここに持つ。
  const store = createBoardStore();
  const boardErrors = new Map<string, string>();
  const boardInflight = new Map<string, Promise<void>>();
  /**
   * 追跡で、実行中の行が無くても取る開催日(開催日 → 登録時の通し番号)。202 の本文が想定外だったとき・手動の更新で板を捨てたときに入れる。
   * **登録より後に出した取得**の応答が届いたら外す(登録より前に出した古い取得では外さない)。
   */
  const forceDates = new Map<string, number>();
  /** 追跡の板の取得(whenIdle の待ち対象。手動の取得の束ねの対象ではない)。 */
  const pollInflight = new Set<Promise<unknown>>();
  const runInflight = new Set<Promise<unknown>>();

  // 場ごとの開閉(Issue #187)。(開催日, 区分) ごとに、利用者が押した値だけを持つ(既定は描画のたびに導く)。「更新」では消さない。ハッシュ・localStorage には持たない。
  const openChoices = new Map<string, Map<string, boolean>>();

  const raceStatuses = new Map<string, RaceStatusEntry>();
  const raceStatusErrors = new Map<string, string>();
  const raceStatusInflight = new Map<string, Promise<void>>();
  /** 完了のあとの prior の取り直しに失敗した注記(カードは残す)。 */
  const priorNotices = new Map<string, string>();
  /** 取得中に完了を検知したレース(取得が終わったら取り直す)。 */
  const statusRefetchPending = new Set<string>();
  const pasts = new Map<string, readonly PastAnalysis[]>();
  const pastErrors = new Map<string, string>();
  const pastInflight = new Map<string, Promise<void>>();
  const pastRefetchPending = new Set<string>();
  const analyses = new Map<number, AnalysisDetail>();
  const analysisErrors = new Map<number, string>();
  const analysisInflight = new Map<number, Promise<void>>();

  /** 起動の操作の表示((開催日, レース, モード)ごと)。送信中の印は `await` の前に同期で立てる(二重押しを防ぐ)。 */
  const runStates = new Map<string, RunUi>();

  function trackedDates(): string[] {
    return [...new Set([...store.activeDates(), ...forceDates.keys()])].sort();
  }

  const tracker = createTracker({
    now: () => deps.now().getTime(),
    setTimer: (fn, ms) => deps.timers.set(fn, ms),
    clearTimer: (handle) => deps.timers.clear(handle),
    isVisible: deps.isVisible,
    cycle,
    onChange: () => render(),
  });

  /** 追跡の停止の注記(止まっていて、まだ実行中の行があるときだけ。全部終わっていれば注記は要らない)。 */
  function trackingNotice(): string | null {
    const state = tracker.state();
    return state.kind === "stopped" && trackedDates().length > 0 ? trackingMessage(state.reason) : null;
  }

  function listSource(): ListSource {
    const key = listKey(route.date, route.venue);
    const cached = races.get(key);
    if (cached !== undefined) return { kind: "ready", races: cached };
    const error = raceErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function boardSource(): BoardSource {
    const rows = store.effectiveRows(route.date);
    if (rows !== null) return { kind: "ready", rows };
    const error = boardErrors.get(route.date);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "none" };
  }

  function raceStatusSource(key: string, date: string): RaceStatusSource {
    const cached = raceStatuses.get(key);
    // カードの行は最新の板(ポーリング・オーバーレイを反映したもの)から導く。`status?race_id=` の応答は prior と板の初期値。
    if (cached !== undefined) return { kind: "ready", rows: store.effectiveRows(date) ?? cached.rows, prior: cached.prior, priorNotice: priorNotices.get(key) ?? null };
    const error = raceStatusErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function pastSource(key: string): PastSource {
    const cached = pasts.get(key);
    if (cached !== undefined) return { kind: "ready", analyses: cached };
    const error = pastErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function analysisSource(id: number): ResultSource {
    const cached = analyses.get(id);
    if (cached !== undefined) return { kind: "ready", analysis: cached };
    const error = analysisErrors.get(id);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function runsFor(date: string, raceId: string): Map<TaskMode, RunUi> {
    const runs = new Map<TaskMode, RunUi>();
    for (const mode of ["morning", "pre_race"] as const) {
      const state = runStates.get(runKey(date, raceId, mode));
      if (state !== undefined) runs.set(mode, state);
    }
    return runs;
  }

  const actions = { onDateChange, onRefresh, onToggleGroup, onRun, onRetrack };

  function render(force = false): void {
    if (route.analysis !== null) {
      deps.render(renderScreen(buildResultModel({ route, source: analysisSource(route.analysis) }), actions), force);
    } else if (route.race !== null) {
      const key = raceKey(route.date, route.race);
      const listRow = races.get(listKey(route.date, route.venue))?.find((r) => r.raceId === route.race);
      deps.render(
        renderScreen(buildRaceModel({ route, status: raceStatusSource(key, route.date), past: pastSource(key), listRow, runs: runsFor(route.date, route.race), tracking: trackingNotice() }), actions),
        force,
      );
    } else {
      deps.render(
        renderScreen(
          buildListModel({ route, list: listSource(), board: boardSource(), boardLoading: boardInflight.has(route.date), tracking: trackingNotice(), choices: openChoices.get(listKey(route.date, route.venue)) }),
          actions,
        ),
        force,
      );
    }
  }

  // ---- 板の適用・完了への遷移 ----

  /** 取得した板を適用する(古い応答は捨てられる)。完了への遷移があれば、prior・過去の分析を取り直す。`priorFreshFor`: この取得は、そのレースの prior と同時に取ったもの(朝の完了で取り直さない)。 */
  function applyBoard(date: string, rows: readonly BoardRow[], seq: number, priorFreshFor?: string): void {
    const { completions } = store.apply(date, rows, seq);
    const forced = forceDates.get(date);
    if (forced !== undefined && seq > forced) forceDates.delete(date); // 登録より後に出した取得が届いた(板が最新になった)
    for (const completion of completions) {
      if (completion.mode === "morning" && completion.raceId === priorFreshFor) continue;
      onCompleted(completion);
    }
  }

  function onCompleted(c: BoardCompletion): void {
    const key = raceKey(c.date, c.raceId);
    const onThisRace = route.analysis === null && route.race === c.raceId && route.date === c.date;
    if (c.mode === "morning") {
      if (raceStatusInflight.has(key)) statusRefetchPending.add(key);
      else if (onThisRace) startStatusFetch(c.date, c.raceId, "refresh");
      else {
        raceStatuses.delete(key);
        raceStatusErrors.delete(key);
        priorNotices.delete(key);
      }
    } else if (pastInflight.has(key)) {
      pastRefetchPending.add(key);
    } else if (onThisRace) {
      startPastFetch(c.date, c.raceId);
    } else {
      pasts.delete(key);
      pastErrors.delete(key);
    }
  }

  // ---- 取得 ----

  function loadRaces(date: string, venue: Venue): void {
    const key = listKey(date, venue);
    if (races.has(key) || raceErrors.has(key) || raceInflight.has(key)) return;
    const promise = fetchRaces(deps.fetch, date, venue).then((result) => {
      raceInflight.delete(key);
      if (result.ok) races.set(key, result.races);
      else raceErrors.set(key, failureMessage(result.error));
      render();
    });
    raceInflight.set(key, promise);
  }

  function loadBoard(date: string): void {
    if (store.has(date) || boardErrors.has(date) || boardInflight.has(date)) return;
    const seq = store.nextSeq();
    const promise = fetchBoard(deps.fetch, date).then((result) => {
      boardInflight.delete(date);
      if (result.ok) {
        boardErrors.delete(date);
        applyBoard(date, result.rows, seq);
        ensureTracking();
      } else {
        boardErrors.set(date, failureMessage(result.error));
      }
      render();
    });
    boardInflight.set(date, promise);
  }

  /** 状態(`status?race_id=`)を取る。`refresh` は完了のあとの取り直しで、成功したカードを残したまま(失敗は注記だけ)。 */
  function startStatusFetch(date: string, raceId: string, kind: "open" | "refresh"): void {
    const key = raceKey(date, raceId);
    const seq = store.nextSeq();
    const promise = fetchRaceStatus(deps.fetch, date, raceId).then((result) => {
      raceStatusInflight.delete(key);
      if (result.ok) {
        raceStatuses.set(key, { rows: result.rows, prior: result.prior });
        raceStatusErrors.delete(key);
        priorNotices.delete(key);
        applyBoard(date, result.rows, seq, raceId);
        ensureTracking();
      } else if (kind === "refresh" && raceStatuses.has(key)) {
        priorNotices.set(key, `${PRIOR_NOTICE_PREFIX}${failureMessage(result.error)}`);
      } else {
        raceStatusErrors.set(key, failureMessage(result.error));
      }
      if (statusRefetchPending.delete(key)) startStatusFetch(date, raceId, "refresh");
      render();
    });
    raceStatusInflight.set(key, promise);
  }

  function loadRaceStatus(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    if (raceStatuses.has(key) || raceStatusErrors.has(key) || raceStatusInflight.has(key)) return;
    startStatusFetch(date, raceId, "open");
  }

  function startPastFetch(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    pasts.delete(key);
    pastErrors.delete(key);
    const promise = fetchPastAnalyses(deps.fetch, date, raceId).then((result) => {
      pastInflight.delete(key);
      if (result.ok) pasts.set(key, result.analyses);
      else pastErrors.set(key, failureMessage(result.error));
      if (pastRefetchPending.delete(key)) startPastFetch(date, raceId);
      render();
    });
    pastInflight.set(key, promise);
  }

  function loadPast(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    if (pasts.has(key) || pastErrors.has(key) || pastInflight.has(key)) return;
    startPastFetch(date, raceId);
  }

  function loadAnalysis(id: number): void {
    if (analyses.has(id) || analysisErrors.has(id) || analysisInflight.has(id)) return;
    const promise = fetchAnalysis(deps.fetch, id).then((result) => {
      analysisInflight.delete(id);
      if (result.ok) analyses.set(id, result.analysis);
      else analysisErrors.set(id, failureMessage(result.error));
      render();
    });
    analysisInflight.set(id, promise);
  }

  /** 今の画面に必要なものを、無ければ取りに行く。結果画面は分析 1 本だけ・レース画面は状態と過去の分析だけ(一覧・板は取らない)。 */
  function ensureLoaded(): void {
    if (route.analysis !== null) {
      loadAnalysis(route.analysis);
    } else if (route.race !== null) {
      loadRaceStatus(route.date, route.race);
      loadPast(route.date, route.race);
    } else {
      loadRaces(route.date, route.venue);
      loadBoard(route.date);
    }
  }

  // ---- 追跡 ----

  /** 追跡の 1 周期: 実行中の開催日ごとに板(`status`。race_id なし)を取り、適用する。**手動の取得の束ねの対象外**(止まった取得に束ねない)。 */
  async function cycle(): Promise<CycleResult> {
    const results = await Promise.all(trackedDates().map((date) => pollDate(date)));
    return { ok: results.every((r) => r), remaining: trackedDates().length };
  }

  function pollDate(date: string): Promise<boolean> {
    const promise = (async () => {
      const seq = store.nextSeq();
      const result = await fetchBoard(deps.fetch, date);
      if (!result.ok) return false; // 板の注記(boardErrors)には入れない(最後に取れた板を残す)。失敗は追跡が数える
      applyBoard(date, result.rows, seq);
      render();
      return true;
    })();
    pollInflight.add(promise);
    void promise.finally(() => pollInflight.delete(promise));
    return promise;
  }

  /** 実行中の行があり、追跡していなければ始める(停止中でも。手動の取得・画面を開いたときに呼ぶ)。追跡中は何もしない(予算を延ばさない)。 */
  function ensureTracking(): void {
    if (tracker.state().kind === "running") return;
    if (trackedDates().length === 0) return;
    tracker.begin({ immediate: false });
  }

  // ---- 起動 ----

  function onRun(date: string, raceId: string, mode: TaskMode): void {
    const key = runKey(date, raceId, mode);
    if (runStates.get(key)?.kind === "sending") return; // 同期の印(await の前)。二重押しを防ぐ
    runStates.set(key, { kind: "sending" });
    render();
    const promise = postRun(deps.fetch, { raceId, date, mode }).then((outcome) => {
      finishRun(key, date, raceId, mode, outcome);
      render();
    });
    runInflight.add(promise);
    void promise.finally(() => runInflight.delete(promise));
  }

  function finishRun(key: string, date: string, raceId: string, mode: TaskMode, outcome: RunOutcome): void {
    const nowMs = deps.now().getTime();
    switch (outcome.kind) {
      case "accepted":
        runStates.delete(key);
        store.setOverlay(date, raceId, mode, "queued", nowMs);
        forceDates.set(date, store.nextSeq());
        tracker.begin({ immediate: false });
        return;
      case "already-running":
        runStates.set(key, { kind: "already" });
        store.setOverlay(date, raceId, mode, outcome.status, nowMs);
        forceDates.set(date, store.nextSeq());
        tracker.begin({ immediate: false });
        return;
      case "accepted-malformed":
        // サーバは受け付けている(202)が、本文が想定外。失敗の文言を出し、追跡は始める(板が真実を教える)。
        runStates.set(key, { kind: "error", message: runFailureMessage({ kind: "unexpected", httpStatus: 202 }) });
        forceDates.set(date, store.nextSeq());
        tracker.begin({ immediate: false });
        return;
      case "failed":
        runStates.set(key, { kind: "error", message: runFailureMessage(outcome.failure) });
        return;
    }
  }

  function onRetrack(): void {
    tracker.begin({ immediate: true });
  }

  // ---- 画面の操作 ----

  function onHashChange(): void {
    route = parseHash(deps.getHash(), todayJst(deps.now()));
    ensureLoaded();
    render();
  }

  function onDateChange(value: string): void {
    const ymd = inputToYmd(value);
    if (ymd === null) {
      // 不正・空の入力: 画面のデータは変わらないので木は同じ。強制の再描画で、入力欄を画面の日付に戻す。
      render(true);
      return;
    }
    deps.setHash(buildHash({ date: ymd, venue: route.venue }));
  }

  function onToggleGroup(key: string, open: boolean): void {
    // 取得は起こさず、描画だけ。
    const k = listKey(route.date, route.venue);
    const choices = openChoices.get(k) ?? new Map<string, boolean>();
    choices.set(key, open);
    openChoices.set(k, choices);
    render();
  }

  function onRefresh(): void {
    if (route.analysis !== null) {
      // 失敗した分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。取得中は何もしない。
      const id = route.analysis;
      if (!analysisErrors.has(id) || analysisInflight.has(id)) return;
      analysisErrors.delete(id);
      ensureLoaded();
      render();
      return;
    }
    if (route.race !== null) {
      const key = raceKey(route.date, route.race);
      if (raceStatusInflight.has(key) || pastInflight.has(key)) return;
      raceStatuses.delete(key);
      raceStatusErrors.delete(key);
      priorNotices.delete(key);
      pasts.delete(key);
      pastErrors.delete(key);
      ensureLoaded();
      render();
      return;
    }
    // 取得中は何もしない(同じものを同時に 2 本取らない。ボタンも disabled)。
    if (raceInflight.has(listKey(route.date, route.venue)) || boardInflight.has(route.date)) return;
    const key = listKey(route.date, route.venue);
    races.delete(key);
    raceErrors.delete(key);
    // 板を捨てると、取得が届くまで「実行中の日」が見えなくなり、追跡が「全部終わった」と誤って止まる。実行中だった日は、取得が成功するまで追跡の対象に残す。
    if (store.activeDates().includes(route.date)) forceDates.set(route.date, store.nextSeq());
    store.clear(route.date);
    boardErrors.delete(route.date);
    ensureLoaded();
    render();
  }

  return {
    start() {
      ensureLoaded();
      render();
    },
    onHashChange,
    onVisibilityChange: () => tracker.onVisibilityChange(),
    async whenIdle() {
      // 取得が終わるたびに新しい取得は始まらない(失敗の自動再試行なし。追跡のタイマーは偽・実物とも待たない)ので、数回の確認で必ず止まる。
      const pending = () => [...raceInflight.values(), ...boardInflight.values(), ...raceStatusInflight.values(), ...pastInflight.values(), ...analysisInflight.values(), ...pollInflight, ...runInflight];
      for (let i = 0; i < 10 && pending().length > 0; i += 1) {
        await Promise.all(pending());
      }
    },
  };
}
