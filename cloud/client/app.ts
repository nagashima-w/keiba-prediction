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
 *  - 起動(`onRun`): `POST /api/analyses/run`。状態・POST・結果の表示は `run-control.ts` が持つ(Issue #400 R-11。同期の印を `await` の前に立てて二重押しを防ぐ。202・409 は板にオーバーレイ〈`setOverlay`〉を重ねて追跡を始める〈`forceTrack`〉)。
 *    場ごとの一括実行(Issue #251)も同じ形で `bulk-control.ts` が持つ。ここは板・追跡の道具(`store`・`forceDates`・`tracker`)を関数で渡す。
 *  - 追跡(`tracker.ts`): `status`(race_id なし)を、実行中の開催日ごとに取る。持ち主はアプリ全体(一覧のバッジ・見出しの要約・レース画面のカードに反映)。
 *    追跡の開始: 起動の 202・409、画面を開いたとき(初めて取った板)に queued・fetched がある、手動の「更新」・「状態を更新」(停止中なら再開)。ポーリングの結果は追跡を再開しない。
 *  - 板は `board-state.ts`(開催日ごとの行・通し番号・オーバーレイ・完了の検知)に持つ。レース画面のカードの行は最新の板から導く(`status?race_id=` は prior と板の初期値)。
 *  - 完了への遷移(同じ完了は 1 回): 朝は prior(`status?race_id=`)、発走前は過去の分析を取り直す(そのレースの画面にいれば取り直し、いなければキャッシュを捨てて、開いたときに取る)。
 *  - `/api/analyses/{id}`・`/api/races`・`status?race_id=`(完了時の取り直しを除く)は、ポーリングの周期では呼ばない(`/api/analyses/{id}` は、レース画面で発走前の完了を検知したとき、新しい id を 1 回だけ。下の Issue #188)。
 *
 * **Issue #189(設定画面。`#settings`)**: 開くと `GET /api/settings` だけを取る(一覧・板・レース・分析は取らない)。状態・取得・保存・プレビュー(#201・#396)・世代・下書きは `settings-screen.ts` が持ち(Issue #400 R-11 で切り出した。
 *   詳細はそのファイルの先頭)、ここは出入り(`enter`・`leave`)・描画(`model(force)`)・「再読込」を渡すだけ。強制なしの描画は画面に出ている内容の写しから木を作る(打っている欄を壊さない)。
 *   画面を離れたら破棄し(`leave`)、戻ると取り直す。
 *
 * **Issue #219(検証画面。`#verify`)**: 一覧の入口のリンク先の**別の画面**。状態・取得・区分の切替・更新・ポーリングは `verify-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画・可視状態の中継だけ。
 *  - 開くと `GET /api/verify?venue=all` だけを取る(一覧・板・設定・レース・分析は取らない)。他の画面は `/api/verify` を取らない。補完中だけ自動で取り直し(3〜5 秒)、離れると状態・タイマー・遅れて届く応答を捨てる。
 *
 * **Issue #235(日報画面。`#report`・`#report=YYYYMMDD`)**: 一覧の入口のリンク先の**別の画面**。状態・取得・日付の切替・手動の作成・作成中のポーリングは `report-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画・可視状態を渡すだけ。
 *  - 開くと `GET /api/reports`(日付の一覧)と、表示する日の `GET /api/reports/{date}` だけを取る(一覧・板・設定・レース・分析・検証は取らない)。他の画面は `/api/reports` を取らない。作成中だけ自動で取り直し(5 秒)、離れると状態・タイマーを捨てる。
 *
 * **Issue #279(月報。`#report=YYYYMM`。日報の画面の中の「月」)**: 画面の種類(`screenOf`)は `report` のまま。状態・取得・月の切替・更新は `monthly-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画を渡すだけ。
 *  - 開くと `GET /api/monthly-reports`(月の一覧)と、表示する月の `GET /api/monthly-reports/{month}` だけを取る(日報・一覧・板・設定・レース・分析・検証は取らない)。日報の画面は月報の API を取らない。
 *  - **Issue #280**: 管理者だけの「この月の月報を作る」「月報を作り直す」(確認つき)と、作成中・作り直し中の確認(5 秒のポーリング。非表示の間は止める)も `monthly-screen.ts` が持つ。ビューの操作は日報の画面と共通
 *    (`onReportRun`・`onReportRegen*`)で、ここが表示中の側(日報か月報)に振り分ける。POST の先は日報が `/api/reports/run`、月報が `/api/monthly-reports/run`。
 *  - 日報 ⇄ 月報の行き来(タブ・日ごとの行のリンク)では、出る側の状態を捨ててから入る側を開く(片方の状態をもう片方へ持ち越さない)。
 *
 * **Issue #188(発走前の結果をレース画面のカードの中に出す)**:
 *  - 最新の分析 = 板の発走前の行が `done` で `analysisId` を持つときのその id(`race.ts` の `latestAnalysisIdOf`。取る・出すの判定は同じ関数)。
 *  - 取得は `loadAnalysis`(id ごとに 1 回。結果画面と**同じキャッシュ・同じ 3 つの門**〈`analyses`・`analysisErrors`・`analysisInflight`〉)。再描画・ポーリング・hashchange の連打では増えない。失敗は自動で再試行しない。
 *  - 取るのは `syncLatestAnalysis`(冪等)を呼ぶ 2 箇所だけ: ① `ensureLoaded`(画面を開いたとき・戻ったとき=状態がキャッシュ済みで、他の画面にいる間に完了していた場合を含む)
 *    ② `applyBoard`(状態の取得の成功・ポーリング・板の取得。完了への遷移もここ)。**`render()` からは取らない**(描画が取得を起こす構造にしない)。
 *  - レース画面の「更新」は、**失敗した最新の分析だけ**を取り直す(成功した分析は取り直さない=R2 の操作回数)。取得中の「更新」は無視する。
 *  - 結果の開閉(`resultOpen`)は (開催日, race_id) ごとにメモリに持つ(#187 と同じ。既定は開・ハッシュ/localStorage には持たない・「更新」で消さない)。
 */
import { failureMessage, fetchBoard, fetchRaces, fetchRaceStatus, type BoardRow, type FetchLike, type MorningPriorView, type RaceRow } from "./api";
import { fetchAnalysis, fetchPastAnalyses, type AnalysisDetail, type PastAnalysis } from "./api-analysis";
import { createBulkControl } from "./bulk-control";
import { createRunControl } from "./run-control";
import { createBoardStore, type BoardCompletion } from "./board-state";
import { inputToYmd, todayJst } from "./date";
import { listKey, raceKey } from "./keys";
import { buildListModel, needsListClock, type BoardSource, type ListSource } from "./list";
import { createListClock } from "./list-clock";
import { buildRaceModel, latestAnalysisIdOf, type PastSource, type RaceStatusSource } from "./race";
import { buildResultModel, type ResultSource } from "./result";
import { createSettingsScreen } from "./settings-screen";
import { createVerifyScreen } from "./verify-screen";
import { createMonthlyScreen } from "./monthly-screen";
import { createReportScreen } from "./report-screen";
import { createTargetsScreen } from "./targets-screen";
import { buildHash, buildReportHash, parseHash, screenOf, type Route, type Screen, type Venue } from "./route";
import { buildAdminOnlyModel } from "./admin-only";
import { isAdmin, type Role } from "./role";
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
  /**
   * 役割(Issue #238。サーバが `#app` の `data-role` で渡す)。**閲覧者(`admin` 以外のすべて)には、設定への入口・分析の実行ボタン・日報の作成ボタンを出さず、
   * 設定の画面を直接開いても API を取らずに案内だけを出す**。画面で隠すのは補助で、拒否はサーバ側(403)。
   * 検証は Issue #263 で閲覧者にも開いた(入口も出る)。閲覧者には「更新」ボタンを出さず、集計のやり直しを起こさない(サーバがキャッシュを返すだけ)。
   */
  readonly role: Role;
}

export interface App {
  start(): void;
  onHashChange(): void;
  /** `visibilitychange` のとき(Issue #186)。 */
  onVisibilityChange(): void;
  /** 取得中のものがすべて終わるまで待つ(テスト用。画面は使わない)。 */
  whenIdle(): Promise<void>;
}


interface RaceStatusEntry {
  readonly rows: readonly BoardRow[];
  readonly prior: MorningPriorView | null;
}

/** 画面の `switch` の網羅チェック(Issue #191)。`Screen` に画面を足して `case` を足し忘れると、ここで型エラーになる。 */
function assertNever(screen: never): never {
  throw new Error(`未対応の画面です: ${String(screen)}`);
}

/** prior の取り直しに失敗したときの注記の前置き(カードは残す)。 */
const PRIOR_NOTICE_PREFIX = "順位を取得できませんでした。";

/** 管理者だけの画面(Issue #238)。閲覧者が開いたときは、API を取らずに案内だけを出す(`admin-only`)。 */
const ADMIN_SCREENS: ReadonlySet<Screen> = new Set<Screen>(["settings"]);

/** 今の画面(Issue #238)。route から決まる画面に、役割で決まる `admin-only` を足したもの。 */
type AppScreen = Screen | "admin-only";

export function createApp(deps: AppDeps): App {
  let route: Route = parseHash(deps.getHash(), todayJst(deps.now()));
  /** 管理者か(`admin` の完全一致だけ。それ以外の値は閲覧者)。 */
  const admin = isAdmin(deps.role);

  /**
   * 今の画面の判定の**唯一の場所**(Issue #191 の `screenOf` に、Issue #238 の役割を足したもの)。閲覧者が管理者だけの画面(設定。検証は Issue #263 で閲覧者にも開いた)の route に居るときは
   * `admin-only` を返す。**app.ts の画面ごとの分岐は、すべてこの関数を通す**(`screenOf(route)` を直接使わない)ので、閲覧者は設定の取得も下書きも始めない。
   */
  function currentScreen(): AppScreen {
    const screen = screenOf(route);
    return !admin && ADMIN_SCREENS.has(screen) ? "admin-only" : screen;
  }

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
  /** 発走前のカードの結果の開閉(Issue #188)。(開催日, race_id) ごとに、利用者が押した値だけを持つ(既定は開)。 */
  const resultOpenChoices = new Map<string, boolean>();
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

  // ---- 起動(Issue #186)・場ごとの一括実行(Issue #251。管理者だけ) ----
  // 状態・POST・結果の表示は `run-control.ts`・`bulk-control.ts` が持つ(Issue #400 R-11)。板・追跡の道具(オーバーレイ・追跡の開始)は、ここ(`store`・`forceDates`・`tracker`)を関数で渡す。

  /** 追跡の対象にその開催日を足し(実行中の行が無くても取る)、追跡を始める。起動・一括実行を受け付けたあとに呼ぶ(`forceDates` に登録した通し番号より後に出した取得が届くまで残る)。 */
  function forceTrack(date: string): void {
    forceDates.set(date, store.nextSeq());
    tracker.begin({ immediate: false });
  }

  const run = createRunControl({ fetch: deps.fetch, now: deps.now, admin, onChange: () => render(), setOverlay: store.setOverlay, forceTrack });

  const bulk = createBulkControl({
    fetch: deps.fetch,
    now: deps.now,
    admin,
    onChange: () => render(),
    route: () => route,
    isListScreen: () => currentScreen() === "list",
    listSource,
    boardRows: () => {
      const source = boardSource();
      return source.kind === "ready" ? source.rows : null;
    },
    setOverlay: store.setOverlay,
    forceTrack,
  });

  // ---- 設定画面(Issue #189) ----
  // 状態・取得・保存・プレビューは `settings-screen.ts` が持つ(Issue #400 R-11)。閲覧者の route は `currentScreen()` が admin-only にするので、`isActive()` は false になる。
  const settings = createSettingsScreen({
    fetch: deps.fetch,
    isActive: () => currentScreen() === "settings",
    onChange: (force) => render(force),
  });

  // ---- 検証画面(Issue #219) ----
  // Issue #263: 閲覧者にも開く。閲覧者には更新ボタンを出さず、「更新」(refresh=1)も送らない(サーバも閲覧者の refresh は無視し、集計のやり直しを起こさない)。
  const verify = createVerifyScreen({
    fetch: deps.fetch,
    timers: deps.timers,
    isVisible: deps.isVisible,
    admin,
    onChange: () => render(),
  });

  // ---- 今日の狙い目の画面(Issue #336) ----
  // 閲覧者にも同じに開く(読み取りだけ)。取得は GET /api/targets だけ。残り時間は取得なしで 30 秒ごとに再描画し、取り直しは 3 分ごと(見えている間・今日・発走前のレースか結果待ちの行が残る間〈まだ分析が 1 件も無い間も〉・上限つき)。
  const targets = createTargetsScreen({
    fetch: deps.fetch,
    now: () => deps.now().getTime(),
    timers: deps.timers,
    isVisible: deps.isVisible,
    today: () => todayJst(deps.now()),
    onChange: () => render(),
  });

  // ---- 日報画面(Issue #235) ----
  const report = createReportScreen({
    fetch: deps.fetch,
    timers: deps.timers,
    isVisible: deps.isVisible,
    today: () => todayJst(deps.now()),
    onChange: () => render(),
    readOnly: !admin,
  });

  // ---- 月報画面(Issue #279。日報の画面の中の「月」) ----
  const monthly = createMonthlyScreen({
    fetch: deps.fetch,
    timers: deps.timers,
    isVisible: deps.isVisible,
    today: () => todayJst(deps.now()),
    onChange: () => render(),
    readOnly: !admin,
  });

  /** 今のルートが月報(`#report=YYYYMM`)か。日報の画面の中の 2 つの表示のどちらか。 */
  const isMonthlyRoute = (): boolean => route.report?.month !== undefined;

  const actions = {
    onDateChange,
    onRefresh,
    onToggleGroup,
    onToggleResult,
    onRun: run.onRun,
    onBulkOpen: bulk.onOpen,
    onBulkGo: bulk.onGo,
    onBulkDismiss: bulk.onDismiss,
    onRetrack,
    onSettingsInput: settings.onInput,
    onSettingsSave: settings.onSave,
    onSettingsPreviewToggle: settings.onPreviewToggle,
    onSettingsPreviewRefresh: settings.onPreviewRefresh,
    onSettingsWeightsReset: settings.onWeightsReset,
    onVerifyVenue: verify.onVenue,
    onVerifyVersionToggle: verify.onVersionToggle,
    onVerifyCalibrationTarget: verify.onCalibrationTarget,
    // 日報と月報の画面は同じ操作(作る・作り直す)を持つので、表示中の側に振り分ける(Issue #280)。
    onReportRun: () => (isMonthlyRoute() ? monthly.onRun() : report.onRun()),
    onReportRegenOpen: () => (isMonthlyRoute() ? monthly.onRegenOpen() : report.onRegenOpen()),
    onReportRegenGo: () => (isMonthlyRoute() ? monthly.onRegenGo() : report.onRegenGo()),
    onReportRegenCancel: () => (isMonthlyRoute() ? monthly.onRegenCancel() : report.onRegenCancel()),
    onReportDateChange,
  };

  /** 一覧の並べ替えの再描画のタイマー(Issue #346)。`render` の末尾で毎回 `sync` する(冪等)。 */
  const listClock = createListClock({ timers: deps.timers, isVisible: deps.isVisible, onChange: () => render() });

  function render(force = false): void {
    draw(force);
    const shown = listSource();
    listClock.sync(currentScreen() === "list" && shown.kind === "ready" && needsListClock(shown.races, route.date, deps.now()));
  }

  function draw(force: boolean): void {
    const screen = currentScreen();
    switch (screen) {
      case "admin-only": {
        deps.render(renderScreen(buildAdminOnlyModel(), actions), force);
        return;
      }
      case "result": {
        deps.render(renderScreen(buildResultModel({ route, source: analysisSource(route.analysis!), readOnly: !admin }), actions), force);
        return;
      }
      case "race": {
        const raceId = route.race!;
        const key = raceKey(route.date, raceId);
        const listRow = races.get(listKey(route.date, route.venue))?.find((r) => r.raceId === raceId);
        const status = raceStatusSource(key, route.date);
        const latestId = status.kind === "ready" ? latestAnalysisIdOf(status.rows, raceId) : null;
        deps.render(
          renderScreen(
            buildRaceModel({
              route,
              status,
              past: pastSource(key),
              listRow,
              runs: run.runsFor(route.date, raceId),
              tracking: trackingNotice(),
              ...(latestId === null ? {} : { result: analysisSource(latestId) }),
              resultOpen: resultOpenChoices.get(key) ?? true,
              readOnly: !admin,
            }),
            actions,
          ),
          force,
        );
        return;
      }
      case "settings": {
        // 強制描画のとき、または画面に入った直後(まだ写していない)は、今の状態を写す。それ以外(強制なし)は、画面に出ている内容の写しから作る(`settings-screen.ts`)。
        deps.render(renderScreen(settings.model(force), actions), force);
        return;
      }
      case "verify": {
        deps.render(renderScreen(verify.model(), actions), force);
        return;
      }
      case "report": {
        deps.render(renderScreen(isMonthlyRoute() ? monthly.model() : report.model(), actions), force);
        return;
      }
      case "targets": {
        const model = targets.model();
        if (model !== null) deps.render(renderScreen(model, actions), force);
        return;
      }
      case "list": {
        deps.render(
          renderScreen(
            buildListModel({
              route,
              list: listSource(),
              board: boardSource(),
              boardLoading: boardInflight.has(route.date),
              tracking: trackingNotice(),
              choices: openChoices.get(listKey(route.date, route.venue)),
              readOnly: !admin,
              now: deps.now(),
              bulk: { now: deps.now(), states: bulk.statesOf(listKey(route.date, route.venue)) },
            }),
            actions,
          ),
          force,
        );
        return;
      }
      default:
        return assertNever(screen);
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
    syncLatestAnalysis();
  }

  function onCompleted(c: BoardCompletion): void {
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

  /**
   * レース画面の最新の分析(Issue #188)を、無ければ取りに行く。冪等(`loadAnalysis` の 3 つの門)。状態が取れていない・最新の分析が無い(未実行・実行中・失敗・id なし)ときは何もしない。
   * 呼ぶのは `ensureLoaded` と `applyBoard` だけ(`render()` からは呼ばない)。
   */
  function syncLatestAnalysis(): void {
    if (currentScreen() !== "race") return;
    const raceId = route.race!;
    const status = raceStatusSource(raceKey(route.date, raceId), route.date);
    if (status.kind !== "ready") return;
    const id = latestAnalysisIdOf(status.rows, raceId);
    if (id !== null) loadAnalysis(id);
  }

  /** 今の画面に必要なものを、無ければ取りに行く。結果画面は分析 1 本だけ・レース画面は状態と過去の分析だけ(一覧・板は取らない)。 */
  function ensureLoaded(): void {
    const screen = currentScreen();
    switch (screen) {
      case "admin-only":
        return; // 閲覧者が管理者だけの画面を開いた: 何も取らない(案内だけ)
      case "result":
        loadAnalysis(route.analysis!);
        return;
      case "race": {
        const raceId = route.race!;
        loadRaceStatus(route.date, raceId);
        loadPast(route.date, raceId);
        syncLatestAnalysis();
        return;
      }
      case "list":
        loadRaces(route.date, route.venue);
        loadBoard(route.date);
        return;
      case "settings":
        settings.enter(); // まだ取っていなければ取る(重ねて呼んでも取得は増えない)
        return;
      case "verify":
        verify.enter();
        return;
      case "targets":
        targets.enter(route.targets!.date);
        return;
      case "report":
        // 日報 ⇄ 月報(Issue #279): 出る側を離れてから入る側を開く(`leave` は開いていなければ何も起きない)。同じ画面の中の日付・月の切替も、ここ(重ねて呼んでも同じ日・月の取得は増えない)。
        if (route.report?.month !== undefined) {
          report.leave();
          monthly.enter(route.report.month);
        } else {
          monthly.leave();
          report.enter(route.report?.date ?? null);
        }
        return;
      default:
        return assertNever(screen);
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

  function onRetrack(): void {
    tracker.begin({ immediate: true });
  }

  // ---- 画面の操作 ----

  function onHashChange(): void {
    const wasSettings = currentScreen() === "settings";
    const wasVerify = currentScreen() === "verify";
    const wasReport = currentScreen() === "report";
    const wasTargets = currentScreen() === "targets";
    route = parseHash(deps.getHash(), todayJst(deps.now()));
    if (wasSettings && currentScreen() !== "settings") settings.leave(); // 画面を離れたら下書きを破棄する
    if (wasVerify && currentScreen() !== "verify") verify.leave(); // 検証の状態(タイマー・遅れて届く応答)を破棄する
    if (wasTargets && currentScreen() !== "targets") targets.leave(); // 狙い目の状態(タイマー・遅れて届く応答)を破棄する
    if (wasReport && currentScreen() !== "report") {
      report.leave(); // 日報の状態(タイマー・遅れて届く応答)を破棄する
      monthly.leave(); // 月報の状態(遅れて届く応答)を破棄する
    }
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

  /** 日報画面の日付の入力(Issue #273)。有効な日付なら `#report=YYYYMMDD` へ(前・今日・次のリンクと同じ経路)。空・不正は無視し、強制の再描画で入力欄を表示中の日に戻す。 */
  function onReportDateChange(value: string): void {
    const ymd = inputToYmd(value);
    if (ymd === null) {
      render(true);
      return;
    }
    deps.setHash(buildReportHash(ymd));
  }

  function onToggleGroup(key: string, open: boolean): void {
    // 取得は起こさず、描画だけ。
    const k = listKey(route.date, route.venue);
    const choices = openChoices.get(k) ?? new Map<string, boolean>();
    choices.set(key, open);
    openChoices.set(k, choices);
    render();
  }

  function onToggleResult(date: string, raceId: string, open: boolean): void {
    // 取得は起こさず、描画だけ。
    resultOpenChoices.set(raceKey(date, raceId), open);
    render();
  }

  function onRefresh(): void {
    const screen = currentScreen();
    switch (screen) {
      case "admin-only":
        return; // 取るものが無い(案内だけ)
      case "result": {
        // 失敗した分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。取得中は何もしない。
        const id = route.analysis!;
        if (!analysisErrors.has(id) || analysisInflight.has(id)) return;
        analysisErrors.delete(id);
        ensureLoaded();
        render();
        return;
      }
      case "race": {
        const raceId = route.race!;
        const key = raceKey(route.date, raceId);
        const status = raceStatusSource(key, route.date);
        const latestId = status.kind === "ready" ? latestAnalysisIdOf(status.rows, raceId) : null;
        if (raceStatusInflight.has(key) || pastInflight.has(key) || (latestId !== null && analysisInflight.has(latestId))) return;
        // 失敗した最新の分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。状態の取り直しが済むと `applyBoard` が取る。
        if (latestId !== null) analysisErrors.delete(latestId);
        raceStatuses.delete(key);
        raceStatusErrors.delete(key);
        priorNotices.delete(key);
        pasts.delete(key);
        pastErrors.delete(key);
        ensureLoaded();
        render();
        return;
      }
      case "list": {
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
        return;
      }
      case "verify":
        // 取得中は何もしない(`onRefresh` が見る)。再計算の要求(refresh=1)。画面の再描画は状態の変化(`onChange`)で行われる。
        verify.onRefresh();
        return;
      case "targets":
        // 取得中は何もしない(`onRefresh` が見る)。取り直しの回数と失敗の数も数え直す。画面の再描画は状態の変化(`onChange`)で行われる。
        targets.onRefresh();
        return;
      case "report":
        // 取得中は何もしない(`onRefresh` が見る)。一覧と本文を取り直す。画面の再描画は状態の変化(`onChange`)で行われる。月報(Issue #279)は月報の一覧と本文。
        if (isMonthlyRoute()) monthly.onRefresh();
        else report.onRefresh();
        return;
      case "settings":
        // 取得中・保存中は何もしない(同じものを同時に 2 本取らない・保存中の入力を捨てない)。未保存の入力は捨てて、サーバの値を取り直す(強制の再描画も `settings` が行う)。
        settings.onRefresh();
        return;
      default:
        return assertNever(screen);
    }
  }

  return {
    start() {
      ensureLoaded();
      render();
    },
    onHashChange,
    onVisibilityChange: () => {
      tracker.onVisibilityChange();
      verify.onVisibilityChange();
      report.onVisibilityChange();
      monthly.onVisibilityChange();
      targets.onVisibilityChange();
      render(); // 一覧の並べ替えのタイマー: 隠れたら止め、見えたら今の時刻で並べ直して張り直す(Issue #346。他の画面は木が同じなら何も起きない)
    },
    async whenIdle() {
      // 取得が終わるたびに新しい取得は始まらない(失敗の自動再試行なし。追跡のタイマーは偽・実物とも待たない)ので、数回の確認で必ず止まる。
      const pending = () => [...raceInflight.values(), ...boardInflight.values(), ...raceStatusInflight.values(), ...pastInflight.values(), ...analysisInflight.values(), ...pollInflight, ...run.pending(), ...bulk.pending(), ...settings.pending(), ...verify.pending(), ...report.pending(), ...monthly.pending(), ...targets.pending()];
      for (let i = 0; i < 10 && pending().length > 0; i += 1) {
        await Promise.all(pending());
      }
    },
  };
}
