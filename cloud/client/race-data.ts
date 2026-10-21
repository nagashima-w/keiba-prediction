/**
 * 一覧・レース・結果の読み込み(取得・メモリキャッシュ)と、板の追跡(ポーリング)。`app.ts` から切り出した(Issue #400 R-11b。振る舞いは変えない)。
 * DOM・fetch・時計は注入する(Node でテストできる)。画面(どれを出すか・ハッシュ)は `app.ts` が持ち、ここは「今の route」「今の画面」を関数で受け取る。
 *
 * **netkeiba への取得と DO の起動を、画面の操作で増やさない**(Issue #184):
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
 * **Issue #186(追跡)**:
 *  - 追跡(`tracker.ts`): `status`(race_id なし)を、実行中の開催日ごとに取る。持ち主はアプリ全体(一覧のバッジ・見出しの要約・レース画面のカードに反映)。
 *    追跡の開始: 起動の 202・409(`forceTrack`)、画面を開いたとき(初めて取った板)に queued・fetched がある、手動の「更新」・「状態を更新」(停止中なら再開)。ポーリングの結果は追跡を再開しない。
 *  - 板は `board-state.ts`(開催日ごとの行・通し番号・オーバーレイ・完了の検知)に持つ。レース画面のカードの行は最新の板から導く(`status?race_id=` は prior と板の初期値)。
 *  - 完了への遷移(同じ完了は 1 回): 朝は prior(`status?race_id=`)、発走前は過去の分析を取り直す(そのレースの画面にいれば取り直し、いなければキャッシュを捨てて、開いたときに取る)。
 *  - `/api/analyses/{id}`・`/api/races`・`status?race_id=`(完了時の取り直しを除く)は、ポーリングの周期では呼ばない(`/api/analyses/{id}` は、レース画面で発走前の完了を検知したとき、新しい id を 1 回だけ。下の Issue #188)。
 *
 * **Issue #188(発走前の結果をレース画面のカードの中に出す)**:
 *  - 最新の分析 = 板の発走前の行が `done` で `analysisId` を持つときのその id(`race.ts` の `latestAnalysisIdOf`。取る・出すの判定は同じ関数)。
 *  - 取得は `loadAnalysis`(id ごとに 1 回。結果画面と**同じキャッシュ・同じ 3 つの門**〈`analyses`・`analysisErrors`・`analysisInflight`〉)。再描画・ポーリング・hashchange の連打では増えない。失敗は自動で再試行しない。
 *  - 取るのは `syncLatestAnalysis`(冪等)を呼ぶ 2 箇所だけ: ① `ensureRace`(画面を開いたとき・戻ったとき=状態がキャッシュ済みで、他の画面にいる間に完了していた場合を含む)
 *    ② `applyBoard`(状態の取得の成功・ポーリング・板の取得。完了への遷移もここ)。**描画(`app.ts` の `render()`)からは取らない**(描画が取得を起こす構造にしない)。
 *  - レース画面の「更新」は、**失敗した最新の分析だけ**を取り直す(成功した分析は取り直さない=R2 の操作回数)。取得中の「更新」は無視する。
 *
 * **画面の判定は `currentScreen()`(`app.ts` が渡す)だけを使う**(Issue #191・#238)。ここで `screenOf(route)` を直接呼ばない
 * (閲覧者の `admin-only` の判定を素通りしないため。`test/client-route.test.ts` が `app.ts` とこのファイルを静的に読んで固定する)。
 */
import { failureMessage, fetchBoard, fetchRaces, fetchRaceStatus, type BoardRow, type FetchLike, type MorningPriorView, type RaceRow } from "./api";
import { fetchAnalysis, fetchPastAnalyses, type AnalysisDetail, type PastAnalysis } from "./api-analysis";
import type { AppScreen } from "./admin-only";
import { createBoardStore, type BoardCompletion, type BoardStore } from "./board-state";
import { listKey, raceKey } from "./keys";
import type { BoardSource, ListSource } from "./list";
import { latestAnalysisIdOf, type PastSource, type RaceStatusSource } from "./race";
import type { ResultSource } from "./result";
import type { Route, Venue } from "./route";
import { createTracker, trackingMessage, type CycleResult } from "./tracker";

export interface RaceDataDeps {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  /** 追跡のタイマー(Issue #186。`setTimeout` の薄い包み。テストでは偽物を渡して時間を手で進める)。 */
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  /** ページが表示されているか(`document.visibilityState`)。非表示の間、追跡は一時停止する。 */
  readonly isVisible: () => boolean;
  /** 今の route(完了を検知したとき、そのレースの画面にいるかを見る)。 */
  readonly route: () => Route;
  /** 今の画面(役割を反映したもの。Issue #238)。 */
  readonly currentScreen: () => AppScreen;
  /** 画面の再描画の要求(取得の完了・追跡の状態の変化)。 */
  readonly onChange: () => void;
}

export interface RaceData {
  // ---- 表示の元(キャッシュから導く) ----
  listSource(date: string, venue: Venue): ListSource;
  /** 一覧のキャッシュにあるそのレースの行(レース画面の見出し用)。 */
  listRowOf(date: string, venue: Venue, raceId: string): RaceRow | undefined;
  boardSource(date: string): BoardSource;
  /** その開催日の板を手動で取得中か。 */
  boardLoading(date: string): boolean;
  raceStatusSource(date: string, raceId: string): RaceStatusSource;
  pastSource(date: string, raceId: string): PastSource;
  analysisSource(id: number): ResultSource;
  /** 追跡の停止の注記(止まっていて、まだ実行中の行があるときだけ)。 */
  trackingNotice(): string | null;
  // ---- 板・追跡の道具(起動・一括実行へ関数で渡す) ----
  setOverlay: BoardStore["setOverlay"];
  /** 追跡の対象にその開催日を足し(実行中の行が無くても取る)、追跡を始める。 */
  forceTrack(date: string): void;
  // ---- 取得(無ければ取る。冪等) ----
  ensureList(date: string, venue: Venue): void;
  ensureRace(date: string, raceId: string): void;
  ensureResult(id: number): void;
  // ---- 「更新」(取得中・成功済みは何もしない。キャッシュを捨てて取り直し、再描画を要求する) ----
  refreshList(date: string, venue: Venue): void;
  refreshRace(date: string, raceId: string): void;
  refreshResult(id: number): void;
  // ---- 追跡 ----
  /** 「状態を更新」(停止中なら再開。すぐ 1 回取る)。 */
  onRetrack(): void;
  /** `visibilitychange` のとき。 */
  onVisibilityChange(): void;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

interface RaceStatusEntry {
  readonly rows: readonly BoardRow[];
  readonly prior: MorningPriorView | null;
}

/** prior の取り直しに失敗したときの注記の前置き(カードは残す)。 */
const PRIOR_NOTICE_PREFIX = "順位を取得できませんでした。";

export function createRaceData(deps: RaceDataDeps): RaceData {
  const currentScreen = deps.currentScreen;

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

  function trackedDates(): string[] {
    return [...new Set([...store.activeDates(), ...forceDates.keys()])].sort();
  }

  const tracker = createTracker({
    now: () => deps.now().getTime(),
    setTimer: (fn, ms) => deps.timers.set(fn, ms),
    clearTimer: (handle) => deps.timers.clear(handle),
    isVisible: deps.isVisible,
    cycle,
    onChange: () => deps.onChange(),
  });

  /** 追跡の停止の注記(止まっていて、まだ実行中の行があるときだけ。全部終わっていれば注記は要らない)。 */
  function trackingNotice(): string | null {
    const state = tracker.state();
    return state.kind === "stopped" && trackedDates().length > 0 ? trackingMessage(state.reason) : null;
  }

  function listSource(date: string, venue: Venue): ListSource {
    const key = listKey(date, venue);
    const cached = races.get(key);
    if (cached !== undefined) return { kind: "ready", races: cached };
    const error = raceErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function boardSource(date: string): BoardSource {
    const rows = store.effectiveRows(date);
    if (rows !== null) return { kind: "ready", rows };
    const error = boardErrors.get(date);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "none" };
  }

  function raceStatusSource(date: string, raceId: string): RaceStatusSource {
    const key = raceKey(date, raceId);
    const cached = raceStatuses.get(key);
    // カードの行は最新の板(ポーリング・オーバーレイを反映したもの)から導く。`status?race_id=` の応答は prior と板の初期値。
    if (cached !== undefined) return { kind: "ready", rows: store.effectiveRows(date) ?? cached.rows, prior: cached.prior, priorNotice: priorNotices.get(key) ?? null };
    const error = raceStatusErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function pastSource(date: string, raceId: string): PastSource {
    const key = raceKey(date, raceId);
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

  /** 追跡の対象にその開催日を足し(実行中の行が無くても取る)、追跡を始める。起動・一括実行を受け付けたあとに呼ぶ(`forceDates` に登録した通し番号より後に出した取得が届くまで残る)。 */
  function forceTrack(date: string): void {
    forceDates.set(date, store.nextSeq());
    tracker.begin({ immediate: false });
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
    syncLatestAnalysis();
  }

  function onCompleted(c: BoardCompletion): void {
    const route = deps.route();
    const key = raceKey(c.date, c.raceId);
    const onThisRace = currentScreen() === "race" && route.race === c.raceId && route.date === c.date;
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
      deps.onChange();
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
      deps.onChange();
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
      deps.onChange();
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
      deps.onChange();
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
      deps.onChange();
    });
    analysisInflight.set(id, promise);
  }

  /**
   * レース画面の最新の分析(Issue #188)を、無ければ取りに行く。冪等(`loadAnalysis` の 3 つの門)。状態が取れていない・最新の分析が無い(未実行・実行中・失敗・id なし)ときは何もしない。
   * 呼ぶのは `ensureRace` と `applyBoard` だけ(描画からは呼ばない)。
   */
  function syncLatestAnalysis(): void {
    if (currentScreen() !== "race") return;
    const route = deps.route();
    const raceId = route.race!;
    const status = raceStatusSource(route.date, raceId);
    if (status.kind !== "ready") return;
    const id = latestAnalysisIdOf(status.rows, raceId);
    if (id !== null) loadAnalysis(id);
  }

  /** 一覧の画面に必要なものを、無ければ取りに行く(一覧と板)。 */
  function ensureList(date: string, venue: Venue): void {
    loadRaces(date, venue);
    loadBoard(date);
  }

  /** レース画面に必要なものを、無ければ取りに行く(状態と過去の分析だけ。一覧・板は取らない)。 */
  function ensureRace(date: string, raceId: string): void {
    loadRaceStatus(date, raceId);
    loadPast(date, raceId);
    syncLatestAnalysis();
  }

  /** 結果画面に必要なものを、無ければ取りに行く(分析 1 本だけ)。 */
  function ensureResult(id: number): void {
    loadAnalysis(id);
  }

  // ---- 「更新」 ----

  function refreshResult(id: number): void {
    // 失敗した分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。取得中は何もしない。
    if (!analysisErrors.has(id) || analysisInflight.has(id)) return;
    analysisErrors.delete(id);
    ensureResult(id);
    deps.onChange();
  }

  function refreshRace(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    const status = raceStatusSource(date, raceId);
    const latestId = status.kind === "ready" ? latestAnalysisIdOf(status.rows, raceId) : null;
    if (raceStatusInflight.has(key) || pastInflight.has(key) || (latestId !== null && analysisInflight.has(latestId))) return;
    // 失敗した最新の分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。状態の取り直しが済むと `applyBoard` が取る。
    if (latestId !== null) analysisErrors.delete(latestId);
    raceStatuses.delete(key);
    raceStatusErrors.delete(key);
    priorNotices.delete(key);
    pasts.delete(key);
    pastErrors.delete(key);
    ensureRace(date, raceId);
    deps.onChange();
  }

  function refreshList(date: string, venue: Venue): void {
    // 取得中は何もしない(同じものを同時に 2 本取らない。ボタンも disabled)。
    if (raceInflight.has(listKey(date, venue)) || boardInflight.has(date)) return;
    const key = listKey(date, venue);
    races.delete(key);
    raceErrors.delete(key);
    // 板を捨てると、取得が届くまで「実行中の日」が見えなくなり、追跡が「全部終わった」と誤って止まる。実行中だった日は、取得が成功するまで追跡の対象に残す。
    if (store.activeDates().includes(date)) forceDates.set(date, store.nextSeq());
    store.clear(date);
    boardErrors.delete(date);
    ensureList(date, venue);
    deps.onChange();
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
      deps.onChange();
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

  return {
    listSource,
    listRowOf: (date, venue, raceId) => races.get(listKey(date, venue))?.find((r) => r.raceId === raceId),
    boardSource,
    boardLoading: (date) => boardInflight.has(date),
    raceStatusSource,
    pastSource,
    analysisSource,
    trackingNotice,
    setOverlay: store.setOverlay,
    forceTrack,
    ensureList,
    ensureRace,
    ensureResult,
    refreshList,
    refreshRace,
    refreshResult,
    onRetrack: () => tracker.begin({ immediate: true }),
    onVisibilityChange: () => tracker.onVisibilityChange(),
    pending: () => [...raceInflight.values(), ...boardInflight.values(), ...raceStatusInflight.values(), ...pastInflight.values(), ...analysisInflight.values(), ...pollInflight],
  };
}
