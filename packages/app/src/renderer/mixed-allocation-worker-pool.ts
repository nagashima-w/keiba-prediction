/**
 * mixed-allocation-worker-pool — 配分計算(`buildMixedAllocationDisplay`)を複数のWorkerへ
 * レース単位で振り分けて並列化する仕組み(Issue #119・#24-C3)。
 *
 * ## 位置づけ(#110の置き換えではなく拡張)
 *
 * `mixed-allocation-queue.ts`(`createAllocationQueueRunner`・`createAllocationScheduler`。
 * 1ステップ=1レースの**逐次**計算)は変更しない。本モジュールは:
 * 1. `createAllocationWorkerPool` — Worker群にレースを振り分ける本体
 * 2. `createAllocationRunner` — 上記を既定で使い、Workerの起動・実行に失敗したら
 *    既存の逐次経路(`createAllocationQueueRunner`+`createAllocationScheduler`)へ
 *    自動的に切り替える統合ロジック(AC-4)
 * の2つを追加するだけで、逐次経路自体の実装・テストは1つも変更しない。
 *
 * ## Workerとの役割分担(AC-1: 別実装を作らない)
 *
 * 実際の計算(`buildMixedAllocationDisplay`)はWorkerエントリ(`mixed-allocation.worker.ts`)が
 * 呼ぶ。本モジュールはメッセージのやり取り・空きWorkerへの割り当て・キャッシュへの書き込みだけを
 * 担当し、配分ロジックには一切触れない。
 *
 * ## 古い結果の破棄(AC-3再評価: 2026-09-25ゴーサインで明記)
 *
 * `setInputs`は呼ぶたびに最新の`keyFor`へ差し替わる(`mixed-allocation-queue.ts`の
 * `AllocationQueueRunner.setInputs`と同じ契約)。Worker完了時、送信した時点のキー
 * (`sentKey`)と、**その時点で`keyFor(raceId)`を呼び直した現在のキー**を
 * `cacheKeyEquals`(`mixed-allocation-cache.ts`からexport。比較ロジックの唯一の定義を
 * 再利用する)で比較し、不一致なら`cache`へは一切書き込まずに捨てる。次の`pump()`で
 * 「まだ未計算(現在のキーでcache.peekがundefined)」として自然に再発注される。
 *
 * ## Worker自体の故障 と 1レースの計算失敗 の切り分け(AC-4・2026-09-25ゴーサイン)
 *
 * 推測で判定しない。**経路で区別する**:
 * - Worker**エントリ内**で計算をtry/catchし、例外は`{status:"error"}`という**メッセージ**として
 *   返す(`onmessage`で受け取る)。これは「そのレース固有の失敗」であり、そのレースだけを
 *   `{status:"error"}`としてキャッシュし、Workerは引き続き使う(#110の`AllocationOutcome`と
 *   同じ形・同じ意味論)。
 * - Workerの`onerror`/`onmessageerror`イベント(読み込み失敗・クラッシュ等、メッセージの形を
 *   取らない異常)は「Worker自体の故障」を意味する。**1回でも起きたら**、そのとき計算中だった
 *   レースは`{status:"error"}`として**キャッシュしない**(未計算のまま残し、後段の逐次計算に
 *   委ねる)、プール全体をterminateし、以降のpump()は何もしない(`onBroken`を1回だけ呼ぶ)。
 * - `createWorker()`自体が同期的に例外を投げた場合(起動失敗)も同じ扱い(既に作成済みの
 *   Workerがあればそれもterminateする)。
 *
 * ## プールサイズ(2026-09-25ゴーサイン)
 *
 * 固定上限 = `max(1, min(hardwareConcurrency − 1, maxWorkers))`(既定`maxWorkers`=4)。
 * この上限は**プールの生存期間中ずっと固定**(未計算レース数の増減で作り直さない)。
 * Workerは未計算のレースがあるときに、この上限までpump()のたびに**遅延生成**し、
 * `dispose()`まで使い回す(#110のスケジューラと同じ「必要になるまで作らない」流儀)。
 */

import {
  cacheKeyEquals,
  type MixedAllocationCache,
  type MixedAllocationCacheKey,
} from "./mixed-allocation-cache.js";
import {
  createAllocationQueueRunner,
  createAllocationScheduler,
  type AllocationOutcome,
  type AllocationScheduler,
} from "./mixed-allocation-queue.js";

/** プールWorker数の既定上限(2026-09-25ゴーサイン)。 */
export const MAX_ALLOCATION_WORKERS = 4;

/**
 * プールWorker数の固定上限を計算する(2026-09-25ゴーサイン)。
 * `hardwareConcurrency`が1未満・非有限(0以下・NaN等、通常のブラウザでは起きないが
 * 防御的に扱う)のときは1として扱う。
 */
export function computeAllocationWorkerPoolCap(
  hardwareConcurrency: number,
  maxWorkers: number = MAX_ALLOCATION_WORKERS,
): number {
  const safeConcurrency = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(safeConcurrency - 1, maxWorkers));
}

/**
 * 本モジュールが実Worker(`globalThis.Worker`)に要求する最小限のインターフェース。
 * 実Workerはこの形をそのまま満たすため`createRealAllocationWorker`でそのまま使え、
 * テストではこの形を満たすダブル(フェイク)を注入して、Node上で完了順の入れ替わり・
 * 故障系のシナリオを再現できる(AC-6)。
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  // イベント引数の型は実DOMの`Worker`が持つ型(MessageEvent/ErrorEvent)にそのまま合わせる。
  // これより緩い型(例: `{readonly data: unknown}`)にすると、`new Worker(...)`の戻り値を
  // `WorkerLike`へ代入する際にプロパティの反変性チェックで型エラーになる
  // (関数型プロパティの代入互換性は引数について反変にチェックされるため、`Worker`本来の型より
  // 緩い引数型を宣言すると「その型のイベントが来る保証」を`WorkerLike`側が要求してしまい、
  // 実際のWorkerの型より強い前提になって合わなくなる)。
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

/** Workerへ実際に`new Worker(...)`する本番用ファクトリ(唯一の生成箇所)。 */
export function createRealAllocationWorker(): WorkerLike {
  return new Worker(new URL("./mixed-allocation.worker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Workerからの応答メッセージの形。`mixed-allocation.worker.ts`と対で定義する。
 * リクエスト側(`buildRequest`の戻り値)はメッセージをそのまま`postMessage`するため、
 * **`raceId`を含めるのは`buildRequest`の実装側の責務**とする(本プールはリクエストの中身に
 * 立ち入らない。相関は応答側の`raceId`だけで行う)。
 */
export interface AllocationWorkerResponseEnvelope<TValue> {
  readonly raceId: string;
  readonly outcome: AllocationOutcome<TValue>;
}

/** `createAllocationWorkerPool`が受け取る「今の」入力(#110の`AllocationQueueInputs`と対応)。 */
export interface AllocationPoolInputs<TRequest> {
  readonly order: readonly string[];
  readonly keyFor: (raceId: string) => MixedAllocationCacheKey;
  readonly buildRequest: (raceId: string) => TRequest;
}

/** Worker自体が壊れた・起動できなかったときのログ操作名(2026-09-25ゴーサイン)。 */
export const ALLOCATION_WORKER_STARTUP_FAILURE_OPERATION = "配分計算Workerの起動失敗";
export const ALLOCATION_WORKER_CRASH_OPERATION = "配分計算Workerの異常終了";

interface WorkerSlot {
  readonly worker: WorkerLike;
  busyRaceId: string | null;
}

/** Workerプール1つの操作面(#110の`AllocationSchedulable`に相当する最小限の形)。 */
export interface AllocationWorkerPool<TRequest> {
  setInputs(inputs: AllocationPoolInputs<TRequest>): void;
  /** 空いているWorker(上限までは遅延生成)があれば、pendingの先頭から詰めて発注する。 */
  pump(): void;
  /** 保持している全Workerをterminateする(アンマウント時)。 */
  dispose(): void;
}

/** `createAllocationWorkerPool`の依存(実Worker/フェイクの両方を注入できる)。 */
export interface AllocationWorkerPoolDeps<TRequest, TValue> {
  readonly cache: MixedAllocationCache<AllocationOutcome<TValue>>;
  readonly createWorker: () => WorkerLike;
  readonly cap: number;
  /** 1件結果が確定するたびに呼ぶ(再描画トリガ。#110の`onStepped`に相当)。 */
  readonly onProgress: () => void;
  /** Worker自体が壊れた・起動できなかったとき、1回だけ呼ばれる。 */
  readonly onBroken: (operation: string, error: unknown) => void;
}

/**
 * Workerプールを新規作成する(Issue #119)。`cap`は呼び出し側が
 * `computeAllocationWorkerPoolCap`で事前に求めた固定値を渡す(このオブジェクトの生存期間中
 * 再計算しない)。
 */
export function createAllocationWorkerPool<TRequest, TValue>(
  deps: AllocationWorkerPoolDeps<TRequest, TValue>,
): AllocationWorkerPool<TRequest> {
  let inputs: AllocationPoolInputs<TRequest> | null = null;
  const slots: WorkerSlot[] = [];
  // raceId → 送信時点のキー(in-flight判定と、完了時のキー再評価の両方に使う)。
  const sentKeys = new Map<string, MixedAllocationCacheKey>();
  let broken = false;

  const terminateAll = (): void => {
    for (const slot of slots) {
      try {
        slot.worker.terminate();
      } catch {
        // terminate自体の失敗は握りつぶす(既に壊れている経路の後始末のため)。
      }
    }
    slots.length = 0;
    sentKeys.clear();
  };

  /** Worker自体の故障を扱う(AC-4: 1回だけログし、プール全体を終了する)。 */
  const handleBroken = (operation: string, error: unknown): void => {
    if (broken) {
      // ログは1回だけ(2026-09-25ゴーサイン)。
      return;
    }
    broken = true;
    terminateAll();
    deps.onBroken(operation, error);
  };

  const wireSlot = (slot: WorkerSlot): void => {
    slot.worker.onmessage = (event) => {
      const { raceId, outcome } = event.data as AllocationWorkerResponseEnvelope<TValue>;
      const sentKey = sentKeys.get(raceId);
      sentKeys.delete(raceId);
      slot.busyRaceId = null;
      // AC-3再評価: 送信時のキーと「今」の最新キーが一致するときだけ書き込む。
      if (sentKey !== undefined && inputs !== null && cacheKeyEquals(sentKey, inputs.keyFor(raceId))) {
        deps.cache.get(sentKey, () => outcome);
      }
      deps.onProgress();
      // 空いたのですぐ次を詰める(次の再描画を待たず並列度を落とさない。
      // 二重発注はbusyRaceId===null判定とsentKeysで防がれている)。
      pump();
    };
    slot.worker.onerror = (event) => {
      slot.busyRaceId = null;
      handleBroken(ALLOCATION_WORKER_CRASH_OPERATION, event);
    };
    slot.worker.onmessageerror = (event) => {
      slot.busyRaceId = null;
      handleBroken(ALLOCATION_WORKER_CRASH_OPERATION, event);
    };
  };

  function pump(): void {
    if (broken || inputs === null) {
      return;
    }
    const current = inputs;
    const pendingRaceIds = current.order.filter(
      (raceId) => !sentKeys.has(raceId) && deps.cache.peek(current.keyFor(raceId)) === undefined,
    );
    for (const raceId of pendingRaceIds) {
      let slot = slots.find((s) => s.busyRaceId === null);
      if (slot === undefined) {
        if (slots.length >= deps.cap) {
          // 全Worker稼働中かつ上限到達。これ以上は発注できない(次のpump()を待つ)。
          break;
        }
        let worker: WorkerLike;
        try {
          worker = deps.createWorker();
        } catch (error) {
          handleBroken(ALLOCATION_WORKER_STARTUP_FAILURE_OPERATION, error);
          return;
        }
        slot = { worker, busyRaceId: null };
        wireSlot(slot);
        slots.push(slot);
      }
      const key = current.keyFor(raceId);
      slot.busyRaceId = raceId;
      sentKeys.set(raceId, key);
      slot.worker.postMessage(current.buildRequest(raceId));
    }
  }

  return {
    setInputs(next) {
      inputs = next;
    },
    pump,
    dispose() {
      terminateAll();
    },
  };
}

/** `createAllocationRunner`が受け取る「今の」入力(pool向け`buildRequest`・逐次向け`compute`の両方を持つ)。 */
export interface AllocationRunnerInputs<TRequest, TValue> {
  readonly order: readonly string[];
  readonly keyFor: (raceId: string) => MixedAllocationCacheKey;
  /** Workerへ送るリクエストを組み立てる(structuredClone可能な値を返すこと)。 */
  readonly buildRequest: (raceId: string) => TRequest;
  /** 逐次フォールバック用の直接計算(Workerが使えないときだけ呼ばれる。AC-1と同じ関数を使うこと)。 */
  readonly compute: (raceId: string) => TValue;
}

/** BatchAnalysisView.tsxから見た、配分計算の駆動役の統一インターフェース。 */
export interface AllocationRunner<TRequest, TValue> {
  setInputs(inputs: AllocationRunnerInputs<TRequest, TValue>): void;
  /** 描画のたびに(依存配列を付けず)呼ぶ。内部で今どちらの経路が有効かを判断する。 */
  pump(): void;
  /** アンマウント時に呼ぶ。Worker・タイマーいずれも後始末する。 */
  dispose(): void;
}

/** `createAllocationRunner`の依存。 */
export interface AllocationRunnerDeps<TValue> {
  readonly cache: MixedAllocationCache<AllocationOutcome<TValue>>;
  readonly createWorker: () => WorkerLike;
  readonly hardwareConcurrency: number;
  readonly maxWorkers?: number;
  /** 逐次フォールバック(`createAllocationScheduler`)用のタイマー注入。 */
  readonly schedule: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
  readonly onProgress: () => void;
  /** Workerの起動失敗・異常終了を記録する(呼び出し側が`logRendererError`等へ配線する)。 */
  readonly onLog: (operation: string, error: unknown) => void;
}

/**
 * 配分計算の駆動役を作る(Issue #119)。既定でWorkerプール経由(`createAllocationWorkerPool`)を
 * 使い、Workerの起動・実行に失敗したら**既存の逐次経路**(`createAllocationQueueRunner`+
 * `createAllocationScheduler`。1文字も変更しない)へ自動的に切り替える(AC-4)。
 * 切り替え後は最後に`setInputs`された内容をそのまま逐次側へ引き継ぐため、
 * 壊れた時点で計算中だった・まだ未計算だったレースも取りこぼさない。
 */
export function createAllocationRunner<TRequest, TValue>(
  deps: AllocationRunnerDeps<TValue>,
): AllocationRunner<TRequest, TValue> {
  const cap = computeAllocationWorkerPoolCap(deps.hardwareConcurrency, deps.maxWorkers);
  let lastInputs: AllocationRunnerInputs<TRequest, TValue> | null = null;
  let mode: "pool" | "sequential" = "pool";

  let sequentialQueueRunner: ReturnType<typeof createAllocationQueueRunner<TValue>> | null = null;
  let sequentialScheduler: AllocationScheduler | null = null;

  const pool = createAllocationWorkerPool<TRequest, TValue>({
    cache: deps.cache,
    createWorker: deps.createWorker,
    cap,
    onProgress: deps.onProgress,
    onBroken: (operation, error) => {
      deps.onLog(operation, error);
      switchToSequential();
    },
  });

  /** Worker起動・実行に失敗したときに1度だけ呼ばれ、以降は逐次経路へ切り替える。 */
  function switchToSequential(): void {
    if (mode === "sequential") {
      return;
    }
    mode = "sequential";
    const runner = createAllocationQueueRunner<TValue>(deps.cache);
    sequentialQueueRunner = runner;
    sequentialScheduler = createAllocationScheduler({
      runner,
      schedule: deps.schedule,
      cancel: deps.cancel,
      onStepped: deps.onProgress,
    });
    if (lastInputs !== null) {
      applySequentialInputs(lastInputs);
    }
  }

  function applySequentialInputs(inputs: AllocationRunnerInputs<TRequest, TValue>): void {
    sequentialQueueRunner?.setInputs({
      order: inputs.order,
      keyFor: inputs.keyFor,
      compute: inputs.compute,
    });
  }

  return {
    setInputs(inputs) {
      lastInputs = inputs;
      if (mode === "pool") {
        pool.setInputs({
          order: inputs.order,
          keyFor: inputs.keyFor,
          buildRequest: inputs.buildRequest,
        });
      } else {
        applySequentialInputs(inputs);
      }
    },
    pump() {
      // else-ifにしない: pool.pump()の中でWorkerが壊れてmodeが"sequential"へ切り替わることが
      // あるため、同じpump()呼び出しの中で逐次側もすぐ起動する(次の再描画を待って初めて
      // フォールバックが動き出す、という1コミット分の空白を作らない。AC-4「動き続ける」)。
      if (mode === "pool") {
        pool.pump();
      }
      if (mode === "sequential") {
        sequentialScheduler?.sync();
      }
    },
    dispose() {
      pool.dispose();
      sequentialScheduler?.dispose();
    },
  };
}
