/**
 * アプリの制御(Issue #184)。画面の判定(route・役割)・描画・各画面の配線。DOM・fetch・時計は注入する(Node でテストできる)。
 * 切り出し先(Issue #400 R-11・R-11b。振る舞いは変えない):
 *  - 一覧・レース・結果の読み込み(取得・メモリキャッシュ・「更新」)と板の追跡 → `race-data.ts`(`createRaceData`。「netkeiba への取得と DO の起動を、画面の操作で増やさない」方針・追跡・
 *    完了への遷移・発走前の結果〈Issue #188〉の取得の説明は、そのファイルの先頭)。ここは「今の route」「今の画面」を関数で渡し、表示の元(`listSource` ほか)を木の組み立てに渡すだけ。
 *  - 起動(`onRun`。Issue #186): `run-control.ts`。同期の印を `await` の前に立てて二重押しを防ぐ。202・409 は板にオーバーレイ〈`setOverlay`〉を重ねて追跡を始める〈`forceTrack`〉。
 *    場ごとの一括実行(Issue #251)も同じ形で `bulk-control.ts` が持つ。板・追跡の道具(`setOverlay`・`forceTrack`)は、`race-data.ts` から関数で渡す。
 * 表示は「現在のハッシュ + キャッシュ」から毎回導く(遅れて届いた結果は、キャッシュに入るだけで、今の画面を壊さない)。
 *  - 結果の開閉(`resultOpen`。Issue #188)は (開催日, race_id) ごとにメモリに持つ(#187 と同じ。既定は開・ハッシュ/localStorage には持たない・「更新」で消さない)。
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
 */
import type { FetchLike } from "./api";
import { createBulkControl } from "./bulk-control";
import { createRunControl } from "./run-control";
import { inputToYmd, todayJst } from "./date";
import { listKey, raceKey } from "./keys";
import { buildListModel, needsListClock, type BoardSource, type ListSource } from "./list";
import { createListClock } from "./list-clock";
import { createRaceData } from "./race-data";
import { buildRaceModel, latestAnalysisIdOf } from "./race";
import { buildResultModel } from "./result";
import { createSettingsScreen } from "./settings-screen";
import { createVerifyScreen } from "./verify-screen";
import { createMonthlyScreen } from "./monthly-screen";
import { createReportScreen } from "./report-screen";
import { createTargetsScreen } from "./targets-screen";
import { buildHash, buildReportHash, parseHash, screenOf, type Route, type Screen } from "./route";
import { buildAdminOnlyModel, type AppScreen } from "./admin-only";
import { isAdmin, type Role } from "./role";
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

/** 画面の `switch` の網羅チェック(Issue #191)。`Screen` に画面を足して `case` を足し忘れると、ここで型エラーになる。 */
function assertNever(screen: never): never {
  throw new Error(`未対応の画面です: ${String(screen)}`);
}

/** 管理者だけの画面(Issue #238)。閲覧者が開いたときは、API を取らずに案内だけを出す(`admin-only`)。 */
const ADMIN_SCREENS: ReadonlySet<Screen> = new Set<Screen>(["settings"]);

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

  // 読み込み(一覧・レース・結果の取得とメモリキャッシュ)と板の追跡は `race-data.ts` が持つ(Issue #400 R-11b)。今の route と画面の判定は、ここから関数で渡す。
  const data = createRaceData({ fetch: deps.fetch, now: deps.now, timers: deps.timers, isVisible: deps.isVisible, route: () => route, currentScreen, onChange: () => render() });

  // 場ごとの開閉(Issue #187)。(開催日, 区分) ごとに、利用者が押した値だけを持つ(既定は描画のたびに導く)。「更新」では消さない。ハッシュ・localStorage には持たない。
  const openChoices = new Map<string, Map<string, boolean>>();
  /** 発走前のカードの結果の開閉(Issue #188)。(開催日, race_id) ごとに、利用者が押した値だけを持つ(既定は開)。 */
  const resultOpenChoices = new Map<string, boolean>();

  const listSource = (): ListSource => data.listSource(route.date, route.venue);
  const boardSource = (): BoardSource => data.boardSource(route.date);

  // ---- 起動(Issue #186)・場ごとの一括実行(Issue #251。管理者だけ) ----
  // 状態・POST・結果の表示は `run-control.ts`・`bulk-control.ts` が持つ(Issue #400 R-11)。板・追跡の道具(オーバーレイ・追跡の開始)は、`race-data.ts` のものを関数で渡す。

  const run = createRunControl({ fetch: deps.fetch, now: deps.now, admin, onChange: () => render(), setOverlay: data.setOverlay, forceTrack: data.forceTrack });

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
    setOverlay: data.setOverlay,
    forceTrack: data.forceTrack,
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
    onRetrack: data.onRetrack,
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
        deps.render(renderScreen(buildResultModel({ route, source: data.analysisSource(route.analysis!), readOnly: !admin }), actions), force);
        return;
      }
      case "race": {
        const raceId = route.race!;
        const key = raceKey(route.date, raceId);
        const listRow = data.listRowOf(route.date, route.venue, raceId);
        const status = data.raceStatusSource(route.date, raceId);
        const latestId = status.kind === "ready" ? latestAnalysisIdOf(status.rows, raceId) : null;
        deps.render(
          renderScreen(
            buildRaceModel({
              route,
              status,
              past: data.pastSource(route.date, raceId),
              listRow,
              runs: run.runsFor(route.date, raceId),
              tracking: data.trackingNotice(),
              ...(latestId === null ? {} : { result: data.analysisSource(latestId) }),
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
              boardLoading: data.boardLoading(route.date),
              tracking: data.trackingNotice(),
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

  /** 今の画面に必要なものを、無ければ取りに行く。結果画面は分析 1 本だけ・レース画面は状態と過去の分析だけ(一覧・板は取らない)。 */
  function ensureLoaded(): void {
    const screen = currentScreen();
    switch (screen) {
      case "admin-only":
        return; // 閲覧者が管理者だけの画面を開いた: 何も取らない(案内だけ)
      case "result":
        data.ensureResult(route.analysis!);
        return;
      case "race":
        data.ensureRace(route.date, route.race!);
        return;
      case "list":
        data.ensureList(route.date, route.venue);
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
      case "result":
        data.refreshResult(route.analysis!); // 失敗した分析だけを取り直す(取得中は何もしない)
        return;
      case "race":
        data.refreshRace(route.date, route.race!); // 状態・過去の分析と、失敗した最新の分析を取り直す
        return;
      case "list":
        data.refreshList(route.date, route.venue); // 一覧と板を取り直す
        return;
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
      data.onVisibilityChange();
      verify.onVisibilityChange();
      report.onVisibilityChange();
      monthly.onVisibilityChange();
      targets.onVisibilityChange();
      render(); // 一覧の並べ替えのタイマー: 隠れたら止め、見えたら今の時刻で並べ直して張り直す(Issue #346。他の画面は木が同じなら何も起きない)
    },
    async whenIdle() {
      // 取得が終わるたびに新しい取得は始まらない(失敗の自動再試行なし。追跡のタイマーは偽・実物とも待たない)ので、数回の確認で必ず止まる。
      const pending = () => [...data.pending(), ...run.pending(), ...bulk.pending(), ...settings.pending(), ...verify.pending(), ...report.pending(), ...monthly.pending(), ...targets.pending()];
      for (let i = 0; i < 10 && pending().length > 0; i += 1) {
        await Promise.all(pending());
      }
    },
  };
}
