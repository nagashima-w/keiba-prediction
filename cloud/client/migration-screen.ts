/**
 * 移行画面(`#migration`)の制御(Issue #222〈#167-B2〉)。進捗の取得・ポーリング・選んだファイルの検証・アップロード。DOM・fetch・時計・タイマーは注入する(Node でテストできる)。
 * 画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。**設定画面とは別の画面**なので、ここの再描画が設定フォームの入力を壊すことはない。
 *
 *  - 開く(`enter`): `GET /api/migration` を 1 回。他の API には出ない(netkeiba・LLM・D1 の読み取りを増やさない。サーバは移行の DO の状態を読むだけ)。失敗は自動で再試行しない(「再読込」だけ)。
 *  - **ポーリング(画面を開いている間だけ)**: 取り込み中の状態だけ、取得の完了後にタイマーを張る(`setInterval` は使わない=取得が長引いても重ならない)。
 *    verifying・importing は {@link BUSY_INTERVAL_MS}(10 秒)、waiting-budget・waiting-r2 は {@link WAIT_INTERVAL_MS}(60 秒。再開は数時間〜翌月先)。idle・completed・failed では止める。
 *    **非表示の間は止め**(タイマーを消す)、表示に戻ったら即時に 1 回取って再開する。通信の失敗が {@link MAX_FAILURES} 回続いたら止めて「再読込」を促す(最後に取れた進捗は残す)。
 *  - 検証: ファイルを選んだらブラウザで全行を検証する(`migration-file.ts`)。再描画は {@link PROGRESS_RENDER_MS} ごとに間引く。通れば開始できる。通らなければ理由を出して、アップロードさせない。
 *  - アップロード: 検証したファイルそのものを POST。押した瞬間に同期で「送信中」の印を立てる(二重押しを防ぐ)。取り込み中は選べず・始められない(`migration-model.ts`)。
 *  - 結果の補完の進捗(Issue #217): 移行が `completed` だったときだけ、進捗の取得のあとに `GET /api/results/backfill` を 1 回取る(付随の情報の 1 行。ポーリングはしない。「再読込」で取り直す)。失敗は黙って出さないだけ。
 *  - 世代(`gen`): 離れる・開き直すたびに増やし、**古い世代の応答・検証の結果は反映しない**。
 */
import { fetchBackfill, fetchMigration, migrationFetchFailureMessage, postMigrationUpload, uploadFailureMessage, type BackfillProgress, type MigrationProgress } from "./api-migration";
import type { FetchLike } from "./api";
import { validateMigrationFile } from "./migration-file";
import { buildMigrationModel, type MigrationCheckState, type MigrationLoadState, type MigrationModel, type MigrationUploadState } from "./migration-model";
import type { PickedFile } from "./vnode";

/** verifying・importing の更新間隔。 */
export const BUSY_INTERVAL_MS = 10_000;
/** waiting-budget・waiting-r2 の更新間隔(再開は数時間〜翌月先なので、細かく見ない)。 */
export const WAIT_INTERVAL_MS = 60_000;
/** 通信の失敗がこの回数続いたら、ポーリングを止める。 */
export const MAX_FAILURES = 3;
/** 検証の進捗の再描画の最小間隔。 */
export const PROGRESS_RENDER_MS = 250;

export interface MigrationScreenDeps {
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  /** 画面に制御を返す(検証が主スレッドを占有し続けないように。本番は `setTimeout(0)`)。 */
  readonly yieldToUi: () => Promise<void>;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
}

export interface MigrationScreen {
  /** 画面に入った。まだ取っていなければ進捗を取る(重ねて呼んでも取得は増えない)。 */
  enter(): void;
  /** 画面を離れた。検証・タイマーを止め、状態を捨てる。 */
  leave(): void;
  /** ファイルが選ばれた(選択が空なら null=何もしない)。 */
  onFile(file: PickedFile | null): void;
  onStart(): void;
  onCancelCheck(): void;
  /** 「再読込」。取得中は無視。 */
  onReload(): void;
  onVisibilityChange(): void;
  model(): MigrationModel;
  /** 取得中・検証中・アップロード中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

const BUSY_STATES: ReadonlySet<string> = new Set(["verifying", "importing", "waiting-budget", "waiting-r2"]);

export function createMigrationScreen(deps: MigrationScreenDeps): MigrationScreen {
  let load: MigrationLoadState | null = null; // null: 画面にいない
  let file: PickedFile | null = null;
  let check: MigrationCheckState = { kind: "idle" };
  let upload: MigrationUploadState = { kind: "idle" };
  let backfill: BackfillProgress | null = null;
  let pollStopped = false;
  let failures = 0;
  let timer: unknown = null;
  let fetching = false;
  /** 世代。離れる・開き直すたびに増やす。 */
  let gen = 0;
  /** 検証の世代。選び直す・取り消す・離れるたびに増やす。 */
  let checkGen = 0;
  const inflight = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): void {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  function clearTimer(): void {
    if (timer !== null) {
      deps.timers.clear(timer);
      timer = null;
    }
  }

  function progress(): MigrationProgress | null {
    return load !== null && load.kind === "ready" ? load.progress : null;
  }

  function isBusy(): boolean {
    const p = progress();
    return p !== null && BUSY_STATES.has(p.state);
  }

  /** 取得の完了後に呼ぶ。取り込み中で、表示されていて、止めていなければ、次の取得のタイマーを張る。 */
  function schedule(): void {
    clearTimer();
    const p = progress();
    if (load === null || p === null || !isBusy() || pollStopped || !deps.isVisible()) return;
    const g = gen;
    const ms = p.state === "verifying" || p.state === "importing" ? BUSY_INTERVAL_MS : WAIT_INTERVAL_MS;
    timer = deps.timers.set(() => {
      timer = null;
      if (g === gen) fetchOnce("poll");
    }, ms);
  }

  /** 進捗を 1 回取る。`poll`: 定期の更新(失敗しても前の進捗を残し、連続の失敗を数える)。`first`: 開いたとき・再読込(失敗はエラー表示)。 */
  function fetchOnce(mode: "first" | "poll"): void {
    if (fetching) return;
    fetching = true;
    const g = gen;
    if (mode === "first") {
      load = { kind: "loading" };
      pollStopped = false;
      failures = 0;
      clearTimer();
      deps.onChange();
    }
    const promise = fetchMigration(deps.fetch).then((result) => {
      if (g !== gen) return; // 離れた・開き直した(古い応答。`fetching` は離れたときに戻してあり、新しい取得の印を壊さない)
      fetching = false;
      if (result.ok) {
        load = { kind: "ready", progress: result.progress };
        failures = 0;
        pollStopped = false;
        if (upload.kind === "sent" && !BUSY_STATES.has(result.progress.state)) upload = { kind: "idle" }; // 取り込みが終わったら「アップロードしました」の通知は要らない
        if (result.progress.state === "completed") fetchBackfillOnce(g);
        else backfill = null;
      } else if (mode === "first") {
        load = { kind: "error", message: migrationFetchFailureMessage(result.error) };
      } else {
        failures += 1;
        if (failures >= MAX_FAILURES) pollStopped = true;
      }
      schedule();
      deps.onChange();
    });
    track(promise);
  }

  /** 結果の補完の進捗を 1 回取る(Issue #217)。失敗・古い世代の応答は反映しない。 */
  function fetchBackfillOnce(g: number): void {
    const promise = fetchBackfill(deps.fetch).then((result) => {
      if (g !== gen) return;
      backfill = result.ok ? result.progress : null;
      deps.onChange();
    });
    track(promise);
  }

  function enter(): void {
    if (load !== null) return;
    gen += 1;
    fetchOnce("first");
  }

  function leave(): void {
    gen += 1;
    checkGen += 1;
    clearTimer();
    load = null;
    file = null;
    check = { kind: "idle" };
    upload = { kind: "idle" };
    backfill = null;
    pollStopped = false;
    failures = 0;
    fetching = false;
  }

  function model(): MigrationModel {
    return buildMigrationModel({
      load: load ?? { kind: "loading" },
      file: file === null ? null : { name: file.name, size: file.size },
      check,
      upload,
      pollStopped,
      backfill,
    });
  }

  function onFile(picked: PickedFile | null): void {
    if (picked === null || load === null || !model().canPick) return;
    const g = gen;
    checkGen += 1;
    const myCheck = checkGen;
    file = picked;
    upload = { kind: "idle" };
    check = { kind: "checking", percent: 0, lines: 0 };
    let lastRender = deps.now();
    deps.onChange();
    const promise = validateMigrationFile(picked, {
      isCancelled: () => g !== gen || myCheck !== checkGen,
      now: deps.now,
      yieldToUi: deps.yieldToUi,
      onProgress: (p) => {
        if (g !== gen || myCheck !== checkGen) return;
        // 終わるまで 100% にしない(展開・検証がまだ残っている)。
        const percent = p.totalBytes > 0 ? Math.min(99, Math.floor((p.readBytes / p.totalBytes) * 100)) : 0;
        check = { kind: "checking", percent, lines: p.lines };
        const t = deps.now();
        if (t - lastRender >= PROGRESS_RENDER_MS) {
          lastRender = t;
          deps.onChange();
        }
      },
    }).then((result) => {
      if (g !== gen || myCheck !== checkGen) return; // 離れた・取り消した・選び直した
      if (result.kind === "ok") check = { kind: "ok", summary: result.summary };
      else if (result.kind === "invalid") check = { kind: "invalid", message: result.message };
      else return;
      deps.onChange();
    });
    track(promise);
  }

  function onCancelCheck(): void {
    if (check.kind !== "checking") return;
    checkGen += 1;
    file = null;
    check = { kind: "idle" };
    deps.onChange();
  }

  function onStart(): void {
    if (load === null || file === null || !model().start.enabled) return;
    const g = gen;
    const sending = file;
    upload = { kind: "sending" }; // 同期の印(await の前)。二重押しを防ぐ
    deps.onChange();
    const promise = postMigrationUpload(deps.fetch, sending).then((result) => {
      if (g !== gen) return; // 離れた(古い応答)
      if (result.ok) {
        upload = { kind: "sent" };
        file = null;
        check = { kind: "idle" };
        if (result.progress !== null) {
          load = { kind: "ready", progress: result.progress };
          failures = 0;
          pollStopped = false;
          schedule();
        }
        deps.onChange();
        if (result.progress === null) fetchOnce("poll"); // 本文が想定外: 受け付け済みなので、今の状態を取り直す
        return;
      }
      upload = { kind: "error", message: uploadFailureMessage(result.error) };
      deps.onChange();
      if (result.error.kind === "busy") fetchOnce("poll"); // 別のタブなどで取り込みが始まっている: 今の状態を見せる
    });
    track(promise);
  }

  function onReload(): void {
    if (load === null || fetching) return;
    fetchOnce("first");
  }

  function onVisibilityChange(): void {
    if (load === null) return;
    if (!deps.isVisible()) {
      clearTimer();
      return;
    }
    // 表示に戻った: 取り込み中なら、即時に 1 回取って再開する(止めた〈連続の失敗〉ときは再読込を待つ)。
    if (isBusy() && !pollStopped && timer === null && !fetching) fetchOnce("poll");
  }

  return { enter, leave, onFile, onStart, onCancelCheck, onReload, onVisibilityChange, model, pending: () => [...inflight] };
}
