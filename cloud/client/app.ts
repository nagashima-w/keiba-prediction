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
 *  - `/api/analyses/{id}`・`/api/races`・`status?race_id=`(完了時の取り直しを除く)は、ポーリングの周期では呼ばない(`/api/analyses/{id}` は、レース画面で発走前の完了を検知したとき、新しい id を 1 回だけ。下の Issue #188)。
 *
 * **Issue #189(設定画面。`#settings`)**: 開くと `GET /api/settings` だけを取る(一覧・板・レース・分析は取らない)。失敗は自動で再試行しない(「再読込」だけ。取得中・保存中は無視)。
 *  - 状態は closure に持つ: 取得の状態・下書き(`settings-form.ts`。数値は入力した文字のまま)・検証エラー・保存の状態。**画面を離れたら破棄**し(`leaveSettings`)、戻ると取り直す。
 *  - **入力(数値欄・追加指示は `input`〈打つたび〉と `change`、チェックボックス・選択は `change`)は下書きを書くだけで、再描画しない**(入力中の欄・フォーカスを壊さない。保存中の入力は無視。
 *    `input` でも書くのは、`change` が blur で発火し、フォーカスがあるまま「保存」を押して click が先に届くと、直前の入力を取りこぼすため)。保存・再読込・取得・失敗の直後は **`render(true)`**
 *    (木が前回と同じでも DOM を置き換える。change では描画しないので、DOM が下書きと食い違ったまま残るのを、強制の再描画で直す)。
 *  - **強制なしの描画(追跡のポーリングなど、設定画面の外の原因)は、画面に出ている内容の写し(`settingsShown`)から木を作る**。`input` で下書きが変わっても木は変わらず、`createMounter` が DOM を置き換えない(打っている欄・キーボードを壊さない)。
 *  - 保存の押下: 検証(項目ごと。保存の押下時に1回)→ NG なら POST せず項目ごとのエラー / OK なら全 14 項目を POST。保存中は二重に送らない。失敗しても入力は残る。成功したらサーバが返した設定で下書きを戻す。
 *  - 世代(`settingsGen`): 離れる・取り直すたびに増やし、**古い世代の応答(離れる前に出した取得・保存)は今の画面に反映しない**。
 *  - **Issue #201(プロンプトのプレビュー)**: 画面の末尾のボタンで開閉する(既定は閉じている。メモリだけ・画面を離れたら破棄)。文面は **画面に出ている写し(`settingsShown`)の下書き**から作る
 *    (`buildPreviewText`。送信と同じ手順)。**入力のたびには更新しない**(#189 の設計どおり)。開閉と「入力中の内容を反映」は `render(true)` で、写しを現在の下書きへ更新してから描く
 *    (強制なしだと古い写しで入力欄が作り直され、打った文字が消える)。ネットワークには出ない。保存中・下書きなしは無視。
 *
 * **Issue #222(移行画面。`#migration`)**: 設定画面の「exe から移行」の節のリンク先の**別の画面**。状態・取得・ポーリング・検証・アップロードは `migration-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画・可視状態の中継だけ。
 *  - 開くと `GET /api/migration` だけを取る(一覧・板・設定・レース・分析は取らない)。設定画面は `/api/migration` を取らない。**別の画面なので、移行の再描画・ポーリングが設定フォームの入力を壊さない**
 *    (設定画面にいる間、移行のタイマー・取得は無い。移行画面を離れると状態を破棄し、遅れて届く応答は反映しない)。
 *
 * **Issue #219(検証画面。`#verify`)**: 一覧の入口のリンク先の**別の画面**。状態・取得・区分の切替・更新・ポーリングは `verify-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画・可視状態の中継だけ。
 *  - 開くと `GET /api/verify?venue=all` だけを取る(一覧・板・設定・レース・分析は取らない)。他の画面は `/api/verify` を取らない。補完中だけ自動で取り直し(3〜5 秒)、離れると状態・タイマー・遅れて届く応答を捨てる。
 *
 * **Issue #235(日報画面。`#report`・`#report=YYYYMMDD`)**: 一覧の入口のリンク先の**別の画面**。状態・取得・日付の切替・手動の作成・作成中のポーリングは `report-screen.ts` が持ち、ここは出入り(`enter`・`leave`)・描画・可視状態を渡すだけ。
 *  - 開くと `GET /api/reports`(日付の一覧)と、表示する日の `GET /api/reports/{date}` だけを取る(一覧・板・設定・レース・分析・検証は取らない)。他の画面は `/api/reports` を取らない。作成中だけ自動で取り直し(5 秒)、離れると状態・タイマーを捨てる。
 *
 * **Issue #188(発走前の結果をレース画面のカードの中に出す)**:
 *  - 最新の分析 = 板の発走前の行が `done` で `analysisId` を持つときのその id(`race.ts` の `latestAnalysisIdOf`。取る・出すの判定は同じ関数)。
 *  - 取得は `loadAnalysis`(id ごとに 1 回。結果画面と**同じキャッシュ・同じ 3 つの門**〈`analyses`・`analysisErrors`・`analysisInflight`〉)。再描画・ポーリング・hashchange の連打では増えない。失敗は自動で再試行しない。
 *  - 取るのは `syncLatestAnalysis`(冪等)を呼ぶ 2 箇所だけ: ① `ensureLoaded`(画面を開いたとき・戻ったとき=状態がキャッシュ済みで、他の画面にいる間に完了していた場合を含む)
 *    ② `applyBoard`(状態の取得の成功・ポーリング・板の取得。完了への遷移もここ)。**`render()` からは取らない**(描画が取得を起こす構造にしない)。
 *  - レース画面の「更新」は、**失敗した最新の分析だけ**を取り直す(成功した分析は取り直さない=R2 の操作回数)。取得中の「更新」は無視する。
 *  - 結果の開閉(`resultOpen`)は (開催日, race_id) ごとにメモリに持つ(#187 と同じ。既定は開・ハッシュ/localStorage には持たない・「更新」で消さない)。
 */
import { failureMessage, fetchBoard, fetchRaces, fetchRaceStatus, type BoardRow, type FetchLike, type MorningPriorView, type RaceRow, type TaskMode } from "./api";
import { fetchAnalysis, fetchPastAnalyses, type AnalysisDetail, type PastAnalysis } from "./api-analysis";
import { bulkFailureMessage, postBulk, type BulkOutcome } from "./api-bulk";
import { postRun, runFailureMessage, type RunOutcome } from "./api-run";
import { bulkAcceptedText, bulkDayCapText, selectBulkTargets, type BulkUi } from "./bulk";
import { createBoardStore, type BoardCompletion } from "./board-state";
import { inputToYmd, todayJst } from "./date";
import { buildListModel, groupKeys, groupRaces, type BoardSource, type ListSource } from "./list";
import { buildRaceModel, latestAnalysisIdOf, type PastSource, type RaceStatusSource, type RunUi } from "./race";
import { fetchSettings, postSettings, settingsFailureMessage } from "./api-settings";
import { buildResultModel, type ResultSource } from "./result";
import { buildSettingsModel, draftFromSettings, resetWeightsInDraft, setDraftValue, validateDraft, WEIGHT_FIELD_ORDER, type FieldErrors, type FieldKey, type SettingsDraft, type SettingsLoadState, type SettingsSaveState } from "./settings-form";
import { createMigrationScreen } from "./migration-screen";
import { createVerifyScreen } from "./verify-screen";
import { createReportScreen } from "./report-screen";
import { buildHash, parseHash, screenOf, type Route, type Screen, type Venue } from "./route";
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
  /** 画面に制御を返す(移行ファイルの検証が主スレッドを占有し続けないように。本番は `setTimeout(0)`。省略は何もしない)。Issue #222。 */
  readonly yieldToUi?: () => Promise<void>;
  /**
   * 役割(Issue #238。サーバが `#app` の `data-role` で渡す)。**閲覧者(`admin` 以外のすべて)には、設定・検証への入口・分析の実行ボタン・日報の作成ボタンを出さず、
   * 設定・検証・移行の画面を直接開いても API を取らずに案内だけを出す**。画面で隠すのは補助で、拒否はサーバ側(403)。
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

const listKey = (date: string, venue: Venue): string => `${date}:${venue}`;
const raceKey = (date: string, raceId: string): string => `${date}:${raceId}`;

interface RaceStatusEntry {
  readonly rows: readonly BoardRow[];
  readonly prior: MorningPriorView | null;
}

const runKey = (date: string, raceId: string, mode: TaskMode): string => `${date}:${raceId}:${mode}`;

/** 画面の `switch` の網羅チェック(Issue #191)。`Screen` に画面を足して `case` を足し忘れると、ここで型エラーになる。 */
function assertNever(screen: never): never {
  throw new Error(`未対応の画面です: ${String(screen)}`);
}

/** prior の取り直しに失敗したときの注記の前置き(カードは残す)。 */
const PRIOR_NOTICE_PREFIX = "順位を取得できませんでした。";

/** 管理者だけの画面(Issue #238)。閲覧者が開いたときは、API を取らずに案内だけを出す(`admin-only`)。 */
const ADMIN_SCREENS: ReadonlySet<Screen> = new Set<Screen>(["settings", "migration", "verify"]);

/** 今の画面(Issue #238)。route から決まる画面に、役割で決まる `admin-only` を足したもの。 */
type AppScreen = Screen | "admin-only";

export function createApp(deps: AppDeps): App {
  let route: Route = parseHash(deps.getHash(), todayJst(deps.now()));
  /** 管理者か(`admin` の完全一致だけ。それ以外の値は閲覧者)。 */
  const admin = isAdmin(deps.role);

  /**
   * 今の画面の判定の**唯一の場所**(Issue #191 の `screenOf` に、Issue #238 の役割を足したもの)。閲覧者が管理者だけの画面(設定・移行・検証)の route に居るときは
   * `admin-only` を返す。**app.ts の画面ごとの分岐は、すべてこの関数を通す**(`screenOf(route)` を直接使わない)ので、閲覧者は設定・移行・検証の取得も下書きも始めない。
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
  /** 発走前のカードの結果の開閉(Issue #188)。(開催日, race_id) ごとに、利用者が押した値だけを持つ(既定は開)。 */
  const resultOpenChoices = new Map<string, boolean>();
  const analyses = new Map<number, AnalysisDetail>();
  const analysisErrors = new Map<number, string>();
  const analysisInflight = new Map<number, Promise<void>>();

  /** 起動の操作の表示((開催日, レース, モード)ごと)。送信中の印は `await` の前に同期で立てる(二重押しを防ぐ)。 */
  const runStates = new Map<string, RunUi>();

  /** 場ごとの一括実行(Issue #251)の操作の状態。(開催日, 区分) → 場のまとまりのキー(`groupKeys`)→ 状態。メモリだけ(「更新」では消さない)。送信中の印は `await` の前に同期で立てる。 */
  const bulkStates = new Map<string, Map<string, BulkUi>>();

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

  // ---- 設定画面(Issue #189) ----
  /** 取得の状態。null は「まだ取っていない(この画面にいない)」。 */
  let settingsLoad: SettingsLoadState | null = null;
  let settingsDraft: SettingsDraft | null = null;
  let settingsErrors: FieldErrors = {};
  let settingsSave: SettingsSaveState = { kind: "idle" };
  /** 世代。離れる・取り直すたびに増やし、古い世代の応答を捨てる。 */
  let settingsGen = 0;
  /**
   * 画面に出ている内容(最後に**強制描画**したとき、または画面に入ったときの、取得の状態・下書き・エラー・保存の状態の写し)。
   * **強制なしの描画(追跡のポーリング・他の取得の完了など、設定画面の外の原因)は、この写しから木を作る**=打っている途中の下書きは、
   * 次の強制描画(保存・再読込・取得完了・検証エラー・失敗)まで木に出さない。木が同じなら `createMounter` は DOM を置き換えない(打っている欄がフォーカスを失わない・スマホのキーボードが閉じない)。
   * 下書き(`settingsDraft`)自体は最新のまま(保存はそれを読む)。null は「まだ写していない(画面に入った直後)」。
   */
  let settingsShown: { load: SettingsLoadState; draft: SettingsDraft | null; errors: FieldErrors; save: SettingsSaveState; previewOpen: boolean } | null = null;
  /** プロンプトのプレビューを開いているか(Issue #201)。メモリだけ(既定は閉じている。画面を離れたら破棄。「再読込」では変えない)。 */
  let settingsPreviewOpen = false;
  const settingsInflight = new Set<Promise<unknown>>();

  // ---- 移行画面(Issue #222) ----
  const migration = createMigrationScreen({
    fetch: deps.fetch,
    now: () => deps.now().getTime(),
    timers: deps.timers,
    isVisible: deps.isVisible,
    yieldToUi: deps.yieldToUi ?? (async () => {}),
    onChange: () => render(),
  });

  // ---- 検証画面(Issue #219) ----
  const verify = createVerifyScreen({
    fetch: deps.fetch,
    timers: deps.timers,
    isVisible: deps.isVisible,
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

  const actions = {
    onDateChange,
    onRefresh,
    onToggleGroup,
    onToggleResult,
    onRun,
    onBulkOpen,
    onBulkGo,
    onBulkDismiss,
    onRetrack,
    onSettingsInput,
    onSettingsSave,
    onSettingsPreviewToggle,
    onSettingsPreviewRefresh,
    onSettingsWeightsReset,
    onMigrationFile: migration.onFile,
    onMigrationStart: migration.onStart,
    onMigrationCancelCheck: migration.onCancelCheck,
    onVerifyVenue: verify.onVenue,
    onVerifyVersionToggle: verify.onVersionToggle,
    onReportRun: report.onRun,
  };

  function render(force = false): void {
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
              runs: runsFor(route.date, raceId),
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
        // 強制描画のとき、または画面に入った直後(まだ写していない)は、今の状態を写す。それ以外(強制なし)は、画面に出ている内容の写しから作る。
        if (force || settingsShown === null) {
          settingsShown = { load: settingsLoad ?? { kind: "loading" }, draft: settingsDraft, errors: settingsErrors, save: settingsSave, previewOpen: settingsPreviewOpen };
        }
        deps.render(renderScreen(buildSettingsModel(settingsShown), actions), force);
        return;
      }
      case "migration": {
        deps.render(renderScreen(migration.model(), actions), force);
        return;
      }
      case "verify": {
        deps.render(renderScreen(verify.model(), actions), force);
        return;
      }
      case "report": {
        deps.render(renderScreen(report.model(), actions), force);
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
              bulk: { now: deps.now(), states: bulkStates.get(listKey(route.date, route.venue)) ?? new Map<string, BulkUi>() },
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
        if (settingsLoad === null) startSettingsLoad();
        return;
      case "migration":
        migration.enter();
        return;
      case "verify":
        verify.enter();
        return;
      case "report":
        report.enter(route.report?.date ?? null); // 同じ画面の中の日付の切替も、ここ(重ねて呼んでも同じ日の取得は増えない)
        return;
      default:
        return assertNever(screen);
    }
  }

  // ---- 設定 ----

  /** 設定を取り直す(下書き・エラー・保存の状態を捨てる)。**呼び出し側が描画する**。 */
  function startSettingsLoad(): void {
    settingsGen += 1;
    const gen = settingsGen;
    settingsLoad = { kind: "loading" };
    settingsDraft = null;
    settingsErrors = {};
    settingsSave = { kind: "idle" };
    const promise = fetchSettings(deps.fetch).then((result) => {
      settingsInflight.delete(promise);
      if (gen !== settingsGen) return; // 離れた・取り直した(古い応答)
      if (result.ok) {
        settingsLoad = { kind: "ready", source: result.source };
        settingsDraft = draftFromSettings(result.settings);
      } else {
        settingsLoad = { kind: "error", message: settingsFailureMessage(result.error, "load") };
      }
      render(true);
    });
    settingsInflight.add(promise);
  }

  /** 設定画面を離れる: 下書き・エラー・保存の状態を捨て、世代を進める(遅れて届く応答を捨てる)。戻ると取り直す。 */
  function leaveSettings(): void {
    settingsGen += 1;
    settingsShown = null;
    settingsPreviewOpen = false;
    settingsLoad = null;
    settingsDraft = null;
    settingsErrors = {};
    settingsSave = { kind: "idle" };
  }

  /** 入力欄の変更。**下書きを書くだけで、再描画しない**(入力中の欄・フォーカスを壊さない)。保存中・取得前は無視。 */
  function onSettingsInput(key: string, value: string): void {
    if (currentScreen() !== "settings" || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsDraft = setDraftValue(settingsDraft, key as FieldKey, value);
    // 「保存しました」の通知は、未保存の入力が生まれた時点で状態から外す(描画はしない。次の描画から出さない)。
    if (settingsSave.kind === "saved") settingsSave = { kind: "idle" };
  }

  /**
   * プロンプトのプレビューの開閉(Issue #201)。ネットワークには出ない。**`render(true)`**: 強制なしの描画は古い写し(`settingsShown`)から木を作るので、そのままだと
   * 入力欄が古い下書きで作り直され、打った文字が消える。強制描画は、写しを現在の下書きへ更新してから描く(保存・検証エラーと同じ)。
   * 下書きが無い(取得前・失敗)・保存中は無視する(入力を無視するのと同じ)。
   */
  function onSettingsPreviewToggle(open: boolean): void {
    if (currentScreen() !== "settings" || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsPreviewOpen = open;
    render(true);
  }

  /** 「入力中の内容を反映」(Issue #201): 開いているときだけ。強制描画で写しを現在の下書きへ更新し、プレビューの文面を入力に追いつかせる。 */
  function onSettingsPreviewRefresh(): void {
    if (currentScreen() !== "settings" || settingsDraft === null || settingsSave.kind === "saving" || !settingsPreviewOpen) return;
    render(true);
  }

  /**
   * 「重みを既定値に戻す」(Issue #218): 下書きの重み13項目だけを既定値に戻す(保存はしない。ネットワークには出ない)。重みの欄のエラーも消す(戻した値は有効)。
   * `render(true)`: 強制なしの描画は古い写し(`settingsShown`)から木を作るので、そのままだと欄が古い値のまま残る(プレビューの開閉と同じ)。
   * 下書きが無い(取得前・失敗)・保存中は無視する。
   */
  function onSettingsWeightsReset(): void {
    if (currentScreen() !== "settings" || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsDraft = resetWeightsInDraft(settingsDraft);
    const remaining: Partial<Record<FieldKey, string>> = { ...settingsErrors };
    for (const key of WEIGHT_FIELD_ORDER) delete remaining[key];
    settingsErrors = remaining;
    if (settingsSave.kind === "saved") settingsSave = { kind: "idle" }; // 未保存の変更が生まれたので、「保存しました」を外す
    render(true);
  }

  function onSettingsSave(): void {
    if (currentScreen() !== "settings" || settingsLoad?.kind !== "ready" || settingsDraft === null || settingsSave.kind === "saving") return;
    const checked = validateDraft(settingsDraft);
    if (!checked.ok) {
      settingsErrors = checked.errors;
      settingsSave = { kind: "idle" };
      render(true);
      return;
    }
    settingsErrors = {};
    settingsSave = { kind: "saving" }; // 同期の印(await の前)。二重押しを防ぐ
    const gen = settingsGen;
    render(true);
    const promise = postSettings(deps.fetch, checked.settings).then((result) => {
      settingsInflight.delete(promise);
      if (gen !== settingsGen) return; // 離れた・取り直した(古い応答)
      if (result.ok) {
        settingsDraft = draftFromSettings(result.settings);
        settingsLoad = { kind: "ready", source: "d1" };
        settingsSave = { kind: "saved" };
      } else {
        settingsSave = { kind: "error", message: settingsFailureMessage(result.error, "save") };
      }
      render(true);
    });
    settingsInflight.add(promise);
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
    if (!admin) return; // 閲覧者(Issue #238)には起動のボタンが無い。万一呼ばれても POST しない(サーバも 403)
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

  // ---- 場ごとの一括実行(Issue #251。管理者だけ)----

  function bulkStatesFor(key: string): Map<string, BulkUi> {
    const found = bulkStates.get(key);
    if (found !== undefined) return found;
    const created = new Map<string, BulkUi>();
    bulkStates.set(key, created);
    return created;
  }

  /** いま表示中の一覧の、場のまとまり(キー)のレース。一覧が取れていない・キーが無いときは null。 */
  function racesOfGroup(groupKey: string): readonly RaceRow[] | null {
    const source = listSource();
    if (source.kind !== "ready") return null;
    const index = groupKeys(source.races).indexOf(groupKey);
    return index < 0 ? null : groupRaces(source.races)[index]!.races;
  }

  function boardRowsOrNull(): readonly BoardRow[] | null {
    const source = boardSource();
    return source.kind === "ready" ? source.rows : null;
  }

  /** ボタン: 確認画面を開く(この時点では POST しない)。過去の開催日・板が取れていない・対象が 0 件・送信中は何もしない(ボタンも無効)。 */
  function onBulkOpen(groupKey: string, mode: TaskMode): void {
    if (!admin) return; // 閲覧者(Issue #238)にはボタンが無い。万一呼ばれても何もしない(サーバも 403)
    if (currentScreen() !== "list") return;
    const date = route.date;
    const now = deps.now();
    if (date < todayJst(now)) return;
    const board = boardRowsOrNull();
    const races = racesOfGroup(groupKey);
    if (board === null || races === null) return;
    const states = bulkStatesFor(listKey(date, route.venue));
    if (states.get(groupKey)?.kind === "sending") return;
    const selection = selectBulkTargets({ mode, races, board, date, now });
    if (selection.raceIds.length === 0) return;
    states.set(groupKey, { kind: "confirm", mode, raceIds: selection.raceIds, excluded: selection.excluded });
    render();
  }

  /**
   * 確認画面の「実行する」: **実行の直前に対象を取り直し、確認した対象との共通部分だけを送る**(確認のあとで実行中・完了・発走済みになったものは外れる。増えることはない)。
   * 共通部分が空なら POST しない。送信中の印は `await` の前に同期で立てる(二重押しを防ぐ。確認画面の状態でなければ何もしない)。
   */
  function onBulkGo(groupKey: string): void {
    if (!admin) return;
    const date = route.date;
    const key = listKey(date, route.venue);
    const states = bulkStatesFor(key);
    const ui = states.get(groupKey);
    if (ui === undefined || ui.kind !== "confirm") return;
    const now = deps.now();
    const board = boardRowsOrNull();
    const races = racesOfGroup(groupKey);
    const current = board !== null && races !== null && date >= todayJst(now) ? new Set(selectBulkTargets({ mode: ui.mode, races, board, date, now }).raceIds) : new Set<string>();
    const raceIds = ui.raceIds.filter((id) => current.has(id));
    if (raceIds.length === 0) {
      states.set(groupKey, { kind: "result", tone: "error", text: "対象のレースがなくなったため、何も予約していません。" });
      render();
      return;
    }
    states.set(groupKey, { kind: "sending", mode: ui.mode });
    render();
    const mode = ui.mode;
    const promise = postBulk(deps.fetch, { date, mode, raceIds }).then((outcome) => {
      finishBulk(states, groupKey, date, mode, outcome);
      render();
    });
    runInflight.add(promise);
    void promise.finally(() => runInflight.delete(promise));
  }

  function finishBulk(states: Map<string, BulkUi>, groupKey: string, date: string, mode: TaskMode, outcome: BulkOutcome): void {
    const nowMs = deps.now().getTime();
    switch (outcome.kind) {
      case "accepted":
        for (const entry of outcome.results) {
          store.setOverlay(date, entry.raceId, mode, entry.result === "accepted" ? "queued" : entry.status, nowMs);
        }
        forceDates.set(date, store.nextSeq());
        tracker.begin({ immediate: false });
        states.set(groupKey, { kind: "result", tone: "ok", text: bulkAcceptedText(outcome.results) });
        return;
      case "accepted-malformed":
        // サーバは受け付けている(202)が、本文が想定外。失敗の文言を出し、追跡は始める(板が真実を教える)。
        forceDates.set(date, store.nextSeq());
        tracker.begin({ immediate: false });
        states.set(groupKey, { kind: "result", tone: "error", text: runFailureMessage({ kind: "unexpected", httpStatus: 202 }) });
        return;
      case "day-cap":
        states.set(groupKey, { kind: "result", tone: "error", text: bulkDayCapText(outcome) });
        return;
      case "failed":
        states.set(groupKey, { kind: "result", tone: "error", text: bulkFailureMessage(outcome.failure) });
        return;
    }
  }

  /** 確認画面の「やめる」・結果の「閉じる」。送信中は消せない(結果が届くまで)。 */
  function onBulkDismiss(groupKey: string): void {
    if (!admin) return;
    const states = bulkStatesFor(listKey(route.date, route.venue));
    const ui = states.get(groupKey);
    if (ui === undefined || ui.kind === "sending") return;
    states.delete(groupKey);
    render();
  }

  function onRetrack(): void {
    tracker.begin({ immediate: true });
  }

  // ---- 画面の操作 ----

  function onHashChange(): void {
    const wasSettings = currentScreen() === "settings";
    const wasMigration = currentScreen() === "migration";
    const wasVerify = currentScreen() === "verify";
    const wasReport = currentScreen() === "report";
    route = parseHash(deps.getHash(), todayJst(deps.now()));
    if (wasSettings && currentScreen() !== "settings") leaveSettings(); // 画面を離れたら下書きを破棄する
    if (wasMigration && currentScreen() !== "migration") migration.leave(); // 移行の状態(検証・タイマー・遅れて届く応答)を破棄する
    if (wasVerify && currentScreen() !== "verify") verify.leave(); // 検証の状態(タイマー・遅れて届く応答)を破棄する
    if (wasReport && currentScreen() !== "report") report.leave(); // 日報の状態(タイマー・遅れて届く応答)を破棄する
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
      case "migration":
        // 取得中は何もしない(`onReload` が見る)。画面の再描画は状態の変化(`onChange`)で行われる。
        migration.onReload();
        return;
      case "verify":
        // 取得中は何もしない(`onRefresh` が見る)。再計算の要求(refresh=1)。画面の再描画は状態の変化(`onChange`)で行われる。
        verify.onRefresh();
        return;
      case "report":
        // 取得中は何もしない(`onRefresh` が見る)。一覧と本文を取り直す。画面の再描画は状態の変化(`onChange`)で行われる。
        report.onRefresh();
        return;
      case "settings": {
        // 取得中・保存中は何もしない(同じものを同時に 2 本取らない・保存中の入力を捨てない)。未保存の入力は捨てて、サーバの値を取り直す。
        if (settingsLoad?.kind === "loading" || settingsSave.kind === "saving") return;
        startSettingsLoad();
        render(true);
        return;
      }
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
      migration.onVisibilityChange();
      verify.onVisibilityChange();
      report.onVisibilityChange();
    },
    async whenIdle() {
      // 取得が終わるたびに新しい取得は始まらない(失敗の自動再試行なし。追跡のタイマーは偽・実物とも待たない)ので、数回の確認で必ず止まる。
      const pending = () => [...raceInflight.values(), ...boardInflight.values(), ...raceStatusInflight.values(), ...pastInflight.values(), ...analysisInflight.values(), ...pollInflight, ...runInflight, ...settingsInflight, ...migration.pending(), ...verify.pending(), ...report.pending()];
      for (let i = 0; i < 10 && pending().length > 0; i += 1) {
        await Promise.all(pending());
      }
    },
  };
}
